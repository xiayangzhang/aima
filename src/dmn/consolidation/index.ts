import type { DmnConfig } from '../index'

export class DmnConsolidation {
  constructor(private config: DmnConfig) {}

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async runOnce(): Promise<void> {}
}
