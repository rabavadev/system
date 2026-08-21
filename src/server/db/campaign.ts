import { z } from 'zod'

import type {
  Campaign,
  CampaignAudience,
  CampaignContentItem,
  CampaignMetricKey,
  CampaignObjective,
  CampaignPriority,
  CampaignStatus,
  CampaignStrategy,
  CampaignTarget,
  WorkflowRunStatus,
} from '../../types/domain.ts'
import { researchFreshness } from '../context/freshness.ts'
import {
  type StartRunResult,
  startWorkflowRun,
  type WorkflowEngineDeps,
} from '../workflows/engine.ts'
import { writeAuditLog } from './audit.ts'
import { listCampaignContent } from './content.ts'
import { emitEventSafe } from './event.ts'
import { ensureBuiltinMetrics, findMetricDefinitionByKey } from './metric.ts'
import { IntegrityError, requireActiveBrand, requireProductForBrand } from './relations.ts'
import {
  computeProvenanceSummary,
  listResearchSources,
  type ProvenanceSummary,
} from './research.ts'
import { execute, newId, nowIso, queryAll, queryFirst, type SqlDatabase } from './sql.ts'
import { getWorkflowById } from './workflow.ts'

interface CampaignRow {
  id: string
  workspace_id: string
  brand_id: string | null
  product_id: string | null
  goal_id: string | null
  name: string
  audience: string | null
  angle: string | null
  objective: CampaignObjective | null
  priority: CampaignPriority
  positioning: string | null
  offer_message: string | null
  hypothesis: string | null
  audience_json: string | null
  targets_json: string | null
  status: CampaignStatus
  starts_at: string | null
  ends_at: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export function parseCampaignAudience(row: {
  audience: string | null
  audience_json?: string | null
  audienceJson?: string | null
}): CampaignAudience {
  const rawJson = row.audience_json ?? row.audienceJson
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson)
      if (parsed && typeof parsed === 'object') {
        return {
          summary: typeof parsed.summary === 'string' ? parsed.summary : (row.audience ?? ''),
          problem: typeof parsed.problem === 'string' ? parsed.problem : null,
          awarenessLevel: parsed.awarenessLevel ?? null,
          geography: typeof parsed.geography === 'string' ? parsed.geography : null,
          notes: typeof parsed.notes === 'string' ? parsed.notes : null,
        }
      }
    } catch {
      // ignore JSON parse error and fallback
    }
  }
  return {
    summary: row.audience ?? '',
    problem: null,
    awarenessLevel: null,
    geography: null,
    notes: null,
  }
}

export function parseCampaignStrategy(row: {
  positioning?: string | null
  angle?: string | null
  offer_message?: string | null
  offerMessage?: string | null
  hypothesis?: string | null
}): CampaignStrategy {
  return {
    positioning: row.positioning ?? null,
    coreAngle: row.angle ?? null,
    offerMessage: row.offer_message ?? row.offerMessage ?? null,
    hypothesis: row.hypothesis ?? null,
  }
}

export function parseCampaignTargets(row: {
  targets_json?: string | null
  targetsJson?: string | null
}): CampaignTarget[] {
  const rawJson = row.targets_json ?? row.targetsJson
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson)
      if (Array.isArray(parsed)) {
        return parsed
          .map((t, idx) => ({
            id: t.id || newId(),
            metricKey: t.metricKey as CampaignMetricKey,
            targetValue: Number(t.targetValue),
            unit: t.unit ?? null,
            isPrimary: Boolean(t.isPrimary),
            orderIndex: typeof t.orderIndex === 'number' ? t.orderIndex : idx,
          }))
          .sort(
            (a, b) => (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0) || a.orderIndex - b.orderIndex,
          )
      }
    } catch {
      // ignore
    }
  }
  return []
}

function toCampaign(row: CampaignRow): Campaign {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    brandId: row.brand_id,
    productId: row.product_id,
    goalId: row.goal_id,
    name: row.name,
    audience: row.audience,
    angle: row.angle,
    objective: row.objective ?? null,
    priority: row.priority ?? 'normal',
    positioning: row.positioning ?? null,
    offerMessage: row.offer_message ?? null,
    hypothesis: row.hypothesis ?? null,
    audienceJson: row.audience_json ?? null,
    targetsJson: row.targets_json ?? null,
    status: row.status,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }
}

export interface CampaignAccountItem {
  id: string
  handle: string
  displayName: string | null
  platformId: string
  platformName: string
  status: string
}

export interface CampaignSummary extends Campaign {
  brandName: string
  productName: string | null
  accountCount: number
  accountHandles: string[]
}

export interface CampaignResearchItem {
  id: string
  subject: string
  researchType: string
  status: string
  freshness: 'current' | 'aging' | 'stale' | 'expired'
  provenance: ProvenanceSummary
  scopeType: string | null
  scopeId: string | null
  createdAt: string
}

export interface CampaignWorkflowRunItem {
  id: string
  workflowId: string
  workflowName: string
  status: WorkflowRunStatus
  triggerType: string
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
  error: string | null
  hasWaitingApproval: boolean
  pendingApprovalId: string | null
}

export interface CampaignDetail extends CampaignSummary {
  accounts: CampaignAccountItem[]
  audienceDetails: CampaignAudience
  strategy: CampaignStrategy
  targets: CampaignTarget[]
  primaryTarget: CampaignTarget | null
  supportingTargets: CampaignTarget[]
  researchCount: number
  recentResearch: CampaignResearchItem[]
  contentCount: number
  contentItems: CampaignContentItem[]
  recentWorkflowRuns: CampaignWorkflowRunItem[]
}

export const campaignObjectiveSchema = z.enum([
  'revenue',
  'conversions',
  'traffic',
  'leads',
  'awareness',
  'engagement',
  'retention',
  'validation',
])

export const campaignPrioritySchema = z.enum(['high', 'normal', 'low'])

export const audienceAwarenessLevelSchema = z.enum([
  'unaware',
  'problem_aware',
  'solution_aware',
  'product_aware',
  'most_aware',
])

export const campaignAudienceSchema = z.object({
  summary: z.string().trim().max(2000),
  problem: z.string().trim().max(2000).nullish(),
  awarenessLevel: audienceAwarenessLevelSchema.nullish(),
  geography: z.string().trim().max(500).nullish(),
  notes: z.string().trim().max(2000).nullish(),
})

export const campaignStrategySchema = z.object({
  positioning: z.string().trim().max(2000).nullish(),
  coreAngle: z.string().trim().max(2000).nullish(),
  offerMessage: z.string().trim().max(2000).nullish(),
  hypothesis: z.string().trim().max(2000).nullish(),
})

export const campaignTargetInputSchema = z
  .object({
    id: z.string().uuid().optional(),
    metricKey: z.string().trim().min(1, 'Metric key is required.').max(100),
    targetValue: z.number().finite().min(0, 'Target value must be non-negative.'),
    unit: z.string().trim().max(50).nullish(),
    isPrimary: z.boolean().default(false),
    orderIndex: z.number().int().default(0),
  })
  .refine(
    (t) => {
      if (t.metricKey === 'conversion_rate' || t.metricKey === 'ctr') {
        return t.targetValue >= 0 && t.targetValue <= 100
      }
      return true
    },
    { message: 'Percentage metrics must be between 0 and 100.' },
  )

export const campaignTargetsListSchema = z.array(campaignTargetInputSchema).refine(
  (targets) => {
    if (targets.length === 0) return true
    const primaryCount = targets.filter((t) => t.isPrimary).length
    return primaryCount === 1
  },
  { message: 'Exactly one target must be marked as Primary KPI.' },
)

export const createCampaignInput = z
  .object({
    workspaceId: z.uuid(),
    brandId: z.uuid(),
    productId: z.uuid().nullish(),
    goalId: z.uuid().nullish(),
    name: z.string().trim().min(1, 'Give the campaign a name.').max(200),
    audience: z.string().trim().max(2000).nullish(),
    angle: z.string().trim().max(2000).nullish(),
    objective: campaignObjectiveSchema.nullish(),
    priority: campaignPrioritySchema.default('normal'),
    positioning: z.string().trim().max(2000).nullish(),
    offerMessage: z.string().trim().max(2000).nullish(),
    hypothesis: z.string().trim().max(2000).nullish(),
    audienceDetails: campaignAudienceSchema.nullish(),
    targets: campaignTargetsListSchema.nullish(),
    status: z.enum(['draft', 'active', 'paused', 'completed', 'archived']).default('draft'),
    startsAt: z.iso.datetime({ offset: false }).nullish(),
    endsAt: z.iso.datetime({ offset: false }).nullish(),
    accountIds: z.array(z.uuid()).default([]),
  })
  .refine((data) => !data.startsAt || !data.endsAt || data.endsAt >= data.startsAt, {
    message: 'End date must be on or after start date.',
  })
export type CreateCampaignInput = z.input<typeof createCampaignInput>

export const updateCampaignInput = z
  .object({
    id: z.uuid(),
    workspaceId: z.uuid().optional(),
    brandId: z.uuid().optional(),
    productId: z.uuid().nullish(),
    goalId: z.uuid().nullish(),
    name: z.string().trim().min(1, 'Give the campaign a name.').max(200).optional(),
    audience: z.string().trim().max(2000).nullish(),
    angle: z.string().trim().max(2000).nullish(),
    objective: campaignObjectiveSchema.nullish(),
    priority: campaignPrioritySchema.optional(),
    positioning: z.string().trim().max(2000).nullish(),
    offerMessage: z.string().trim().max(2000).nullish(),
    hypothesis: z.string().trim().max(2000).nullish(),
    audienceDetails: campaignAudienceSchema.nullish(),
    targets: campaignTargetsListSchema.nullish(),
    status: z.enum(['draft', 'active', 'paused', 'completed', 'archived']).optional(),
    startsAt: z.iso.datetime({ offset: false }).nullish(),
    endsAt: z.iso.datetime({ offset: false }).nullish(),
    accountIds: z.array(z.uuid()).optional(),
  })
  .refine((data) => !data.startsAt || !data.endsAt || data.endsAt >= data.startsAt, {
    message: 'End date must be on or after start date.',
  })
export type UpdateCampaignInput = z.input<typeof updateCampaignInput>

export const updateCampaignStrategyInput = z.object({
  workspaceId: z.uuid(),
  id: z.uuid(),
  objective: campaignObjectiveSchema.nullish(),
  priority: campaignPrioritySchema.optional(),
  positioning: z.string().trim().max(2000).nullish(),
  angle: z.string().trim().max(2000).nullish(),
  offerMessage: z.string().trim().max(2000).nullish(),
  hypothesis: z.string().trim().max(2000).nullish(),
  audience: campaignAudienceSchema.or(z.string().trim().max(2000)).nullish(),
})
export type UpdateCampaignStrategyInput = z.input<typeof updateCampaignStrategyInput>

export const updateCampaignTargetsInput = z.object({
  workspaceId: z.uuid(),
  id: z.uuid(),
  targets: campaignTargetsListSchema,
})
export type UpdateCampaignTargetsInput = z.input<typeof updateCampaignTargetsInput>

/** Validate accounts list and return unique IDs */
async function validateAccounts(
  db: SqlDatabase,
  workspaceId: string,
  accountIds: string[],
): Promise<string[]> {
  const unique = Array.from(new Set(accountIds))
  for (const accountId of unique) {
    const acc = await queryFirst<{ id: string; workspace_id: string; deleted_at: string | null }>(
      db,
      `SELECT id, workspace_id, deleted_at FROM account WHERE id = ?`,
      [accountId],
    )
    if (!acc || acc.workspace_id !== workspaceId || acc.deleted_at !== null) {
      throw new IntegrityError('Account not found in this workspace.')
    }
  }
  return unique
}

/** Synchronize accounts for a campaign */
async function syncCampaignAccounts(
  db: SqlDatabase,
  campaignId: string,
  accountIds: string[],
): Promise<void> {
  await execute(db, `DELETE FROM campaign_account WHERE campaign_id = ?`, [campaignId])
  const now = nowIso()
  for (const accountId of accountIds) {
    await execute(
      db,
      `INSERT OR IGNORE INTO campaign_account (campaign_id, account_id, created_at) VALUES (?, ?, ?)`,
      [campaignId, accountId, now],
    )
  }
}

export async function createCampaign(
  db: SqlDatabase,
  rawInput: CreateCampaignInput,
): Promise<CampaignSummary> {
  const data = createCampaignInput.parse(rawInput)

  // 1. Validate Brand
  const brandRow = await queryFirst<{
    id: string
    workspace_id: string
    deleted_at: string | null
  }>(db, `SELECT id, workspace_id, deleted_at FROM brand WHERE id = ?`, [data.brandId])
  if (!brandRow || brandRow.workspace_id !== data.workspaceId) {
    throw new IntegrityError('Brand not found in this workspace.')
  }
  requireActiveBrand({
    id: brandRow.id,
    workspaceId: brandRow.workspace_id,
    name: '',
    description: null,
    createdAt: '',
    updatedAt: '',
    deletedAt: brandRow.deleted_at,
  })

  // 2. Validate Product if specified
  if (data.productId) {
    const prodRow = await queryFirst<{ id: string; brand_id: string; deleted_at: string | null }>(
      db,
      `SELECT id, brand_id, deleted_at FROM product WHERE id = ?`,
      [data.productId],
    )
    if (!prodRow) {
      throw new IntegrityError('Product not found.')
    }
    requireProductForBrand(
      {
        id: prodRow.id,
        brandId: prodRow.brand_id,
        nicheId: null,
        name: '',
        description: null,
        url: null,
        status: 'active',
        createdAt: '',
        updatedAt: '',
        deletedAt: prodRow.deleted_at,
      },
      data.brandId,
    )
  }

  // 3. Validate Accounts
  const validAccountIds = await validateAccounts(db, data.workspaceId, data.accountIds ?? [])

  // 4. Validate Targets against canonical metric_definition registry
  if (data.targets && data.targets.length > 0) {
    await validateCampaignTargets(db, data.workspaceId, data.targets)
  }

  let audienceSummary = data.audience ?? null
  let audienceJson: string | null = null
  if (data.audienceDetails) {
    audienceSummary = data.audienceDetails.summary
    audienceJson = JSON.stringify(data.audienceDetails)
  } else if (data.audience) {
    audienceJson = JSON.stringify({ summary: data.audience })
  }

  let targetsJson: string | null = null
  if (data.targets && data.targets.length > 0) {
    const formattedTargets: CampaignTarget[] = data.targets.map((t, idx) => ({
      id: t.id || newId(),
      metricKey: t.metricKey,
      targetValue: t.targetValue,
      unit: t.unit ?? null,
      isPrimary: t.isPrimary,
      orderIndex: typeof t.orderIndex === 'number' ? t.orderIndex : idx,
    }))
    targetsJson = JSON.stringify(formattedTargets)
  }

  const id = newId()
  const now = nowIso()
  await execute(
    db,
    `INSERT INTO campaign (
       id, workspace_id, brand_id, product_id, goal_id, name, audience, angle,
       objective, priority, positioning, offer_message, hypothesis, audience_json, targets_json,
       status, starts_at, ends_at, created_at, updated_at, deleted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      id,
      data.workspaceId,
      data.brandId,
      data.productId ?? null,
      data.goalId ?? null,
      data.name,
      audienceSummary,
      data.angle ?? null,
      data.objective ?? null,
      data.priority ?? 'normal',
      data.positioning ?? null,
      data.offerMessage ?? null,
      data.hypothesis ?? null,
      audienceJson,
      targetsJson,
      data.status,
      data.startsAt ?? null,
      data.endsAt ?? null,
      now,
      now,
    ],
  )

  // 5. Link accounts
  if (validAccountIds.length > 0) {
    await syncCampaignAccounts(db, id, validAccountIds)
  }

  // 6. Audit log & Event
  await writeAuditLog(db, {
    workspaceId: data.workspaceId,
    entityType: 'campaign',
    entityId: id,
    action: 'create',
    actorType: 'user',
    newValueJson: JSON.stringify({
      id,
      name: data.name,
      brandId: data.brandId,
      status: data.status,
      objective: data.objective,
      priority: data.priority,
    }),
  })

  await emitEventSafe(db, {
    workspaceId: data.workspaceId,
    eventType: 'campaign.created',
    subjectType: 'campaign',
    subjectId: id,
    payloadJson: JSON.stringify({
      campaignId: id,
      brandId: data.brandId,
      status: data.status,
      name: data.name,
    }),
  })

  const summary = await getCampaignSummaryById(db, id)
  if (!summary) throw new Error('Failed to load created campaign summary')
  return summary
}

export async function updateCampaign(
  db: SqlDatabase,
  rawInput: UpdateCampaignInput,
): Promise<CampaignSummary> {
  const data = updateCampaignInput.parse(rawInput)

  const existing = await queryFirst<CampaignRow>(db, `SELECT * FROM campaign WHERE id = ?`, [
    data.id,
  ])
  if (!existing) {
    throw new IntegrityError('Campaign not found in this workspace.')
  }

  const workspaceId = data.workspaceId ?? existing.workspace_id
  if (existing.workspace_id !== workspaceId) {
    throw new IntegrityError('Cannot update campaign from another workspace.')
  }

  const targetBrandId = data.brandId ?? existing.brand_id
  if (!targetBrandId) {
    throw new IntegrityError('Campaign must belong to a brand.')
  }

  // Validate brand if changing or confirming
  const brandRow = await queryFirst<{
    id: string
    workspace_id: string
    deleted_at: string | null
  }>(db, `SELECT id, workspace_id, deleted_at FROM brand WHERE id = ?`, [targetBrandId])
  if (!brandRow || brandRow.workspace_id !== workspaceId) {
    throw new IntegrityError('Brand not found in this workspace.')
  }
  requireActiveBrand({
    id: brandRow.id,
    workspaceId: brandRow.workspace_id,
    name: '',
    description: null,
    createdAt: '',
    updatedAt: '',
    deletedAt: brandRow.deleted_at,
  })

  // Validate product if changing
  const targetProductId = data.productId !== undefined ? data.productId : existing.product_id
  if (targetProductId) {
    const prodRow = await queryFirst<{
      id: string
      brand_id: string
      niche_id: string | null
      name: string
      description: string | null
      url: string | null
      status: 'draft' | 'active' | 'archived'
      created_at: string
      updated_at: string
      deleted_at: string | null
    }>(db, `SELECT * FROM product WHERE id = ?`, [targetProductId])
    if (!prodRow) {
      throw new IntegrityError('Product not found.')
    }
    requireProductForBrand(
      {
        id: prodRow.id,
        brandId: prodRow.brand_id,
        nicheId: prodRow.niche_id,
        name: prodRow.name,
        description: prodRow.description,
        url: prodRow.url,
        status: prodRow.status,
        createdAt: prodRow.created_at,
        updatedAt: prodRow.updated_at,
        deletedAt: prodRow.deleted_at,
      },
      targetBrandId,
    )
  }

  // Validate and sync accounts if provided
  if (data.accountIds !== undefined) {
    const validAccountIds = await validateAccounts(db, workspaceId, data.accountIds)
    await syncCampaignAccounts(db, data.id, validAccountIds)
  }

  let audienceSummary = data.audience !== undefined ? data.audience : existing.audience
  let audienceJson = existing.audience_json
  if (data.audienceDetails) {
    audienceSummary = data.audienceDetails.summary
    audienceJson = JSON.stringify(data.audienceDetails)
  } else if (data.audience !== undefined) {
    audienceJson = data.audience ? JSON.stringify({ summary: data.audience }) : null
  }

  let targetsJson = existing.targets_json
  if (data.targets !== undefined) {
    if (data.targets && data.targets.length > 0) {
      await validateCampaignTargets(db, workspaceId, data.targets)
      const formattedTargets: CampaignTarget[] = data.targets.map((t, idx) => ({
        id: t.id || newId(),
        metricKey: t.metricKey,
        targetValue: t.targetValue,
        unit: t.unit ?? null,
        isPrimary: t.isPrimary,
        orderIndex: typeof t.orderIndex === 'number' ? t.orderIndex : idx,
      }))
      targetsJson = JSON.stringify(formattedTargets)
    } else {
      targetsJson = null
    }
  }

  const now = nowIso()
  const nextName = data.name ?? existing.name
  const nextAngle = data.angle !== undefined ? data.angle : existing.angle
  const nextObjective = data.objective !== undefined ? data.objective : existing.objective
  const nextPriority = data.priority !== undefined ? data.priority : existing.priority
  const nextPositioning = data.positioning !== undefined ? data.positioning : existing.positioning
  const nextOfferMessage =
    data.offerMessage !== undefined ? data.offerMessage : existing.offer_message
  const nextHypothesis = data.hypothesis !== undefined ? data.hypothesis : existing.hypothesis
  const nextStatus = data.status ?? existing.status
  const nextStartsAt = data.startsAt !== undefined ? data.startsAt : existing.starts_at
  const nextEndsAt = data.endsAt !== undefined ? data.endsAt : existing.ends_at
  const nextGoalId = data.goalId !== undefined ? data.goalId : existing.goal_id

  await execute(
    db,
    `UPDATE campaign
     SET brand_id = ?, product_id = ?, goal_id = ?, name = ?, audience = ?, angle = ?,
         objective = ?, priority = ?, positioning = ?, offer_message = ?, hypothesis = ?,
         audience_json = ?, targets_json = ?, status = ?, starts_at = ?, ends_at = ?, updated_at = ?
     WHERE id = ?`,
    [
      targetBrandId,
      targetProductId ?? null,
      nextGoalId ?? null,
      nextName,
      audienceSummary ?? null,
      nextAngle ?? null,
      nextObjective ?? null,
      nextPriority,
      nextPositioning ?? null,
      nextOfferMessage ?? null,
      nextHypothesis ?? null,
      audienceJson ?? null,
      targetsJson ?? null,
      nextStatus,
      nextStartsAt ?? null,
      nextEndsAt ?? null,
      now,
      data.id,
    ],
  )

  const updated = await getCampaignSummaryById(db, data.id)
  if (!updated) {
    throw new Error('campaign update did not produce a readable summary')
  }

  await writeAuditLog(db, {
    workspaceId,
    entityType: 'campaign',
    entityId: data.id,
    action: 'update',
    actorType: 'user',
    previousValueJson: JSON.stringify({
      name: existing.name,
      brandId: existing.brand_id,
      productId: existing.product_id,
      status: existing.status,
      objective: existing.objective,
      priority: existing.priority,
    }),
    newValueJson: JSON.stringify({
      name: updated.name,
      brandId: updated.brandId,
      productId: updated.productId,
      status: updated.status,
      objective: updated.objective,
      priority: updated.priority,
    }),
  })

  await emitEventSafe(db, {
    workspaceId,
    eventType: 'campaign.updated',
    actorType: 'user',
    subjectType: 'campaign',
    subjectId: data.id,
    payloadJson: JSON.stringify({
      name: updated.name,
      brandId: updated.brandId,
      productId: updated.productId,
      status: updated.status,
      objective: updated.objective,
      priority: updated.priority,
    }),
  })

  return updated
}

export async function updateCampaignStrategy(
  db: SqlDatabase,
  rawInput: UpdateCampaignStrategyInput,
): Promise<CampaignDetail> {
  const data = updateCampaignStrategyInput.parse(rawInput)
  const existing = await queryFirst<CampaignRow>(db, `SELECT * FROM campaign WHERE id = ?`, [
    data.id,
  ])
  if (!existing || existing.workspace_id !== data.workspaceId) {
    throw new IntegrityError('Campaign not found in this workspace.')
  }

  let audienceSummary = existing.audience
  let audienceJson = existing.audience_json
  if (data.audience !== undefined) {
    if (typeof data.audience === 'string') {
      audienceSummary = data.audience
      audienceJson = data.audience ? JSON.stringify({ summary: data.audience }) : null
    } else if (data.audience) {
      audienceSummary = data.audience.summary
      audienceJson = JSON.stringify(data.audience)
    } else {
      audienceSummary = null
      audienceJson = null
    }
  }

  const nextObjective = data.objective !== undefined ? data.objective : existing.objective
  const nextPriority = data.priority !== undefined ? data.priority : existing.priority
  const nextPositioning = data.positioning !== undefined ? data.positioning : existing.positioning
  const nextAngle = data.angle !== undefined ? data.angle : existing.angle
  const nextOfferMessage =
    data.offerMessage !== undefined ? data.offerMessage : existing.offer_message
  const nextHypothesis = data.hypothesis !== undefined ? data.hypothesis : existing.hypothesis

  const now = nowIso()
  await execute(
    db,
    `UPDATE campaign
     SET objective = ?, priority = ?, positioning = ?, angle = ?, offer_message = ?,
         hypothesis = ?, audience = ?, audience_json = ?, updated_at = ?
     WHERE id = ?`,
    [
      nextObjective ?? null,
      nextPriority,
      nextPositioning ?? null,
      nextAngle ?? null,
      nextOfferMessage ?? null,
      nextHypothesis ?? null,
      audienceSummary ?? null,
      audienceJson ?? null,
      now,
      data.id,
    ],
  )

  await writeAuditLog(db, {
    workspaceId: data.workspaceId,
    entityType: 'campaign',
    entityId: data.id,
    action: 'update',
    actorType: 'user',
    newValueJson: JSON.stringify({
      objective: nextObjective,
      priority: nextPriority,
      positioning: nextPositioning,
      angle: nextAngle,
      hypothesis: nextHypothesis,
    }),
  })

  await emitEventSafe(db, {
    workspaceId: data.workspaceId,
    eventType: 'campaign.strategy_updated',
    subjectType: 'campaign',
    subjectId: data.id,
    payloadJson: JSON.stringify({
      campaignId: data.id,
      objective: nextObjective,
      priority: nextPriority,
    }),
  })

  const detail = await getCampaignDetail(db, data.workspaceId, data.id)
  if (!detail) throw new Error('Failed to load updated campaign detail')
  return detail
}

export async function updateCampaignTargets(
  db: SqlDatabase,
  rawInput: UpdateCampaignTargetsInput,
): Promise<CampaignDetail> {
  const data = updateCampaignTargetsInput.parse(rawInput)
  const existing = await queryFirst<CampaignRow>(db, `SELECT * FROM campaign WHERE id = ?`, [
    data.id,
  ])
  if (!existing || existing.workspace_id !== data.workspaceId) {
    throw new IntegrityError('Campaign not found in this workspace.')
  }

  // Validate Targets against canonical metric_definition registry
  await validateCampaignTargets(db, data.workspaceId, data.targets)

  const formattedTargets: CampaignTarget[] = data.targets.map((t, idx) => ({
    id: t.id || newId(),
    metricKey: t.metricKey,
    targetValue: t.targetValue,
    unit: t.unit ?? null,
    isPrimary: t.isPrimary,
    orderIndex: typeof t.orderIndex === 'number' ? t.orderIndex : idx,
  }))

  const targetsJson = formattedTargets.length > 0 ? JSON.stringify(formattedTargets) : null
  const now = nowIso()

  await execute(
    db,
    `UPDATE campaign
     SET targets_json = ?, updated_at = ?
     WHERE id = ?`,
    [targetsJson, now, data.id],
  )

  await writeAuditLog(db, {
    workspaceId: data.workspaceId,
    entityType: 'campaign',
    entityId: data.id,
    action: 'update',
    actorType: 'user',
    newValueJson: JSON.stringify({
      targetsCount: formattedTargets.length,
      primaryMetric: formattedTargets.find((t) => t.isPrimary)?.metricKey ?? null,
    }),
  })

  await emitEventSafe(db, {
    workspaceId: data.workspaceId,
    eventType: 'campaign.targets_updated',
    subjectType: 'campaign',
    subjectId: data.id,
    payloadJson: JSON.stringify({
      campaignId: data.id,
      targetsCount: formattedTargets.length,
      primaryMetric: formattedTargets.find((t) => t.isPrimary)?.metricKey ?? null,
    }),
  })

  const detail = await getCampaignDetail(db, data.workspaceId, data.id)
  if (!detail) throw new Error('Failed to load updated campaign detail')
  return detail
}

async function transitionCampaignStatus(
  db: SqlDatabase,
  params: { workspaceId: string; id: string },
  nextStatus: CampaignStatus = 'active',
  eventType: string = 'campaign.updated',
  auditAction: 'create' | 'update' | 'delete' | 'restore' = 'update',
  nowOverride?: string,
): Promise<CampaignSummary> {
  const existing = await queryFirst<CampaignRow>(db, `SELECT * FROM campaign WHERE id = ?`, [
    params.id,
  ])
  if (!existing) {
    throw new IntegrityError('Campaign not found in this workspace.')
  }
  if (existing.workspace_id !== params.workspaceId) {
    throw new IntegrityError('Cannot modify campaign from another workspace.')
  }

  const now = nowOverride ?? nowIso()
  const deletedAt = nextStatus === 'archived' ? now : null

  await execute(
    db,
    `UPDATE campaign
     SET status = ?, deleted_at = ?, updated_at = ?
     WHERE id = ?`,
    [nextStatus, deletedAt, now, params.id],
  )

  const updated = await getCampaignSummaryById(db, params.id)
  if (!updated) {
    throw new Error('campaign status transition did not produce a summary')
  }

  await writeAuditLog(db, {
    workspaceId: params.workspaceId,
    entityType: 'campaign',
    entityId: params.id,
    action: auditAction,
    actorType: 'user',
    previousValueJson: JSON.stringify({ status: existing.status }),
    newValueJson: JSON.stringify({ status: updated.status }),
  })

  await emitEventSafe(db, {
    workspaceId: params.workspaceId,
    eventType,
    actorType: 'user',
    subjectType: 'campaign',
    subjectId: params.id,
    payloadJson: JSON.stringify({
      id: updated.id,
      status: updated.status,
    }),
  })

  return updated
}

export async function activateCampaign(
  db: SqlDatabase,
  params: { workspaceId: string; id: string },
): Promise<CampaignSummary> {
  return transitionCampaignStatus(db, params, 'active', 'campaign.activated')
}

export async function pauseCampaign(
  db: SqlDatabase,
  params: { workspaceId: string; id: string },
): Promise<CampaignSummary> {
  return transitionCampaignStatus(db, params, 'paused', 'campaign.paused')
}

export async function completeCampaign(
  db: SqlDatabase,
  params: { workspaceId: string; id: string },
): Promise<CampaignSummary> {
  return transitionCampaignStatus(db, params, 'completed', 'campaign.completed')
}

export async function archiveCampaign(
  db: SqlDatabase,
  params: { workspaceId: string; id: string },
): Promise<CampaignSummary> {
  return transitionCampaignStatus(db, params, 'archived', 'campaign.archived', 'delete', nowIso())
}

export async function restoreCampaign(
  db: SqlDatabase,
  params: { workspaceId: string; id: string },
): Promise<CampaignSummary> {
  return transitionCampaignStatus(db, params, 'draft', 'campaign.restored', 'restore', undefined)
}

export async function getCampaignById(db: SqlDatabase, id: string): Promise<Campaign | null> {
  const row = await queryFirst<CampaignRow>(db, `SELECT * FROM campaign WHERE id = ?`, [id])
  return row ? toCampaign(row) : null
}

export async function getCampaignSummaryById(
  db: SqlDatabase,
  id: string,
): Promise<CampaignSummary | null> {
  const row = await queryFirst<
    CampaignRow & {
      brand_name: string | null
      product_name: string | null
      account_count: number
      account_handles: string | null
    }
  >(
    db,
    `SELECT c.*,
            b.name AS brand_name,
            p.name AS product_name,
            (SELECT COUNT(*) FROM campaign_account ca WHERE ca.campaign_id = c.id) AS account_count,
            (SELECT GROUP_CONCAT(a.handle, ', ') FROM campaign_account ca JOIN account a ON a.id = ca.account_id WHERE ca.campaign_id = c.id) AS account_handles
     FROM campaign c
     LEFT JOIN brand b ON b.id = c.brand_id
     LEFT JOIN product p ON p.id = c.product_id
     WHERE c.id = ?`,
    [id],
  )
  if (!row) return null

  return {
    ...toCampaign(row),
    brandName: row.brand_name ?? 'Unknown Brand',
    productName: row.product_name,
    accountCount: row.account_count ?? 0,
    accountHandles: row.account_handles ? row.account_handles.split(', ').filter(Boolean) : [],
  }
}

export async function listCampaignAccounts(
  db: SqlDatabase,
  campaignId: string,
): Promise<CampaignAccountItem[]> {
  const rows = await queryAll<{
    id: string
    handle: string
    display_name: string | null
    platform_id: string
    platform_name: string
    status: string
  }>(
    db,
    `SELECT a.id, a.handle, a.display_name, a.platform_id, p.name AS platform_name, a.status
     FROM campaign_account ca
     JOIN account a ON a.id = ca.account_id
     LEFT JOIN platform p ON p.id = a.platform_id
     WHERE ca.campaign_id = ?
     ORDER BY a.handle ASC`,
    [campaignId],
  )
  return rows.map((r) => ({
    id: r.id,
    handle: r.handle,
    displayName: r.display_name,
    platformId: r.platform_id,
    platformName: r.platform_name,
    status: r.status,
  }))
}

export async function getCampaignDetail(
  db: SqlDatabase,
  workspaceId: string,
  id: string,
): Promise<CampaignDetail | null> {
  const summary = await getCampaignSummaryById(db, id)
  if (!summary || summary.workspaceId !== workspaceId) {
    return null
  }

  const accounts = await listCampaignAccounts(db, id)

  // Fetch relevant research (scoped to this campaign, or under brand)
  const researchRows = await queryAll<{
    id: string
    subject: string
    research_type: string
    status: string
    expires_at: string | null
    last_verified_at: string | null
    updated_at: string
    created_at: string
    scope_type: string | null
    scope_id: string | null
  }>(
    db,
    `SELECT id, subject, research_type, status, expires_at, last_verified_at, updated_at, created_at, scope_type, scope_id
     FROM research
     WHERE workspace_id = ?
       AND deleted_at IS NULL
       AND (
         (scope_type = 'campaign' AND scope_id = ?)
         OR (scope_type = 'brand' AND scope_id = ?)
       )
     ORDER BY created_at DESC
     LIMIT 10`,
    [workspaceId, id, summary.brandId],
  )

  const researchCountRow = await queryFirst<{ count: number }>(
    db,
    `SELECT COUNT(*) AS count
     FROM research
     WHERE workspace_id = ?
       AND deleted_at IS NULL
       AND (
         (scope_type = 'campaign' AND scope_id = ?)
         OR (scope_type = 'brand' AND scope_id = ?)
       )`,
    [workspaceId, id, summary.brandId],
  )

  const now = nowIso()
  const recentResearch: CampaignResearchItem[] = await Promise.all(
    researchRows.map(async (r) => {
      const freshness = researchFreshness(
        {
          status: r.status,
          expiresAt: r.expires_at,
          lastVerifiedAt: r.last_verified_at,
          updatedAt: r.updated_at,
        },
        now,
        90,
      )
      const sources = await listResearchSources(db, {
        workspaceId,
        researchId: r.id,
      }).catch(() => [])
      const provenance = computeProvenanceSummary(sources)
      return {
        id: r.id,
        subject: r.subject,
        researchType: r.research_type,
        status: r.status,
        freshness,
        provenance,
        scopeType: r.scope_type,
        scopeId: r.scope_id,
        createdAt: r.created_at,
      }
    }),
  )

  const audienceDetails = parseCampaignAudience({
    audience: summary.audience,
    audienceJson: summary.audienceJson,
  })

  const strategy = parseCampaignStrategy({
    positioning: summary.positioning,
    angle: summary.angle,
    offerMessage: summary.offerMessage,
    hypothesis: summary.hypothesis,
  })

  const targets = parseCampaignTargets({
    targetsJson: summary.targetsJson,
  })

  const primaryTarget = targets.find((t) => t.isPrimary) ?? null
  const supportingTargets = targets.filter((t) => !t.isPrimary)

  const contentItems = await listCampaignContent(db, {
    workspaceId,
    campaignId: id,
  })

  const recentWorkflowRuns = await listCampaignWorkflowRuns(db, workspaceId, id, 10)

  return {
    ...summary,
    accounts,
    audienceDetails,
    strategy,
    targets,
    primaryTarget,
    supportingTargets,
    researchCount: researchCountRow?.count ?? researchRows.length,
    recentResearch,
    contentCount: contentItems.length,
    contentItems,
    recentWorkflowRuns,
  }
}

export async function listCampaignWorkflowRuns(
  db: SqlDatabase,
  workspaceId: string,
  campaignId: string,
  limit = 10,
): Promise<CampaignWorkflowRunItem[]> {
  const rows = await queryAll<{
    id: string
    workflow_id: string
    workflow_name: string
    status: WorkflowRunStatus
    trigger_type: string
    started_at: string | null
    finished_at: string | null
    created_at: string
    error: string | null
  }>(
    db,
    `SELECT r.id, r.workflow_id, w.name AS workflow_name, r.status, r.trigger_type,
            r.started_at, r.finished_at, r.created_at, r.error
     FROM workflow_run r
     JOIN workflow w ON w.id = r.workflow_id
     WHERE w.workspace_id = ?
       AND r.scope_type = 'campaign'
       AND r.scope_id = ?
     ORDER BY r.created_at DESC, r.rowid DESC
     LIMIT ?`,
    [workspaceId, campaignId, limit],
  )

  const items: CampaignWorkflowRunItem[] = []
  for (const r of rows) {
    let hasWaitingApproval = false
    let pendingApprovalId: string | null = null

    if (r.status === 'waiting') {
      const app = await queryFirst<{ id: string }>(
        db,
        `SELECT id FROM approval WHERE run_id = ? AND status = 'pending' LIMIT 1`,
        [r.id],
      )
      if (app) {
        hasWaitingApproval = true
        pendingApprovalId = app.id
      }
    }

    items.push({
      id: r.id,
      workflowId: r.workflow_id,
      workflowName: r.workflow_name,
      status: r.status,
      triggerType: r.trigger_type,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      createdAt: r.created_at,
      error: r.error,
      hasWaitingApproval,
      pendingApprovalId,
    })
  }

  return items
}

export const startCampaignWorkflowRunInput = z.object({
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  workflowId: z.string().uuid(),
  inputs: z.record(z.string(), z.unknown()).default({}),
})
export type StartCampaignWorkflowRunInput = z.input<typeof startCampaignWorkflowRunInput>

export async function startCampaignWorkflowRun(
  db: SqlDatabase,
  rawInput: unknown,
  deps: WorkflowEngineDeps,
  drive = true,
): Promise<StartRunResult> {
  const data = startCampaignWorkflowRunInput.parse(rawInput)

  // 1. Validate Campaign
  const campaign = await getCampaignSummaryById(db, data.campaignId)
  if (!campaign || campaign.workspaceId !== data.workspaceId || campaign.deletedAt !== null) {
    return { ok: false, message: 'Campaign not found or is archived in this workspace.' }
  }

  // 2. Validate Workflow
  const workflow = await getWorkflowById(db, data.workflowId)
  if (!workflow || workflow.workspaceId !== data.workspaceId || workflow.deletedAt !== null) {
    return { ok: false, message: 'Workflow not found in this workspace.' }
  }
  if (workflow.status !== 'active') {
    return {
      ok: false,
      message: `Workflow is ${workflow.status}. Only active workflows can be run.`,
    }
  }

  // 3. Start workflow run with campaign scope
  return startWorkflowRun({
    db,
    workspaceId: data.workspaceId,
    workflowId: data.workflowId,
    inputs: data.inputs,
    scope: { type: 'campaign', id: data.campaignId },
    triggerType: 'manual',
    deps,
    drive,
  })
}

export interface ListCampaignsParams {
  workspaceId: string
  brandId?: string | undefined
  productId?: string | undefined
  status?: CampaignStatus | undefined
  includeArchived?: boolean | undefined
}

export async function listCampaigns(
  db: SqlDatabase,
  params: ListCampaignsParams,
): Promise<CampaignSummary[]> {
  let sql = `
    SELECT c.*,
           b.name AS brand_name,
           p.name AS product_name,
           (SELECT COUNT(*) FROM campaign_account ca WHERE ca.campaign_id = c.id) AS account_count,
           (SELECT GROUP_CONCAT(a.handle, ', ') FROM campaign_account ca JOIN account a ON a.id = ca.account_id WHERE ca.campaign_id = c.id) AS account_handles
    FROM campaign c
    LEFT JOIN brand b ON b.id = c.brand_id
    LEFT JOIN product p ON p.id = c.product_id
    WHERE c.workspace_id = ?
  `
  const queryParams: unknown[] = [params.workspaceId]

  if (!params.includeArchived) {
    sql += ` AND c.deleted_at IS NULL AND c.status != 'archived'`
  }

  if (params.brandId) {
    sql += ` AND c.brand_id = ?`
    queryParams.push(params.brandId)
  }

  if (params.productId) {
    sql += ` AND c.product_id = ?`
    queryParams.push(params.productId)
  }

  if (params.status) {
    sql += ` AND c.status = ?`
    queryParams.push(params.status)
  }

  sql += ` ORDER BY c.created_at DESC, c.id DESC`

  const rows = await queryAll<
    CampaignRow & {
      brand_name: string | null
      product_name: string | null
      account_count: number
      account_handles: string | null
    }
  >(db, sql, queryParams)

  return rows.map((row) => ({
    ...toCampaign(row),
    brandName: row.brand_name ?? 'Unknown Brand',
    productName: row.product_name,
    accountCount: row.account_count ?? 0,
    accountHandles: row.account_handles ? row.account_handles.split(', ').filter(Boolean) : [],
  }))
}

export async function listArchivedCampaigns(
  db: SqlDatabase,
  workspaceId: string,
): Promise<CampaignSummary[]> {
  const rows = await queryAll<
    CampaignRow & {
      brand_name: string | null
      product_name: string | null
      account_count: number
      account_handles: string | null
    }
  >(
    db,
    `SELECT c.*,
            b.name AS brand_name,
            p.name AS product_name,
            (SELECT COUNT(*) FROM campaign_account ca WHERE ca.campaign_id = c.id) AS account_count,
            (SELECT GROUP_CONCAT(a.handle, ', ') FROM campaign_account ca JOIN account a ON a.id = ca.account_id WHERE ca.campaign_id = c.id) AS account_handles
     FROM campaign c
     LEFT JOIN brand b ON b.id = c.brand_id
     LEFT JOIN product p ON p.id = c.product_id
     WHERE c.workspace_id = ? AND (c.deleted_at IS NOT NULL OR c.status = 'archived')
     ORDER BY c.updated_at DESC, c.id DESC`,
    [workspaceId],
  )

  return rows.map((row) => ({
    ...toCampaign(row),
    brandName: row.brand_name ?? 'Unknown Brand',
    productName: row.product_name,
    accountCount: row.account_count ?? 0,
    accountHandles: row.account_handles ? row.account_handles.split(', ').filter(Boolean) : [],
  }))
}

async function validateCampaignTargets(
  db: SqlDatabase,
  workspaceId: string,
  targets: Array<{
    metricKey: string
    targetValue: number
    unit?: string | null | undefined
    isPrimary?: boolean | undefined
    orderIndex?: number | undefined
  }>,
): Promise<void> {
  if (!targets || targets.length === 0) return
  await ensureBuiltinMetrics(db)
  for (const t of targets) {
    const def = await findMetricDefinitionByKey(db, workspaceId, t.metricKey)
    if (!def) {
      throw new IntegrityError(
        `Invalid metric key '${t.metricKey}': not found in canonical metric registry for workspace '${workspaceId}'.`,
      )
    }
    if (def.unit === 'percent' || t.metricKey === 'conversion_rate' || t.metricKey === 'ctr') {
      if (t.targetValue < 0 || t.targetValue > 100) {
        throw new IntegrityError(`Percentage metric '${t.metricKey}' must be between 0 and 100.`)
      }
    }
  }
}
