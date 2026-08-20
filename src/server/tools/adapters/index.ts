import type { ToolAdapter, ToolKey } from '../types.ts'
import { listRelevantMemoryAdapter, listRelevantResearchAdapter } from './knowledge.ts'
import { webSearchAdapter } from './web/index.ts'
import {
  getAccountAdapter,
  getCurrentContextAdapter,
  getProductAdapter,
  listAccountsAdapter,
  listProductsAdapter,
} from './workspace.ts'

/**
 * Adapter registry. Tool definitions (metadata/contracts) live in
 * definitions.ts; implementations live here. Available tools without an
 * adapter fail controlled as not_configured, and unavailable tools never
 * reach this map through executeTool.
 */
export const TOOL_ADAPTERS: ReadonlyMap<ToolKey, ToolAdapter> = new Map<ToolKey, ToolAdapter>([
  [getCurrentContextAdapter.key, getCurrentContextAdapter],
  [getProductAdapter.key, getProductAdapter],
  [listProductsAdapter.key, listProductsAdapter],
  [getAccountAdapter.key, getAccountAdapter],
  [listAccountsAdapter.key, listAccountsAdapter],
  [listRelevantMemoryAdapter.key, listRelevantMemoryAdapter],
  [listRelevantResearchAdapter.key, listRelevantResearchAdapter],
  [webSearchAdapter.key, webSearchAdapter],
])
