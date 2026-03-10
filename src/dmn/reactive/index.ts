import type { DmnConfig } from '../index'

export class DmnReactive {
  constructor(private config: DmnConfig) {}

  async start(): Promise<void> {}

  async stop(): Promise<void> {}
}
