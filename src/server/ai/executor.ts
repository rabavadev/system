import {
  AI_GENERATION_DEFAULTS,
  AI_RETRY,
  AI_TIMEOUTS,
  AIConfigError,
  isRetryable,
  resolveModel,
} from './config.ts'
import type {
  AIAdapterRawResponse,
  AIErrorCode,
  AIExecutionRequest,
  AIExecutionResult,
  AIProviderAdapter,
} from './types.ts'
import { AIAdapterError } from './types.ts'

/**
 * The ONE AI execution boundary. Everything in the application that needs
 * a model calls `executeAI`; nothing else imports provider SDKs or
 * bindings. The executor owns: execution-type dispatch, model resolution,
 * timeouts, the centralized retry policy, latency/usage normalization, and
 * error containment (provider exceptions never escape raw).
 *
 * Adapters are injected (see runtime.ts for the production wiring), which
 * keeps this module free of `cloudflare:workers` and testable in node.
 */

export interface ExecuteAIDeps {
  /** Adapter registry keyed by provider name (e.g. 'workers-ai'). */
  adapters: ReadonlyMap<string, AIProviderAdapter>
  /** Optional model overrides from environment vars. */
  modelOverrides?: { provider?: string; models?: Partial<Record<string, string>> }
  /** Overrides the per-attempt timeout (ops tuning / tests). */
  timeoutMs?: number
  /** Injectable clock/sleep for tests. */
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function failure(
  request: AIExecutionRequest,
  startedAt: number,
  attempts: number,
  code: AIErrorCode,
  message: string,
  retryable: boolean,
  provider: string | null,
  model: string | null,
): AIExecutionResult {
  return {
    executionId: request.executionId,
    status: 'failed',
    content: null,
    finishReason: null,
    provider,
    model,
    usage: null,
    latencyMs: Math.max(0, Date.now() - startedAt),
    attempts,
    error: { code, message: message.slice(0, 500), retryable },
  }
}

/**
 * Execute one provider-neutral request. Never throws for provider/config
 * problems: callers get a typed `failed` result. (Programming errors in our
 * own code may still throw; provider misbehavior may not.)
 */
export async function executeAI(
  request: AIExecutionRequest,
  deps: ExecuteAIDeps,
): Promise<AIExecutionResult> {
  const startedAt = Date.now()

  // STEP 6 implements direct_model only. external_agent and router are
  // declared execution types with a controlled result, not a fake.
  if (request.agent.executionType !== 'direct_model') {
    return failure(
      request,
      startedAt,
      0,
      'unsupported_execution_type',
      `Execution type '${request.agent.executionType}' is not implemented yet.`,
      false,
      null,
      null,
    )
  }

  let provider: string
  let model: string
  try {
    const resolved = resolveModel(
      request.model.strategy,
      deps.modelOverrides
        ? {
            ...(deps.modelOverrides.provider ? { provider: deps.modelOverrides.provider } : {}),
            ...(deps.modelOverrides.models ? { models: deps.modelOverrides.models } : {}),
          }
        : {},
    )
    provider = resolved.provider
    model = resolved.model
  } catch (error) {
    const message = error instanceof AIConfigError ? error.message : 'Invalid model configuration.'
    return failure(request, startedAt, 0, 'invalid_model_config', message, false, null, null)
  }

  const adapter = deps.adapters.get(provider)
  if (!adapter) {
    return failure(
      request,
      startedAt,
      0,
      'not_configured',
      `No adapter is configured for provider '${provider}'.`,
      false,
      provider,
      model,
    )
  }

  const sleep = deps.sleep ?? defaultSleep
  const timeoutMs = deps.timeoutMs ?? request.timeoutMs ?? AI_TIMEOUTS.default
  let attempts = 0
  let lastError: { code: AIErrorCode; message: string; retryable: boolean } | null = null

  while (attempts < AI_RETRY.maxAttempts) {
    attempts += 1
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // Race the adapter against a hard timeout: even a provider call that
      // ignores the abort signal can never hang the worker indefinitely.
      const raw: AIAdapterRawResponse = await Promise.race([
        adapter.execute({
          model,
          messages: request.messages,
          ...(request.tools ? { tools: request.tools } : {}),
          generation: {
            maxTokens: request.generation.maxTokens || AI_GENERATION_DEFAULTS.maxTokens,
            temperature: request.generation.temperature ?? AI_GENERATION_DEFAULTS.temperature,
          },
          signal: controller.signal,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(new AIAdapterError('timeout', 'The model did not respond in time.', false))
          }, timeoutMs)
        }),
      ])
      const content = typeof raw.content === 'string' ? raw.content.trim() : null
      const toolCalls =
        Array.isArray(raw.toolCalls) && raw.toolCalls.length > 0 ? raw.toolCalls : undefined
      if (!content && !toolCalls) {
        throw new AIAdapterError('malformed_response', 'The provider returned empty content.', true)
      }
      return {
        executionId: request.executionId,
        status: 'succeeded',
        content,
        ...(toolCalls ? { toolCalls } : {}),
        finishReason: raw.finishReason ?? null,
        provider: adapter.key,
        model,
        usage: raw.usage ?? null,
        latencyMs: Math.max(0, Date.now() - startedAt),
        attempts,
        error: null,
      }
    } catch (error) {
      lastError = normalizeAdapterError(error, controller.signal.aborted)
      if (
        !lastError.retryable ||
        !isRetryable(lastError.code) ||
        attempts >= AI_RETRY.maxAttempts
      ) {
        break
      }
      await sleep(AI_RETRY.backoffMs)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  const err = lastError ?? {
    code: 'unknown' as AIErrorCode,
    message: 'Unknown AI failure.',
    retryable: false,
  }
  return failure(
    request,
    startedAt,
    attempts,
    err.code,
    err.message,
    err.retryable,
    provider,
    model,
  )
}

/** Map anything an adapter threw into a typed, secret-free error. */
function normalizeAdapterError(
  error: unknown,
  aborted: boolean,
): { code: AIErrorCode; message: string; retryable: boolean } {
  if (aborted) {
    return { code: 'timeout', message: 'The model did not respond in time.', retryable: false }
  }
  if (error instanceof AIAdapterError) {
    return { code: error.code, message: error.message, retryable: error.retryable }
  }
  const message = error instanceof Error ? error.message : String(error)
  // Never surface raw SDK internals verbatim beyond a bounded snippet.
  return {
    code: 'unknown',
    message: `Unexpected provider error: ${message.slice(0, 200)}`,
    retryable: false,
  }
}
