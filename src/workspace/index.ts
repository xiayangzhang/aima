import { and, desc, eq, inArray, isNull, not, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { memories, slots, threads } from '../schema/index'
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

  // ── Pending Observations — implemented in WP05 ───────────────────────────────

  async writePending(_params: CreatePendingParams): Promise<PendingObservation> {
    throw new Error('Not implemented')
  }

  async getPendingObservations(): Promise<PendingObservation[]> {
    throw new Error('Not implemented')
  }

  async removeExpiredPending(_now: Date): Promise<void> {
    throw new Error('Not implemented')
  }

  async removePending(_id: string): Promise<void> {
    throw new Error('Not implemented')
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
      conditions.push(sql`${memories.tags} @> ${sql.array(filters.tags, 'text')}`)
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
        const outcomes = row.usageOutcomes as { positive: number; negative: number; neutral: number }
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
