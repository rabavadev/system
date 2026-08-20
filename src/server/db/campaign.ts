import { z } from 'zod'

import type { Campaign, CampaignStatus } from '../../types/domain.ts'
import { writeAuditLog } from './audit.ts'
import { emitEventSafe } from './event.ts'
import { IntegrityError, requireActiveBrand, requireProductForBrand } from './relations.ts'
import { execute, newId, nowIso, queryAll, queryFirst, type SqlDatabase } from './sql.ts'

interface CampaignRow {
  id: string
  workspace_id: string
  brand_id: string | null
  product_id: string | null
  goal_id: string | null
  name: string
  audience: string | null
  angle: string | null
  status: CampaignStatus
  starts_at: string | null
  ends_at: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
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

export interface CampaignDetail extends CampaignSummary {
  accounts: CampaignAccountItem[]
  researchCount: number
  recentResearch: Array<{
    id: string
    subject: string
    researchType: string
    status: string
  }>
}

export const createCampaignInput = z
  .object({
    workspaceId: z.uuid(),
    brandId: z.uuid(),
    productId: z.uuid().nullish(),
    goalId: z.uuid().nullish(),
    name: z.string().trim().min(1, 'Give the campaign a name.').max(200),
    audience: z.string().trim().max(2000).nullish(),
    angle: z.string().trim().max(2000).nullish(),
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
    status: z.enum(['draft', 'active', 'paused', 'completed', 'archived']).optional(),
    startsAt: z.iso.datetime({ offset: false }).nullish(),
    endsAt: z.iso.datetime({ offset: false }).nullish(),
    accountIds: z.array(z.uuid()).optional(),
  })
  .refine((data) => !data.startsAt || !data.endsAt || data.endsAt >= data.startsAt, {
    message: 'End date must be on or after start date.',
  })
export type UpdateCampaignInput = z.input<typeof updateCampaignInput>

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
    if (!acc || acc.workspace_id !== workspaceId) {
      throw new IntegrityError('Account not found in this workspace.')
    }
    if (acc.deleted_at !== null) {
      throw new IntegrityError('An archived account cannot be added to a campaign.')
    }
  }
  return unique
}

/** Set campaign account relationships */
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
      `INSERT INTO campaign_account (campaign_id, account_id, created_at) VALUES (?, ?, ?)`,
      [campaignId, accountId, now],
    )
  }
}

export async function createCampaign(
  db: SqlDatabase,
  input: CreateCampaignInput,
): Promise<CampaignSummary> {
  const data = createCampaignInput.parse(input)

  // 1. Validate Brand
  const brandRow = await queryFirst<{
    id: string
    workspace_id: string
    name: string
    description: string | null
    created_at: string
    updated_at: string
    deleted_at: string | null
  }>(db, `SELECT * FROM brand WHERE id = ?`, [data.brandId])

  if (!brandRow || brandRow.workspace_id !== data.workspaceId) {
    throw new IntegrityError('Brand not found in this workspace.')
  }
  requireActiveBrand({
    id: brandRow.id,
    workspaceId: brandRow.workspace_id,
    name: brandRow.name,
    description: brandRow.description,
    createdAt: brandRow.created_at,
    updatedAt: brandRow.updated_at,
    deletedAt: brandRow.deleted_at,
  })

  // 2. Validate Product (if provided)
  if (data.productId) {
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
    }>(db, `SELECT * FROM product WHERE id = ?`, [data.productId])

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
      data.brandId,
    )
  }

  // 3. Validate Accounts
  const validAccountIds = await validateAccounts(db, data.workspaceId, data.accountIds)

  const id = newId()
  const now = nowIso()
  await execute(
    db,
    `INSERT INTO campaign (
       id, workspace_id, brand_id, product_id, goal_id, name, audience, angle,
       status, starts_at, ends_at, created_at, updated_at, deleted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      id,
      data.workspaceId,
      data.brandId,
      data.productId ?? null,
      data.goalId ?? null,
      data.name,
      data.audience ?? null,
      data.angle ?? null,
      data.status,
      data.startsAt ?? null,
      data.endsAt ?? null,
      now,
      now,
    ],
  )

  // 4. Attach Accounts
  if (validAccountIds.length > 0) {
    await syncCampaignAccounts(db, id, validAccountIds)
  }

  const created = await getCampaignSummaryById(db, id)
  if (!created) {
    throw new Error('campaign insert did not produce a readable summary')
  }

  // 5. Audit log & Event
  await writeAuditLog(db, {
    workspaceId: data.workspaceId,
    entityType: 'campaign',
    entityId: id,
    action: 'create',
    actorType: 'user',
    newValueJson: JSON.stringify({
      id: created.id,
      name: created.name,
      brandId: created.brandId,
      productId: created.productId,
      status: created.status,
      accountCount: validAccountIds.length,
    }),
  })

  await emitEventSafe(db, {
    workspaceId: data.workspaceId,
    eventType: 'campaign.created',
    actorType: 'user',
    subjectType: 'campaign',
    subjectId: id,
    payloadJson: JSON.stringify({
      name: created.name,
      brandId: created.brandId,
      productId: created.productId,
      status: created.status,
    }),
  })

  return created
}

export async function updateCampaign(
  db: SqlDatabase,
  input: UpdateCampaignInput,
): Promise<CampaignSummary> {
  const data = updateCampaignInput.parse(input)

  const existing = await queryFirst<CampaignRow>(db, `SELECT * FROM campaign WHERE id = ?`, [
    data.id,
  ])
  if (!existing) {
    throw new IntegrityError('Campaign not found.')
  }

  const workspaceId = existing.workspace_id
  const targetBrandId = data.brandId ?? existing.brand_id
  if (!targetBrandId) {
    throw new IntegrityError('Every campaign must belong to a brand.')
  }

  // Validate brand if changing or checking
  const brandRow = await queryFirst<{
    id: string
    workspace_id: string
    name: string
    description: string | null
    created_at: string
    updated_at: string
    deleted_at: string | null
  }>(db, `SELECT * FROM brand WHERE id = ?`, [targetBrandId])

  if (!brandRow || brandRow.workspace_id !== workspaceId) {
    throw new IntegrityError('Brand not found in this workspace.')
  }
  requireActiveBrand({
    id: brandRow.id,
    workspaceId: brandRow.workspace_id,
    name: brandRow.name,
    description: brandRow.description,
    createdAt: brandRow.created_at,
    updatedAt: brandRow.updated_at,
    deletedAt: brandRow.deleted_at,
  })

  // Validate product if supplied
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

  const now = nowIso()
  const nextName = data.name ?? existing.name
  const nextAudience = data.audience !== undefined ? data.audience : existing.audience
  const nextAngle = data.angle !== undefined ? data.angle : existing.angle
  const nextStatus = data.status ?? existing.status
  const nextStartsAt = data.startsAt !== undefined ? data.startsAt : existing.starts_at
  const nextEndsAt = data.endsAt !== undefined ? data.endsAt : existing.ends_at
  const nextGoalId = data.goalId !== undefined ? data.goalId : existing.goal_id

  await execute(
    db,
    `UPDATE campaign
     SET brand_id = ?, product_id = ?, goal_id = ?, name = ?, audience = ?, angle = ?,
         status = ?, starts_at = ?, ends_at = ?, updated_at = ?
     WHERE id = ?`,
    [
      targetBrandId,
      targetProductId ?? null,
      nextGoalId ?? null,
      nextName,
      nextAudience ?? null,
      nextAngle ?? null,
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
    }),
    newValueJson: JSON.stringify({
      name: updated.name,
      brandId: updated.brandId,
      productId: updated.productId,
      status: updated.status,
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
    }),
  })

  return updated
}

async function transitionCampaignStatus(
  db: SqlDatabase,
  params: { workspaceId: string; id: string },
  nextStatus: CampaignStatus = 'active',
  eventType: string = 'campaign.updated',
  auditAction: 'create' | 'update' | 'delete' | 'restore' = 'update',
  deletedAt: string | null | undefined = undefined,
): Promise<CampaignSummary> {
  const existing = await queryFirst<CampaignRow>(
    db,
    `SELECT * FROM campaign WHERE id = ? AND workspace_id = ?`,
    [params.id, params.workspaceId],
  )
  if (!existing) {
    throw new IntegrityError('Campaign not found.')
  }

  const now = nowIso()
  const nextDeletedAt = deletedAt !== undefined ? deletedAt : existing.deleted_at

  await execute(
    db,
    `UPDATE campaign
     SET status = ?, deleted_at = ?, updated_at = ?
     WHERE id = ?`,
    [nextStatus, nextDeletedAt, now, params.id],
  )

  const updated = await getCampaignSummaryById(db, params.id)
  if (!updated) {
    throw new Error('status transition did not produce a readable summary')
  }

  await writeAuditLog(db, {
    workspaceId: params.workspaceId,
    entityType: 'campaign',
    entityId: params.id,
    action: auditAction,
    actorType: 'user',
    previousValueJson: JSON.stringify({ status: existing.status, deletedAt: existing.deleted_at }),
    newValueJson: JSON.stringify({ status: updated.status, deletedAt: updated.deletedAt }),
  })

  await emitEventSafe(db, {
    workspaceId: params.workspaceId,
    eventType,
    actorType: 'user',
    subjectType: 'campaign',
    subjectId: params.id,
    payloadJson: JSON.stringify({
      status: updated.status,
      deletedAt: updated.deletedAt,
    }),
  })

  return updated
}

export async function activateCampaign(
  db: SqlDatabase,
  params: { workspaceId: string; id: string },
): Promise<CampaignSummary> {
  return transitionCampaignStatus(db, params, 'active', 'campaign.activated', 'update', null)
}

export async function pauseCampaign(
  db: SqlDatabase,
  params: { workspaceId: string; id: string },
): Promise<CampaignSummary> {
  return transitionCampaignStatus(db, params, 'paused', 'campaign.paused', 'update')
}

export async function completeCampaign(
  db: SqlDatabase,
  params: { workspaceId: string; id: string },
): Promise<CampaignSummary> {
  return transitionCampaignStatus(db, params, 'completed', 'campaign.completed', 'update')
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
  return transitionCampaignStatus(db, params, 'draft', 'campaign.restored', 'restore', null)
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
    `SELECT a.id, a.handle, a.display_name, a.platform_id, pl.name AS platform_name, a.status
     FROM campaign_account ca
     JOIN account a ON a.id = ca.account_id
     JOIN platform pl ON pl.id = a.platform_id
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
  }>(
    db,
    `SELECT id, subject, research_type, status
     FROM research
     WHERE workspace_id = ?
       AND deleted_at IS NULL
       AND (
         (scope_type = 'campaign' AND scope_id = ?)
         OR (scope_type = 'brand' AND scope_id = ?)
       )
     ORDER BY created_at DESC
     LIMIT 5`,
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

  return {
    ...summary,
    accounts,
    researchCount: researchCountRow?.count ?? researchRows.length,
    recentResearch: researchRows.map((r) => ({
      id: r.id,
      subject: r.subject,
      researchType: r.research_type,
      status: r.status,
    })),
  }
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
