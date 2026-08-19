import type { AIErrorCode, ModelStrategy } from './types.ts'

/**
 * Central AI configuration. Model names live HERE and nowhere else in
 * business logic: agents refer to a strategy, this module resolves it to a
 * provider + model pair. Retry and timeout policy is centralized here too;
 * individual components never invent their own.
 */

export interface ResolvedModel {
  provider: string
  model: string
}

/**
 * Strategy → provider/model mapping. Workers AI is the first provider; the
 * executor dispatches on `provider`, so adding another provider means one
 * new adapter plus entries here.
 */
const MODEL_STRATEGIES: Record<ModelStrategy, ResolvedModel> = {
  default: { provider: 'workers-ai', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' },
  fast: { provider: 'workers-ai', model: '@cf/meta/llama-3.1-8b-instruct-fast' },
  reasoning: { provider: 'workers-ai', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' },
  cheap: { provider: 'workers-ai', model: '@cf/meta/llama-3.1-8b-instruct-fast' },
  vision: { provider: 'workers-ai', model: '@cf/meta/llama-3.2-11b-vision-instruct' },
}

/** Optional env overrides (vars, not secrets): AI_MODEL_DEFAULT etc. */
export interface AIConfigOverrides {
  provider?: string
  models?: Partial<Record<ModelStrategy, string>>
}

export function resolveModel(
  strategy: ModelStrategy,
  overrides: AIConfigOverrides = {},
): ResolvedModel {
  const base = MODEL_STRATEGIES[strategy]
  if (!base) {
    throw new AIConfigError(`Unknown model strategy: ${strategy}`)
  }
  const model = overrides.models?.[strategy] ?? base.model
  const provider = overrides.provider ?? base.provider
  if (!model || !provider) {
    throw new AIConfigError(`Model strategy '${strategy}' resolved to an empty provider/model.`)
  }
  return { provider, model }
}

export class AIConfigError extends Error {
  readonly code: AIErrorCode = 'invalid_model_config'
  constructor(message: string) {
    super(message)
    this.name = 'AIConfigError'
  }
}

/** Central timeout policy (ms). One attempt may not exceed this. */
export const AI_TIMEOUTS = {
  default: 30_000,
} as const

/**
 * Central retry policy. Generation is expensive and duplicates are worse
 * than failures, so: at most ONE extra attempt, only for clearly retryable
 * codes, with a short fixed backoff. Non-retryable failures return at once.
 */
export const AI_RETRY = {
  maxAttempts: 2,
  backoffMs: 750,
  retryableCodes: ['provider_unavailable', 'rate_limited', 'network'] as AIErrorCode[],
} as const

export function isRetryable(code: AIErrorCode): boolean {
  return (AI_RETRY.retryableCodes as string[]).includes(code)
}

/** Generation defaults applied when an agent config does not specify. */
export const AI_GENERATION_DEFAULTS = {
  maxTokens: 1024,
  temperature: 0.4,
} as const
