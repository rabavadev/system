import { z } from 'zod'

import type {
  ContentApprovalStatus,
  ContentStatus,
  PostDetail,
  PostStatus,
  PublicationEligibilityResult,
} from '~/types/domain'
import { writeAuditLog } from './audit.ts'
import { emitEventSafe } from './event.ts'
import { IntegrityError } from './relations.ts'
import { execute, newId, nowIso, queryAll, queryFirst, type SqlDatabase } from './sql.ts'

interface AccountRow {
  id: string
  workspace_id: string
  platform_id: string
  handle: string
  display_name: string | null
  primary_niche_id: string | null
  status: string
  created_at: string
  updated_at: string
  deleted_at: string | null
}

interface ContentRow {
  id: string
  workspace_id: string
  campaign_id: string | null
  target_account_id: string | null
  selected_variant_id: string | null
  title: string
  brief: string | null
  body: string | null
  status: ContentStatus
  created_at: string
  updated_at: string
  deleted_at: string | null
}

interface ContentVariantRow {
  id: string
  content_id: string
  platform_id: string
  body: string | null
  metadata: string | null
  status: ContentStatus
  created_at: string
  updated_at: string
  deleted_at: string | null
}

interface ContentApprovalRow {
  id: string
  workspace_id: string
  content_id: string
  content_variant_id: string
  status: ContentApprovalStatus
  actor_type: string
  critic_override: number
  note: string | null
  created_at: string
}

interface CampaignRow {
  id: string
  workspace_id: string
  brand_id: string
  name: string
  status: string
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface PostRow {
  id: string
  workspace_id: string | null
  content_variant_id: string
  account_id: string
  content_approval_id: string | null
  status: PostStatus
  external_id: string | null
  url: string | null
  scheduled_at: string | null
  published_at: string | null
  error: string | null
  idempotency_key: string | null
  created_at: string
  updated_at: string
  // Joins
  account_handle?: string | null
  account_display_name?: string | null
  platform_id?: string | null
  platform_name?: string | null
  content_id?: string | null
  content_title?: string | null
  campaign_id?: string | null
  campaign_name?: string | null
  variant_body?: string | null
  variant_metadata?: string | null
  approval_status?: ContentApprovalStatus | null
  approval_created_at?: string | null
  critic_override?: number | null
}

export function toPostDetail(row: PostRow): PostDetail {
  let metaHeadline: string | null = null
  if (row.variant_metadata) {
    try {
      const parsed = JSON.parse(row.variant_metadata)
      if (typeof parsed?.headline === 'string') {
        metaHeadline = parsed.headline
      }
    } catch {
      metaHeadline = null
    }
  }

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    contentVariantId: row.content_variant_id,
    accountId: row.account_id,
    contentApprovalId: row.content_approval_id,
    status: row.status,
    externalId: row.external_id,
    url: row.url,
    scheduledAt: row.scheduled_at,
    publishedAt: row.published_at,
    error: row.error,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    accountHandle: row.account_handle ?? null,
    accountDisplayName: row.account_display_name ?? null,
    platformId: row.platform_id ?? null,
    platformName: row.platform_name ?? null,
    contentId: row.content_id ?? null,
    contentTitle: row.content_title ?? null,
    campaignId: row.campaign_id ?? null,
    campaignName: row.campaign_name ?? null,
    variantNumber: null,
    variantBody: row.variant_body ?? null,
    variantHeadline: metaHeadline,
    approvalStatus: row.approval_status ?? null,
    approvalCreatedAt: row.approval_created_at ?? null,
    criticOverride:
      row.critic_override !== undefined && row.critic_override !== null
        ? Boolean(row.critic_override)
        : null,
  }
}

export const createPublicationIntentInput = z.object({
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid().optional(),
  contentId: z.string().uuid(),
  contentVariantId: z.string().uuid(),
  accountId: z.string().uuid(),
  scheduledAt: z.string().datetime().nullable().optional(),
  idempotencyKey: z.string().trim().max(120).nullable().optional(),
})

export type CreatePublicationIntentInput = z.input<typeof createPublicationIntentInput>

/**
 * Creates a server-authoritative publication intent (Post record in draft/scheduled status).
 * Validates the full chain: workspace, content readiness, exact approved variant, active human approval,
 * account validity, platform match, and campaign account linkage.
 *
 * STEP 15E.1 performs ZERO external network calls and sets published_at/external_id/url to null.
 */
export async function createPublicationIntent(
  db: SqlDatabase,
  rawInput: unknown,
  nowOverride?: string,
): Promise<PostDetail> {
  const data = createPublicationIntentInput.parse(rawInput)
  const now = nowOverride ?? nowIso()

  // 1. Validate Workspace
  const workspace = await queryFirst<{ id: string }>(db, `SELECT id FROM workspace WHERE id = ?`, [
    data.workspaceId,
  ])
  if (!workspace) {
    throw new IntegrityError('Workspace not found.')
  }

  // 2. Validate Content Item
  const contentRow = await queryFirst<ContentRow>(
    db,
    `SELECT * FROM content WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [data.contentId, data.workspaceId],
  )
  if (!contentRow || contentRow.status === 'archived') {
    throw new IntegrityError('Content item not found or is archived.')
  }
  if (contentRow.status !== 'ready') {
    throw new IntegrityError(
      `Content item is in '${contentRow.status}' status, but must be in 'ready' status for publication.`,
    )
  }
  if (contentRow.selected_variant_id !== data.contentVariantId) {
    throw new IntegrityError(
      'Requested variant is not the currently approved publication candidate for this content item.',
    )
  }

  // 3. Validate Campaign if content is linked to one
  const campaignId = data.campaignId ?? contentRow.campaign_id ?? undefined
  if (campaignId) {
    const campaign = await queryFirst<CampaignRow>(
      db,
      `SELECT * FROM campaign WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
      [campaignId, data.workspaceId],
    )
    if (!campaign || campaign.status === 'archived') {
      throw new IntegrityError('Campaign not found or is archived in this workspace.')
    }
  }

  // 4. Validate Exact Content Variant
  const variantRow = await queryFirst<ContentVariantRow>(
    db,
    `SELECT * FROM content_variant WHERE id = ? AND content_id = ? AND deleted_at IS NULL`,
    [data.contentVariantId, data.contentId],
  )
  if (!variantRow) {
    throw new IntegrityError('Content variant not found or does not belong to this content item.')
  }

  // 5. Validate Active Human Editorial Approval
  const latestApproval = await queryFirst<ContentApprovalRow>(
    db,
    `SELECT * FROM content_approval 
     WHERE workspace_id = ? AND content_id = ? AND content_variant_id = ?
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    [data.workspaceId, data.contentId, data.contentVariantId],
  )
  if (!latestApproval || latestApproval.status !== 'approved') {
    throw new IntegrityError(
      'Content variant does not have an active human editorial approval (it may be unapproved or revoked).',
    )
  }

  // 6. Validate Account & Platform Match
  const accountRow = await queryFirst<AccountRow>(
    db,
    `SELECT * FROM account WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [data.accountId, data.workspaceId],
  )
  if (!accountRow) {
    throw new IntegrityError('Account not found in this workspace.')
  }

  // Ensure account platform matches content variant platform
  if (accountRow.platform_id !== variantRow.platform_id) {
    throw new IntegrityError(
      `Platform mismatch: Account belongs to platform '${accountRow.platform_id}' but variant is formatted for '${variantRow.platform_id}'.`,
    )
  }

  // If content has a designated target_account_id, ensure account matches
  if (contentRow.target_account_id && contentRow.target_account_id !== data.accountId) {
    throw new IntegrityError(
      'Account does not match the designated target account for this content item.',
    )
  }

  // If content belongs to a campaign, ensure account is attached to the campaign
  if (campaignId) {
    const campaignAccount = await queryFirst<{ campaign_id: string; account_id: string }>(
      db,
      `SELECT campaign_id, account_id FROM campaign_account WHERE campaign_id = ? AND account_id = ?`,
      [campaignId, data.accountId],
    )
    if (!campaignAccount) {
      throw new IntegrityError('Account is not connected to this campaign.')
    }
  }

  // 7. Idempotency Handling
  const cleanIdempotencyKey = data.idempotencyKey?.trim() || null

  if (cleanIdempotencyKey) {
    const existingByIdempotency = await getPostByQuery(
      db,
      `SELECT p.*, a.handle AS account_handle, a.display_name AS account_display_name,
              a.platform_id, pl.name AS platform_name,
              c.id AS content_id, c.title AS content_title, c.campaign_id, cmp.name AS campaign_name,
              v.body AS variant_body, v.metadata AS variant_metadata,
              ca.status AS approval_status, ca.created_at AS approval_created_at, ca.critic_override
       FROM post p
       JOIN account a ON a.id = p.account_id
       JOIN platform pl ON pl.id = a.platform_id
       JOIN content_variant v ON v.id = p.content_variant_id
       JOIN content c ON c.id = v.content_id
       LEFT JOIN campaign cmp ON cmp.id = c.campaign_id
       LEFT JOIN content_approval ca ON ca.id = p.content_approval_id
       WHERE p.workspace_id = ? AND p.idempotency_key = ?`,
      [data.workspaceId, cleanIdempotencyKey],
    )
    if (existingByIdempotency) {
      return existingByIdempotency
    }
  }

  // Check if an identical active publication intent already exists
  const existingActivePost = await getPostByQuery(
    db,
    `SELECT p.*, a.handle AS account_handle, a.display_name AS account_display_name,
            a.platform_id, pl.name AS platform_name,
            c.id AS content_id, c.title AS content_title, c.campaign_id, cmp.name AS campaign_name,
            v.body AS variant_body, v.metadata AS variant_metadata,
            ca.status AS approval_status, ca.created_at AS approval_created_at, ca.critic_override
     FROM post p
     JOIN account a ON a.id = p.account_id
     JOIN platform pl ON pl.id = a.platform_id
     JOIN content_variant v ON v.id = p.content_variant_id
     JOIN content c ON c.id = v.content_id
     LEFT JOIN campaign cmp ON cmp.id = c.campaign_id
     LEFT JOIN content_approval ca ON ca.id = p.content_approval_id
     WHERE p.workspace_id = ? AND p.content_variant_id = ? AND p.account_id = ?
       AND p.status IN ('draft', 'scheduled')
     ORDER BY p.created_at DESC, p.rowid DESC
     LIMIT 1`,
    [data.workspaceId, data.contentVariantId, data.accountId],
  )
  if (existingActivePost && !cleanIdempotencyKey) {
    return existingActivePost
  }

  // 8. Insert Post Record
  const postId = newId()
  const initialStatus: PostStatus = data.scheduledAt ? 'scheduled' : 'draft'

  await execute(
    db,
    `INSERT INTO post (
       id, workspace_id, content_variant_id, account_id, content_approval_id,
       status, external_id, url, scheduled_at, published_at, error,
       idempotency_key, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, ?, ?, ?)`,
    [
      postId,
      data.workspaceId,
      data.contentVariantId,
      data.accountId,
      latestApproval.id,
      initialStatus,
      data.scheduledAt ?? null,
      cleanIdempotencyKey,
      now,
      now,
    ],
  )

  // 9. Write Audit Log & Emit Domain Event
  await writeAuditLog(db, {
    workspaceId: data.workspaceId,
    actorType: 'user',
    action: 'create',
    entityType: 'post',
    entityId: postId,
    newValueJson: JSON.stringify({
      postId,
      campaignId: campaignId ?? null,
      contentId: data.contentId,
      contentVariantId: data.contentVariantId,
      accountId: data.accountId,
      contentApprovalId: latestApproval.id,
      status: initialStatus,
      scheduledAt: data.scheduledAt ?? null,
      hasIdempotencyKey: Boolean(cleanIdempotencyKey),
    }),
  })

  await emitEventSafe(db, {
    workspaceId: data.workspaceId,
    eventType: 'publication.prepared',
    actorType: 'user',
    subjectType: 'post',
    subjectId: postId,
    payloadJson: JSON.stringify({
      postId,
      campaignId: campaignId ?? null,
      contentId: data.contentId,
      contentVariantId: data.contentVariantId,
      accountId: data.accountId,
      contentApprovalId: latestApproval.id,
      status: initialStatus,
      scheduledAt: data.scheduledAt ?? null,
    }),
  })

  // 10. Fetch & Return Created Post Detail
  const createdPost = await getPostDetail(db, data.workspaceId, postId)
  if (!createdPost) {
    throw new Error('Failed to retrieve newly created post.')
  }

  return createdPost
}

/**
 * Validates whether a post or publication request is currently eligible for publishing.
 * Re-checks current live readiness: content is ready, variant is selected, approval is active,
 * account exists and matches platform.
 */
export async function validatePublicationEligibility(
  db: SqlDatabase,
  target:
    | { workspaceId: string; postId: string }
    | { workspaceId: string; contentId: string; contentVariantId: string; accountId: string },
): Promise<PublicationEligibilityResult> {
  let contentId: string
  let contentVariantId: string
  let accountId: string

  if ('postId' in target) {
    const postRow = await queryFirst<PostRow>(
      db,
      `SELECT p.*, v.content_id
       FROM post p
       JOIN content_variant v ON v.id = p.content_variant_id
       WHERE p.id = ? AND (p.workspace_id = ? OR p.workspace_id IS NULL)`,
      [target.postId, target.workspaceId],
    )
    if (!postRow || !postRow.content_id) {
      return { eligible: false, reason: 'Post record not found in this workspace.' }
    }
    contentId = postRow.content_id
    contentVariantId = postRow.content_variant_id
    accountId = postRow.account_id
  } else {
    contentId = target.contentId
    contentVariantId = target.contentVariantId
    accountId = target.accountId
  }

  // 1. Content check
  const content = await queryFirst<ContentRow>(
    db,
    `SELECT * FROM content WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [contentId, target.workspaceId],
  )
  if (!content) {
    return { eligible: false, reason: 'Content item not found or deleted.', contentId }
  }
  if (content.status !== 'ready') {
    return {
      eligible: false,
      reason: `Content is in '${content.status}' status, not 'ready'.`,
      contentId,
      isReady: false,
    }
  }
  if (content.selected_variant_id !== contentVariantId) {
    return {
      eligible: false,
      reason: 'Content variant is no longer the active approved variant for this content item.',
      contentId,
      contentVariantId,
    }
  }

  // 2. Variant check
  const variant = await queryFirst<ContentVariantRow>(
    db,
    `SELECT * FROM content_variant WHERE id = ? AND content_id = ? AND deleted_at IS NULL`,
    [contentVariantId, contentId],
  )
  if (!variant) {
    return { eligible: false, reason: 'Content variant not found or deleted.', contentVariantId }
  }

  // 3. Approval check
  const latestApproval = await queryFirst<ContentApprovalRow>(
    db,
    `SELECT * FROM content_approval 
     WHERE workspace_id = ? AND content_id = ? AND content_variant_id = ?
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    [target.workspaceId, contentId, contentVariantId],
  )
  if (!latestApproval || latestApproval.status !== 'approved') {
    return {
      eligible: false,
      reason: 'Active human editorial approval is missing or was revoked.',
      contentId,
      contentVariantId,
      hasApproval: false,
    }
  }

  // 4. Account check
  const account = await queryFirst<AccountRow>(
    db,
    `SELECT * FROM account WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [accountId, target.workspaceId],
  )
  if (!account) {
    return {
      eligible: false,
      reason: 'Account not found or deleted.',
      accountId,
      accountActive: false,
    }
  }
  if (account.platform_id !== variant.platform_id) {
    return {
      eligible: false,
      reason: `Platform mismatch: Account platform is '${account.platform_id}' but variant platform is '${variant.platform_id}'.`,
      platformMatched: false,
    }
  }

  return {
    eligible: true,
    contentId,
    contentVariantId,
    accountId,
    platformId: account.platform_id,
    approvalId: latestApproval.id,
    isReady: true,
    hasApproval: true,
    accountActive: true,
    platformMatched: true,
  }
}

/**
 * List all publication intents / posts for a content item.
 */
export async function listPostsForContent(
  db: SqlDatabase,
  workspaceId: string,
  contentId: string,
): Promise<PostDetail[]> {
  const rows = await queryAll<PostRow>(
    db,
    `SELECT p.*, a.handle AS account_handle, a.display_name AS account_display_name,
            a.platform_id, pl.name AS platform_name,
            c.id AS content_id, c.title AS content_title, c.campaign_id, cmp.name AS campaign_name,
            v.body AS variant_body, v.metadata AS variant_metadata,
            ca.status AS approval_status, ca.created_at AS approval_created_at, ca.critic_override
     FROM post p
     JOIN account a ON a.id = p.account_id
     JOIN platform pl ON pl.id = a.platform_id
     JOIN content_variant v ON v.id = p.content_variant_id
     JOIN content c ON c.id = v.content_id
     LEFT JOIN campaign cmp ON cmp.id = c.campaign_id
     LEFT JOIN content_approval ca ON ca.id = p.content_approval_id
     WHERE (p.workspace_id = ? OR p.workspace_id IS NULL) AND c.id = ?
     ORDER BY p.created_at DESC, p.rowid DESC`,
    [workspaceId, contentId],
  )

  return rows.map(toPostDetail)
}

/**
 * List all publication intents / posts for an entire campaign.
 */
export async function listPostsForCampaign(
  db: SqlDatabase,
  workspaceId: string,
  campaignId: string,
): Promise<PostDetail[]> {
  const rows = await queryAll<PostRow>(
    db,
    `SELECT p.*, a.handle AS account_handle, a.display_name AS account_display_name,
            a.platform_id, pl.name AS platform_name,
            c.id AS content_id, c.title AS content_title, c.campaign_id, cmp.name AS campaign_name,
            v.body AS variant_body, v.metadata AS variant_metadata,
            ca.status AS approval_status, ca.created_at AS approval_created_at, ca.critic_override
     FROM post p
     JOIN account a ON a.id = p.account_id
     JOIN platform pl ON pl.id = a.platform_id
     JOIN content_variant v ON v.id = p.content_variant_id
     JOIN content c ON c.id = v.content_id
     JOIN campaign cmp ON cmp.id = c.campaign_id
     LEFT JOIN content_approval ca ON ca.id = p.content_approval_id
     WHERE (p.workspace_id = ? OR p.workspace_id IS NULL) AND cmp.id = ?
     ORDER BY p.created_at DESC, p.rowid DESC`,
    [workspaceId, campaignId],
  )

  return rows.map(toPostDetail)
}

/**
 * Retrieve single post detail by ID.
 */
export async function getPostDetail(
  db: SqlDatabase,
  workspaceId: string,
  postId: string,
): Promise<PostDetail | null> {
  return getPostByQuery(
    db,
    `SELECT p.*, a.handle AS account_handle, a.display_name AS account_display_name,
            a.platform_id, pl.name AS platform_name,
            c.id AS content_id, c.title AS content_title, c.campaign_id, cmp.name AS campaign_name,
            v.body AS variant_body, v.metadata AS variant_metadata,
            ca.status AS approval_status, ca.created_at AS approval_created_at, ca.critic_override
     FROM post p
     JOIN account a ON a.id = p.account_id
     JOIN platform pl ON pl.id = a.platform_id
     JOIN content_variant v ON v.id = p.content_variant_id
     JOIN content c ON c.id = v.content_id
     LEFT JOIN campaign cmp ON cmp.id = c.campaign_id
     LEFT JOIN content_approval ca ON ca.id = p.content_approval_id
     WHERE p.id = ? AND (p.workspace_id = ? OR p.workspace_id IS NULL)`,
    [postId, workspaceId],
  )
}

async function getPostByQuery(
  db: SqlDatabase,
  sql: string,
  params: unknown[],
): Promise<PostDetail | null> {
  const row = await queryFirst<PostRow>(db, sql, params)
  return row ? toPostDetail(row) : null
}
