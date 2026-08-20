import { AIAdapterError, type AIProviderAdapter, type AIToolCall } from '../types.ts'

/**
 * Workers AI adapter — the first direct-model provider.
 *
 * This is the ONLY module that knows the `Ai` binding shape. It accepts a
 * structural `WorkersAiLike` instead of importing `cloudflare:workers`, so
 * the adapter runs in plain node tests with a stub.
 *
 * When `gatewayId` is set, requests route through Cloudflare AI Gateway
 * (observability, caching, future routing/fallbacks) via the binding
 * option `{ gateway: { id } }` — no credentials in code or in D1.
 *
 * Adding the next provider: implement `AIProviderAdapter` in a sibling
 * file, register it in runtime.ts, add strategy entries in config.ts.
 * Nothing outside src/server/ai changes.
 */

/** The slice of the Workers AI binding this adapter uses. */
export interface WorkersAiLike {
  run(
    model: string,
    input: {
      messages: { role: string; content: string }[]
      tools?: unknown
      max_tokens?: number
      temperature?: number
    },
    options?: { gateway?: { id: string } },
  ): Promise<unknown>
}

interface WorkersAiTextResponse {
  response?: unknown
  tool_calls?: unknown
  usage?: {
    prompt_tokens?: unknown
    completion_tokens?: unknown
    total_tokens?: unknown
  }
}

function asTokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function isRateLimited(message: string): boolean {
  return /rate.?limit|429|too many requests/i.test(message)
}

function isUnavailable(message: string): boolean {
  return /unavailable|503|502|500|overloaded|internal/i.test(message)
}

function parseWorkersAiToolCalls(raw: unknown): AIToolCall[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const calls: AIToolCall[] = []
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i]
    if (typeof item !== 'object' || item === null) continue
    const name = Reflect.get(item, 'name') || Reflect.get(item, 'tool')
    let args = Reflect.get(item, 'arguments') || Reflect.get(item, 'args') || {}
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args)
      } catch {
        args = {}
      }
    }
    if (typeof name === 'string' && typeof args === 'object' && args !== null) {
      calls.push({
        id: `call-${i + 1}`,
        toolKey: name,
        args: args as Record<string, unknown>,
      })
    }
  }
  return calls.length > 0 ? calls : undefined
}

export function createWorkersAiAdapter(ai: WorkersAiLike, gatewayId?: string): AIProviderAdapter {
  return {
    key: 'workers-ai',
    async execute({ model, messages, tools, generation, signal }) {
      if (signal.aborted) {
        throw new AIAdapterError('timeout', 'The model did not respond in time.', false)
      }
      let raw: unknown
      try {
        // Workers AI has no per-call AbortSignal; the executor's timeout
        // still bounds the awaited promise and discards late results.
        raw = await ai.run(
          model,
          {
            messages: messages.map((m) => ({ role: m.role, content: m.content })),
            ...(tools && tools.length > 0
              ? {
                  tools: tools.map((t) => ({
                    type: 'function',
                    function: {
                      name: t.key,
                      description: t.description,
                      parameters: t.inputSchema ?? {},
                    },
                  })),
                }
              : {}),
            max_tokens: generation.maxTokens,
            temperature: generation.temperature,
          },
          gatewayId ? { gateway: { id: gatewayId } } : undefined,
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (isRateLimited(message)) {
          throw new AIAdapterError(
            'rate_limited',
            'The model provider rate-limited the request.',
            true,
          )
        }
        if (isUnavailable(message)) {
          throw new AIAdapterError(
            'provider_unavailable',
            'The model provider is unavailable.',
            true,
          )
        }
        if (/not.?found|unknown model|invalid model/i.test(message)) {
          throw new AIAdapterError(
            'invalid_model_config',
            `Model '${model}' is not available.`,
            false,
          )
        }
        throw new AIAdapterError(
          'network',
          `Provider request failed: ${message.slice(0, 160)}`,
          true,
        )
      }

      if (signal.aborted) {
        throw new AIAdapterError('timeout', 'The model did not respond in time.', false)
      }

      const body = raw as WorkersAiTextResponse | undefined
      const parsedToolCalls = parseWorkersAiToolCalls(body?.tool_calls)
      const content = typeof body?.response === 'string' ? body.response : null

      if (!content && !parsedToolCalls) {
        throw new AIAdapterError(
          'malformed_response',
          'The provider returned an unexpected shape.',
          true,
        )
      }

      return {
        content,
        ...(parsedToolCalls ? { toolCalls: parsedToolCalls } : {}),
        finishReason: parsedToolCalls ? 'tool_calls' : 'stop',
        usage: body?.usage
          ? {
              inputTokens: asTokenCount(body.usage.prompt_tokens),
              outputTokens: asTokenCount(body.usage.completion_tokens),
              totalTokens: asTokenCount(body.usage.total_tokens),
            }
          : null,
      }
    },
  }
}
