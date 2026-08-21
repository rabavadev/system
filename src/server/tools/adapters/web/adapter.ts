import { nowIso } from '../../../db/sql.ts'
import { type ToolAdapter, ToolError } from '../../types.ts'
import type {
  RawSearchResult,
  WebSearchOutput,
  WebSearchProviderClient,
  WebSearchResultItem,
} from './types.ts'

export interface WebSearchAdapterOptions {
  client?: WebSearchProviderClient | null
  getClient?: () => WebSearchProviderClient | null
}

function isValidHttpUrl(candidate: string): boolean {
  try {
    const parsed = new URL(candidate)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function normalizeResult(raw: RawSearchResult, retrievedAt: string): WebSearchResultItem | null {
  if (!raw.url || !isValidHttpUrl(raw.url)) {
    return null
  }
  if (!raw.title || raw.title.trim().length === 0) {
    return null
  }

  let publisher: string | null = raw.publisher?.trim() || null
  if (!publisher) {
    try {
      publisher = new URL(raw.url).hostname
    } catch {
      publisher = null
    }
  }

  return {
    title: raw.title.trim(),
    url: raw.url.trim(),
    snippet: raw.snippet && raw.snippet.trim().length > 0 ? raw.snippet.trim() : null,
    publisher,
    publishedAt:
      raw.publishedAt && raw.publishedAt.trim().length > 0 ? raw.publishedAt.trim() : null,
    retrievedAt,
  }
}

export function createWebSearchAdapter(options: WebSearchAdapterOptions = {}): ToolAdapter {
  const getClient = (): WebSearchProviderClient | null => {
    if (options.client !== undefined) return options.client
    if (options.getClient) return options.getClient()
    return null
  }

  return {
    key: 'web.search',
    isConfigured(): boolean {
      return getClient() !== null
    },
    async run({ args }): Promise<WebSearchOutput> {
      const parsedArgs = args as {
        query: string
        limit?: number
        freshness?: string
      }

      const query = parsedArgs?.query?.trim()
      if (!query || query.length === 0) {
        throw new ToolError('invalid_input', 'Query cannot be empty.')
      }
      if (query.length > 300) {
        throw new ToolError('invalid_input', 'Query cannot exceed 300 characters.')
      }

      const limit =
        typeof parsedArgs.limit === 'number' ? Math.min(Math.max(1, parsedArgs.limit), 10) : 5

      const client = getClient()
      if (!client) {
        throw new ToolError('not_configured', 'Web Search needs setup before it can be used.')
      }

      let rawResults: RawSearchResult[]
      try {
        rawResults = await client.search(query, limit, parsedArgs.freshness)
      } catch (err: unknown) {
        if (err instanceof ToolError) {
          throw err
        }
        const message = err instanceof Error ? err.message : 'Web search execution failed.'
        throw new ToolError('execution_failed', message.slice(0, 300))
      }

      const retrievedAt = nowIso()
      const normalizedResults: WebSearchResultItem[] = []

      for (const item of rawResults) {
        const normalized = normalizeResult(item, retrievedAt)
        if (normalized) {
          normalizedResults.push(normalized)
        }
        if (normalizedResults.length >= limit) {
          break
        }
      }

      return {
        query,
        provider: client.providerName,
        resultCount: normalizedResults.length,
        results: normalizedResults,
      }
    },
  }
}

export const webSearchAdapter: ToolAdapter = createWebSearchAdapter()
