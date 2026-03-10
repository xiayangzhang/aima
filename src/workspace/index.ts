import { EventEmitter } from 'node:events'
import { and, arrayContains, asc, desc, eq, gte, inArray, isNull, lt, not, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { BrainSignal, BrainSignalType } from '../adapters/index'
import { memories, pendingObservations, slots, threads } from '../schema/index'
import type * as schema from '../schema/index'
import type {
  BrainType,
  CognitiveBrainType,
  ComplexityHint,
  CreateMemoryParams,
  CreatePendingParams,
  CreateThreadParams,
  ICognitiveWorkspace,
  Intent,
  MemoryEntry,
  MemorySearchFilters,
  PendingObservation,
  Slot,
  Thread,
  ThreadState,
  UsageOutcome,
  WriteSlotParams,
} from '../types/index'

export type DrizzleDB = PostgresJsDatabase<typeof schema>

export interface CognitiveWorkspaceOptions {
  pendingCapacity?: number // default: 100
}

// ─── Row Mappers ───────────────────────────────────────────────────────────────

function mapThreadRow(row: typeof threads.$inferSelect): Thread {
  return {
    id: row.id,
    state: row.state,
    sourceChannel: row.sourceChannel,
    initiatedBy: row.initiatedBy,
    trigger: row.trigger,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function mapSlotRow(row: typeof slots.$inferSelect): Slot {
  return {
    id: row.id,
    threadId: row.threadId,
    brain: row.brain as BrainType,
    status: row.status,
    input: row.input,
    output: row.output,
    intent: (row.intent as Intent | null) ?? null,
    complexityHint: (row.complexityHint as ComplexityHint | null) ?? null,
    executionSessionId: row.executionSessionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function mapPendingRow(row: typeof pendingObservations.$inferSelect): PendingObservation {
  return {
    id: row.id,
    targetBrain: row.targetBrain as BrainType,
    note: row.note,
    triggerAt: row.triggerAt,
    expiresAt: row.expiresAt,
    baseImportance: row.baseImportance,
    addedAt: row.addedAt,
  }
}

function mapMemoryRow(row: typeof memories.$inferSelect): MemoryEntry {
  const outcomes = row.usageOutcomes as { positive: number; negative: number; neutral: number }
  return {
    id: row.id,
    type: row.type,
    content: row.content,
    entityId: row.entityId,
    segmentId: row.segmentId,
    segmentSeq: row.segmentSeq,
    tags: row.tags,
    baseImportance: row.baseImportance,
    usageOutcomes: outcomes,
    sourceBrain: (row.sourceBrain as BrainType) ?? null,
    threadId: row.threadId,
    sessionId: row.sessionId,
    supersedesId: row.supersedesId,
    tInvalid: row.tInvalid,
    lastAccessedAt: row.lastAccessedAt,
    pinned: row.pinned,
    forgotten: row.forgotten,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

// ─── CognitiveWorkspace ────────────────────────────────────────────────────────

export class CognitiveWorkspace implements ICognitiveWorkspace {
  private readonly db: DrizzleDB
  private readonly pendingCapacity: number
  private signals: Map<string, BrainSignal[]> = new Map()
  private wsEmitter = new EventEmitter()

  constructor(db: DrizzleDB, options: CognitiveWorkspaceOptions = {}) {
    this.db = db
    this.pendingCapacity = options.pendingCapacity ?? 100
  }

  // ── Brain Signals (in-memory) ────────────────────────────────────────────────

  pushSignal(signal: BrainSignal): void {
    const existing = this.signals.get(signal.type) ?? []
    existing.push(signal)
    this.signals.set(signal.type, existing)
  }

  popSignal(type: BrainSignalType): BrainSignal | undefined {
    const list = this.signals.get(type) ?? []
    const item = list.shift()
    if (list.length === 0) this.signals.delete(type)
    else this.signals.set(type, list)
    return item
  }

  hasSignal(type: BrainSignalType): boolean {
    return (this.signals.get(type)?.length ?? 0) > 0
  }

  // ── Workspace Notifications (for ThreadRunner) ───────────────────────────────

  notifySlotDone(threadId: string, brain: CognitiveBrainType, slotStatus: string): void {
    this.wsEmitter.emit('slot_change', { threadId, brain, slotStatus })
  }

  notifyThreadComplete(threadId: string): void {
    this.wsEmitter.emit('thread_complete', threadId)
  }

  onSlotChange(
    handler: (event: { threadId: string; brain: CognitiveBrainType; slotStatus: string }) => void,
  ): () => void {
    this.wsEmitter.on('slot_change', handler)
    return () => {
      this.wsEmitter.off('slot_change', handler)
    }
  }

  onThreadComplete(handler: (threadId: string) => void): () => void {
    this.wsEmitter.on('thread_complete', handler)
    return () => {
      this.wsEmitter.off('thread_complete', handler)
    }
  }

  waitForComplete(threadId: string): Promise<void> {
    return new Promise((resolve) => {
      this.getThread(threadId)
        .then((thread) => {
          if (thread?.state === 'complete' || thread?.state === 'interrupted') {
            resolve()
            return
          }
          const handler = (id: string) => {
            if (id === threadId) {
              this.wsEmitter.off('thread_complete', handler)
              resolve()
            }
          }
          this.wsEmitter.on('thread_complete', handler)
        })
        .catch(() => resolve())
    })
  }

  // ── Thread ──────────────────────────────────────────────────────────────────

  async createThread(params: CreateThreadParams): Promise<Thread> {
    const [row] = await this.db
      .insert(threads)
      .values({
        initiatedBy: params.initiatedBy,
        trigger: params.trigger ?? null,
        sourceChannel: params.sourceChannel ?? null,
      })
      .returning()

    if (!row) throw new Error('Insert returned no rows')
    return mapThreadRow(row)
  }

  async getThread(id: string): Promise<Thread | null> {
    const row = await this.db.query.threads.findFirst({
      where: eq(threads.id, id),
    })
    return row ? mapThreadRow(row) : null
  }

  async updateThreadState(id: string, state: ThreadState): Promise<void> {
    await this.db.update(threads).set({ state, updatedAt: new Date() }).where(eq(threads.id, id))
  }

  async getActiveThreads(): Promise<Thread[]> {
    const rows = await this.db
      .select()
      .from(threads)
      .where(not(inArray(threads.state, ['complete'])))
    return rows.map(mapThreadRow)
  }

  // ── Slot ────────────────────────────────────────────────────────────────────

  async writeSlot(threadId: string, brain: BrainType, data: WriteSlotParams): Promise<Slot> {
    const [row] = await this.db
      .insert(slots)
      .values({
        threadId,
        brain,
        status: data.status ?? 'pending',
        input: data.input ?? null,
        output: data.output ?? null,
        intent: data.intent ?? null,
        complexityHint: data.complexityHint ?? null,
        executionSessionId: data.executionSessionId ?? null,
      })
      .onConflictDoUpdate({
        target: [slots.threadId, slots.brain],
        set: {
          status: data.status ?? 'pending',
          input: data.input ?? null,
          output: data.output ?? null,
          intent: data.intent ?? null,
          complexityHint: data.complexityHint ?? null,
          executionSessionId: data.executionSessionId ?? null,
          updatedAt: new Date(),
        },
      })
      .returning()

    if (!row) throw new Error('Upsert returned no rows')
    return mapSlotRow(row)
  }

  async readSlot(threadId: string, brain: BrainType): Promise<Slot | null> {
    const row = await this.db.query.slots.findFirst({
      where: (s, { and, eq: eqOp }) => and(eqOp(s.threadId, threadId), eqOp(s.brain, brain)),
    })
    return row ? mapSlotRow(row) : null
  }

  async getSlotsByThread(threadId: string): Promise<Slot[]> {
    const rows = await this.db.select().from(slots).where(eq(slots.threadId, threadId))
    return rows.map(mapSlotRow)
  }

  // ── Pending Observations ────────────────────────────────────────────────────

  async writePending(params: CreatePendingParams): Promise<PendingObservation> {
    return await this.db.transaction(async (tx) => {
      // 1. Acquire transaction-level advisory lock — serializes concurrent writes
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('aima_pending_write'))`)

      // 2. Count valid (non-expired) records
      const now = new Date()
      const [countResult] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(pendingObservations)
        .where(gte(pendingObservations.expiresAt, now))

      const currentCount = countResult?.count ?? 0

      // 3. Evict lowest-priority records when at capacity
      if (currentCount >= this.pendingCapacity) {
        const excess = currentCount - this.pendingCapacity + 1
        const toEvict = await tx
          .select({ id: pendingObservations.id })
          .from(pendingObservations)
          .where(gte(pendingObservations.expiresAt, now))
          .orderBy(asc(pendingObservations.baseImportance), asc(pendingObservations.addedAt))
          .limit(excess)

        if (toEvict.length > 0) {
          const evictIds = toEvict.map((r) => r.id)
          await tx.delete(pendingObservations).where(inArray(pendingObservations.id, evictIds))
        }
      }

      // 4. Insert the new record
      const [row] = await tx
        .insert(pendingObservations)
        .values({
          targetBrain: params.targetBrain,
          note: params.note,
          triggerAt: params.triggerAt ?? null,
          expiresAt: params.expiresAt,
          baseImportance: params.baseImportance ?? 0.5,
        })
        .returning()

      if (!row) throw new Error('Insert returned no rows')
      return mapPendingRow(row)
    })
  }

  async getPendingObservations(): Promise<PendingObservation[]> {
    const now = new Date()
    const rows = await this.db
      .select()
      .from(pendingObservations)
      .where(gte(pendingObservations.expiresAt, now))
      .orderBy(sql`${pendingObservations.triggerAt} ASC NULLS FIRST`)
    return rows.map(mapPendingRow)
  }

  async removeExpiredPending(now: Date): Promise<void> {
    await this.db.delete(pendingObservations).where(lt(pendingObservations.expiresAt, now))
  }

  async removePending(id: string): Promise<void> {
    await this.db.delete(pendingObservations).where(eq(pendingObservations.id, id))
  }

  // ── Memory ──────────────────────────────────────────────────────────────────

  async writeMemory(params: CreateMemoryParams): Promise<MemoryEntry> {
    const performInsert = async (tx: DrizzleDB) => {
      const [row] = await tx
        .insert(memories)
        .values({
          type: params.type,
          content: params.content,
          entityId: params.entityId ?? null,
          segmentId: params.segmentId ?? null,
          segmentSeq: params.segmentSeq ?? null,
          tags: params.tags ?? [],
          baseImportance: params.baseImportance ?? 0.5,
          sourceBrain: params.sourceBrain ?? null,
          threadId: params.threadId ?? null,
          sessionId: params.sessionId ?? null,
          supersedesId: params.supersedesId ?? null,
          expiresAt: params.expiresAt ?? null,
          pinned: params.pinned ?? false,
        })
        .returning()

      if (!row) throw new Error('Insert returned no rows')
      return row
    }

    if (params.supersedesId) {
      const row = await this.db.transaction(async (tx) => {
        const newRow = await performInsert(tx)
        await tx
          .update(memories)
          .set({ tInvalid: new Date(), updatedAt: new Date() })
          .where(eq(memories.id, params.supersedesId as string))
        return newRow
      })
      return mapMemoryRow(row)
    }

    const row = await performInsert(this.db)
    return mapMemoryRow(row)
  }

  async searchMemory(filters: MemorySearchFilters): Promise<MemoryEntry[]> {
    const conditions = []

    if (filters.type !== undefined) {
      conditions.push(eq(memories.type, filters.type))
    }

    if (filters.tags && filters.tags.length > 0) {
      conditions.push(arrayContains(memories.tags, filters.tags))
    }

    if (filters.entityId !== undefined) {
      conditions.push(eq(memories.entityId, filters.entityId))
    }

    if (filters.segmentId !== undefined) {
      conditions.push(eq(memories.segmentId, filters.segmentId))
    }

    if (filters.excludeInvalid !== false) {
      conditions.push(isNull(memories.tInvalid))
    }

    const rows = await this.db
      .select()
      .from(memories)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(memories.baseImportance))
      .limit(filters.limit ?? 20)

    return rows.map(mapMemoryRow)
  }

  async markMemoryUsed(ids: string[], outcome: UsageOutcome): Promise<void> {
    if (ids.length === 0) return

    const rows = await this.db
      .select({ id: memories.id, usageOutcomes: memories.usageOutcomes })
      .from(memories)
      .where(inArray(memories.id, ids))

    await this.db.transaction(async (tx) => {
      for (const row of rows) {
        const outcomes = row.usageOutcomes as {
          positive: number
          negative: number
          neutral: number
        }
        const updated = {
          ...outcomes,
          [outcome]: (outcomes[outcome] ?? 0) + 1,
        }
        await tx
          .update(memories)
          .set({ usageOutcomes: updated, updatedAt: new Date() })
          .where(eq(memories.id, row.id))
      }
    })
  }

  async clearWorkingMemory(threadId: string): Promise<void> {
    await this.db
      .delete(memories)
      .where(and(eq(memories.type, 'working'), eq(memories.threadId, threadId)))
  }
}
