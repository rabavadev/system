export {
  createWebSearchAdapter,
  getActiveWebSearchClient,
  setActiveWebSearchClient,
  webSearchAdapter,
} from './adapter.ts'
export { type BraveClientOptions, BraveSearchClient } from './brave.ts'
export { MockWebSearchClient, type MockWebSearchOptions } from './mock.ts'
export type {
  RawSearchResult,
  WebSearchOutput,
  WebSearchProviderClient,
  WebSearchResultItem,
} from './types.ts'
