import type { BrainType, CognitiveBrainType } from '../types/index'

// ─── Brain Signals ────────────────────────────────────────────────────────────

export type BrainSignalType = 'amygdala_interrupt' | 'dmn_correction'

export interface BrainSignal {
  type: BrainSignalType
  message: string
  causationId?: string
}

// ─── BrainAdapter Run Params / Result ────────────────────────────────────────

export interface BrainRunParams {
  brain: CognitiveBrainType
  threadId: string
  systemPrompt: string // Context Assembly result (Blocks 1-4)
  initialPrompt?: string // trigger content; omit to resume current session
}

export interface BrainRunResult {
  sessionId: string
  output: Record<string, unknown> // structured result written to Slot
  stopReason: 'done' | 'interrupted' | 'error'
  injectedMemoryIds: string[] // Block 4 injected memory IDs, for DMN use
}

// ─── BrainAdapter Interface ───────────────────────────────────────────────────

// Aligns with pi-coding-agent Agent interface; AIMA adds inject/abort
export interface BrainAdapter {
  // Start or resume brain loop; blocks until complete
  run(params: BrainRunParams): Promise<BrainRunResult>
  // Inject a signal into a running loop (Amygdala interrupt / DMN correction)
  inject(signal: BrainSignal): Promise<void>
  // Abort the current loop (cooperative cancellation)
  abort(): void
}

// ─── BrainEvent Types ─────────────────────────────────────────────────────────

export type EventLevel = 'TRACE' | 'DEBUG' | 'INFO' | 'COMPLIANCE' | 'ALERT'

export interface BrainEvent {
  event_id: string // UUID, auto-generated
  event_type: string // e.g. 'tool.pre_use', 'brain.complete', 'memory.write'
  level: EventLevel
  occurred_at: Date
  brain: BrainType
  thread_id: string | null
  session_id: string | null
  causation_id: string | null // null = causation chain origin
  schema_version: string // framework-injected, currently '1.0'
  payload: Record<string, unknown>
}
