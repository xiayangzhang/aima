import type { BrainAdapter, BrainRunParams, BrainRunResult } from '../../../src/adapters/index'
import type { BrainType, SlotStatus } from '../../../src/types/index'
import type { CognitiveWorkspace } from '../../../src/workspace/index'

export interface MockSlotOutput {
  status: SlotStatus
  output: Record<string, unknown>
}

/**
 * MockBrainAdapter for integration tests.
 *
 * On each run(), writes a Slot to the real workspace DB so that ThreadRunner's
 * routing logic (which reads slots via getSlotsByThread) sees the expected output.
 */
export class MockBrainAdapter implements BrainAdapter {
  private callCount = 0

  constructor(
    private readonly workspace: CognitiveWorkspace,
    private readonly slotOutputFn: (params: BrainRunParams, callCount: number) => MockSlotOutput,
  ) {}

  async run(params: BrainRunParams): Promise<BrainRunResult> {
    this.callCount++
    const { brain, threadId } = params
    const { status, output } = this.slotOutputFn(params, this.callCount)

    await this.workspace.writeSlot(threadId, brain as BrainType, { status, output })

    return {
      sessionId: `mock:${brain}:${threadId}:${this.callCount}`,
      output,
      stopReason: status === 'done' ? 'done' : 'error',
      injectedMemoryIds: [],
    }
  }

  async inject(): Promise<void> {}

  abort(): void {}
}
