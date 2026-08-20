import { ToolError } from '../../types.ts'
import type { RawSearchResult, WebSearchProviderClient } from './types.ts'

export interface BraveClientOptions {
  apiKey: string
  endpoint?: string | undefined
  fetchFn?: typeof fetch | undefined
}

const FRESHNESS_MAP: Record<string, string> = {
  day: 'pd',
  week: 'pw',
  month: 'pm',
  year: 'py',
}

export class BraveSearchClient implements WebSearchProviderClient {
  readonly providerName = 'brave'
  private readonly apiKey: string
  private readonly endpoint: string
  private readonly fetchFn: typeof fetch

  constructor(options: BraveClientOptions) {
    this.apiKey = options.apiKey
    this.endpoint = options.endpoint ?? 'https://api.search.brave.com/res/v1/web/search'
    this.fetchFn = options.fetchFn ?? fetch
  }

  async search(query: string, limit: number, freshness?: string): Promise<RawSearchResult[]> {
    if (!this.apiKey || this.apiKey.trim().length === 0) {
      throw new ToolError('not_configured', 'Web Search API key is missing.')
    }

    const url = new URL(this.endpoint)
    url.searchParams.set('q', query)
    url.searchParams.set('count', String(Math.min(Math.max(1, limit), 20)))

    if (freshness && FRESHNESS_MAP[freshness]) {
      url.searchParams.set('freshness', FRESHNESS_MAP[freshness])
    }

    let response: Response
    try {
      response = await this.fetchFn(url.toString(), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': this.apiKey,
        },
      })
    } catch (err: unknown) {
      if (err instanceof ToolError) throw err
      throw new ToolError('execution_failed', 'Failed to connect to web search provider.')
    }

    if (response.status === 401 || response.status === 403) {
      throw new ToolError('not_configured', 'Web Search API key is invalid or unauthorized.')
    }

    if (response.status === 429) {
      throw new ToolError('rate_limited', 'Web search rate limit reached. Please try again later.')
    }

    if (!response.ok) {
      throw new ToolError('provider_error', `Web search provider error (HTTP ${response.status}).`)
    }

    let json: unknown
    try {
      json = await response.json()
    } catch {
      throw new ToolError('provider_error', 'Malformed response from web search provider.')
    }

    if (typeof json !== 'object' || json === null) {
      return []
    }

    const rawWeb = Reflect.get(json, 'web')
    if (typeof rawWeb !== 'object' || rawWeb === null) {
      return []
    }

    const rawResults = Reflect.get(rawWeb, 'results')
    if (!Array.isArray(rawResults)) {
      return []
    }

    const results: RawSearchResult[] = []
    for (const item of rawResults) {
      if (typeof item !== 'object' || item === null) continue
      const title = Reflect.get(item, 'title')
      const itemUrl = Reflect.get(item, 'url')
      const description = Reflect.get(item, 'description')
      const metaUrl = Reflect.get(item, 'meta_url')
      const pageAge = Reflect.get(item, 'page_age')

      if (typeof title !== 'string' || typeof itemUrl !== 'string') continue

      let publisher: string | null = null
      if (typeof metaUrl === 'object' && metaUrl !== null) {
        const hostname = Reflect.get(metaUrl, 'hostname')
        if (typeof hostname === 'string') {
          publisher = hostname
        }
      }

      results.push({
        title: title.trim(),
        url: itemUrl.trim(),
        snippet: typeof description === 'string' ? description.trim() : null,
        publisher,
        publishedAt: typeof pageAge === 'string' ? pageAge : null,
      })
    }

    return results
  }
}
