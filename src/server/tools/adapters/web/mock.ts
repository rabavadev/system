import type { ToolError } from '../../types.ts'
import type { RawSearchResult, WebSearchProviderClient } from './types.ts'

export interface MockWebSearchOptions {
  results?: RawSearchResult[] | undefined
  resultsByQuery?: Record<string, RawSearchResult[]> | undefined
  error?: Error | ToolError | undefined
  delayMs?: number | undefined
}

export class MockWebSearchClient implements WebSearchProviderClient {
  readonly providerName = 'mock'
  private readonly defaultResults: RawSearchResult[]
  private readonly resultsByQuery: Record<string, RawSearchResult[]>
  private readonly error?: Error | ToolError | undefined
  private readonly delayMs?: number | undefined
  public readonly calls: Array<{ query: string; limit: number; freshness?: string | undefined }> =
    []

  constructor(options: MockWebSearchOptions = {}) {
    this.defaultResults = options.results ?? []
    this.resultsByQuery = options.resultsByQuery ?? {}
    this.error = options.error
    this.delayMs = options.delayMs
  }

  async search(query: string, limit: number, freshness?: string): Promise<RawSearchResult[]> {
    this.calls.push({ query, limit, freshness })

    if (this.delayMs && this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs))
    }

    if (this.error) {
      throw this.error
    }

    const matched = this.resultsByQuery[query] ?? this.defaultResults
    return matched.slice(0, limit)
  }
}
