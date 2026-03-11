// ─── Brain & Cognitive ────────────────────────────────────────────────────────

export type BrainType = 'limbic' | 'cortex' | 'brainstem' | 'amygdala' | 'dmn'

// BrainAdapter 只处理三个认知脑区，Amygdala 和 DMN 不走标准 BrainAdapter
export type CognitiveBrainType = 'limbic' | 'cortex' | 'brainstem'

// ─── Thread & Slot ────────────────────────────────────────────────────────────

export type ThreadState = 'active' | 'waiting' | 'complete' | 'interrupted'

export type SlotStatus = 'pending' | 'running' | 'done' | 'error'

// Cortex 专用：此次 Thread 的处理意图
export type Intent = 'communicate' | 'execute' | 'both'

// Cortex 专用（可选注解）：供 Brainstem 判断是否启动子执行 session
export type ComplexityHint = 'simple' | 'complex'

// ─── Memory ───────────────────────────────────────────────────────────────────

export type MemoryType = 'semantic' | 'episodic' | 'procedural' | 'working' | 'implicit'

// markMemoryUsed 调用时传入的结果类型
export type UsageOutcome = 'positive' | 'negative' | 'neutral'

// ─── Entity Types ─────────────────────────────────────────────────────────────

export interface Thread {
  id: string
  state: ThreadState
  sourceChannel: string | null // null = DMN-initiated, no external channel
  initiatedBy: string // 'dmn' | 'external:teams' | 'external:webhook' etc.
  trigger: string | null
  createdAt: Date
  updatedAt: Date
}

export interface Slot {
  id: string
  threadId: string
  brain: BrainType
  status: SlotStatus
  input: unknown | null
  output: unknown | null
  intent: Intent | null // Cortex only
  complexityHint: ComplexityHint | null // Cortex only, optional annotation
  executionSessionId: string | null // Brainstem only
  createdAt: Date
  updatedAt: Date
}

export interface UsageOutcomes {
  positive: number
  negative: number
  neutral: number
}

export interface MemoryEntry {
  id: string
  type: MemoryType
  content: string // Brain action description, NOT raw input text
  entityId: string | null
  segmentId: string | null // episodic only
  segmentSeq: number | null // episodic only
  tags: string[]
  baseImportance: number // 0.0–1.0
  usageOutcomes: UsageOutcomes
  sourceBrain: BrainType | null
  threadId: string | null // working memory only
  sessionId: string | null
  supersedesId: string | null
  tInvalid: Date | null // null = valid; non-null = soft-deleted
  lastAccessedAt: Date | null
  pinned: boolean
  forgotten: boolean
  expiresAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface PendingObservation {
  id: string
  targetBrain: BrainType
  note: string
  triggerAt: Date | null // null = route immediately
  expiresAt: Date // required TTL
  baseImportance: number
  addedAt: Date
}

// ─── Input Types ─────────────────────────────────────────────────────────────

export interface CreateThreadParams {
  trigger?: string
  initiatedBy: string
  sourceChannel?: string | null
}

export interface WriteSlotParams {
  status?: SlotStatus
  input?: unknown
  output?: unknown
  intent?: Intent | null
  complexityHint?: ComplexityHint | null
  executionSessionId?: string | null
}

export interface CreateMemoryParams {
  type: MemoryType
  content: string
  entityId?: string
  segmentId?: string
  segmentSeq?: number
  tags?: string[]
  baseImportance?: number
  sourceBrain?: BrainType
  threadId?: string
  sessionId?: string
  supersedesId?: string // triggers atomic invalidation of old record
  expiresAt?: Date
  pinned?: boolean
}

export interface MemorySearchFilters {
  type?: MemoryType
  tags?: string[] // AND match: entry must have ALL specified tags
  entityId?: string
  segmentId?: string
  excludeInvalid?: boolean // default true (filter WHERE t_invalid IS NULL)
  limit?: number // default 20
  createdAfter?: Date // filter WHERE created_at > createdAfter
}

export interface CreatePendingParams {
  targetBrain: BrainType
  note: string
  triggerAt?: Date | null
  expiresAt: Date
  baseImportance?: number
}

// ─── CognitiveWorkspace Interface ────────────────────────────────────────────

export interface ICognitiveWorkspace {
  // ── Thread ──────────────────────────────────────────────────────────────
  createThread(params: CreateThreadParams): Promise<Thread>
  getThread(id: string): Promise<Thread | null>
  updateThreadState(id: string, state: ThreadState): Promise<void>
  getActiveThreads(): Promise<Thread[]> // state NOT IN ('complete')

  // ── Slot ────────────────────────────────────────────────────────────────
  writeSlot(threadId: string, brain: BrainType, data: WriteSlotParams): Promise<Slot>
  readSlot(threadId: string, brain: BrainType): Promise<Slot | null>
  getSlotsByThread(threadId: string): Promise<Slot[]>

  // ── Pending Observations ────────────────────────────────────────────────
  writePending(params: CreatePendingParams): Promise<PendingObservation>
  getPendingObservations(): Promise<PendingObservation[]>
  removeExpiredPending(now: Date): Promise<void>
  removePending(id: string): Promise<void>

  // ── Memory ──────────────────────────────────────────────────────────────
  writeMemory(params: CreateMemoryParams): Promise<MemoryEntry>
  searchMemory(filters: MemorySearchFilters): Promise<MemoryEntry[]>
  markMemoryUsed(ids: string[], outcome: UsageOutcome): Promise<void>
  clearWorkingMemory(threadId: string): Promise<void>
  invalidateMemory(id: string): Promise<void>
  getEntityContext(
    entityId: string,
    opts?: { types?: MemoryType[]; limit?: number },
  ): Promise<MemoryEntry[]>
  findSimilarSituations(
    situation: string,
    opts?: { limit?: number },
  ): Promise<{ episodes: MemoryEntry[]; procedures: MemoryEntry[]; facts: MemoryEntry[] }>
  getProcedure(taskType: string, opts?: { limit?: number }): Promise<MemoryEntry[]>
}
