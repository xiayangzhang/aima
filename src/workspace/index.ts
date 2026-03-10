import { eq, inArray, not } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { slots, threads } from '../schema/index'
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
