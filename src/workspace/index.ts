import { asc, eq, gte, inArray, lt, not, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { pendingObservations, slots, threads } from '../schema/index'
import type * as schema from '../schema/index'
import type {
  BrainType,
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

// ─── CognitiveWorkspace ────────────────────────────────────────────────────────

export class CognitiveWorkspace implements ICognitiveWorkspace {
  private readonly db: DrizzleDB
  private readonly pendingCapacity: number

  constructor(db: DrizzleDB, options: CognitiveWorkspaceOptions = {}) {
    this.db = db
    this.pendingCapacity = options.pendingCapacity ?? 100
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

  // ── Memory — implemented in WP06 ────────────────────────────────────────────

  async writeMemory(_params: CreateMemoryParams): Promise<MemoryEntry> {
    throw new Error('Not implemented')
  }

  async searchMemory(_filters: MemorySearchFilters): Promise<MemoryEntry[]> {
    throw new Error('Not implemented')
  }

  async markMemoryUsed(_ids: string[], _outcome: UsageOutcome): Promise<void> {
    throw new Error('Not implemented')
  }

  async clearWorkingMemory(_threadId: string): Promise<void> {
    throw new Error('Not implemented')
  }
}
