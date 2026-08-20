import { env } from 'cloudflare:workers'
import { BraveSearchClient } from './brave.ts'
import type { WebSearchProviderClient } from './types.ts'

interface WebSearchEnvShape {
  WEB_SEARCH_API_KEY?: string
  BRAVE_API_KEY?: string
  WEB_SEARCH_PROVIDER?: string
  WEB_SEARCH_ENDPOINT?: string
}

export function resolveWebSearchRuntime(): {
  client: WebSearchProviderClient | null
  status: { configured: boolean; provider: string; detail: string }
} {
  const bindings = env as unknown as WebSearchEnvShape
  const providerKey = bindings.WEB_SEARCH_PROVIDER ?? 'brave'
  const apiKey = bindings.WEB_SEARCH_API_KEY ?? bindings.BRAVE_API_KEY ?? ''

  if (!apiKey || apiKey.trim().length === 0) {
    return {
      client: null,
      status: {
        configured: false,
        provider: providerKey,
        detail:
          'Web search API key is not configured. Set WEB_SEARCH_API_KEY or BRAVE_API_KEY in secrets.',
      },
    }
  }

  if (providerKey === 'brave') {
    const client = new BraveSearchClient({
      apiKey,
      endpoint: bindings.WEB_SEARCH_ENDPOINT || undefined,
    })
    return {
      client,
      status: {
        configured: true,
        provider: 'brave',
        detail: 'Brave Search API configured and available.',
      },
    }
  }

  return {
    client: null,
    status: {
      configured: false,
      provider: providerKey,
      detail: `Unsupported search provider '${providerKey}'.`,
    },
  }
}
