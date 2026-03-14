import OpenAI from 'openai'

export interface EmbeddingConfig {
  /** If not set, reads from process.env.OPENAI_API_KEY */
  apiKey?: string
  /** Default: 'text-embedding-3-small' */
  model?: string
  /** Default: 1536 (must match vector column dimensions) */
  dimensions?: number
}

/**
 * Generate an embedding vector (number[]) for the given text.
 * Uses OpenAI text-embedding-3-small, returns a 1536-dim float array.
 */
export async function generateEmbedding(
  text: string,
  config: EmbeddingConfig = {},
): Promise<number[]> {
  const client = new OpenAI({
    apiKey: config.apiKey ?? process.env.OPENAI_API_KEY,
  })
  const response = await client.embeddings.create({
    model: config.model ?? 'text-embedding-3-small',
    input: text,
    encoding_format: 'float',
  })
  const embedding = response.data[0]?.embedding
  if (!embedding) throw new Error('OpenAI embeddings API returned no data')
  return embedding
}
