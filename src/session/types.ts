import type { BrainIdentity } from '../context/index'
import type { EmbeddingConfig } from '../embedding'
import type { LlmConfig } from '../llm'
import type { CognitiveBrainType, Slot, ThreadState } from '../types/index'

// ─── Factory Options ──────────────────────────────────────────────────────────

export interface CreateAIMASessionOptions {
  /** Required. PostgreSQL connection string. */
  databaseUrl: string

  /** Optional. Path to identity directory (soul.md / {brain}.md files). */
  identityDir?: string

  /** Optional. Programmatic identity overrides per brain. */
  identities?: Partial<Record<CognitiveBrainType, BrainIdentity>>

  /** Optional. Anthropic API key. Falls back to ANTHROPIC_API_KEY env var. */
  apiKey?: string

  /** Optional. Which adapter to use. Defaults to 'pi-coding-agent'. */
  adapter?: 'pi-agent' | 'pi-coding-agent' | 'claude-sdk'

  /** Optional. Per-brain model overrides. */
  brainModels?: {
    limbic?: string
    cortex?: string
    brainstem?: string
  }

  /** Optional. Model for sub-execution sessions. Defaults to 'claude-sonnet-4-6'. */
  executionModel?: string

  /** Optional. Enable Default Mode Network. Defaults to false. */
  enableDmn?: boolean

  /** Optional. Enable Hippocampus Consolidation. Defaults to false. */
  enableHippocampus?: boolean

  /** Optional. Static skill index text injected into Block 1/2. */
  skillIndex?: string

  /** Optional. Timezone string (e.g. 'Asia/Shanghai'). Defaults to 'UTC'. */
  timezone?: string

  /** Optional. Amygdala configuration. */
  amygdala?: {
    llm?: LlmConfig
    riskLevels?: Record<string, 'low' | 'medium' | 'high'>
    haiku_enabled?: boolean
  }

  /** Optional. Embedding config for pgvector semantic memory search. */
  embedding?: EmbeddingConfig
}

// ─── Prompt Result ────────────────────────────────────────────────────────────

export interface PromptResult {
  threadId: string
  /** The reply text from the thread.reply event, or null if no reply was emitted. */
  reply: string | null
  /** Final thread state after processing completes. */
  finalState: 'complete' | 'interrupted'
  /** Slot snapshot at completion time. */
  slots: Slot[]
}

// ─── Session Events ───────────────────────────────────────────────────────────

export type AIMASessionEvent =
  // Mirrors pi-coding-agent core events
  | { type: 'thread_start'; threadId: string }
  | { type: 'thread_end'; threadId: string; state: ThreadState }
  | { type: 'brain_start'; brain: CognitiveBrainType; threadId: string }
  | { type: 'brain_end'; brain: CognitiveBrainType; threadId: string }
  | { type: 'reply'; threadId: string; content: string }
  | { type: 'tool_start'; brain: CognitiveBrainType; toolName: string; args: unknown }
  | {
      type: 'tool_end'
      brain: CognitiveBrainType
      toolName: string
      result: unknown
      isError: boolean
    }
  // AIMA-specific
  | { type: 'route'; from: CognitiveBrainType; to: CognitiveBrainType | null; threadId: string }
  | { type: 'error'; error: Error; threadId?: string }

export type AIMASessionEventListener = (event: AIMASessionEvent) => void
