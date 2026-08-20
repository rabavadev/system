export interface RawSearchResult {
  title: string
  url: string
  snippet?: string | null
  publisher?: string | null
  publishedAt?: string | null
}

export interface WebSearchProviderClient {
  readonly providerName: string
  search(query: string, limit: number, freshness?: string): Promise<RawSearchResult[]>
}

export interface WebSearchResultItem {
  title: string
  url: string
  snippet: string | null
  publisher: string | null
  publishedAt: string | null
  retrievedAt: string
}

export interface WebSearchOutput {
  query: string
  provider: string
  resultCount: number
  results: WebSearchResultItem[]
}
