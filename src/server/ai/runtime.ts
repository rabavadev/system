import { env } from 'cloudflare:workers'

import type { ExecuteAIDeps } from './executor.ts'
import { createEchoAdapter } from './providers/echo.ts'
import { createWorkersAiAdapter, type WorkersAiLike } from './providers/workers-ai.ts'
import type { AIProviderAdapter, ModelStrategy } from './types.ts'

/**
 * Production wiring for the AI boundary. This is the ONLY module here that
 * reads the Worker environment; executor/composer/agents stay env-free and
 * testable. Server-only — never import from client code.
 *
 * Environment contract (documented in docs/ai-execution.md):
 *   binding AI            Workers AI binding (wrangler.jsonc)
 *   var AI_PROVIDER       'workers-ai' (default) | 'echo' (local dev only)
 *   var AI_GATEWAY_ID     optional AI Gateway id; routes Workers AI through
 *                         the gateway (observability/caching/future routing)
 *   var AI_MODEL_DEFAULT  optional model override for the 'default' strategy
 *
 * No API keys are required for Workers AI (binding-based). Nothing secret
 * is read here, so nothing secret can leak downstream.
 */

interface AiEnvShape {
  AI?: WorkersAiLike
  AI_PROVIDER?: string
  AI_GATEWAY_ID?: string
  AI_MODEL_DEFAULT?: string
}

export function resolveAiRuntime(): {
  deps: ExecuteAIDeps
  status: { configured: boolean; provider: string; detail: string }
} {
  const bindings = env as unknown as AiEnvShape
  const providerKey = bindings.AI_PROVIDER ?? 'workers-ai'

  const adapters = new Map<string, AIProviderAdapter>()
  let configured = false
  let detail = ''

  if (providerKey === 'echo') {
    adapters.set('echo', createEchoAdapter())
    configured = true
    detail = 'Offline echo adapter (local development only; not a real model).'
  } else if (providerKey === 'workers-ai') {
    if (bindings.AI) {
      adapters.set(
        'workers-ai',
        createWorkersAiAdapter(bindings.AI, bindings.AI_GATEWAY_ID || undefined),
      )
      configured = true
      detail = bindings.AI_GATEWAY_ID
        ? 'Workers AI via AI Gateway.'
        : 'Workers AI (no AI Gateway id set; direct binding).'
    } else {
      detail = 'The Workers AI binding (AI) is missing. See docs/ai-execution.md.'
    }
  } else {
    detail = `Unknown AI_PROVIDER '${providerKey}'.`
  }

  return {
    deps: {
      adapters,
      modelOverrides: {
        ...(providerKey !== 'workers-ai' ? { provider: providerKey } : {}),
        ...(bindings.AI_MODEL_DEFAULT
          ? {
              models: { default: bindings.AI_MODEL_DEFAULT } as Partial<
                Record<ModelStrategy, string>
              >,
            }
          : {}),
      },
    },
    status: { configured, provider: providerKey, detail },
  }
}
