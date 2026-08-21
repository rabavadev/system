import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { resolveAiRuntime } from '~/server/ai/runtime'
import { type AccountSummary, listAccounts } from '~/server/db/account'
import { listAgents } from '~/server/db/agent'
import { listBrands } from '~/server/db/brand'
import {
  activateCampaign,
  archiveCampaign,
  type CampaignDetail,
  type CampaignSummary,
  completeCampaign,
  createCampaign,
  createCampaignInput,
  getCampaignDetail,
  getCampaignSummaryById,
  listArchivedCampaigns,
  listCampaigns,
  pauseCampaign,
  restoreCampaign,
  startCampaignWorkflowRun,
  updateCampaign,
  updateCampaignInput,
  updateCampaignStrategy,
  updateCampaignStrategyInput,
  updateCampaignTargets,
  updateCampaignTargetsInput,
} from '~/server/db/campaign'
import { getDb } from '~/server/db/client'
import {
  archiveCampaignContent,
  archiveCampaignContentInput,
  createCampaignContent,
  createCampaignContentInput,
  listCampaignContent,
  updateCampaignContent,
  updateCampaignContentInput,
} from '~/server/db/content'
import {
  type GenerateContentReviewResult,
  generateCampaignContentReview,
  listContentReviews,
  saveCampaignContentReview,
} from '~/server/db/content-review'
import {
  type ContentVariantDetail,
  type GenerateContentDraftResult,
  generateCampaignContentDraft,
  listContentVariants,
  saveCampaignContentDraft,
} from '~/server/db/content-variant'
import { createConversation } from '~/server/db/conversation'
import { emitEventSafe } from '~/server/db/event'
import { listProducts, type ProductSummary } from '~/server/db/product'
import { getWorkflowById, getWorkflowVersion, listWorkflows } from '~/server/db/workflow'
import { getDefaultWorkspace } from '~/server/db/workspace'
import type { WorkflowInputDecl } from '~/server/workflows/definition'
import { resolveWorkflowRuntime } from '~/server/workflows/runtime'
import type {
  Brand,
  CampaignContentItem,
  CampaignStatus,
  ContentReviewDetail,
  ContentStatus,
} from '~/types/domain'

const idWire = z.object({ id: z.uuid() })
const filterWire = z.object({
  brandId: z.uuid().optional(),
  productId: z.uuid().optional(),
  status: z.enum(['draft', 'active', 'paused', 'completed', 'archived']).optional(),
})

export interface CampaignsPageData {
  campaigns: CampaignSummary[]
  archivedCampaigns: CampaignSummary[]
  brands: Brand[]
  productsByBrand: Record<string, ProductSummary[]>
  allAccounts: AccountSummary[]
}

export const getCampaignsPageData = createServerFn({ method: 'GET' })
  .validator(filterWire)
  .handler(async ({ data }): Promise<CampaignsPageData> => {
    const db = getDb()
    const workspace = await getDefaultWorkspace()
    if (!workspace) {
      return {
        campaigns: [],
        archivedCampaigns: [],
        brands: [],
        productsByBrand: {},
        allAccounts: [],
      }
    }

    const [brands, products, allAccounts, campaigns, archivedCampaigns] = await Promise.all([
      listBrands(workspace.id),
      listProducts(workspace.id),
      listAccounts(workspace.id),
      listCampaigns(db, {
        workspaceId: workspace.id,
        brandId: data.brandId,
        productId: data.productId,
        status: data.status as CampaignStatus | undefined,
      }),
      listArchivedCampaigns(db, workspace.id),
    ])

    const productsByBrand: Record<string, ProductSummary[]> = {}
    for (const brand of brands) {
      productsByBrand[brand.id] = products.filter((p) => p.brandId === brand.id)
    }

    return {
      campaigns,
      archivedCampaigns,
      brands,
      productsByBrand,
      allAccounts,
    }
  })

export const getCampaignDetailData = createServerFn({ method: 'GET' })
  .validator(idWire)
  .handler(
    async ({
      data,
    }): Promise<{
      campaign: CampaignDetail
      brands: Brand[]
      productsByBrand: Record<string, ProductSummary[]>
      allAccounts: AccountSummary[]
      activeWorkflows: Array<{ id: string; name: string; description: string | null }>
    } | null> => {
      const db = getDb()
      const workspace = await getDefaultWorkspace()
      if (!workspace) return null

      const campaign = await getCampaignDetail(db, workspace.id, data.id)
      if (!campaign) return null

      const [brands, products, allAccounts, allWorkflows] = await Promise.all([
        listBrands(workspace.id),
        listProducts(workspace.id),
        listAccounts(workspace.id),
        listWorkflows(db, workspace.id),
      ])

      const productsByBrand: Record<string, ProductSummary[]> = {}
      for (const brand of brands) {
        productsByBrand[brand.id] = products.filter((p) => p.brandId === brand.id)
      }

      const activeWorkflows = allWorkflows
        .filter((w) => w.status === 'active')
        .map((w) => ({ id: w.id, name: w.name, description: w.description }))

      return {
        campaign,
        brands,
        productsByBrand,
        allAccounts,
        activeWorkflows,
      }
    },
  )

export const createCampaignFn = createServerFn({ method: 'POST' })
  .validator(createCampaignInput)
  .handler(async ({ data }): Promise<CampaignSummary> => {
    const db = getDb()
    return createCampaign(db, data)
  })

export const updateCampaignFn = createServerFn({ method: 'POST' })
  .validator(updateCampaignInput)
  .handler(async ({ data }): Promise<CampaignSummary> => {
    const db = getDb()
    return updateCampaign(db, data)
  })

export const updateCampaignStrategyFn = createServerFn({ method: 'POST' })
  .validator(updateCampaignStrategyInput)
  .handler(async ({ data }): Promise<CampaignSummary> => {
    const db = getDb()
    return updateCampaignStrategy(db, data)
  })

export const updateCampaignTargetsFn = createServerFn({ method: 'POST' })
  .validator(updateCampaignTargetsInput)
  .handler(async ({ data }): Promise<CampaignSummary> => {
    const db = getDb()
    return updateCampaignTargets(db, data)
  })

export const activateCampaignFn = createServerFn({ method: 'POST' })
  .validator(idWire)
  .handler(async ({ data }): Promise<CampaignSummary> => {
    const db = getDb()
    const workspace = await getDefaultWorkspace()
    if (!workspace) throw new Error('Workspace not found')
    return activateCampaign(db, { workspaceId: workspace.id, id: data.id })
  })

export const pauseCampaignFn = createServerFn({ method: 'POST' })
  .validator(idWire)
  .handler(async ({ data }): Promise<CampaignSummary> => {
    const db = getDb()
    const workspace = await getDefaultWorkspace()
    if (!workspace) throw new Error('Workspace not found')
    return pauseCampaign(db, { workspaceId: workspace.id, id: data.id })
  })

export const completeCampaignFn = createServerFn({ method: 'POST' })
  .validator(idWire)
  .handler(async ({ data }): Promise<CampaignSummary> => {
    const db = getDb()
    const workspace = await getDefaultWorkspace()
    if (!workspace) throw new Error('Workspace not found')
    return completeCampaign(db, { workspaceId: workspace.id, id: data.id })
  })

export const archiveCampaignFn = createServerFn({ method: 'POST' })
  .validator(idWire)
  .handler(async ({ data }): Promise<CampaignSummary> => {
    const db = getDb()
    const workspace = await getDefaultWorkspace()
    if (!workspace) throw new Error('Workspace not found')
    return archiveCampaign(db, { workspaceId: workspace.id, id: data.id })
  })

export const restoreCampaignFn = createServerFn({ method: 'POST' })
  .validator(idWire)
  .handler(async ({ data }): Promise<CampaignSummary> => {
    const db = getDb()
    const workspace = await getDefaultWorkspace()
    if (!workspace) throw new Error('Workspace not found')
    return restoreCampaign(db, { workspaceId: workspace.id, id: data.id })
  })

const listContentWire = z.object({
  campaignId: z.uuid(),
  status: z
    .enum(['idea', 'planned', 'draft', 'ready', 'in_review', 'approved', 'archived'])
    .optional(),
  includeArchived: z.boolean().optional(),
})

export const listCampaignContentFn = createServerFn({ method: 'GET' })
  .validator(listContentWire)
  .handler(async ({ data }): Promise<CampaignContentItem[]> => {
    const db = getDb()
    const workspace = await getDefaultWorkspace()
    if (!workspace) return []
    return listCampaignContent(db, {
      workspaceId: workspace.id,
      campaignId: data.campaignId,
      status: data.status as ContentStatus | undefined,
      includeArchived: data.includeArchived,
    })
  })

export const createCampaignContentFn = createServerFn({ method: 'POST' })
  .validator(createCampaignContentInput)
  .handler(async ({ data }): Promise<CampaignContentItem> => {
    const db = getDb()
    return createCampaignContent(db, data)
  })

export const updateCampaignContentFn = createServerFn({ method: 'POST' })
  .validator(updateCampaignContentInput)
  .handler(async ({ data }): Promise<CampaignContentItem> => {
    const db = getDb()
    return updateCampaignContent(db, data)
  })

export const archiveCampaignContentFn = createServerFn({ method: 'POST' })
  .validator(archiveCampaignContentInput)
  .handler(async ({ data }): Promise<CampaignContentItem> => {
    const db = getDb()
    return archiveCampaignContent(db, data)
  })

export const startCampaignResearchChatFn = createServerFn({ method: 'POST' })
  .validator(z.object({ campaignId: z.uuid() }))
  .handler(async ({ data }): Promise<{ conversationId: string; agentId: string | null }> => {
    const db = getDb()
    const workspace = await getDefaultWorkspace()
    if (!workspace) throw new Error('Workspace not found')

    const campaign = await getCampaignSummaryById(db, data.campaignId)
    if (!campaign || campaign.workspaceId !== workspace.id || campaign.deletedAt !== null) {
      throw new Error('Campaign not found or is archived.')
    }

    const agents = await listAgents(db, workspace.id)
    const researcher =
      agents.find((a) => a.role === 'researcher') ??
      agents.find((a) => a.name.toLowerCase() === 'researcher')
    const agentId = researcher?.id ?? null

    const conversation = await createConversation(db, {
      workspaceId: workspace.id,
      title: `Research: ${campaign.name}`,
      scopeType: 'campaign',
      scopeId: campaign.id,
    })

    await emitEventSafe(db, {
      workspaceId: workspace.id,
      eventType: 'campaign.research_started',
      actorType: 'user',
      subjectType: 'conversation',
      subjectId: conversation.id,
      payloadJson: JSON.stringify({
        campaignId: campaign.id,
        conversationId: conversation.id,
        agentId,
      }),
    })

    return {
      conversationId: conversation.id,
      agentId,
    }
  })

export const startCampaignWorkflowRunFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      campaignId: z.uuid(),
      workflowId: z.uuid(),
      inputs: z.record(z.string(), z.unknown()).default({}),
    }),
  )
  .handler(async ({ data }): Promise<{ ok: boolean; runId?: string; message?: string }> => {
    const db = getDb()
    const workspace = await getDefaultWorkspace()
    if (!workspace) return { ok: false, message: 'Workspace not found' }

    const { deps } = resolveAiRuntime()
    const engineDeps = { ai: deps }

    const started = await startCampaignWorkflowRun(
      db,
      {
        workspaceId: workspace.id,
        campaignId: data.campaignId,
        workflowId: data.workflowId,
        inputs: data.inputs,
      },
      engineDeps,
      false,
    )
    if (!started.ok || !started.runId) return started
    await resolveWorkflowRuntime().drive(db, started.runId, engineDeps)
    return started
  })

export const getWorkflowInputDeclsFn = createServerFn({ method: 'GET' })
  .validator(z.object({ workflowId: z.uuid() }))
  .handler(async ({ data }): Promise<WorkflowInputDecl[]> => {
    const db = getDb()
    const workflow = await getWorkflowById(db, data.workflowId)
    if (!workflow?.currentVersionId) return []
    const version = await getWorkflowVersion(db, workflow.currentVersionId)
    if (!version) return []
    try {
      const parsed = JSON.parse(version.definitionJson)
      return Array.isArray(parsed.inputs) ? parsed.inputs : []
    } catch {
      return []
    }
  })

export const generateCampaignContentDraftFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      campaignId: z.uuid(),
      contentId: z.uuid(),
    }),
  )
  .handler(async ({ data }): Promise<GenerateContentDraftResult> => {
    const db = getDb()
    const workspace = await getDefaultWorkspace()
    if (!workspace) {
      return { ok: false, errorCode: 'workspace_not_found', message: 'Workspace not found' }
    }
    const { deps } = resolveAiRuntime()
    return generateCampaignContentDraft(
      db,
      {
        workspaceId: workspace.id,
        campaignId: data.campaignId,
        contentId: data.contentId,
      },
      deps,
    )
  })

export const saveCampaignContentDraftFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      campaignId: z.uuid(),
      contentId: z.uuid(),
      candidateId: z.uuid(),
      draft: z.object({
        headline: z.string().nullable().optional(),
        body: z.string().min(1, 'Draft body cannot be empty'),
        callToAction: z.string().nullable().optional(),
        creativeDirection: z.string().nullable().optional(),
        notes: z.string().nullable().optional(),
      }),
    }),
  )
  .handler(
    async ({
      data,
    }): Promise<{ variant: ContentVariantDetail; contentItem: CampaignContentItem }> => {
      const db = getDb()
      const workspace = await getDefaultWorkspace()
      if (!workspace) throw new Error('Workspace not found')
      return saveCampaignContentDraft(db, {
        workspaceId: workspace.id,
        campaignId: data.campaignId,
        contentId: data.contentId,
        candidateId: data.candidateId,
        draft: data.draft,
      })
    },
  )

export const listContentVariantsFn = createServerFn({ method: 'GET' })
  .validator(z.object({ contentId: z.uuid() }))
  .handler(async ({ data }): Promise<ContentVariantDetail[]> => {
    const db = getDb()
    const workspace = await getDefaultWorkspace()
    if (!workspace) return []
    return listContentVariants(db, workspace.id, data.contentId)
  })

export const generateCampaignContentReviewFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      campaignId: z.uuid(),
      contentId: z.uuid(),
      contentVariantId: z.uuid(),
    }),
  )
  .handler(async ({ data }): Promise<GenerateContentReviewResult> => {
    const db = getDb()
    const workspace = await getDefaultWorkspace()
    if (!workspace) {
      return { ok: false, errorCode: 'workspace_not_found', message: 'Workspace not found' }
    }
    const { deps } = resolveAiRuntime()
    return generateCampaignContentReview(
      db,
      {
        workspaceId: workspace.id,
        campaignId: data.campaignId,
        contentId: data.contentId,
        contentVariantId: data.contentVariantId,
      },
      deps,
    )
  })

export const saveCampaignContentReviewFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      campaignId: z.uuid(),
      contentId: z.uuid(),
      contentVariantId: z.uuid(),
      verdict: z.enum(['pass', 'revise']),
      review: z.object({
        verdict: z.enum(['pass', 'revise']),
        summary: z.string().min(1, 'Review summary cannot be empty'),
        strengths: z.array(z.string()).default([]),
        issues: z
          .array(
            z.object({
              category: z.string(),
              severity: z.enum(['low', 'medium', 'high']),
              message: z.string(),
            }),
          )
          .default([]),
        recommendedChanges: z.array(z.string()).default([]),
      }),
      provenance: z
        .object({
          criticAgentId: z.string().uuid(),
          criticAgentName: z.string(),
          criticAgentVersionId: z.string().uuid(),
          versionNumber: z.number(),
          executionId: z.string().uuid(),
          model: z.string(),
          createdAt: z.string(),
        })
        .nullable()
        .optional(),
    }),
  )
  .handler(async ({ data }): Promise<ContentReviewDetail> => {
    const db = getDb()
    const workspace = await getDefaultWorkspace()
    if (!workspace) throw new Error('Workspace not found')
    return saveCampaignContentReview(db, {
      workspaceId: workspace.id,
      campaignId: data.campaignId,
      contentId: data.contentId,
      contentVariantId: data.contentVariantId,
      verdict: data.verdict,
      review: data.review,
      provenance: data.provenance,
    })
  })

export const listContentReviewsFn = createServerFn({ method: 'GET' })
  .validator(z.object({ contentVariantId: z.uuid() }))
  .handler(async ({ data }): Promise<ContentReviewDetail[]> => {
    const db = getDb()
    const workspace = await getDefaultWorkspace()
    if (!workspace) return []
    return listContentReviews(db, workspace.id, data.contentVariantId)
  })
