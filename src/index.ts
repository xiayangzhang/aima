// @aima/core — Public API

// ── CognitiveWorkspace ────────────────────────────────────────────────────────
export { CognitiveWorkspace } from './workspace/index'
export type { DrizzleDB } from './workspace/index'

// ── Types ─────────────────────────────────────────────────────────────────────
export type {
  // Primitive types
  BrainType,
  CognitiveBrainType,
  ThreadState,
  SlotStatus,
  Intent,
  ComplexityHint,
  MemoryType,
  UsageOutcome,
  // Entity types
  Thread,
  Slot,
  MemoryEntry,
  PendingObservation,
  UsageOutcomes,
  // Input types
  CreateThreadParams,
  WriteSlotParams,
  CreateMemoryParams,
  MemorySearchFilters,
  CreatePendingParams,
  // Interface
  ICognitiveWorkspace,
} from './types/index'
