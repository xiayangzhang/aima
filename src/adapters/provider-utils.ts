import type {
  BrainModelConfig,
  CognitiveBrainType,
  ModelSpec,
  MultiProviderConfig,
} from '../types/index'

// ─── resolveBrainConfig ───────────────────────────────────────────────────────

/**
 * Resolve the BrainModelConfig for a specific brain.
 * Per-brain override takes precedence over default.
 */
export function resolveBrainConfig(
  config: MultiProviderConfig,
  brain: CognitiveBrainType,
): BrainModelConfig {
  return config.brains?.[brain] ?? config.default
}

// ─── buildAttemptList ─────────────────────────────────────────────────────────

/**
 * Build the ordered attempt list for a brain:
 * [primary, ...fallback] capped at effectiveMaxAttempts.
 */
export function buildAttemptList(brainConfig: BrainModelConfig): ModelSpec[] {
  const fallback = brainConfig.fallback ?? []
  const all: ModelSpec[] = [brainConfig.primary, ...fallback]
  const defaultMax = Math.min(2, all.length)
  const maxAttempts = brainConfig.maxAttempts ?? defaultMax
  return all.slice(0, maxAttempts)
}

// ─── validateMultiProviderConfig ──────────────────────────────────────────────

/**
 * Validate a MultiProviderConfig at construction time.
 * Throws a descriptive Error if invalid.
 */
export function validateMultiProviderConfig(config: MultiProviderConfig): void {
  validateBrainModelConfig(config.default, 'default')
  if (config.brains) {
    for (const [brain, brainConfig] of Object.entries(config.brains)) {
      if (brainConfig !== undefined) {
        validateBrainModelConfig(brainConfig, `brains.${brain}`)
      }
    }
  }
}

function validateBrainModelConfig(config: BrainModelConfig, path: string): void {
  validateModelSpec(config.primary, `${path}.primary`)
  const fallback = config.fallback ?? []
  for (let i = 0; i < fallback.length; i++) {
    const spec = fallback[i]
    if (spec !== undefined) {
      validateModelSpec(spec, `${path}.fallback[${i}]`)
    }
  }
  const totalProviders = 1 + fallback.length
  if (config.maxAttempts !== undefined) {
    if (config.maxAttempts < 1) {
      throw new Error(
        `[AIMA] Invalid provider config: ${path}.maxAttempts must be >= 1, got ${config.maxAttempts}`,
      )
    }
    if (config.maxAttempts > totalProviders) {
      throw new Error(
        `[AIMA] Invalid provider config: ${path}.maxAttempts (${config.maxAttempts}) exceeds available providers (${totalProviders})`,
      )
    }
  }
}

function validateModelSpec(spec: ModelSpec, path: string): void {
  if (!spec.model || spec.model.trim() === '') {
    throw new Error(`[AIMA] Invalid provider config: ${path}.model must be a non-empty string`)
  }
  if (!spec.provider.baseUrl || spec.provider.baseUrl.trim() === '') {
    throw new Error(
      `[AIMA] Invalid provider config: ${path}.provider.baseUrl must be a non-empty string`,
    )
  }
  if (!spec.provider.apiKey || spec.provider.apiKey.trim() === '') {
    throw new Error(
      `[AIMA] Invalid provider config: ${path}.provider.apiKey must be a non-empty string`,
    )
  }
}

// ─── classifyProviderError ────────────────────────────────────────────────────

/**
 * Classify an error thrown by query() into a fallback reason.
 * Returns null if the error is not a known retryable provider error.
 */
export function classifyProviderError(err: unknown): '429' | '5xx' | 'timeout' | null {
  const msg = err instanceof Error ? err.message : String(err)
  const lower = msg.toLowerCase()

  if (msg.includes('429')) return '429'

  // 5xx: check for explicit status codes 500-599 as whole words
  if (/\b5\d{2}\b/.test(msg)) return '5xx'

  // Connection / timeout errors
  if (
    lower.includes('etimedout') ||
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('timeout') ||
    lower.includes('timed out')
  ) {
    return 'timeout'
  }

  return null
}
