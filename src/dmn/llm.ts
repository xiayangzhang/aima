import Anthropic from '@anthropic-ai/sdk'
import type { DmnLlmConfig } from './index'

/**
 * 一次性 LLM 调用，无对话历史，不走 BrainAdapter，不在 Thread/Slot 体系内。
 * DMN 所有 LLM 判断均通过此函数发起。
 */
export async function callLlm(
  prompt: string,
  config: DmnLlmConfig,
  opts: { useComplexModel?: boolean; maxTokens?: number } = {},
): Promise<string> {
  const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('DMN: No API key configured')

  const model = opts.useComplexModel
    ? (config.complexModel ?? 'claude-sonnet-4-6')
    : (config.model ?? 'claude-haiku-4-5-20251001')

  const maxTokens = opts.maxTokens ?? config.maxTokens ?? 512

  const anthropic = new Anthropic({ apiKey })
  const msg = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  })

  for (const block of msg.content) {
    if (block.type === 'text') return block.text
  }
  return ''
}

/**
 * 解析 LLM 返回的 JSON，失败时返回 fallback 值。
 */
export function parseLlmJson<T>(text: string, fallback: T): T {
  try {
    // 提取 markdown code block 内的 JSON（如有）
    const match = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/)
    const raw = match?.[1] ?? text.trim()
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}
