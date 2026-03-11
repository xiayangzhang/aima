import type { ToolDefinition } from '@mariozechner/pi-coding-agent'
import type { Amygdala } from '../../amygdala/index'
import type { BrainEventBus } from '../../eventbus/index'
import type { CognitiveBrainType } from '../../types/index'

// Stub: full implementation in WP02
export function createAimaExtension(
  _brain: CognitiveBrainType,
  _threadId: string,
  _amygdala: Amygdala,
  _eventBus: BrainEventBus,
  _registeredTools: ToolDefinition[],
): object {
  return { handlers: {} }
}
