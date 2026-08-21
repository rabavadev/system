import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { runAgentReply } from '~/server/agents/reply'
import { resolveAiRuntime } from '~/server/ai/runtime'
import { researchFreshness } from '~/server/context/freshness'
import type { Freshness } from '~/server/context/types'
import { listAccounts } from '~/server/db/account'
import { listAgents } from '~/server/db/agent'
import { listBrands } from '~/server/db/brand'
import { listCampaigns } from '~/server/db/campaign'
import { getDb } from '~/server/db/client'
import { createConversation } from '~/server/db/conversation'
import { emitEventSafe } from '~/server/db/event'
import { appendUserMessage } from '~/server/db/message'
import { listNiches } from '~/server/db/niche'
import { listProducts } from '~/server/db/product'
import {
  archiveResearch,
  composeResearchAnalysisTask,
  computeProvenanceSummary,
  createResearch,
  createResearchSource,
  deriveResearchTitle,
  getResearch,
  listResearch,
  listResearchSources,
  MAX_RESEARCH_ANALYSIS_SELECTION,
  MIN_RESEARCH_ANALYSIS_SELECTION,
  type ProvenanceSummary,
  RESEARCH_ANALYSIS_MODES,
  RESEARCH_SCOPE_TYPES,
  RESEARCH_SOURCE_TYPES,
  RESEARCH_STATUSES,
  RESEARCH_TYPES,
  type ResearchAnalysisMode,
  ResearchAnalysisValidationError,
  type ResearchOrigin,
  type ResearchRecord,
  type ResearchScopeType,
  type ResearchSourceRecord,
  type ResearchSourceType,
  type ResearchStatus,
  type ResearchType,
  removeResearchSource,
  researchOriginSchema,
  restoreResearch,
  type SelectedResearchItem,
  updateResearch,
  updateResearchSource,
  validateResearchSelection,
} from '~/server/db/research'
import { getDefaultWorkspace } from '~/server/db/workspace'
import { resolveWebSearchRuntime } from '~/server/tools/adapters/web/runtime'

export {
  composeResearchAnalysisTask,
  deriveResearchTitle,
  MAX_RESEARCH_ANALYSIS_SELECTION,
  MIN_RESEARCH_ANALYSIS_SELECTION,
  RESEARCH_ANALYSIS_MODES,
  RESEARCH_STATUSES,
  RESEARCH_TYPES,
  type ResearchAnalysisMode,
  ResearchAnalysisValidationError,
  type ResearchOrigin,
  type ResearchScopeType,
  type ResearchStatus,
  type ResearchType,
  type SelectedResearchItem,
  validateResearchSelection,
}

export const RESEARCH_TYPE_LABELS: Record<ResearchType, string> = {
  market: 'Market',
  audience: 'Audience',
  competitor: 'Competitor',
  product: 'Product',
  platform: 'Platform',
  content: 'Content',
  general: 'General',
}

export const RESEARCH_ANALYSIS_MODE_LABELS: Record<ResearchAnalysisMode, string> = {
  compare: 'Compare',
  synthesize: 'Synthesize',
  patterns: 'Find Patterns',
  contradictions: 'Find Contradictions',
}

export const RESEARCH_ANALYSIS_MODE_DESCRIPTIONS: Record<ResearchAnalysisMode, string> = {
  compare: 'Highlight agreements, differences, and evidence gaps between records.',
  synthesize: 'Combine findings into unified takeaways separating facts from hypotheses.',
  patterns: 'Identify recurring themes and cross-cutting findings across records.',
  contradictions: 'Uncover direct disagreements and analyze possible causes without bias.',
}

export const RESEARCH_STATUS_LABELS: Record<ResearchStatus, string> = {
  draft: 'Draft',
  in_progress: 'In Progress',
  completed: 'Completed',
  stale: 'Stale',
  archived: 'Archived',
}

export const RESEARCH_SOURCE_TYPE_LABELS: Record<ResearchSourceType, string> = {
  website: 'Website',
  report: 'Report',
  marketplace: 'Marketplace',
  social: 'Social',
  internal_data: 'Internal Data',
  user_provided: 'User Provided',
  other: 'Other',
}

export const FRESHNESS_LABELS: Record<Freshness, string> = {
  current: 'Current',
  aging: 'Aging',
  stale: 'Stale',
  expired: 'Expired',
}

export interface ResearchListItem {
  id: string
  workspaceId: string
  subject: string
  findings: string | null
  researchType: ResearchType
  researchTypeLabel: string
  status: ResearchStatus
  statusLabel: string
  confidence: number | null
  scopeType: ResearchScopeType | null
  scopeId: string | null
  scopeLabel: string
  freshness: Freshness
  freshnessLabel: string
  sources: ResearchSourceRecord[]
  provenance: ProvenanceSummary
  createdAt: string
  updatedAt: string
  lastVerifiedAt: string | null
  expiresAt: string | null
  deletedAt: string | null
}

export interface ResearchOverviewData {
  workspaceId: string
  items: ResearchListItem[]
  brands: Array<{ id: string; name: string }>
  niches: Array<{ id: string; name: string; brandId: string }>
  products: Array<{ id: string; name: string; brandId: string }>
  accounts: Array<{ id: string; name: string }>
  webSearchStatus?: {
    configured: boolean
    provider: string
  }
}

function computeScopeLabel(
  record: ResearchRecord,
  maps: {
    brands: Map<string, string>
    niches: Map<string, string>
    products: Map<string, string>
    accounts: Map<string, string>
    campaigns?: Map<string, string>
  },
): string {
  if (!record.scopeType || record.scopeType === 'workspace') {
    return 'Workspace'
  }
  if (record.scopeType === 'brand' && record.scopeId) {
    const name = maps.brands.get(record.scopeId)
    return name ? `Brand: ${name}` : 'Brand'
  }
  if (record.scopeType === 'niche' && record.scopeId) {
    const name = maps.niches.get(record.scopeId)
    return name ? `Niche: ${name}` : 'Niche'
  }
  if (record.scopeType === 'product' && record.scopeId) {
    const name = maps.products.get(record.scopeId)
    return name ? `Product: ${name}` : 'Product'
  }
  if (record.scopeType === 'account' && record.scopeId) {
    const name = maps.accounts.get(record.scopeId)
    return name ? `Account: ${name}` : 'Account'
  }
  if (record.scopeType === 'platform' && record.scopeId) {
    return `Platform: ${record.scopeId}`
  }
  if (record.scopeType === 'campaign' && record.scopeId) {
    const name = maps.campaigns?.get(record.scopeId)
    return name ? `Campaign: ${name}` : 'Campaign'
  }
  return 'Workspace'
}

function enrichResearchRecord(
  record: ResearchRecord,
  sources: ResearchSourceRecord[],
  maps: {
    brands: Map<string, string>
    niches: Map<string, string>
    products: Map<string, string>
    accounts: Map<string, string>
    campaigns?: Map<string, string>
  },
  now: string,
): ResearchListItem {
  const freshness = researchFreshness(
    {
      status: record.status,
      expiresAt: record.expiresAt,
      lastVerifiedAt: record.lastVerifiedAt,
      updatedAt: record.updatedAt,
    },
    now,
    90,
  )

  const provenance = computeProvenanceSummary(sources)

  return {
    id: record.id,
    workspaceId: record.workspaceId,
    subject: record.subject,
    findings: record.findings,
    researchType: record.researchType,
    researchTypeLabel: RESEARCH_TYPE_LABELS[record.researchType] ?? record.researchType,
    status: record.status,
    statusLabel: RESEARCH_STATUS_LABELS[record.status] ?? record.status,
    confidence: record.confidence,
    scopeType: record.scopeType,
    scopeId: record.scopeId,
    scopeLabel: computeScopeLabel(record, maps),
    freshness,
    freshnessLabel: FRESHNESS_LABELS[freshness] ?? freshness,
    sources,
    provenance,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastVerifiedAt: record.lastVerifiedAt,
    expiresAt: record.expiresAt,
    deletedAt: record.deletedAt,
  }
}

async function loadScopeEntities(workspaceId: string) {
  const db = getDb()
  const [brands, products, accounts, campaigns] = await Promise.all([
    listBrands(workspaceId),
    listProducts(workspaceId),
    listAccounts(workspaceId),
    listCampaigns(db, { workspaceId }),
  ])

  const niches: Array<{ id: string; name: string; brandId: string }> = []
  for (const b of brands) {
    const brandNiches = await listNiches(b.id)
    niches.push(
      ...brandNiches.map((n) => ({
        id: n.id,
        name: n.name,
        brandId: b.id,
      })),
    )
  }

  const maps = {
    brands: new Map(brands.map((b) => [b.id, b.name])),
    niches: new Map(niches.map((n) => [n.id, n.name])),
    products: new Map(products.map((p) => [p.id, p.name])),
    accounts: new Map(accounts.map((a) => [a.id, a.displayName ?? a.handle])),
    campaigns: new Map(campaigns.map((c) => [c.id, c.name])),
  }

  return {
    brands: brands.map((b) => ({ id: b.id, name: b.name })),
    niches,
    products: products.map((p) => ({ id: p.id, name: p.name, brandId: p.brandId })),
    accounts: accounts.map((a) => ({ id: a.id, name: a.displayName ?? a.handle })),
    campaigns: campaigns.map((c) => ({ id: c.id, name: c.name, brandId: c.brandId })),
    maps,
  }
}

export const listResearchOverview = createServerFn({ method: 'GET' })
  .validator(
    (data?: {
      scopeType?: string
      scopeId?: string
      researchType?: string
      status?: string
      search?: string
      includeArchived?: boolean
    }) => data,
  )
  .handler(async ({ data }): Promise<ResearchOverviewData> => {
    const workspace = await getDefaultWorkspace()
    if (!workspace) {
      return {
        workspaceId: '',
        items: [],
        brands: [],
        niches: [],
        products: [],
        accounts: [],
      }
    }
    const db = getDb()
    const now = new Date().toISOString()

    const [records, { brands, niches, products, accounts, maps }] = await Promise.all([
      listResearch(db, {
        workspaceId: workspace.id,
        ...(data?.scopeType ? { scopeType: data.scopeType } : {}),
        ...(data?.scopeId ? { scopeId: data.scopeId } : {}),
        ...(data?.researchType ? { researchType: data.researchType } : {}),
        ...(data?.status ? { status: data.status } : {}),
        ...(data?.search ? { search: data.search } : {}),
        includeArchived: data?.includeArchived ?? true,
      }),
      loadScopeEntities(workspace.id),
    ])

    // Load sources for all returned research records
    const sourcesPromises = records.map((r) =>
      listResearchSources(db, { workspaceId: workspace.id, researchId: r.id }).catch(() => []),
    )
    const sourcesResults = await Promise.all(sourcesPromises)

    const items = records.map((r, index) =>
      enrichResearchRecord(r, sourcesResults[index] ?? [], maps, now),
    )

    const webSearch = resolveWebSearchRuntime()

    return {
      workspaceId: workspace.id,
      items,
      brands,
      niches,
      products,
      accounts,
      webSearchStatus: {
        configured: webSearch.status.configured,
        provider: webSearch.status.provider,
      },
    }
  })

export const getResearchDetailFn = createServerFn({ method: 'GET' })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }): Promise<ResearchListItem | null> => {
    const workspace = await getDefaultWorkspace()
    if (!workspace) return null
    const db = getDb()
    const record = await getResearch(db, {
      workspaceId: workspace.id,
      id: data.id,
      includeArchived: true,
    })
    if (!record) return null

    const [sources, { maps }] = await Promise.all([
      listResearchSources(db, { workspaceId: workspace.id, researchId: record.id }).catch(() => []),
      loadScopeEntities(workspace.id),
    ])

    return enrichResearchRecord(record, sources, maps, new Date().toISOString())
  })

export interface ResearchScopeOptions {
  brands: Array<{ id: string; name: string }>
  niches: Array<{ id: string; name: string; brandId: string }>
  products: Array<{ id: string; name: string; brandId: string }>
  accounts: Array<{ id: string; name: string }>
  campaigns: Array<{ id: string; name: string; brandId: string | null }>
}

export const getResearchScopeOptionsFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<ResearchScopeOptions> => {
    const workspace = await getDefaultWorkspace()
    if (!workspace) {
      return { brands: [], niches: [], products: [], accounts: [], campaigns: [] }
    }
    const { brands, niches, products, accounts, campaigns } = await loadScopeEntities(workspace.id)
    return { brands, niches, products, accounts, campaigns }
  },
)

export const startResearcherChatFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      scopeType: z
        .enum(['brand', 'product', 'account', 'campaign', 'niche', 'workspace'])
        .nullable()
        .optional(),
      scopeId: z.string().nullable().optional(),
      title: z.string().trim().min(1).max(200).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const workspace = await getDefaultWorkspace()
    if (!workspace) throw new Error('No active workspace found.')
    const db = getDb()

    // Find Researcher agent in workspace
    const agents = await listAgents(db, workspace.id)
    const researcher =
      agents.find((a) => a.role === 'researcher') ??
      agents.find((a) => a.name.toLowerCase() === 'researcher')
    const agentId = researcher?.id ?? null

    let targetScopeType: 'brand' | 'product' | 'account' | 'campaign' | null = null
    let targetScopeId: string | null = null

    if (data.scopeType && data.scopeId && data.scopeType !== 'workspace') {
      if (data.scopeType === 'niche') {
        const niche = await getDb()
          .prepare('SELECT brand_id FROM niche WHERE id = ?')
          .bind(data.scopeId)
          .first<{ brand_id: string }>()
        if (niche?.brand_id) {
          targetScopeType = 'brand'
          targetScopeId = niche.brand_id
        }
      } else if (['brand', 'product', 'account', 'campaign'].includes(data.scopeType)) {
        targetScopeType = data.scopeType as 'brand' | 'product' | 'account' | 'campaign'
        targetScopeId = data.scopeId
      }
    }

    const conversation = await createConversation(db, {
      workspaceId: workspace.id,
      title: data.title ?? 'Live Research',
      scopeType: targetScopeType,
      scopeId: targetScopeId,
    })

    if (targetScopeType === 'campaign' && targetScopeId) {
      await emitEventSafe(db, {
        workspaceId: workspace.id,
        eventType: 'campaign.research_started',
        actorType: 'user',
        subjectType: 'conversation',
        subjectId: conversation.id,
        payloadJson: JSON.stringify({
          campaignId: targetScopeId,
          conversationId: conversation.id,
          agentId,
        }),
      })
    }

    return {
      conversationId: conversation.id,
      agentId,
    }
  })

export const startResearchAnalysisChatFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      researchIds: z
        .array(z.string().uuid())
        .min(MIN_RESEARCH_ANALYSIS_SELECTION)
        .max(MAX_RESEARCH_ANALYSIS_SELECTION),
      mode: z.enum(RESEARCH_ANALYSIS_MODES).default('compare'),
    }),
  )
  .handler(async ({ data }) => {
    const workspace = await getDefaultWorkspace()
    if (!workspace) throw new Error('No active workspace found.')
    const db = getDb()

    const selectedResearch = await validateResearchSelection(db, {
      workspaceId: workspace.id,
      researchIds: data.researchIds,
    })

    const agents = await listAgents(db, workspace.id)
    const researcher =
      agents.find((a) => a.role === 'researcher') ??
      agents.find((a) => a.name.toLowerCase() === 'researcher')
    const agentId = researcher?.id ?? null

    // Determine common scope if applicable
    let commonScopeType: 'brand' | 'product' | 'account' | 'campaign' | null = null
    let commonScopeId: string | null = null

    const validScopes = selectedResearch
      .filter(
        (r) =>
          r.scopeType &&
          r.scopeId &&
          ['brand', 'product', 'account', 'campaign'].includes(r.scopeType),
      )
      .map((r) => `${r.scopeType}:${r.scopeId}`)

    const firstItem = selectedResearch[0]
    if (
      firstItem &&
      validScopes.length === selectedResearch.length &&
      new Set(validScopes).size === 1
    ) {
      commonScopeType =
        (firstItem.scopeType as 'brand' | 'product' | 'account' | 'campaign') ?? null
      commonScopeId = firstItem.scopeId ?? null
    }

    const modeLabel = data.mode.charAt(0).toUpperCase() + data.mode.slice(1)
    const conversationTitle = `Research ${modeLabel} (${selectedResearch.length} records)`

    const conversation = await createConversation(db, {
      workspaceId: workspace.id,
      title: conversationTitle,
      scopeType: commonScopeType,
      scopeId: commonScopeId,
    })

    const taskPrompt = composeResearchAnalysisTask({
      mode: data.mode,
      selectedResearch,
    })

    await emitEventSafe(db, {
      workspaceId: workspace.id,
      eventType: 'research.analysis_started',
      actorType: 'user',
      subjectType: 'conversation',
      subjectId: conversation.id,
      payloadJson: JSON.stringify({
        mode: data.mode,
        selectedResearchIds: data.researchIds,
        count: selectedResearch.length,
        agentId,
      }),
    })

    // Append initial user message with composed prompt
    const userMessage = await appendUserMessage(db, {
      conversationId: conversation.id,
      content: taskPrompt,
    })

    // Execute Researcher reply immediately
    if (agentId) {
      await runAgentReply({
        db,
        workspaceId: workspace.id,
        conversationId: conversation.id,
        agentId,
        userText: taskPrompt,
        deps: resolveAiRuntime().deps,
      })
    }

    return {
      conversationId: conversation.id,
      agentId,
      userMessageId: userMessage.id,
      derivedFromResearchIds: data.researchIds,
    }
  })

export const createResearchFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      subject: z.string().trim().min(1, 'Title is required').max(500),
      findings: z.string().nullable().optional(),
      researchType: z.enum(RESEARCH_TYPES).default('general'),
      status: z.enum(RESEARCH_STATUSES).default('completed'),
      confidence: z.number().min(0).max(1).nullable().optional(),
      scopeType: z.enum(RESEARCH_SCOPE_TYPES).nullable().optional(),
      scopeId: z.string().nullable().optional(),
      lastVerifiedAt: z.string().nullable().optional(),
      expiresAt: z.string().nullable().optional(),
      sourceMessageId: z.string().uuid().nullable().optional(),
      origin: researchOriginSchema.optional(),
      selectedSourceIndices: z.array(z.number().int().min(0)).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const workspace = await getDefaultWorkspace()
    if (!workspace) throw new Error('No active workspace found.')
    const db = getDb()
    const created = await createResearch(db, {
      workspaceId: workspace.id,
      subject: data.subject,
      ...(data.findings !== undefined ? { findings: data.findings } : {}),
      researchType: data.researchType,
      status: data.status,
      ...(data.confidence !== undefined ? { confidence: data.confidence } : {}),
      ...(data.scopeType !== undefined ? { scopeType: data.scopeType } : {}),
      ...(data.scopeId !== undefined ? { scopeId: data.scopeId } : {}),
      ...(data.lastVerifiedAt !== undefined ? { lastVerifiedAt: data.lastVerifiedAt } : {}),
      ...(data.expiresAt !== undefined ? { expiresAt: data.expiresAt } : {}),
      ...(data.sourceMessageId !== undefined ? { sourceMessageId: data.sourceMessageId } : {}),
      ...(data.origin !== undefined ? { origin: data.origin } : {}),
      ...(data.selectedSourceIndices !== undefined
        ? { selectedSourceIndices: data.selectedSourceIndices }
        : {}),
      actor: { actorType: 'user' },
    })

    return created
  })

export const updateResearchFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      id: z.string().uuid(),
      subject: z.string().trim().min(1).max(500).optional(),
      findings: z.string().nullable().optional(),
      researchType: z.enum(RESEARCH_TYPES).optional(),
      status: z.enum(RESEARCH_STATUSES).optional(),
      confidence: z.number().min(0).max(1).nullable().optional(),
      scopeType: z.enum(RESEARCH_SCOPE_TYPES).nullable().optional(),
      scopeId: z.string().nullable().optional(),
      lastVerifiedAt: z.string().nullable().optional(),
      expiresAt: z.string().nullable().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const workspace = await getDefaultWorkspace()
    if (!workspace) throw new Error('No active workspace found.')
    const db = getDb()
    const updated = await updateResearch(db, {
      workspaceId: workspace.id,
      id: data.id,
      ...(data.subject !== undefined ? { subject: data.subject } : {}),
      ...(data.findings !== undefined ? { findings: data.findings } : {}),
      ...(data.researchType !== undefined ? { researchType: data.researchType } : {}),
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.confidence !== undefined ? { confidence: data.confidence } : {}),
      ...(data.scopeType !== undefined ? { scopeType: data.scopeType } : {}),
      ...(data.scopeId !== undefined ? { scopeId: data.scopeId } : {}),
      ...(data.lastVerifiedAt !== undefined ? { lastVerifiedAt: data.lastVerifiedAt } : {}),
      ...(data.expiresAt !== undefined ? { expiresAt: data.expiresAt } : {}),
      actor: { actorType: 'user' },
    })
    return updated
  })

export const archiveResearchFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    const workspace = await getDefaultWorkspace()
    if (!workspace) throw new Error('No active workspace found.')
    const db = getDb()
    return archiveResearch(db, {
      workspaceId: workspace.id,
      id: data.id,
      actor: { actorType: 'user' },
    })
  })

export const restoreResearchFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    const workspace = await getDefaultWorkspace()
    if (!workspace) throw new Error('No active workspace found.')
    const db = getDb()
    return restoreResearch(db, {
      workspaceId: workspace.id,
      id: data.id,
      actor: { actorType: 'user' },
    })
  })

export const listResearchSourcesFn = createServerFn({ method: 'GET' })
  .validator((data: { researchId: string }) => data)
  .handler(async ({ data }): Promise<ResearchSourceRecord[]> => {
    const workspace = await getDefaultWorkspace()
    if (!workspace) return []
    const db = getDb()
    return listResearchSources(db, {
      workspaceId: workspace.id,
      researchId: data.researchId,
    })
  })

export const addResearchSourceFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      researchId: z.string().uuid(),
      sourceType: z.enum(RESEARCH_SOURCE_TYPES).default('website'),
      title: z.string().trim().min(1, 'Title is required').max(500),
      url: z.string().nullable().optional(),
      publisher: z.string().trim().nullable().optional(),
      publishedAt: z.string().nullable().optional(),
      retrievedAt: z.string().nullable().optional(),
      note: z.string().nullable().optional(),
      confidence: z.number().min(0).max(1).nullable().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const workspace = await getDefaultWorkspace()
    if (!workspace) throw new Error('No active workspace found.')
    const db = getDb()
    return createResearchSource(db, {
      workspaceId: workspace.id,
      researchId: data.researchId,
      sourceType: data.sourceType,
      title: data.title,
      ...(data.url !== undefined ? { url: data.url } : {}),
      ...(data.publisher !== undefined ? { publisher: data.publisher } : {}),
      ...(data.publishedAt !== undefined ? { publishedAt: data.publishedAt } : {}),
      ...(data.retrievedAt !== undefined ? { retrievedAt: data.retrievedAt } : {}),
      ...(data.note !== undefined ? { note: data.note } : {}),
      ...(data.confidence !== undefined ? { confidence: data.confidence } : {}),
      actor: { actorType: 'user' },
    })
  })

export const updateResearchSourceFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      researchId: z.string().uuid(),
      id: z.string().uuid(),
      sourceType: z.enum(RESEARCH_SOURCE_TYPES).optional(),
      title: z.string().trim().min(1, 'Title is required').max(500).optional(),
      url: z.string().nullable().optional(),
      publisher: z.string().trim().nullable().optional(),
      publishedAt: z.string().nullable().optional(),
      retrievedAt: z.string().nullable().optional(),
      note: z.string().nullable().optional(),
      confidence: z.number().min(0).max(1).nullable().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const workspace = await getDefaultWorkspace()
    if (!workspace) throw new Error('No active workspace found.')
    const db = getDb()
    return updateResearchSource(db, {
      workspaceId: workspace.id,
      researchId: data.researchId,
      id: data.id,
      ...(data.sourceType !== undefined ? { sourceType: data.sourceType } : {}),
      ...(data.title !== undefined ? { title: data.title } : {}),
      ...(data.url !== undefined ? { url: data.url } : {}),
      ...(data.publisher !== undefined ? { publisher: data.publisher } : {}),
      ...(data.publishedAt !== undefined ? { publishedAt: data.publishedAt } : {}),
      ...(data.retrievedAt !== undefined ? { retrievedAt: data.retrievedAt } : {}),
      ...(data.note !== undefined ? { note: data.note } : {}),
      ...(data.confidence !== undefined ? { confidence: data.confidence } : {}),
      actor: { actorType: 'user' },
    })
  })

export const removeResearchSourceFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      researchId: z.string().uuid(),
      id: z.string().uuid(),
    }),
  )
  .handler(async ({ data }) => {
    const workspace = await getDefaultWorkspace()
    if (!workspace) throw new Error('No active workspace found.')
    const db = getDb()
    return removeResearchSource(db, {
      workspaceId: workspace.id,
      researchId: data.researchId,
      id: data.id,
      actor: { actorType: 'user' },
    })
  })
