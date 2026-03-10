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

// ── Brain Runtime ─────────────────────────────────────────────────────────────
export type {
  BrainAdapter,
  BrainRunParams,
  BrainRunResult,
  BrainSignal,
  BrainSignalType,
  BrainEvent,
  EventLevel,
} from './adapters/index'
export { BrainEventBus, getEventBus } from './eventbus/index'

// ── Context Assembler ─────────────────────────────────────────────────────────
export type {
  BrainIdentity,
  ContextAssemblerConfig,
  AssembledContext,
} from './context/index'
export { assembleBlock12, assembleBlock3, assembleBlock4, assembleContext } from './context/index'
