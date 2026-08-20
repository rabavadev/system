import { createServerFn } from '@tanstack/react-start'
import { listAccounts } from '~/server/db/account'
import { listBrands } from '~/server/db/brand'
import { listCampaigns } from '~/server/db/campaign'
import { getDb } from '~/server/db/client'
import { getConversationById } from '~/server/db/conversation'
import {
  archiveMemory,
  createMemory,
  getMemorySummaryById,
  listMemories,
  type MemorySummary,
  rejectMemory,
  restoreMemory,
  supersedeMemory,
  updateMemory,
  verifyMemory,
} from '~/server/db/memory'
import { getMessageById } from '~/server/db/message'
import { listNiches } from '~/server/db/niche'
import { listPlatforms } from '~/server/db/platform'
import { listProducts } from '~/server/db/product'
import { getDefaultWorkspace } from '~/server/db/workspace'
import {
  CONFIDENCE_VALUE,
  confidenceLevelFromValue,
  MEMORY_STATUS_LABEL,
  MEMORY_TYPE_LABEL,
} from '~/server/memory/rules'
import type { MemorySourceType } from '~/types/domain'

import {
  type ConfidenceLevelWire,
  createMemoryWire,
  memoryFiltersWire,
  memoryIdWire,
  supersedeMemoryWire,
  updateMemoryWire,
  verifyMemoryWire,
} from './wire'

/** Human-facing memory row; raw status/class values are mapped to labels. */
export interface MemoryListItem extends MemorySummary {
  typeLabel: string
  statusLabel: string
  confidenceLabel: 'Low' | 'Medium' | 'High' | null
  sourceLabel: string
}

export interface MemoryScopeOptions {
  brands: { id: string; name: string }[]
  niches: { id: string; name: string; brandId: string; brandName: string }[]
  products: {
    id: string
    name: string
    brandId: string
    brandName: string
    nicheId: string | null
    nicheName: string | null
  }[]
  accounts: { id: string; name: string; platformName: string }[]
  platforms: { id: string; name: string }[]
  campaigns: { id: string; name: string; brandId: string | null; productId: string | null }[]
}

export interface MemoryCounts {
  importantFacts: number
  verifiedLearnings: number
  needsReview: number
  temporary: number
  archived: number
}

export interface MemoryPageData {
  memories: MemoryListItem[]
  counts: MemoryCounts
  scopeOptions: MemoryScopeOptions
}

function sourceLabel(sourceType: MemorySourceType): string {
  switch (sourceType) {
    case 'agent':
      return 'Chief'
    case 'research':
      return 'Research'
    case 'observation':
      return 'Analytics'
    case 'import':
      return 'Imported data'
    default:
      return 'You'
  }
}

function toListItem(memory: MemorySummary): MemoryListItem {
  const confidence = confidenceLevelFromValue(memory.confidence)
  return {
    ...memory,
    typeLabel: MEMORY_TYPE_LABEL[memory.memoryClass],
    statusLabel: MEMORY_STATUS_LABEL[memory.status],
    confidenceLabel:
      confidence === null
        ? null
        : confidence === 'low'
          ? 'Low'
          : confidence === 'medium'
            ? 'Medium'
            : 'High',
    sourceLabel: sourceLabel(memory.sourceType),
  }
}

function confidenceValue(level: ConfidenceLevelWire | null | undefined): number | null {
  return level ? CONFIDENCE_VALUE[level] : null
}

async function requireWorkspace() {
  const workspace = await getDefaultWorkspace()
  if (!workspace) {
    throw new Error('Workspace is not set up yet.')
  }
  return workspace
}

async function requireOwnedMemory(id: string, workspaceId: string) {
  const memory = await getMemorySummaryById(getDb(), id)
  if (!memory || memory.workspaceId !== workspaceId) {
    throw new Error('Memory not found.')
  }
  return memory
}

async function provenanceFromMessage(
  sourceMessageId: string | null | undefined,
  workspaceId: string,
): Promise<{ sourceType: MemorySourceType; sourceId: string | null }> {
  if (!sourceMessageId) {
    return { sourceType: 'manual', sourceId: null }
  }
  const db = getDb()
  const message = await getMessageById(db, sourceMessageId)
  if (!message || (message.senderType !== 'user' && message.senderType !== 'agent')) {
    throw new Error('That message cannot be saved to Memory.')
  }
  const conversation = await getConversationById(db, message.conversationId)
  if (!conversation || conversation.workspaceId !== workspaceId) {
    throw new Error('That message is not available in this workspace.')
  }
  return { sourceType: message.senderType, sourceId: message.id }
}

async function loadScopeOptions(workspaceId: string): Promise<MemoryScopeOptions> {
  const db = getDb()
  const [brands, accounts, platforms, campaigns] = await Promise.all([
    listBrands(workspaceId),
    listAccounts(workspaceId),
    listPlatforms(),
    listCampaigns(db, { workspaceId }),
  ])
  const niches: MemoryScopeOptions['niches'] = []
  for (const brand of brands) {
    const brandNiches = await listNiches(brand.id)
    niches.push(
      ...brandNiches.map((niche) => ({
        id: niche.id,
        name: niche.name,
        brandId: brand.id,
        brandName: brand.name,
      })),
    )
  }
  const products = (await listProducts(workspaceId)).map((product) => ({
    id: product.id,
    name: product.name,
    brandId: product.brandId,
    brandName: product.brandName,
    nicheId: product.nicheId,
    nicheName: product.nicheName,
  }))
  return {
    brands: brands.map((brand) => ({ id: brand.id, name: brand.name })),
    niches,
    products,
    accounts: accounts.map((account) => ({
      id: account.id,
      name: account.displayName ?? account.handle,
      platformName: account.platformName,
    })),
    platforms: platforms.map((platform) => ({ id: platform.id, name: platform.name })),
    campaigns: campaigns
      .filter((campaign) => campaign.status !== 'archived' && !campaign.deletedAt)
      .map((campaign) => ({
        id: campaign.id,
        name: campaign.name,
        brandId: campaign.brandId,
        productId: campaign.productId,
      })),
  }
}

export const getMemoryScopeOptions = createServerFn({ method: 'GET' }).handler(
  async (): Promise<MemoryScopeOptions> => {
    const workspace = await getDefaultWorkspace()
    if (!workspace) {
      return { brands: [], niches: [], products: [], accounts: [], platforms: [], campaigns: [] }
    }
    return loadScopeOptions(workspace.id)
  },
)

export const getMemoryPageData = createServerFn({ method: 'GET' })
  .validator(memoryFiltersWire)
  .handler(async ({ data }): Promise<MemoryPageData> => {
    const workspace = await getDefaultWorkspace()
    if (!workspace) {
      return {
        memories: [],
        counts: {
          importantFacts: 0,
          verifiedLearnings: 0,
          needsReview: 0,
          temporary: 0,
          archived: 0,
        },
        scopeOptions: {
          brands: [],
          niches: [],
          products: [],
          accounts: [],
          platforms: [],
          campaigns: [],
        },
      }
    }
    const db = getDb()
    const [all, filtered, scopeOptions] = await Promise.all([
      listMemories(db, workspace.id, { limit: 500 }),
      listMemories(db, workspace.id, { ...data, limit: 500 }),
      loadScopeOptions(workspace.id),
    ])
    const active = all.filter((memory) => memory.status === 'active')
    return {
      memories: filtered.map(toListItem),
      counts: {
        importantFacts: active.filter((memory) => memory.memoryClass === 'permanent_fact').length,
        verifiedLearnings: active.filter((memory) => memory.memoryClass === 'verified_learning')
          .length,
        needsReview: active.filter((memory) => memory.memoryClass === 'proposed_learning').length,
        temporary: active.filter((memory) => memory.memoryClass === 'temporary_context').length,
        archived: all.filter((memory) => memory.status === 'archived').length,
      },
      scopeOptions,
    }
  })

export const createMemoryFn = createServerFn({ method: 'POST' })
  .validator(createMemoryWire)
  .handler(async ({ data }): Promise<MemoryListItem> => {
    const workspace = await requireWorkspace()
    const provenance = await provenanceFromMessage(data.sourceMessageId, workspace.id)
    const memory = await createMemory(getDb(), {
      workspaceId: workspace.id,
      memoryClass: data.memoryClass,
      content: data.content,
      scopeType: data.scopeType,
      scopeId: data.scopeId ?? null,
      confidence: confidenceValue(data.confidenceLevel),
      sourceType: provenance.sourceType,
      sourceId: provenance.sourceId,
      evidenceJson: data.evidence?.trim()
        ? JSON.stringify([
            {
              type: data.sourceMessageId ? 'message' : 'note',
              text: data.evidence.trim(),
              ...(data.sourceMessageId ? { referenceId: data.sourceMessageId } : {}),
            },
          ])
        : null,
      expiresAt: data.expiresAt ?? null,
      expectedBrandId: data.contextBrandId ?? null,
      expectedNicheId: data.contextNicheId ?? null,
      expectedProductId: data.contextProductId ?? null,
    })
    const summary = await getMemorySummaryById(getDb(), memory.id)
    if (!summary) throw new Error('Memory could not be loaded.')
    return toListItem(summary)
  })

export const updateMemoryFn = createServerFn({ method: 'POST' })
  .validator(updateMemoryWire)
  .handler(async ({ data }): Promise<MemoryListItem> => {
    const workspace = await requireWorkspace()
    await requireOwnedMemory(data.id, workspace.id)
    const evidenceText = typeof data.evidence === 'string' ? data.evidence.trim() : null
    const memory = await updateMemory(getDb(), {
      id: data.id,
      content: data.content,
      scopeType: data.scopeType,
      scopeId: data.scopeId ?? null,
      confidence:
        data.confidenceLevel === undefined ? undefined : confidenceValue(data.confidenceLevel),
      evidenceJson:
        data.evidence === undefined
          ? undefined
          : evidenceText
            ? JSON.stringify([{ type: 'note', text: evidenceText }])
            : null,
      expiresAt: data.expiresAt === undefined ? undefined : (data.expiresAt ?? null),
      expectedBrandId: data.contextBrandId ?? null,
      expectedNicheId: data.contextNicheId ?? null,
      expectedProductId: data.contextProductId ?? null,
    })
    const summary = await getMemorySummaryById(getDb(), memory.id)
    if (!summary) throw new Error('Memory could not be loaded.')
    return toListItem(summary)
  })

export const verifyMemoryFn = createServerFn({ method: 'POST' })
  .validator(verifyMemoryWire)
  .handler(async ({ data }): Promise<MemoryListItem> => {
    const workspace = await requireWorkspace()
    await requireOwnedMemory(data.id, workspace.id)
    const memory = await verifyMemory(getDb(), {
      id: data.id,
      confidence: confidenceValue(data.confidenceLevel) ?? CONFIDENCE_VALUE.medium,
      evidenceJson: JSON.stringify([{ type: 'note', text: data.evidence.trim() }]),
    })
    const summary = await getMemorySummaryById(getDb(), memory.id)
    if (!summary) throw new Error('Memory could not be loaded.')
    return toListItem(summary)
  })

export const archiveMemoryFn = createServerFn({ method: 'POST' })
  .validator(memoryIdWire)
  .handler(async ({ data }): Promise<void> => {
    const workspace = await requireWorkspace()
    await requireOwnedMemory(data.id, workspace.id)
    await archiveMemory(getDb(), data.id)
  })

export const restoreMemoryFn = createServerFn({ method: 'POST' })
  .validator(memoryIdWire)
  .handler(async ({ data }): Promise<void> => {
    const workspace = await requireWorkspace()
    await requireOwnedMemory(data.id, workspace.id)
    await restoreMemory(getDb(), data.id)
  })

export const rejectMemoryFn = createServerFn({ method: 'POST' })
  .validator(memoryIdWire)
  .handler(async ({ data }): Promise<void> => {
    const workspace = await requireWorkspace()
    await requireOwnedMemory(data.id, workspace.id)
    await rejectMemory(getDb(), data.id)
  })

export const supersedeMemoryFn = createServerFn({ method: 'POST' })
  .validator(supersedeMemoryWire)
  .handler(async ({ data }): Promise<MemoryListItem> => {
    const workspace = await requireWorkspace()
    const existing = await requireOwnedMemory(data.id, workspace.id)
    if (existing.memoryClass === 'verified_learning') {
      if (!data.confidenceLevel || !data.evidence?.trim()) {
        throw new Error('Add confidence and evidence for the replacement learning.')
      }
    }
    const result = await supersedeMemory(getDb(), data.id, {
      workspaceId: workspace.id,
      memoryClass: existing.memoryClass,
      content: data.content,
      scopeType: data.scopeType,
      scopeId: data.scopeId ?? null,
      confidence: confidenceValue(data.confidenceLevel),
      sourceType: 'manual',
      sourceId: null,
      evidenceJson: data.evidence?.trim()
        ? JSON.stringify([{ type: 'note', text: data.evidence.trim() }])
        : null,
      expiresAt: data.expiresAt ?? null,
      expectedBrandId: data.contextBrandId ?? null,
      expectedNicheId: data.contextNicheId ?? null,
      expectedProductId: data.contextProductId ?? null,
    })
    const summary = await getMemorySummaryById(getDb(), result.replacement.id)
    if (!summary) throw new Error('Memory could not be loaded.')
    return toListItem(summary)
  })

export type { MemoryClassWire as MemoryTypeFilter } from './wire'
