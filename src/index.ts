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
  MemoryType,
  UsageOutcome,
  // Brain output
  BrainOutput,
  // Token tracking
  BrainTokenUsage,
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
  // Provider config
  ProviderEndpoint,
  ModelSpec,
  BrainModelConfig,
  MultiProviderConfig,
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
  AssembleBlock4Opts,
  AssembledContext,
  BrainIdentity,
  ContextAssemblerConfig,
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
export type { PiAgentAdapterConfig } from './adapters/pi-agent/index'
export { PiAgentAdapter } from './adapters/pi-agent/index'
export type { PiCodingAgentAdapterConfig } from './adapters/pi-coding-agent/index'
export { PiCodingAgentAdapter } from './adapters/pi-coding-agent/index'
export type { ClaudeAgentSDKAdapterConfig } from './adapters/claude-sdk/index'
export { ClaudeAgentSDKAdapter } from './adapters/claude-sdk/index'

// ── MCP Server ────────────────────────────────────────────────────────────────
export { createAimaMcpServer } from './mcp/index'
export type { SpawnExecutionSessionFn } from './mcp/index'

// ── DMN ───────────────────────────────────────────────────────────────────────
export type { DmnConfig, DmnLlmConfig } from './dmn/index'
export { DmnService, createDmnService } from './dmn/index'

// ── Hippocampus ───────────────────────────────────────────────────────────────
export { HippocampusConsolidation, computeNewImportance } from './hippocampus/index'
export type { HippocampusConfig } from './hippocampus/index'

// ── LLM ───────────────────────────────────────────────────────────────────────
export type { LlmConfig } from './llm'

// ── Identity ──────────────────────────────────────────────────────────────────
export { IdentityLoader } from './identity/index'
export type { IdentityCache, RoleEntry } from './identity/index'

// ── AIMAInstance ──────────────────────────────────────────────────────────────
export type { AIMAInstanceConfig, AdapterType } from './instance'
export { AIMAInstance, createAIMAInstance } from './instance'

// ── Session (pi-coding-agent compatible API) ──────────────────────────────────
export type {
  CreateAIMASessionOptions,
  PromptResult,
  AIMASessionEvent,
  AIMASessionEventListener,
} from './session/index'
export { AIMASession, createAIMASession } from './session/index'
