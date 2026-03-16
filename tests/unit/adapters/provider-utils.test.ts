import { describe, expect, it } from 'bun:test'
import {
  buildAttemptList,
  classifyProviderError,
  resolveBrainConfig,
  validateMultiProviderConfig,
} from '../../../src/adapters/provider-utils'
import type { BrainModelConfig, MultiProviderConfig } from '../../../src/types/index'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const mockProvider = { baseUrl: 'https://api.anthropic.com', apiKey: 'sk-test' }
const mockSpec = { model: 'claude-sonnet-4-6', provider: mockProvider }
const mockBrainConfig: BrainModelConfig = { primary: mockSpec }
const baseConfig: MultiProviderConfig = { default: mockBrainConfig }

// ── resolveBrainConfig ───────────────────────────────────────────────────────

describe('resolveBrainConfig', () => {
  it('returns default when no brains override', () => {
    expect(resolveBrainConfig(baseConfig, 'limbic')).toBe(mockBrainConfig)
  })

  it('returns default when brains field is absent', () => {
    const config: MultiProviderConfig = { default: mockBrainConfig }
    expect(resolveBrainConfig(config, 'cortex')).toBe(mockBrainConfig)
    expect(resolveBrainConfig(config, 'brainstem')).toBe(mockBrainConfig)
  })

  it('returns per-brain override when present', () => {
    const cortexConfig: BrainModelConfig = {
      primary: { model: 'claude-opus-4-6', provider: mockProvider },
    }
    const config: MultiProviderConfig = {
      default: mockBrainConfig,
      brains: { cortex: cortexConfig },
    }
    expect(resolveBrainConfig(config, 'cortex')).toBe(cortexConfig)
  })

  it('returns default for brains not in overrides', () => {
    const config: MultiProviderConfig = {
      default: mockBrainConfig,
      brains: { cortex: { primary: { model: 'claude-opus-4-6', provider: mockProvider } } },
    }
    expect(resolveBrainConfig(config, 'limbic')).toBe(mockBrainConfig)
    expect(resolveBrainConfig(config, 'brainstem')).toBe(mockBrainConfig)
  })
})

// ── buildAttemptList ─────────────────────────────────────────────────────────

describe('buildAttemptList', () => {
  it('returns [primary] when no fallback (default max = min(2,1) = 1)', () => {
    const list = buildAttemptList({ primary: mockSpec })
    expect(list).toEqual([mockSpec])
    expect(list).toHaveLength(1)
  })

  it('returns [primary, fallback] with one fallback (default max = min(2,2) = 2)', () => {
    const fallback = { model: 'claude-haiku-4-5-20251001', provider: mockProvider }
    const list = buildAttemptList({ primary: mockSpec, fallback: [fallback] })
    expect(list).toEqual([mockSpec, fallback])
  })

  it('caps at min(2,total) when multiple fallbacks and no maxAttempts', () => {
    const f1 = { model: 'model-b', provider: mockProvider }
    const f2 = { model: 'model-c', provider: mockProvider }
    const list = buildAttemptList({ primary: mockSpec, fallback: [f1, f2] })
    expect(list).toEqual([mockSpec, f1]) // capped at 2, not 3
  })

  it('respects explicit maxAttempts=1 even with fallback', () => {
    const fallback = { model: 'model-b', provider: mockProvider }
    const list = buildAttemptList({ primary: mockSpec, fallback: [fallback], maxAttempts: 1 })
    expect(list).toEqual([mockSpec])
  })

  it('respects explicit maxAttempts=3 with 2 fallbacks', () => {
    const f1 = { model: 'model-b', provider: mockProvider }
    const f2 = { model: 'model-c', provider: mockProvider }
    const list = buildAttemptList({ primary: mockSpec, fallback: [f1, f2], maxAttempts: 3 })
    expect(list).toEqual([mockSpec, f1, f2])
  })

  it('returns only [primary] when maxAttempts=2 and no fallback (min(2,1)=1)', () => {
    // Even if maxAttempts=2, only 1 provider exists, slice(0,2) of [primary] = [primary]
    // Actually: default = min(2, 1) = 1 when maxAttempts undefined
    // With explicit maxAttempts=2 and 1 provider → all.slice(0,2) = [primary]
    const list = buildAttemptList({ primary: mockSpec, maxAttempts: 2 })
    expect(list).toEqual([mockSpec])
  })
})

// ── validateMultiProviderConfig ──────────────────────────────────────────────

describe('validateMultiProviderConfig', () => {
  it('accepts valid single-provider config', () => {
    expect(() => validateMultiProviderConfig(baseConfig)).not.toThrow()
  })

  it('accepts valid config with per-brain override and fallback', () => {
    const config: MultiProviderConfig = {
      default: mockBrainConfig,
      brains: {
        cortex: {
          primary: { model: 'claude-opus-4-6', provider: mockProvider },
          fallback: [mockSpec],
          maxAttempts: 2,
        },
      },
    }
    expect(() => validateMultiProviderConfig(config)).not.toThrow()
  })

  it('accepts config with multiple brains overriding', () => {
    const config: MultiProviderConfig = {
      default: mockBrainConfig,
      brains: {
        limbic: { primary: { model: 'claude-haiku-4-5-20251001', provider: mockProvider } },
        cortex: { primary: { model: 'claude-opus-4-6', provider: mockProvider } },
      },
    }
    expect(() => validateMultiProviderConfig(config)).not.toThrow()
  })

  it('throws on empty model string in default.primary', () => {
    const config: MultiProviderConfig = {
      default: { primary: { model: '', provider: mockProvider } },
    }
    expect(() => validateMultiProviderConfig(config)).toThrow(/default\.primary\.model/)
  })

  it('throws on whitespace-only model string', () => {
    const config: MultiProviderConfig = {
      default: { primary: { model: '   ', provider: mockProvider } },
    }
    expect(() => validateMultiProviderConfig(config)).toThrow(/default\.primary\.model/)
  })

  it('throws on empty baseUrl in default.primary.provider', () => {
    const config: MultiProviderConfig = {
      default: {
        primary: { model: 'claude-sonnet-4-6', provider: { baseUrl: '', apiKey: 'sk-test' } },
      },
    }
    expect(() => validateMultiProviderConfig(config)).toThrow(/default\.primary\.provider\.baseUrl/)
  })

  it('throws on empty apiKey in default.primary.provider', () => {
    const config: MultiProviderConfig = {
      default: {
        primary: {
          model: 'claude-sonnet-4-6',
          provider: { baseUrl: 'https://api.anthropic.com', apiKey: '' },
        },
      },
    }
    expect(() => validateMultiProviderConfig(config)).toThrow(/default\.primary\.provider\.apiKey/)
  })

  it('throws on empty model in brains.cortex.primary', () => {
    const config: MultiProviderConfig = {
      default: mockBrainConfig,
      brains: {
        cortex: { primary: { model: '', provider: mockProvider } },
      },
    }
    expect(() => validateMultiProviderConfig(config)).toThrow(/brains\.cortex\.primary\.model/)
  })

  it('throws on empty apiKey in brains.cortex.primary.provider', () => {
    const config: MultiProviderConfig = {
      default: mockBrainConfig,
      brains: {
        cortex: {
          primary: {
            model: 'claude-opus-4-6',
            provider: { baseUrl: 'https://api.anthropic.com', apiKey: '' },
          },
        },
      },
    }
    expect(() => validateMultiProviderConfig(config)).toThrow(
      /brains\.cortex\.primary\.provider\.apiKey/,
    )
  })

  it('throws on empty model in fallback[0]', () => {
    const config: MultiProviderConfig = {
      default: {
        primary: mockSpec,
        fallback: [{ model: '', provider: mockProvider }],
      },
    }
    expect(() => validateMultiProviderConfig(config)).toThrow(/default\.fallback\[0\]\.model/)
  })

  it('throws when maxAttempts < 1', () => {
    const config: MultiProviderConfig = {
      default: { primary: mockSpec, maxAttempts: 0 },
    }
    expect(() => validateMultiProviderConfig(config)).toThrow(/maxAttempts/)
  })

  it('throws when maxAttempts exceeds available providers', () => {
    const config: MultiProviderConfig = {
      default: { primary: mockSpec, fallback: [mockSpec], maxAttempts: 5 },
    }
    expect(() => validateMultiProviderConfig(config)).toThrow(/maxAttempts/)
  })

  it('error messages start with [AIMA] prefix', () => {
    const config: MultiProviderConfig = {
      default: { primary: { model: '', provider: mockProvider } },
    }
    expect(() => validateMultiProviderConfig(config)).toThrow(/^\[AIMA\]/)
  })
})

// ── classifyProviderError ────────────────────────────────────────────────────

describe('classifyProviderError', () => {
  it('returns 429 for rate limit errors', () => {
    expect(classifyProviderError(new Error('HTTP 429 Too Many Requests'))).toBe('429')
  })

  it('returns 429 when 429 appears anywhere in message', () => {
    expect(classifyProviderError(new Error('Error: rate limit exceeded (429)'))).toBe('429')
  })

  it('returns 5xx for 500 error', () => {
    expect(classifyProviderError(new Error('500 Internal Server Error'))).toBe('5xx')
  })

  it('returns 5xx for 503 error', () => {
    expect(classifyProviderError(new Error('503 Service Unavailable'))).toBe('5xx')
  })

  it('returns 5xx for 502 error', () => {
    expect(classifyProviderError(new Error('502 Bad Gateway'))).toBe('5xx')
  })

  it('does not return 5xx for 5000 (not a 5xx code)', () => {
    // port 5000 or status 5000 should not match
    const result = classifyProviderError(new Error('Connection refused at port 5000'))
    expect(result).not.toBe('5xx')
  })

  it('returns timeout for ETIMEDOUT', () => {
    expect(classifyProviderError(new Error('connect ETIMEDOUT 1.2.3.4:443'))).toBe('timeout')
  })

  it('returns timeout for ECONNREFUSED', () => {
    expect(classifyProviderError(new Error('connect ECONNREFUSED 127.0.0.1:1'))).toBe('timeout')
  })

  it('returns timeout for ECONNRESET', () => {
    expect(classifyProviderError(new Error('ECONNRESET socket hang up'))).toBe('timeout')
  })

  it('returns timeout for "timeout" in message', () => {
    expect(classifyProviderError(new Error('Request timeout exceeded'))).toBe('timeout')
  })

  it('returns timeout for "timed out" in message', () => {
    expect(classifyProviderError(new Error('Connection timed out after 30s'))).toBe('timeout')
  })

  it('returns null for auth error (not retryable)', () => {
    expect(classifyProviderError(new Error('Invalid API key provided'))).toBeNull()
  })

  it('returns null for model not found', () => {
    expect(classifyProviderError(new Error('Model not found: claude-fake-model'))).toBeNull()
  })

  it('returns null for generic error', () => {
    expect(classifyProviderError(new Error('Something went wrong'))).toBeNull()
  })

  it('returns null for non-Error string throws', () => {
    expect(classifyProviderError('something went wrong')).toBeNull()
  })

  it('returns null for null thrown', () => {
    expect(classifyProviderError(null)).toBeNull()
  })

  it('returns null for undefined thrown', () => {
    expect(classifyProviderError(undefined)).toBeNull()
  })

  it('handles numeric throws gracefully', () => {
    expect(classifyProviderError(404)).toBeNull()
  })
})
