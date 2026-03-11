import Anthropic from '@anthropic-ai/sdk'

export interface LlmConfig {
  /** If not set, reads from process.env.ANTHROPIC_API_KEY */
  apiKey?: string
  /** Default: 'claude-haiku-4-5-20251001' */
  model?: string
  /** Default: 1024 */
  maxTokens?: number
}

/**
 * One-shot LLM invocation, no conversation history, not within Thread/Slot system.
 * Shared utility for DMN and Hippocampus modules.
 */
export async function callLlm(
  prompt: string,
  config: LlmConfig,
  opts?: { maxTokens?: number },
): Promise<string> {
  const client = new Anthropic({ apiKey: config.apiKey ?? process.env.ANTHROPIC_API_KEY })
  const response = await client.messages.create({
    model: config.model ?? 'claude-haiku-4-5-20251001',
    max_tokens: opts?.maxTokens ?? config.maxTokens ?? 1024,
    messages: [{ role: 'user', content: prompt }],
  })
  const block = response.content[0]
  if (block?.type !== 'text') throw new Error('Unexpected LLM response type')
  return block.text
}

/**
 * Safe JSON parse of LLM output. Supports ```json ... ``` blocks and bare JSON.
 * Returns fallback on any parse error.
 */
export function parseLlmJson<T>(text: string, fallback: T): T {
  try {
    const match =
      text.match(/```json\s*([\s\S]*?)\s*```/) ?? text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/)
    if (!match?.[1] && !match?.[0]) return fallback
    return JSON.parse(match[1] ?? match[0]) as T
  } catch {
    return fallback
  }
}
