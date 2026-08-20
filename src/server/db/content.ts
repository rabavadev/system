import { z } from 'zod'

import type {
  CampaignContentItem,
  ContentPurpose,
  ContentStatus,
  ContentType,
} from '~/types/domain'
import { writeAuditLog } from './audit.ts'
import { emitEventSafe } from './event.ts'
import { IntegrityError } from './relations.ts'
import { execute, newId, nowIso, queryAll, queryFirst, type SqlDatabase } from './sql.ts'

export const contentTypeSchema = z.enum([
  'post',
  'short_form',
  'long_form',
  'image',
  'video',
  'thread',
  'email',
  'other',
])

export const contentPurposeSchema = z.enum([
  'awareness',
  'traffic',
  'conversion',
  'engagement',
  'education',
  'retention',
  'validation',
])

export const contentStatusSchema = z.enum([
  'idea',
  'planned',
  'draft',
  'ready',
  'in_review',
  'approved',
  'archived',
])

export interface ContentRow {
  id: string
  workspace_id: string
  campaign_id: string | null
  product_id: string | null
  target_account_id: string | null
  title: string | null
  content_type: ContentType
  purpose: ContentPurpose | null
  theme: string | null
  brief: string | null
  body: string | null
  status: ContentStatus
  planned_at: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
  // Joined fields
  account_handle?: string | null
  account_display_name?: string | null
  platform_id?: string | null
  platform_name?: string | null
}

export function toCampaignContentItem(row: ContentRow): CampaignContentItem {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    campaignId: row.campaign_id,
    productId: row.product_id,
    targetAccountId: row.target_account_id,
    title: row.title,
    contentType: row.content_type,
    purpose: row.purpose,
    theme: row.theme,
    brief: row.brief,
    body: row.body,
    status: row.status,
    plannedAt: row.planned_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    accountHandle: row.account_handle ?? null,
    accountDisplayName: row.account_display_name ?? null,
    platformId: row.platform_id ?? null,
    platformName: row.platform_name ?? null,
  }
}

export const createCampaignContentInput = z.object({
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  productId: z.string().uuid().nullable().optional(),
  targetAccountId: z.string().uuid().nullable().optional(),
  title: z
    .string()
    .trim()
    .min(1, 'Title is required')
    .max(200, 'Title cannot exceed 200 characters'),
  contentType: contentTypeSchema.default('post'),
  purpose: contentPurposeSchema.nullable().optional(),
  theme: z.string().trim().max(500).nullable().optional(),
  brief: z.string().trim().max(2000).nullable().optional(),
  body: z.string().nullable().optional(),
  status: contentStatusSchema.default('idea'),
  plannedAt: z.string().nullable().optional(),
})

export type CreateCampaignContentInput = z.input<typeof createCampaignContentInput>

export const updateCampaignContentInput = z.object({
  workspaceId: z.string().uuid(),
  id: z.string().uuid(),
  targetAccountId: z.string().uuid().nullable().optional(),
  title: z
    .string()
    .trim()
    .min(1, 'Title is required')
    .max(200, 'Title cannot exceed 200 characters')
    .optional(),
  contentType: contentTypeSchema.optional(),
  purpose: contentPurposeSchema.nullable().optional(),
  theme: z.string().trim().max(500).nullable().optional(),
  brief: z.string().trim().max(2000).nullable().optional(),
  body: z.string().nullable().optional(),
  status: contentStatusSchema.optional(),
  plannedAt: z.string().nullable().optional(),
})

export type UpdateCampaignContentInput = z.input<typeof updateCampaignContentInput>

export const archiveCampaignContentInput = z.object({
  workspaceId: z.string().uuid(),
  id: z.string().uuid(),
})

export type ArchiveCampaignContentInput = z.input<typeof archiveCampaignContentInput>

/**
 * Validate that an account exists in the workspace and is attached to the campaign via campaign_account.
 */
async function validateCampaignAccount(
  db: SqlDatabase,
  workspaceId: string,
  campaignId: string,
  accountId: string,
): Promise<{ id: string; platform_id: string }> {
  // 1. Account existence and workspace check
  const accountRow = await queryFirst<{
    id: string
    workspace_id: string
    platform_id: string
    deleted_at: string | null
  }>(db, `SELECT id, workspace_id, platform_id, deleted_at FROM account WHERE id = ?`, [accountId])
  if (!accountRow || accountRow.workspace_id !== workspaceId || accountRow.deleted_at !== null) {
    throw new IntegrityError('Account not found in this workspace.')
  }

  // 2. Attached to campaign check
  const membership = await queryFirst<{ campaign_id: string }>(
    db,
    `SELECT campaign_id FROM campaign_account WHERE campaign_id = ? AND account_id = ?`,
    [campaignId, accountId],
  )
  if (!membership) {
    throw new IntegrityError('Account is not attached to this campaign.')
  }

  return { id: accountRow.id, platform_id: accountRow.platform_id }
}

/**
 * Create a new planned content item for a campaign.
 */
export async function createCampaignContent(
  db: SqlDatabase,
  rawInput: unknown,
  nowOverride?: string,
): Promise<CampaignContentItem> {
  const data = createCampaignContentInput.parse(rawInput)
  const now = nowOverride ?? nowIso()

  // 1. Validate Campaign
  const campaignRow = await queryFirst<{
    id: string
    workspace_id: string
    deleted_at: string | null
  }>(db, `SELECT id, workspace_id, deleted_at FROM campaign WHERE id = ?`, [data.campaignId])
  if (
    !campaignRow ||
    campaignRow.workspace_id !== data.workspaceId ||
    campaignRow.deleted_at !== null
  ) {
    throw new IntegrityError('Campaign not found in this workspace.')
  }

  // 2. Validate Target Account if provided
  if (data.targetAccountId) {
    await validateCampaignAccount(db, data.workspaceId, data.campaignId, data.targetAccountId)
  }

  // 3. Validate Product if provided
  if (data.productId) {
    const productRow = await queryFirst<{ id: string; brand_id: string }>(
      db,
      `SELECT p.id, p.brand_id FROM product p
       JOIN brand b ON b.id = p.brand_id
       WHERE p.id = ? AND b.workspace_id = ? AND p.deleted_at IS NULL`,
      [data.productId, data.workspaceId],
    )
    if (!productRow) {
      throw new IntegrityError('Product not found in this workspace.')
    }
  }

  const contentId = newId()
  const title = data.title.trim()
  const theme = data.theme?.trim() || null
  const brief = data.brief?.trim() || null
  const body = data.body?.trim() || null
  const purpose = data.purpose ?? null
  const plannedAt = data.plannedAt?.trim() || null

  await execute(
    db,
    `INSERT INTO content (
      id, workspace_id, campaign_id, product_id, target_account_id,
      title, content_type, purpose, theme, brief, body, status, planned_at,
      created_at, updated_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      contentId,
      data.workspaceId,
      data.campaignId,
      data.productId ?? null,
      data.targetAccountId ?? null,
      title,
      data.contentType,
      purpose,
      theme,
      brief,
      body,
      data.status,
      plannedAt,
      now,
      now,
    ],
  )

  await writeAuditLog(db, {
    workspaceId: data.workspaceId,
    actorType: 'user',
    action: 'create',
    entityType: 'content',
    entityId: contentId,
    newValueJson: JSON.stringify({
      campaignId: data.campaignId,
      title,
      contentType: data.contentType,
      purpose,
      targetAccountId: data.targetAccountId ?? null,
      status: data.status,
      plannedAt,
    }),
  })

  await emitEventSafe(db, {
    workspaceId: data.workspaceId,
    eventType: 'campaign.content_created',
    payloadJson: JSON.stringify({
      campaignId: data.campaignId,
      contentId,
      title,
      contentType: data.contentType,
      purpose,
      targetAccountId: data.targetAccountId ?? null,
      status: data.status,
    }),
  })

  const item = await getCampaignContentDetail(db, data.workspaceId, contentId)
  if (!item) {
    throw new Error('Failed to retrieve newly created content item.')
  }
  return item
}

/**
 * Update an existing campaign content item.
 */
export async function updateCampaignContent(
  db: SqlDatabase,
  rawInput: unknown,
  nowOverride?: string,
): Promise<CampaignContentItem> {
  const data = updateCampaignContentInput.parse(rawInput)
  const now = nowOverride ?? nowIso()

  const existing = await queryFirst<ContentRow>(db, `SELECT * FROM content WHERE id = ?`, [data.id])
  if (!existing || existing.workspace_id !== data.workspaceId || existing.deleted_at !== null) {
    throw new IntegrityError('Content item not found in this workspace.')
  }

  const campaignId = existing.campaign_id
  if (!campaignId) {
    throw new IntegrityError('Content item is not associated with a campaign.')
  }

  // Validate Target Account if changing
  const nextTargetAccountId =
    data.targetAccountId !== undefined ? data.targetAccountId : existing.target_account_id

  if (nextTargetAccountId && nextTargetAccountId !== existing.target_account_id) {
    await validateCampaignAccount(db, data.workspaceId, campaignId, nextTargetAccountId)
  }

  const nextTitle = data.title !== undefined ? data.title.trim() : existing.title
  const nextContentType = data.contentType !== undefined ? data.contentType : existing.content_type
  const nextPurpose = data.purpose !== undefined ? data.purpose : existing.purpose
  const nextTheme = data.theme !== undefined ? data.theme?.trim() || null : existing.theme
  const nextBrief = data.brief !== undefined ? data.brief?.trim() || null : existing.brief
  const nextBody = data.body !== undefined ? data.body?.trim() || null : existing.body
  const nextStatus = data.status !== undefined ? data.status : existing.status
  const nextPlannedAt =
    data.plannedAt !== undefined ? data.plannedAt?.trim() || null : existing.planned_at

  await execute(
    db,
    `UPDATE content SET
      target_account_id = ?,
      title = ?,
      content_type = ?,
      purpose = ?,
      theme = ?,
      brief = ?,
      body = ?,
      status = ?,
      planned_at = ?,
      updated_at = ?
     WHERE id = ?`,
    [
      nextTargetAccountId,
      nextTitle,
      nextContentType,
      nextPurpose,
      nextTheme,
      nextBrief,
      nextBody,
      nextStatus,
      nextPlannedAt,
      now,
      data.id,
    ],
  )

  await writeAuditLog(db, {
    workspaceId: data.workspaceId,
    actorType: 'user',
    action: 'update',
    entityType: 'content',
    entityId: data.id,
    previousValueJson: JSON.stringify({
      title: existing.title,
      contentType: existing.content_type,
      status: existing.status,
    }),
    newValueJson: JSON.stringify({
      campaignId,
      title: nextTitle,
      contentType: nextContentType,
      purpose: nextPurpose,
      targetAccountId: nextTargetAccountId,
      status: nextStatus,
      plannedAt: nextPlannedAt,
    }),
  })

  await emitEventSafe(db, {
    workspaceId: data.workspaceId,
    eventType: 'campaign.content_updated',
    payloadJson: JSON.stringify({
      campaignId,
      contentId: data.id,
      title: nextTitle,
      contentType: nextContentType,
      status: nextStatus,
    }),
  })

  const item = await getCampaignContentDetail(db, data.workspaceId, data.id)
  if (!item) {
    throw new Error('Failed to retrieve updated content item.')
  }
  return item
}

/**
 * Archive / remove a campaign content item (soft delete).
 */
export async function archiveCampaignContent(
  db: SqlDatabase,
  params: { workspaceId: string; id: string },
  nowOverride?: string,
): Promise<CampaignContentItem> {
  const data = archiveCampaignContentInput.parse(params)
  const now = nowOverride ?? nowIso()

  const existing = await queryFirst<ContentRow>(db, `SELECT * FROM content WHERE id = ?`, [data.id])
  if (!existing || existing.workspace_id !== data.workspaceId) {
    throw new IntegrityError('Content item not found in this workspace.')
  }

  await execute(
    db,
    `UPDATE content SET status = 'archived', deleted_at = ?, updated_at = ? WHERE id = ?`,
    [now, now, data.id],
  )

  await writeAuditLog(db, {
    workspaceId: data.workspaceId,
    actorType: 'user',
    action: 'delete',
    entityType: 'content',
    entityId: data.id,
    previousValueJson: JSON.stringify({
      campaignId: existing.campaign_id,
      title: existing.title,
      status: existing.status,
    }),
  })

  await emitEventSafe(db, {
    workspaceId: data.workspaceId,
    eventType: 'campaign.content_archived',
    payloadJson: JSON.stringify({
      campaignId: existing.campaign_id,
      contentId: data.id,
      title: existing.title,
    }),
  })

  const updatedRow = await queryFirst<ContentRow>(
    db,
    `SELECT c.*, a.handle AS account_handle, a.display_name AS account_display_name,
            a.platform_id, p.name AS platform_name
     FROM content c
     LEFT JOIN account a ON a.id = c.target_account_id
     LEFT JOIN platform p ON p.id = a.platform_id
     WHERE c.id = ?`,
    [data.id],
  )
  if (!updatedRow) {
    throw new Error('Failed to retrieve archived content item.')
  }
  return toCampaignContentItem(updatedRow)
}

/**
 * Retrieve one content item by workspace + content ID.
 */
export async function getCampaignContentDetail(
  db: SqlDatabase,
  workspaceId: string,
  contentId: string,
): Promise<CampaignContentItem | null> {
  const row = await queryFirst<ContentRow>(
    db,
    `SELECT c.*, a.handle AS account_handle, a.display_name AS account_display_name,
            a.platform_id, p.name AS platform_name
     FROM content c
     LEFT JOIN account a ON a.id = c.target_account_id
     LEFT JOIN platform p ON p.id = a.platform_id
     WHERE c.id = ? AND c.workspace_id = ?`,
    [contentId, workspaceId],
  )
  if (!row) return null
  return toCampaignContentItem(row)
}

/**
 * List content items for a campaign.
 */
export async function listCampaignContent(
  db: SqlDatabase,
  params: {
    workspaceId: string
    campaignId: string
    status?: ContentStatus | undefined
    includeArchived?: boolean | undefined
  },
): Promise<CampaignContentItem[]> {
  const clauses = ['c.workspace_id = ?', 'c.campaign_id = ?']
  const args: unknown[] = [params.workspaceId, params.campaignId]

  if (params.status) {
    clauses.push('c.status = ?')
    args.push(params.status)
  }

  if (!params.includeArchived && !params.status) {
    clauses.push('c.deleted_at IS NULL')
    clauses.push("c.status != 'archived'")
  }

  const rows = await queryAll<ContentRow>(
    db,
    `SELECT c.*, a.handle AS account_handle, a.display_name AS account_display_name,
            a.platform_id, p.name AS platform_name
     FROM content c
     LEFT JOIN account a ON a.id = c.target_account_id
     LEFT JOIN platform p ON p.id = a.platform_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY 
       CASE 
         WHEN c.planned_at IS NOT NULL THEN 0 
         ELSE 1 
       END ASC,
       c.planned_at ASC,
       c.created_at ASC`,
    args,
  )

  return rows.map(toCampaignContentItem)
}
