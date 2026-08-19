import { buildContext } from '../../context/index.ts'
import {
  getContextAccount,
  getContextBrand,
  getContextConnectionStatus,
  getContextPlatform,
  getContextProduct,
  listContextAccounts,
  listContextProducts,
} from '../../db/context.ts'
import { type ToolAdapter, ToolError } from '../types.ts'

/**
 * Internal workspace read adapters. Read-only, workspace-scoped, and built
 * on the same safe context repository queries as the Context Engine. No
 * secrets are selected (platform_connection contributes status only).
 */

function scopeDenied(message: string): ToolError {
  return new ToolError('scope_denied', message)
}

function toProductOutput(row: {
  id: string
  brand_id: string
  niche_id: string | null
  name: string
  description: string | null
  url: string | null
  status: string
}) {
  return {
    id: row.id,
    brandId: row.brand_id,
    nicheId: row.niche_id,
    name: row.name,
    description: row.description,
    url: row.url,
    status: row.status as 'draft' | 'active' | 'archived',
  }
}

export const getCurrentContextAdapter: ToolAdapter = {
  key: 'workspace.get_current_context',
  async run({ db, workspaceId, context }) {
    // Deliberately the Context Engine, not a second context loader. The tool
    // returns only a summary; the full package remains an execution input.
    const pkg = await buildContext(db, {
      workspaceId,
      ...(context?.conversationId ? { conversationId: context.conversationId } : {}),
      ...(context?.uiBrandId ? { uiSelection: { brandId: context.uiBrandId } } : {}),
      ...(context?.taskText ? { task: { text: context.taskText } } : {}),
    })
    return {
      generatedAt: pkg.generatedAt,
      workspace: pkg.workspace,
      activeScope: pkg.activeScope,
      scopeSource: pkg.scopeSource,
      brand: pkg.brand,
      product: pkg.product,
      account: pkg.account,
      counts: pkg.metadata.counts,
    }
  },
}

export const getProductAdapter: ToolAdapter = {
  key: 'workspace.get_product',
  async run({ db, workspaceId, args }) {
    const { productId } = args as { productId: string }
    const product = await getContextProduct(db, productId)
    if (!product) throw scopeDenied('That product could not be found.')
    const brand = await getContextBrand(db, product.brand_id)
    if (!brand || brand.workspace_id !== workspaceId) {
      throw scopeDenied('That product is not in this workspace.')
    }
    if (brand.deleted_at || product.deleted_at || product.status === 'archived') {
      throw scopeDenied('That product is archived.')
    }
    return toProductOutput(product)
  },
}

export const listProductsAdapter: ToolAdapter = {
  key: 'workspace.list_products',
  async run({ db, workspaceId, args }) {
    const { brandId, limit } = args as { brandId?: string; limit: number }
    if (brandId) {
      const brand = await getContextBrand(db, brandId)
      if (!brand || brand.workspace_id !== workspaceId) {
        throw scopeDenied('That brand is not in this workspace.')
      }
      if (brand.deleted_at) throw scopeDenied('That brand is archived.')
    }
    const rows = await listContextProducts(db, workspaceId, brandId)
    return {
      products: rows
        .slice(0, limit)
        .filter((row) => row.brand_deleted_at === null)
        .map(toProductOutput),
    }
  },
}

function toAccountOutput(row: {
  id: string
  handle: string
  display_name: string | null
  status: string
  platform_id: string
  platform_name?: string | null
  connection_status?: 'connected' | 'expired' | 'error' | 'disconnected' | null
}) {
  return {
    id: row.id,
    handle: row.handle,
    displayName: row.display_name,
    status: row.status as 'active' | 'paused' | 'disconnected' | 'archived',
    platform: { id: row.platform_id, name: row.platform_name ?? 'Unknown platform' },
    connectionStatus: row.connection_status ?? null,
  }
}

export const getAccountAdapter: ToolAdapter = {
  key: 'workspace.get_account',
  async run({ db, workspaceId, args }) {
    const { accountId } = args as { accountId: string }
    const account = await getContextAccount(db, accountId)
    if (!account || account.workspace_id !== workspaceId) {
      throw scopeDenied('That account is not in this workspace.')
    }
    if (account.deleted_at || account.status === 'archived') {
      throw scopeDenied('That account is archived.')
    }
    const platform = await getContextPlatform(db, account.platform_id)
    const connectionStatus = await getContextConnectionStatus(db, account.id)
    return toAccountOutput({
      ...account,
      platform_name: platform?.name ?? null,
      connection_status: connectionStatus,
    })
  },
}

export const listAccountsAdapter: ToolAdapter = {
  key: 'workspace.list_accounts',
  async run({ db, workspaceId, args }) {
    const { limit } = args as { limit: number }
    const rows = await listContextAccounts(db, workspaceId)
    return { accounts: rows.slice(0, limit).map(toAccountOutput) }
  },
}
