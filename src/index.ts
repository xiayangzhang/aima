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

// ── Amygdala ──────────────────────────────────────────────────────────────────
export type {
  ToolRiskLevel,
  AmygdalaDecision,
  AmygdalaRule,
  AmygdalaConfig,
} from './amygdala/index'
export { Amygdala } from './amygdala/index'

// ── ThreadRunner ──────────────────────────────────────────────────────────────
export type { ThreadRunnerConfig } from './runner/index'
export { ThreadRunner } from './runner/index'

// ── Adapters ──────────────────────────────────────────────────────────────────
export type { PiCodingAgentAdapterConfig } from './adapters/pi-agent/index'
export { PiCodingAgentAdapter } from './adapters/pi-agent/index'
export type { ClaudeAgentSDKAdapterConfig } from './adapters/claude-sdk/index'
export { ClaudeAgentSDKAdapter } from './adapters/claude-sdk/index'

// ── MCP Server ────────────────────────────────────────────────────────────────
export { createAimaMcpServer } from './mcp/index'

// ── DMN ───────────────────────────────────────────────────────────────────────
export type { DmnConfig, DmnLlmConfig } from './dmn/index'
export { DmnService, createDmnService } from './dmn/index'

// ── AIMAInstance ──────────────────────────────────────────────────────────────
export type { AIMAInstanceConfig, AdapterType } from './instance'
export { AIMAInstance, createAIMAInstance } from './instance'
