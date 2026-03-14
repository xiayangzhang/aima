import { EventEmitter } from 'node:events'
import {
  and,
  arrayContains,
  asc,
  avg,
  count,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  max,
  sql,
} from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { cosineDistance } from 'drizzle-orm/sql/functions'
import type { BrainSignal, BrainSignalType } from '../adapters/index'
import type { EmbeddingConfig } from '../embedding'
import { generateEmbedding } from '../embedding'
import { memories, pendingObservations, slots, threads } from '../schema/index'
import type * as schema from '../schema/index'
import type {
  BrainType,
  CognitiveBrainType,
  CreateMemoryParams,
  CreatePendingParams,
  CreateThreadParams,
  ICognitiveWorkspace,
  MemoryEntry,
  MemorySearchFilters,
  MemoryType,
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
  /** Embedding config for semantic memory search. If not set, all searches fall back to ILIKE. */
  embedding?: EmbeddingConfig
}

// ─── Row Mappers ───────────────────────────────────────────────────────────────

function mapThreadRow(row: typeof threads.$inferSelect): Thread {
  return {
    id: row.id,
    state: row.state,
    sourceChannel: row.sourceChannel,
    initiatedBy: row.initiatedBy,
    trigger: row.trigger,
    entityId: row.entityId ?? null,
    goal: row.goal ?? null,
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
    threadId: row.threadId ?? null,
    triggerAt: row.triggerAt,
    expiresAt: row.expiresAt,
    baseImportance: row.baseImportance,
    addedAt: row.addedAt,
  }
}

/**
 * Canonical "active memory" filter: not soft-deleted by either mechanism.
 * - tInvalid IS NULL  → not superseded by a newer memory
 * - forgotten = false → not expired-and-cleaned by forgetExpiredMemories
 * Every query that should return live memories MUST use this.
 */
function activeMemory() {
  return and(isNull(memories.tInvalid), eq(memories.forgotten, false))
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractRelatedEntityIds(entries: MemoryEntry[], max: number): string[] {
  const ids: string[] = []
  for (const entry of entries) {
    if (entry.type !== 'semantic') continue
    try {
      const parsed = JSON.parse(entry.content) as Record<string, unknown>
      const relatedEntityId = (parsed.related_to as Record<string, unknown> | undefined)
        ?.related_entity_id
      if (
        typeof relatedEntityId === 'string' &&
        relatedEntityId &&
        !ids.includes(relatedEntityId)
      ) {
        ids.push(relatedEntityId)
        if (ids.length >= max) break
      }
    } catch {
      // skip non-JSON content or missing fields
    }
  }
  return ids
}

// ─── CognitiveWorkspace ────────────────────────────────────────────────────────

export class CognitiveWorkspace implements ICognitiveWorkspace {
  private readonly db: DrizzleDB
  private readonly pendingCapacity: number
  private readonly options: CognitiveWorkspaceOptions
  private signals: Map<string, BrainSignal[]> = new Map()
  private wsEmitter = new EventEmitter()

  constructor(db: DrizzleDB, options: CognitiveWorkspaceOptions = {}) {
    this.db = db
    this.options = options
    this.pendingCapacity = options.pendingCapacity ?? 100
  }

  // ── Brain Signals (in-memory, thread-scoped) ────────────────────────────────

  pushSignal(signal: BrainSignal): void {
    const key = `${signal.type}:${signal.threadId}`
    const existing = this.signals.get(key) ?? []
    existing.push(signal)
    this.signals.set(key, existing)
  }

  popSignal(type: BrainSignalType, threadId: string): BrainSignal | undefined {
    const key = `${type}:${threadId}`
    const list = this.signals.get(key) ?? []
    const item = list.shift()
    if (list.length === 0) this.signals.delete(key)
    else this.signals.set(key, list)
    return item
  }

  hasSignal(type: BrainSignalType, threadId: string): boolean {
    const key = `${type}:${threadId}`
    return (this.signals.get(key)?.length ?? 0) > 0
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
        entityId: params.entityId ?? null,
        sourceChannel: params.sourceChannel ?? null,
        goal: params.goal ?? null,
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

  /**
   * Reopen a completed or interrupted Thread for continuation.
   * Atomically resets state to 'active' and updates the trigger to the new content.
   *
   * @throws {Error} if Thread does not exist
   * @throws {Error} if Thread is in 'active' or 'waiting' state (concurrent protection)
   */
  async reopenThread(id: string, trigger: string): Promise<void> {
    const thread = await this.getThread(id)
    if (!thread) throw new Error(`Thread not found: ${id}`)
    if (thread.state === 'active' || thread.state === 'waiting') {
      throw new Error(`Cannot reopen Thread in state '${thread.state}': ${id}`)
    }
    await this.db
      .update(threads)
      .set({ state: 'active', trigger, updatedAt: new Date() })
      .where(eq(threads.id, id))
  }

  async getActiveThreads(): Promise<Thread[]> {
    const rows = await this.db.select().from(threads).where(eq(threads.state, 'active'))
    return rows.map(mapThreadRow)
  }

  async getWaitingThreads(): Promise<Thread[]> {
    const rows = await this.db.select().from(threads).where(eq(threads.state, 'waiting'))
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
        executionSessionId: data.executionSessionId ?? null,
      })
      .onConflictDoUpdate({
        target: [slots.threadId, slots.brain],
        set: {
          status: data.status ?? 'pending',
          input: data.input ?? null,
          output: data.output ?? null,
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
          threadId: params.threadId ?? null,
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
      const entry = mapMemoryRow(row)
      if (this.options.embedding != null) {
        this.generateAndStoreEmbedding(entry.id, entry.content).catch(() => {})
      }
      return entry
    }

    const row = await performInsert(this.db)
    const entry = mapMemoryRow(row)
    if (this.options.embedding != null) {
      this.generateAndStoreEmbedding(entry.id, entry.content).catch(() => {})
    }
    return entry
  }

  private async generateAndStoreEmbedding(id: string, content: string): Promise<void> {
    // biome-ignore lint/style/noNonNullAssertion: only called when this.options.embedding != null
    const embedding = await generateEmbedding(content, this.options.embedding!)
    await this.db.update(memories).set({ embedding }).where(eq(memories.id, id))
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

    // Always exclude forgotten memories
    conditions.push(eq(memories.forgotten, false))
    // Exclude superseded memories unless caller explicitly opts out
    if (filters.excludeInvalid !== false) {
      conditions.push(isNull(memories.tInvalid))
    }

    if (filters.createdAfter !== undefined) {
      conditions.push(gt(memories.createdAt, filters.createdAfter))
    }

    const lim = filters.limit ?? 20

    // ── Vector path: query + embedding config ──────────────────────────────────
    if (filters.query != null && this.options.embedding != null) {
      try {
        const queryEmbedding = await generateEmbedding(filters.query, this.options.embedding)

        const rows = await this.db
          .select()
          .from(memories)
          .where(and(...conditions, isNotNull(memories.embedding)))
          .orderBy(asc(cosineDistance(memories.embedding, queryEmbedding)))
          .limit(lim)

        if (rows.length > 0) {
          return rows.map(mapMemoryRow)
        }
        // zero results → fall through to ILIKE
      } catch {
        // generateEmbedding failed (API error, timeout, etc.) → fall through to ILIKE
      }
    }

    // ── ILIKE fallback (or no-query path) ──────────────────────────────────────
    if (filters.query != null) {
      conditions.push(ilike(memories.content, `%${filters.query}%`))
    }

    const rows = await this.db
      .select()
      .from(memories)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(memories.baseImportance))
      .limit(lim)

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
          .set({ usageOutcomes: updated, lastAccessedAt: new Date(), updatedAt: new Date() })
          .where(eq(memories.id, row.id))
      }
    })
  }

  async clearWorkingMemory(threadId: string): Promise<void> {
    await this.db
      .delete(memories)
      .where(and(eq(memories.type, 'working'), eq(memories.threadId, threadId)))
  }

  /** Mark a memory entry as invalid (soft delete). Used by DMN Consolidation. */
  async invalidateMemory(id: string): Promise<void> {
    await this.db
      .update(memories)
      .set({ tInvalid: new Date(), updatedAt: new Date() })
      .where(eq(memories.id, id))
  }

  // ── Hippocampus Consolidation methods ────────────────────────────────────────

  /** Query episodic segment summaries by time range (data source for segment refine and replay). */
  async getSegmentsByTimeRange(range: { from: Date; to: Date }): Promise<
    {
      segmentId: string
      eventCount: number
      avgImportance: number
      maxCreatedAt: Date
    }[]
  > {
    const rows = await this.db
      .select({
        segmentId: memories.segmentId,
        eventCount: count(memories.id),
        avgImportance: avg(memories.baseImportance),
        maxCreatedAt: max(memories.createdAt),
      })
      .from(memories)
      .where(
        and(
          eq(memories.type, 'episodic'),
          isNotNull(memories.segmentId),
          activeMemory(),
          gte(memories.createdAt, range.from),
          lt(memories.createdAt, range.to),
        ),
      )
      .groupBy(memories.segmentId)
    return rows
      .filter((r) => r.segmentId !== null)
      .map((r) => ({
        segmentId: r.segmentId as string,
        eventCount: Number(r.eventCount),
        avgImportance: Number(r.avgImportance ?? 0.5),
        maxCreatedAt: r.maxCreatedAt ?? new Date(),
      }))
  }

  /** Fetch the full event sequence of a segment, ordered by segmentSeq ASC. */
  async getSegmentSequence(segmentId: string): Promise<MemoryEntry[]> {
    const rows = await this.db
      .select()
      .from(memories)
      .where(and(eq(memories.segmentId, segmentId), activeMemory()))
      .orderBy(asc(memories.segmentSeq), asc(memories.createdAt))
    return rows.map(mapMemoryRow)
  }

  /** Update segmentId and segmentSeq for a memory entry (used by segment refine merge). */
  async updateMemorySegment(
    memoryId: string,
    newSegmentId: string,
    newSegmentSeq: number,
  ): Promise<void> {
    await this.db
      .update(memories)
      .set({ segmentId: newSegmentId, segmentSeq: newSegmentSeq, updatedAt: new Date() })
      .where(eq(memories.id, memoryId))
  }

  /** Fetch memories with non-zero usage outcomes (convergence step data source). */
  async getMemoriesWithNonZeroOutcomes(): Promise<MemoryEntry[]> {
    const rows = await this.db
      .select()
      .from(memories)
      .where(
        and(
          activeMemory(),
          sql`(
            (${memories.usageOutcomes}->>'positive')::int +
            (${memories.usageOutcomes}->>'negative')::int
          ) > 0`,
        ),
      )
    return rows.map(mapMemoryRow)
  }

  /** Update base_importance and reset usage_outcomes to {0,0,0} after convergence. */
  async updateMemoryImportanceAndResetOutcomes(
    id: string,
    newBaseImportance: number,
  ): Promise<void> {
    await this.db
      .update(memories)
      .set({
        baseImportance: newBaseImportance,
        usageOutcomes: { positive: 0, negative: 0, neutral: 0 },
        updatedAt: new Date(),
      })
      .where(eq(memories.id, id))
  }

  /** Soft-delete expired memories: expiresAt < now AND pinned=false AND forgotten=false. */
  async forgetExpiredMemories(now: Date): Promise<number> {
    const result = await this.db
      .update(memories)
      .set({ forgotten: true, updatedAt: new Date() })
      .where(
        and(
          eq(memories.forgotten, false),
          eq(memories.pinned, false),
          lt(memories.expiresAt, now),
          isNotNull(memories.expiresAt),
        ),
      )
      .returning({ id: memories.id })
    return result.length
  }

  // ── Brain-Specific Retrieval ─────────────────────────────────────────────────

  private async _fetchEntityMemories(
    entityId: string,
    types?: MemoryType[],
    limit = 10,
  ): Promise<MemoryEntry[]> {
    const conditions = [
      eq(memories.entityId, entityId),
      eq(memories.forgotten, false),
      isNull(memories.tInvalid),
    ]
    if (types && types.length > 0) {
      conditions.push(inArray(memories.type, types))
    }
    const rows = await this.db
      .select()
      .from(memories)
      .where(and(...conditions))
      .orderBy(desc(memories.baseImportance), desc(memories.lastAccessedAt))
      .limit(limit)
    return rows.map(mapMemoryRow)
  }

  async getEntityContext(
    entityId: string,
    opts?: {
      depth?: number // default 1, clamped to max 2
      types?: MemoryType[]
      limit?: number // default 10
    },
  ): Promise<MemoryEntry[]> {
    const depth = Math.min(opts?.depth ?? 1, 2)
    const anchorRows = await this._fetchEntityMemories(entityId, opts?.types, opts?.limit ?? 10)
    if (depth < 2) return anchorRows

    const relatedEntityIds = extractRelatedEntityIds(anchorRows, 5)
    if (relatedEntityIds.length === 0) return anchorRows

    const relatedResults = await Promise.all(
      relatedEntityIds.map((relId) => this._fetchEntityMemories(relId, opts?.types, 3)),
    )
    return [...anchorRows, ...relatedResults.flat()]
  }

  async findSimilarSituations(
    situation: string,
    opts?: { limit?: number },
  ): Promise<{ episodes: MemoryEntry[]; procedures: MemoryEntry[]; facts: MemoryEntry[] }> {
    const lim = opts?.limit ?? 5

    // Vector path: only when embedding config is set and situation is non-empty
    if (this.options.embedding != null && situation.trim() !== '') {
      try {
        const queryEmbedding = await generateEmbedding(situation, this.options.embedding)

        const vectorQuery = (type: MemoryType) =>
          this.db
            .select()
            .from(memories)
            .where(
              and(
                eq(memories.type, type),
                eq(memories.forgotten, false),
                isNull(memories.tInvalid),
                isNotNull(memories.embedding),
              ),
            )
            .orderBy(asc(cosineDistance(memories.embedding, queryEmbedding)))
            .limit(lim)

        const [episodeRows, procedureRows, factRows] = await Promise.all([
          vectorQuery('episodic'),
          vectorQuery('procedural'),
          vectorQuery('semantic'),
        ])

        // Return vector results if any type has results
        if (episodeRows.length > 0 || procedureRows.length > 0 || factRows.length > 0) {
          return {
            episodes: episodeRows.map(mapMemoryRow),
            procedures: procedureRows.map(mapMemoryRow),
            facts: factRows.map(mapMemoryRow),
          }
        }
        // else: no embeddings exist yet, fall through to ILIKE
      } catch {
        // generateEmbedding failed (API error, timeout, etc.) → fall through to ILIKE
      }
    }

    // ILIKE fallback (original logic — preserved exactly)
    const pattern = `%${situation}%`

    const baseConditions = (type: MemoryType) => [
      eq(memories.type, type),
      eq(memories.forgotten, false),
      isNull(memories.tInvalid),
      ilike(memories.content, pattern),
    ]

    const [episodeRows, procedureRows, factRows] = await Promise.all([
      this.db
        .select()
        .from(memories)
        .where(and(...baseConditions('episodic')))
        .orderBy(desc(memories.baseImportance))
        .limit(lim),
      this.db
        .select()
        .from(memories)
        .where(and(...baseConditions('procedural')))
        .orderBy(desc(memories.baseImportance))
        .limit(lim),
      this.db
        .select()
        .from(memories)
        .where(and(...baseConditions('semantic')))
        .orderBy(desc(memories.baseImportance))
        .limit(lim),
    ])

    return {
      episodes: episodeRows.map(mapMemoryRow),
      procedures: procedureRows.map(mapMemoryRow),
      facts: factRows.map(mapMemoryRow),
    }
  }

  async getProcedure(taskType: string, opts?: { limit?: number }): Promise<MemoryEntry[]> {
    const lim = opts?.limit ?? 3

    // Vector path
    if (this.options.embedding != null && taskType.trim() !== '') {
      try {
        const queryEmbedding = await generateEmbedding(taskType, this.options.embedding)
        const rows = await this.db
          .select()
          .from(memories)
          .where(
            and(
              eq(memories.type, 'procedural'),
              eq(memories.forgotten, false),
              isNull(memories.tInvalid),
              isNotNull(memories.embedding),
            ),
          )
          .orderBy(asc(cosineDistance(memories.embedding, queryEmbedding)))
          .limit(lim)

        if (rows.length > 0) {
          return rows.map(mapMemoryRow)
        }
        // else: fall through to ILIKE
      } catch {
        // fall through to ILIKE
      }
    }

    // ILIKE fallback (original logic)
    const rows = await this.db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.type, 'procedural'),
          eq(memories.forgotten, false),
          isNull(memories.tInvalid),
          ilike(memories.content, `%${taskType}%`),
        ),
      )
      .orderBy(desc(memories.baseImportance), desc(memories.lastAccessedAt))
      .limit(lim)

    return rows.map(mapMemoryRow)
  }

  async getByTags(
    tags: string[],
    timeRange?: { after?: Date; before?: Date },
    limit?: number,
  ): Promise<MemoryEntry[]> {
    const conditions = [arrayContains(memories.tags, tags), isNull(memories.tInvalid)]
    if (timeRange?.after) conditions.push(gt(memories.createdAt, timeRange.after))
    if (timeRange?.before) conditions.push(lt(memories.createdAt, timeRange.before))

    const rows = await this.db
      .select()
      .from(memories)
      .where(and(...conditions))
      .orderBy(desc(memories.createdAt))
      .limit(limit ?? 20)

    return rows.map(mapMemoryRow)
  }

  // ── DMN Segment Tracking ─────────────────────────────────────────────────────

  async getSessionContext(sessionId: string): Promise<{
    anchor: MemoryEntry | null
    events: MemoryEntry[]
  }> {
    const rows = await this.db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.type, 'episodic'),
          eq(memories.sessionId, sessionId),
          isNull(memories.tInvalid),
          eq(memories.forgotten, false),
        ),
      )
      .orderBy(asc(memories.createdAt))

    if (rows.length === 0) return { anchor: null, events: [] }

    const events = rows.map(mapMemoryRow)
    return { anchor: events[0] ?? null, events }
  }

  /**
   * Returns the most recent active segment state (segmentId + nextSeq) for every
   * thread that has at least one valid episodic memory with a segmentId.
   * Used by DmnReactive.start() to restore in-memory tracking after process restart.
   */
  async getLatestSegmentStates(): Promise<Map<string, { segmentId: string; nextSeq: number }>> {
    const rows = await this.db
      .select({
        threadId: memories.threadId,
        segmentId: memories.segmentId,
        maxSeq: sql<number>`max(${memories.segmentSeq})::int`,
        maxCreatedAt: max(memories.createdAt),
      })
      .from(memories)
      .where(
        and(
          eq(memories.type, 'episodic'),
          isNotNull(memories.threadId),
          isNotNull(memories.segmentId),
          activeMemory(),
        ),
      )
      .groupBy(memories.threadId, memories.segmentId)

    // For each thread, pick the segment with the most recent creation time
    const result = new Map<string, { segmentId: string; nextSeq: number; maxCreatedAt: Date }>()
    for (const row of rows) {
      if (!row.threadId || !row.segmentId) continue
      const existing = result.get(row.threadId)
      const rowDate = row.maxCreatedAt ?? new Date(0)
      if (!existing || rowDate > existing.maxCreatedAt) {
        result.set(row.threadId, {
          segmentId: row.segmentId,
          nextSeq: (row.maxSeq ?? 0) + 1,
          maxCreatedAt: rowDate,
        })
      }
    }

    return new Map(
      [...result.entries()].map(([threadId, { segmentId, nextSeq }]) => [
        threadId,
        { segmentId, nextSeq },
      ]),
    )
  }
}
