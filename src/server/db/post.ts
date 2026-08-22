import { z } from 'zod'

import type {
  ContentApprovalStatus,
  ContentStatus,
  PostDetail,
  PostDispatchStatus,
  PostStatus,
  PublicationEligibilityResult,
} from '~/types/domain'
import { createApprovalRequest, getApprovalRequest } from '../approval/service.ts'
import { verifySnapshotIntegrity } from '../approval/snapshot.ts'
import type { ApprovalRequestRecord } from '../approval/types.ts'
import { prepareToolExecution } from '../tools/executor.ts'
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
  workspace_id: string
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
  account_status?: string | null
  account_deleted_at?: string | null
  platform_id?: string | null
  platform_name?: string | null
  content_id?: string | null
  content_title?: string | null
  content_status?: string | null
  content_deleted_at?: string | null
  content_selected_variant_id?: string | null
  content_target_account_id?: string | null
  campaign_id?: string | null
  campaign_name?: string | null
  campaign_status?: string | null
  campaign_deleted_at?: string | null
  is_campaign_account_connected?: number | null
  variant_body?: string | null
  variant_metadata?: string | null
  variant_status?: string | null
  variant_deleted_at?: string | null
  variant_platform_id?: string | null
  approval_status?: ContentApprovalStatus | null
  approval_created_at?: string | null
  approval_actor_type?: string | null
  critic_override?: number | null
  latest_approval_id?: string | null
  latest_approval_status?: ContentApprovalStatus | null
  latest_approval_actor_type?: string | null
  pending_approval_request_id?: string | null
  latest_publish_approval_status?: string | null
}

export interface PublicationEligibilitySnapshot {
  postId?: string | null
  postStatus?: PostStatus | null
  postApprovalId?: string | null

  contentId?: string | null
  contentExists: boolean
  contentDeleted: boolean
  contentStatus: string | null
  contentSelectedVariantId: string | null
  contentTargetAccountId: string | null

  variantId?: string | null
  variantExists: boolean
  variantDeleted: boolean
  variantStatus: string | null
  variantPlatformId: string | null

  latestApprovalId: string | null
  latestApprovalStatus: string | null
  latestApprovalActorType: string | null

  accountId?: string | null
  accountExists: boolean
  accountDeleted: boolean
  accountStatus: string | null
  accountPlatformId: string | null

  campaignRequired: boolean
  campaignExists: boolean
  campaignDeleted: boolean
  campaignStatus: string | null
  campaignAccountConnected: boolean

  hasPendingApproval?: boolean
  latestPublishApprovalStatus?: string | null
}

/**
 * Pure evaluator that computes publication eligibility from a normalized snapshot.
 * Used identically by validatePublicationEligibility() and derivePostState() / toPostDetail().
 */
export function evaluatePublicationEligibility(snapshot: PublicationEligibilitySnapshot): {
  isEligible: boolean
  reason: string | null
  dispatchStatus: PostDispatchStatus
} {
  // 1. Post Status Guards (Requirements 12 & 13)
  if (snapshot.postStatus === 'published') {
    return {
      isEligible: false,
      reason: 'Post is already published.',
      dispatchStatus: 'published',
    }
  }
  if (snapshot.postStatus === 'publishing') {
    return {
      isEligible: false,
      reason: 'Post is currently publishing.',
      dispatchStatus: 'publishing',
    }
  }
  if (snapshot.postStatus === 'failed') {
    return {
      isEligible: false,
      reason: 'Post execution failed. Explicit retry required.',
      dispatchStatus: 'failed',
    }
  }
  if (snapshot.postStatus === 'removed') {
    return {
      isEligible: false,
      reason: 'Post has been removed.',
      dispatchStatus: 'removed',
    }
  }
  if (
    snapshot.postStatus !== undefined &&
    snapshot.postStatus !== null &&
    snapshot.postStatus !== 'draft' &&
    snapshot.postStatus !== 'scheduled'
  ) {
    return {
      isEligible: false,
      reason: `Post is in ineligible status '${snapshot.postStatus}'.`,
      dispatchStatus: 'needs_reprepare',
    }
  }

  // 2. Post Approval Lineage Check (Requirement 2 & 14)
  if (snapshot.postId !== undefined && snapshot.postId !== null && !snapshot.postApprovalId) {
    return {
      isEligible: false,
      reason: 'Publication intent has no approval lineage and must be prepared again.',
      dispatchStatus: 'needs_reprepare',
    }
  }

  // 3. Content Guards
  if (!snapshot.contentExists || snapshot.contentDeleted || snapshot.contentStatus === 'archived') {
    return {
      isEligible: false,
      reason: 'Content item not found or is archived.',
      dispatchStatus: 'needs_reprepare',
    }
  }
  if (snapshot.contentStatus !== 'ready') {
    return {
      isEligible: false,
      reason: `Content is in '${snapshot.contentStatus ?? 'draft'}' status, not 'ready'.`,
      dispatchStatus: 'needs_reprepare',
    }
  }
  if (
    snapshot.variantId &&
    snapshot.contentSelectedVariantId &&
    snapshot.contentSelectedVariantId !== snapshot.variantId
  ) {
    return {
      isEligible: false,
      reason:
        'Content variant is no longer the active approved publication variant for this content item.',
      dispatchStatus: 'needs_reprepare',
    }
  }

  // 4. Variant Guards
  if (!snapshot.variantExists || snapshot.variantDeleted || snapshot.variantStatus === 'archived') {
    return {
      isEligible: false,
      reason: 'Content variant not found or is archived.',
      dispatchStatus: 'needs_reprepare',
    }
  }

  // 5. Approval Lineage Guards
  if (!snapshot.latestApprovalId || snapshot.latestApprovalStatus !== 'approved') {
    return {
      isEligible: false,
      reason: 'Active human editorial approval is missing or was revoked.',
      dispatchStatus: 'stale',
    }
  }
  if (snapshot.latestApprovalActorType !== 'user') {
    return {
      isEligible: false,
      reason: 'Publication requires human editorial approval.',
      dispatchStatus: 'needs_reprepare',
    }
  }
  if (snapshot.postApprovalId && snapshot.postApprovalId !== snapshot.latestApprovalId) {
    return {
      isEligible: false,
      reason:
        'Post references a stale or revoked approval lineage. Re-approval requires a new publication intent.',
      dispatchStatus: 'stale',
    }
  }

  // 6. Account Lifecycle & Platform Guards
  if (!snapshot.accountExists || snapshot.accountDeleted) {
    return {
      isEligible: false,
      reason: 'Account not found or deleted.',
      dispatchStatus: 'needs_reprepare',
    }
  }
  if (snapshot.accountStatus !== 'active') {
    return {
      isEligible: false,
      reason: `Account is ${snapshot.accountStatus ?? 'inactive'} (must be active to dispatch publication).`,
      dispatchStatus: 'needs_reprepare',
    }
  }
  if (
    snapshot.accountPlatformId &&
    snapshot.variantPlatformId &&
    snapshot.accountPlatformId !== snapshot.variantPlatformId
  ) {
    return {
      isEligible: false,
      reason: `Platform mismatch: Account platform is '${snapshot.accountPlatformId}' but variant platform is '${snapshot.variantPlatformId}'.`,
      dispatchStatus: 'needs_reprepare',
    }
  }
  if (
    snapshot.contentTargetAccountId &&
    snapshot.accountId &&
    snapshot.contentTargetAccountId !== snapshot.accountId
  ) {
    return {
      isEligible: false,
      reason: 'Account does not match the designated target account for this content item.',
      dispatchStatus: 'needs_reprepare',
    }
  }

  // 7. Campaign Existence & Membership Guards
  if (snapshot.campaignRequired) {
    if (
      !snapshot.campaignExists ||
      snapshot.campaignDeleted ||
      snapshot.campaignStatus === 'archived'
    ) {
      return {
        isEligible: false,
        reason: 'Campaign not found or is archived in this workspace.',
        dispatchStatus: 'needs_reprepare',
      }
    }
    if (!snapshot.campaignAccountConnected) {
      return {
        isEligible: false,
        reason: 'Account is not connected to this campaign.',
        dispatchStatus: 'needs_reprepare',
      }
    }
  }

  // 8. Fully Eligible
  if (snapshot.hasPendingApproval) {
    return {
      isEligible: true,
      reason: null,
      dispatchStatus: 'awaiting_approval',
    }
  }

  return {
    isEligible: true,
    reason: null,
    dispatchStatus: snapshot.postStatus === 'scheduled' ? 'scheduled' : 'prepared',
  }
}

export function derivePostState(row: PostRow): {
  isCurrentlyEligible: boolean
  eligibilityReason: string | null
  dispatchStatus: PostDispatchStatus
} {
  const snapshot: PublicationEligibilitySnapshot = {
    postId: row.id,
    postStatus: row.status,
    postApprovalId: row.content_approval_id,

    contentId: row.content_id ?? null,
    contentExists: Boolean(row.content_id),
    contentDeleted: Boolean(row.content_deleted_at),
    contentStatus: row.content_status ?? null,
    contentSelectedVariantId: row.content_selected_variant_id ?? null,
    contentTargetAccountId: row.content_target_account_id ?? null,

    variantId: row.content_variant_id,
    variantExists: Boolean(row.variant_platform_id !== undefined || row.variant_body !== undefined),
    variantDeleted: Boolean(row.variant_deleted_at),
    variantStatus: row.variant_status ?? null,
    variantPlatformId: row.variant_platform_id ?? null,

    latestApprovalId: row.latest_approval_id ?? null,
    latestApprovalStatus: row.latest_approval_status ?? null,
    latestApprovalActorType: row.latest_approval_actor_type ?? null,

    accountId: row.account_id,
    accountExists: Boolean(row.account_handle !== undefined && row.account_handle !== null),
    accountDeleted: Boolean(row.account_deleted_at),
    accountStatus: row.account_status ?? null,
    accountPlatformId: row.platform_id ?? null,

    campaignRequired: Boolean(row.campaign_id),
    campaignExists: Boolean(row.campaign_name !== undefined && row.campaign_name !== null),
    campaignDeleted: Boolean(row.campaign_deleted_at),
    campaignStatus: row.campaign_status ?? null,
    campaignAccountConnected: Boolean(row.is_campaign_account_connected),

    hasPendingApproval: Boolean(row.pending_approval_request_id),
    latestPublishApprovalStatus: row.latest_publish_approval_status ?? null,
  }

  const res = evaluatePublicationEligibility(snapshot)
  return {
    isCurrentlyEligible: res.isEligible,
    eligibilityReason: res.reason,
    dispatchStatus: res.dispatchStatus,
  }
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

  const { isCurrentlyEligible, eligibilityReason, dispatchStatus } = derivePostState(row)

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
    linkedApprovalStatus: row.approval_status ?? null,
    approvalStatus: row.approval_status ?? null,
    approvalCreatedAt: row.approval_created_at ?? null,
    criticOverride:
      row.critic_override !== undefined && row.critic_override !== null
        ? Boolean(row.critic_override)
        : null,
    isCurrentlyEligible,
    eligibilityReason,
    dispatchStatus,
    pendingApprovalRequestId: row.pending_approval_request_id ?? undefined,
    latestPublishApprovalStatus: row.latest_publish_approval_status ?? undefined,
  }
}

const POST_DETAIL_SELECT_FIELDS = `
  p.*,
  a.handle AS account_handle,
  a.display_name AS account_display_name,
  a.status AS account_status,
  a.deleted_at AS account_deleted_at,
  a.platform_id,
  pl.name AS platform_name,
  c.id AS content_id,
  c.title AS content_title,
  c.status AS content_status,
  c.deleted_at AS content_deleted_at,
  c.selected_variant_id AS content_selected_variant_id,
  c.target_account_id AS content_target_account_id,
  c.campaign_id,
  cmp.name AS campaign_name,
  cmp.status AS campaign_status,
  cmp.deleted_at AS campaign_deleted_at,
  (
    CASE
      WHEN c.campaign_id IS NULL THEN 1
      ELSE (
        SELECT 1 FROM campaign_account ca_acc
        WHERE ca_acc.campaign_id = c.campaign_id AND ca_acc.account_id = p.account_id
      )
    END
  ) AS is_campaign_account_connected,
  v.body AS variant_body,
  v.metadata AS variant_metadata,
  v.status AS variant_status,
  v.deleted_at AS variant_deleted_at,
  v.platform_id AS variant_platform_id,
  ca.status AS approval_status,
  ca.created_at AS approval_created_at,
  ca.critic_override,
  ca.actor_type AS approval_actor_type,
  (
    SELECT ca2.id FROM content_approval ca2
    WHERE ca2.workspace_id = p.workspace_id
      AND ca2.content_id = c.id
      AND ca2.content_variant_id = p.content_variant_id
    ORDER BY ca2.created_at DESC, ca2.rowid DESC
    LIMIT 1
  ) AS latest_approval_id,
  (
    SELECT ca2.status FROM content_approval ca2
    WHERE ca2.workspace_id = p.workspace_id
      AND ca2.content_id = c.id
      AND ca2.content_variant_id = p.content_variant_id
    ORDER BY ca2.created_at DESC, ca2.rowid DESC
    LIMIT 1
  ) AS latest_approval_status,
  (
    SELECT ca2.actor_type FROM content_approval ca2
    WHERE ca2.workspace_id = p.workspace_id
      AND ca2.content_id = c.id
      AND ca2.content_variant_id = p.content_variant_id
    ORDER BY ca2.created_at DESC, ca2.rowid DESC
    LIMIT 1
  ) AS latest_approval_actor_type,
  (
    SELECT ar.id FROM approval ar
    WHERE ar.workspace_id = p.workspace_id
      AND ar.action_key = 'content.publish'
      AND ar.subject_type = 'post'
      AND ar.subject_id = p.id
      AND ar.status = 'pending'
      AND (ar.expires_at IS NULL OR ar.expires_at > datetime('now'))
    ORDER BY ar.created_at DESC, ar.rowid DESC
    LIMIT 1
  ) AS pending_approval_request_id,
  (
    SELECT ar.status FROM approval ar
    WHERE ar.workspace_id = p.workspace_id
      AND ar.action_key = 'content.publish'
      AND ar.subject_type = 'post'
      AND ar.subject_id = p.id
    ORDER BY ar.created_at DESC, ar.rowid DESC
    LIMIT 1
  ) AS latest_publish_approval_status
`

const POST_DETAIL_FROM_CLAUSE = `
  FROM post p
  LEFT JOIN content_variant v ON v.id = p.content_variant_id
  LEFT JOIN content c ON c.id = v.content_id AND c.workspace_id = p.workspace_id
  LEFT JOIN account a ON a.id = p.account_id AND a.workspace_id = p.workspace_id
  LEFT JOIN platform pl ON pl.id = a.platform_id
  LEFT JOIN campaign cmp ON cmp.id = c.campaign_id AND cmp.workspace_id = p.workspace_id
  LEFT JOIN content_approval ca ON ca.id = p.content_approval_id AND ca.workspace_id = p.workspace_id AND ca.content_variant_id = p.content_variant_id
`

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
 * account validity & active status, platform match, and campaign account linkage.
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
  const workspaceRow = await queryFirst<{ id: string }>(
    db,
    `SELECT id FROM workspace WHERE id = ?`,
    [data.workspaceId],
  )
  if (!workspaceRow) {
    throw new IntegrityError('Workspace not found.')
  }

  // 2. Validate Content Item & Lifecycle
  const contentRow = await queryFirst<ContentRow>(
    db,
    `SELECT * FROM content WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [data.contentId, data.workspaceId],
  )
  if (!contentRow) {
    throw new IntegrityError('Content item not found in this workspace.')
  }
  if (contentRow.status === 'archived') {
    throw new IntegrityError('Content item is archived and cannot be published.')
  }
  if (contentRow.status !== 'ready') {
    throw new IntegrityError(
      `Content item is in '${contentRow.status}' status, but must be in 'ready' status for publication.`,
    )
  }

  // Server-Authoritative Campaign Lineage Derivation (Requirement 11)
  const serverCampaignId = contentRow.campaign_id ?? null
  if (data.campaignId && serverCampaignId && data.campaignId !== serverCampaignId) {
    throw new IntegrityError(
      'Campaign ID does not match persisted content campaign lineage.',
    )
  }
  if (data.campaignId && !serverCampaignId) {
    throw new IntegrityError(
      'Content does not belong to a campaign, but a campaign ID was provided.',
    )
  }

  // 3. Validate Campaign Lifecycle (if attached)
  if (serverCampaignId) {
    const campaignRow = await queryFirst<CampaignRow>(
      db,
      `SELECT * FROM campaign WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
      [serverCampaignId, data.workspaceId],
    )
    if (!campaignRow) {
      throw new IntegrityError('Campaign not found in this workspace.')
    }
    if (campaignRow.status === 'archived') {
      throw new IntegrityError('Campaign is archived and cannot be published.')
    }
  }

  // 4. Validate Content Variant
  const variantRow = await queryFirst<ContentVariantRow>(
    db,
    `SELECT * FROM content_variant WHERE id = ? AND content_id = ? AND deleted_at IS NULL`,
    [data.contentVariantId, data.contentId],
  )
  if (!variantRow) {
    throw new IntegrityError('Content variant not found for this content item.')
  }
  if (variantRow.status === 'archived') {
    throw new IntegrityError('Content variant is archived.')
  }

  // Verify variant is the current selected publication variant
  if (contentRow.selected_variant_id !== data.contentVariantId) {
    throw new IntegrityError(
      'Requested variant is not the currently approved publication candidate for this content item.',
    )
  }

  // 5. Validate Active Content Approval & Lineage (Requirements 3 & 4)
  const latestApproval = await queryFirst<ContentApprovalRow>(
    db,
    `SELECT * FROM content_approval 
     WHERE workspace_id = ? AND content_id = ? AND content_variant_id = ?
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    [data.workspaceId, data.contentId, data.contentVariantId],
  )
  if (
    !latestApproval ||
    latestApproval.status !== 'approved' ||
    latestApproval.actor_type !== 'user'
  ) {
    throw new IntegrityError(
      'Content variant does not have an active human editorial approval (it may be unapproved, revoked, or non-human).',
    )
  }

  // 6. Validate Account & Active Lifecycle & Platform Match
  const accountRow = await queryFirst<AccountRow>(
    db,
    `SELECT * FROM account WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [data.accountId, data.workspaceId],
  )
  if (!accountRow) {
    throw new IntegrityError('Account not found in this workspace.')
  }
  if (accountRow.status !== 'active') {
    throw new IntegrityError(
      `Account is '${accountRow.status}', but must be active to prepare publication.`,
    )
  }
  if (accountRow.platform_id !== variantRow.platform_id) {
    throw new IntegrityError(
      `Platform mismatch: Account belongs to platform '${accountRow.platform_id}' but variant is for platform '${variantRow.platform_id}'.`,
    )
  }
  if (contentRow.target_account_id && contentRow.target_account_id !== data.accountId) {
    throw new IntegrityError(
      'Account does not match the designated target account for this content item.',
    )
  }

  // Campaign Account Linkage Verification
  if (serverCampaignId) {
    const campaignAccountRow = await queryFirst<{ campaign_id: string; account_id: string }>(
      db,
      `SELECT campaign_id, account_id FROM campaign_account WHERE campaign_id = ? AND account_id = ?`,
      [serverCampaignId, data.accountId],
    )
    if (!campaignAccountRow) {
      throw new IntegrityError(
        'Account is not connected to this campaign.',
      )
    }
  }

  // 7. Check Active Post Uniqueness and Request-Bound Idempotency
  const cleanIdempotencyKey = data.idempotencyKey?.trim() || null

  if (cleanIdempotencyKey) {
    const existingPostWithKey = await getPostByQuery(
      db,
      `SELECT ${POST_DETAIL_SELECT_FIELDS}
       ${POST_DETAIL_FROM_CLAUSE}
       WHERE p.workspace_id = ? AND p.idempotency_key = ?`,
      [data.workspaceId, cleanIdempotencyKey],
    )
    if (existingPostWithKey) {
      if (
        existingPostWithKey.contentVariantId === data.contentVariantId &&
        existingPostWithKey.accountId === data.accountId
      ) {
        return existingPostWithKey
      }
      throw new IntegrityError(
        'idempotency_key_conflict: Idempotency key already used for a different publication intent.',
      )
    }
  }

  const existingActivePost = await getPostByQuery(
    db,
    `SELECT ${POST_DETAIL_SELECT_FIELDS}
     ${POST_DETAIL_FROM_CLAUSE}
     WHERE p.workspace_id = ? AND p.content_variant_id = ? AND p.account_id = ? AND p.content_approval_id = ?
       AND p.status IN ('draft', 'scheduled')
     ORDER BY p.created_at DESC, p.rowid DESC
     LIMIT 1`,
    [data.workspaceId, data.contentVariantId, data.accountId, latestApproval.id],
  )
  if (existingActivePost) {
    return existingActivePost
  }

  // 8. Determine Initial Status
  const initialStatus: PostStatus = data.scheduledAt ? 'scheduled' : 'draft'
  const postId = newId()

  // 9. Insert Post Record
  await execute(
    db,
    `INSERT INTO post (
       id, workspace_id, content_variant_id, account_id,
       content_approval_id, status, external_id, url,
       scheduled_at, published_at, error,
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

  // 10. Write Safe Audit Log
  await writeAuditLog(db, {
    workspaceId: data.workspaceId,
    actorType: 'user',
    action: 'create',
    entityType: 'post',
    entityId: postId,
    newValueJson: JSON.stringify({
      postId,
      campaignId: serverCampaignId,
      contentId: data.contentId,
      contentVariantId: data.contentVariantId,
      accountId: data.accountId,
      contentApprovalId: latestApproval.id,
      status: initialStatus,
      scheduledAt: data.scheduledAt ?? null,
      hasIdempotencyKey: Boolean(cleanIdempotencyKey),
    }),
  })

  // 11. Emit Publication Event
  await emitEventSafe(db, {
    workspaceId: data.workspaceId,
    eventType: 'publication.prepared',
    actorType: 'user',
    subjectType: 'post',
    subjectId: postId,
    payloadJson: JSON.stringify({
      postId,
      campaignId: serverCampaignId,
      contentId: data.contentId,
      contentVariantId: data.contentVariantId,
      accountId: data.accountId,
      contentApprovalId: latestApproval.id,
      status: initialStatus,
      scheduledAt: data.scheduledAt ?? null,
    }),
  })

  // 12. Fetch & Return Created Post Detail
  const createdPost = await getPostDetail(db, data.workspaceId, postId)
  if (!createdPost) {
    throw new Error('Failed to retrieve newly created post.')
  }

  return createdPost
}

/**
 * Validates whether a post or publication request is currently eligible for publishing.
 * Re-checks current live readiness using the same canonical evaluator as derivePostState().
 */
export async function validatePublicationEligibility(
  db: SqlDatabase,
  target:
    | { workspaceId: string; postId: string }
    | { workspaceId: string; contentId: string; contentVariantId: string; accountId: string },
): Promise<PublicationEligibilityResult> {
  if ('postId' in target) {
    const postRow = await queryFirst<PostRow>(
      db,
      `SELECT ${POST_DETAIL_SELECT_FIELDS}
       ${POST_DETAIL_FROM_CLAUSE}
       WHERE p.id = ? AND p.workspace_id = ?`,
      [target.postId, target.workspaceId],
    )
    if (!postRow) {
      return {
        eligible: false,
        reason: 'Post record not found in this workspace.',
        postId: target.postId,
      }
    }

    const derived = derivePostState(postRow)
    return {
      eligible: derived.isCurrentlyEligible,
      reason: derived.eligibilityReason ?? undefined,
      postId: target.postId,
      contentId: postRow.content_id ?? undefined,
      contentVariantId: postRow.content_variant_id,
      accountId: postRow.account_id,
      platformId: postRow.platform_id ?? undefined,
      approvalId: postRow.latest_approval_id ?? undefined,
      isReady: derived.isCurrentlyEligible,
      hasApproval: derived.isCurrentlyEligible,
      accountActive: postRow.account_status === 'active' && !postRow.account_deleted_at,
      platformMatched: Boolean(
        postRow.platform_id &&
          postRow.variant_platform_id &&
          postRow.platform_id === postRow.variant_platform_id,
      ),
      postStatus: postRow.status,
    }
  }

  const contentId = target.contentId
  const contentVariantId = target.contentVariantId
  const accountId = target.accountId

  const content = await queryFirst<ContentRow>(
    db,
    `SELECT * FROM content WHERE id = ? AND workspace_id = ?`,
    [contentId, target.workspaceId],
  )
  const variant = await queryFirst<ContentVariantRow>(
    db,
    `SELECT * FROM content_variant WHERE id = ? AND content_id = ?`,
    [contentVariantId, contentId],
  )
  const latestApproval = await queryFirst<ContentApprovalRow>(
    db,
    `SELECT * FROM content_approval 
     WHERE workspace_id = ? AND content_id = ? AND content_variant_id = ?
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    [target.workspaceId, contentId, contentVariantId],
  )
  const account = await queryFirst<AccountRow>(
    db,
    `SELECT * FROM account WHERE id = ? AND workspace_id = ?`,
    [accountId, target.workspaceId],
  )

  let campaign: CampaignRow | null = null
  let isCampaignAccountConnected = false
  if (content?.campaign_id) {
    campaign = await queryFirst<CampaignRow>(
      db,
      `SELECT * FROM campaign WHERE id = ? AND workspace_id = ?`,
      [content.campaign_id, target.workspaceId],
    )
    const campaignAccount = await queryFirst<{ campaign_id: string; account_id: string }>(
      db,
      `SELECT campaign_id, account_id FROM campaign_account WHERE campaign_id = ? AND account_id = ?`,
      [content.campaign_id, accountId],
    )
    isCampaignAccountConnected = Boolean(campaignAccount)
  }

  const snapshot: PublicationEligibilitySnapshot = {
    contentId,
    contentExists: Boolean(content),
    contentDeleted: Boolean(content?.deleted_at),
    contentStatus: content?.status ?? null,
    contentSelectedVariantId: content?.selected_variant_id ?? null,
    contentTargetAccountId: content?.target_account_id ?? null,

    variantId: contentVariantId,
    variantExists: Boolean(variant),
    variantDeleted: Boolean(variant?.deleted_at),
    variantStatus: variant?.status ?? null,
    variantPlatformId: variant?.platform_id ?? null,

    latestApprovalId: latestApproval?.id ?? null,
    latestApprovalStatus: latestApproval?.status ?? null,
    latestApprovalActorType: latestApproval?.actor_type ?? null,

    accountId,
    accountExists: Boolean(account),
    accountDeleted: Boolean(account?.deleted_at),
    accountStatus: account?.status ?? null,
    accountPlatformId: account?.platform_id ?? null,

    campaignRequired: Boolean(content?.campaign_id),
    campaignExists: Boolean(campaign),
    campaignDeleted: Boolean(campaign?.deleted_at),
    campaignStatus: campaign?.status ?? null,
    campaignAccountConnected: isCampaignAccountConnected,
  }

  const evaluation = evaluatePublicationEligibility(snapshot)
  return {
    eligible: evaluation.isEligible,
    reason: evaluation.reason ?? undefined,
    contentId,
    contentVariantId,
    accountId,
    platformId: account?.platform_id,
    approvalId: latestApproval?.id,
    isReady: evaluation.isEligible,
    hasApproval: evaluation.isEligible,
    accountActive: Boolean(account && account.status === 'active' && !account.deleted_at),
    platformMatched: Boolean(account && variant && account.platform_id === variant.platform_id),
    postStatus: undefined,
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
    `SELECT ${POST_DETAIL_SELECT_FIELDS}
     ${POST_DETAIL_FROM_CLAUSE}
     WHERE p.workspace_id = ? AND c.id = ?
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
    `SELECT ${POST_DETAIL_SELECT_FIELDS}
     ${POST_DETAIL_FROM_CLAUSE}
     WHERE p.workspace_id = ? AND cmp.id = ?
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
    `SELECT ${POST_DETAIL_SELECT_FIELDS}
     ${POST_DETAIL_FROM_CLAUSE}
     WHERE p.id = ? AND p.workspace_id = ?`,
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

export const requestPublicationDispatchInput = z.object({
  workspaceId: z.string().uuid(),
  postId: z.string().uuid(),
})

export type RequestPublicationDispatchInput = z.input<typeof requestPublicationDispatchInput>

export interface RequestPublicationDispatchResult {
  status: 'pending' | 'blocked'
  reason: string
  approvalRequest: ApprovalRequestRecord | null
  isDuplicate?: boolean
  post: PostDetail
}

/**
 * Initiates an approval-gated publication dispatch request for an exact Post.
 * Re-validates canonical publication eligibility and resolves through the STEP 11 Approval Policy.
 */
export async function requestPublicationDispatch(
  db: SqlDatabase,
  rawInput: unknown,
): Promise<RequestPublicationDispatchResult> {
  const data = requestPublicationDispatchInput.parse(rawInput)

  // 1. Validate Workspace
  const workspaceRow = await queryFirst<{ id: string }>(
    db,
    `SELECT id FROM workspace WHERE id = ?`,
    [data.workspaceId],
  )
  if (!workspaceRow) {
    throw new IntegrityError('Workspace not found.')
  }

  // 2. Fetch authoritative exact Post record
  const post = await getPostDetail(db, data.workspaceId, data.postId)
  if (!post) {
    throw new IntegrityError('Post record not found in this workspace.')
  }

  // 3. Re-validate publication eligibility before creating approval
  const elig = await validatePublicationEligibility(db, {
    workspaceId: data.workspaceId,
    postId: data.postId,
  })
  if (!elig.eligible) {
    throw new IntegrityError(
      `Post is not currently eligible for publication: ${elig.reason ?? 'ineligible'}`,
    )
  }

  // 4. Resolve campaign / brand scope for policy
  let brandId: string | null = null
  if (post.campaignId) {
    const campaign = await queryFirst<{ brand_id: string }>(
      db,
      `SELECT brand_id FROM campaign WHERE id = ? AND workspace_id = ?`,
      [post.campaignId, data.workspaceId],
    )
    if (campaign) {
      brandId = campaign.brand_id
    }
  }

  // 5. Create Approval Request through canonical Approval Service
  // Hard minimum review: ensures external publishing requires human review even if workspace policy is AUTO.
  const approvalRes = await createApprovalRequest(db, {
    workspaceId: data.workspaceId,
    actionKey: 'content.publish',
    origin: 'user',
    minimumMode: 'review',
    brandId,
    subjectType: 'post',
    subjectId: post.id,
    risk: ['write', 'external'],
    summary: `Publish approved draft to ${post.accountHandle ? '@' + post.accountHandle.replace(/^@/, '') : (post.accountDisplayName ?? 'account')}`,
    payload: {
      postId: post.id,
      workspaceId: post.workspaceId,
      campaignId: post.campaignId ?? null,
      contentId: post.contentId,
      contentVariantId: post.contentVariantId,
      contentApprovalId: post.contentApprovalId,
      accountId: post.accountId,
      platformId: post.platformId ?? null,
      scheduledAt: post.scheduledAt ?? null,
      idempotencyKey: post.idempotencyKey ?? null,
    },
  })

  // 6. Handle BLOCKED
  if (approvalRes.status === 'blocked') {
    await emitEventSafe(db, {
      workspaceId: data.workspaceId,
      eventType: 'publication.approval_blocked',
      actorType: 'user',
      subjectType: 'post',
      subjectId: post.id,
      payloadJson: JSON.stringify({
        postId: post.id,
        reason: approvalRes.reason,
      }),
    })

    await writeAuditLog(db, {
      workspaceId: data.workspaceId,
      actorType: 'user',
      action: 'update',
      entityType: 'post',
      entityId: post.id,
      newValueJson: JSON.stringify({
        postId: post.id,
        reason: approvalRes.reason,
      }),
    })

    const updatedPost = await getPostDetail(db, data.workspaceId, data.postId)
    return {
      status: 'blocked',
      reason: approvalRes.reason,
      approvalRequest: null,
      post: updatedPost ?? post,
    }
  }

  // 7. Handle REVIEW (Pending)
  if (approvalRes.status !== 'pending') {
    // Unreachable: only blocked handled above, auto returns earlier; guard for exhaustiveness
    throw new IntegrityError('Unexpected approval resolution status.')
  }

  const pendingRequest = approvalRes.request
  if (!approvalRes.isDuplicate) {
    await emitEventSafe(db, {
      workspaceId: data.workspaceId,
      eventType: 'publication.approval_requested',
      actorType: 'user',
      subjectType: 'post',
      subjectId: post.id,
      payloadJson: JSON.stringify({
        postId: post.id,
        approvalRequestId: pendingRequest.id,
        campaignId: post.campaignId ?? null,
        contentId: post.contentId,
        contentVariantId: post.contentVariantId,
        accountId: post.accountId,
        policySource: pendingRequest.policySource,
      }),
    })

    await writeAuditLog(db, {
      workspaceId: data.workspaceId,
      actorType: 'user',
      action: 'update',
      entityType: 'post',
      entityId: post.id,
      newValueJson: JSON.stringify({
        postId: post.id,
        approvalRequestId: pendingRequest.id,
        effectivePolicyMode: 'review',
        policySource: pendingRequest.policySource,
      }),
    })
  }

  const updatedPost = await getPostDetail(db, data.workspaceId, data.postId)
  return {
    status: 'pending',
    reason: approvalRes.reason,
    approvalRequest: pendingRequest,
    isDuplicate: approvalRes.isDuplicate ?? false,
    post: updatedPost ?? post,
  }
}

export interface DispatchPublicationResult {
  ok: boolean
  code: 'not_approved' | 'ineligible' | 'not_configured' | 'integrity_error'
  message: string
  postId?: string
}

/**
 * Handles the dispatch boundary for an approved publication request.
 * Re-validates live publication eligibility and snapshot integrity at approval time.
 * In STEP 15E.2, fails safely without external connectors or fake publication success.
 */
export async function dispatchApprovedPublication(
  db: SqlDatabase,
  input: { workspaceId: string; approvalRequestId: string },
): Promise<DispatchPublicationResult> {
  const req = await getApprovalRequest(db, {
    workspaceId: input.workspaceId,
    id: input.approvalRequestId,
  })
  if (!req) {
    throw new IntegrityError('Approval request not found.')
  }

  if (req.actionKey !== 'content.publish') {
    throw new IntegrityError(
      `Approval request is for action '${req.actionKey}', not 'content.publish'.`,
    )
  }

  if (req.status !== 'approved') {
    const failResult: DispatchPublicationResult = {
      ok: false,
      code: 'not_approved',
      message: `Approval request is ${req.status}, but must be approved to attempt dispatch.`,
    }
    if (req.subjectId) {
      failResult.postId = req.subjectId
    }
    return failResult
  }

  // Verify Snapshot Integrity
  const isIntact = verifySnapshotIntegrity('content.publish', req.snapshotJson, req.fingerprint)
  if (!isIntact) {
    throw new IntegrityError('Approval request snapshot integrity violation.')
  }

  let parsedPayload: Record<string, unknown> = {}
  try {
    parsedPayload = JSON.parse(req.snapshotJson)
  } catch {
    throw new IntegrityError('Malformed approval request snapshot.')
  }

  const postId = typeof parsedPayload['postId'] === 'string' ? parsedPayload['postId'] : req.subjectId
  if (!postId) {
    throw new IntegrityError('Approval request snapshot missing postId.')
  }

  // 1. Approval-Time Revalidation: Recheck current live publication eligibility
  const elig = await validatePublicationEligibility(db, {
    workspaceId: input.workspaceId,
    postId,
  })
  if (!elig.eligible) {
    await emitEventSafe(db, {
      workspaceId: input.workspaceId,
      eventType: 'publication.dispatch_unavailable',
      actorType: 'system',
      subjectType: 'post',
      subjectId: postId,
      payloadJson: JSON.stringify({
        postId,
        approvalRequestId: req.id,
        reason: `Post is no longer eligible for publication: ${elig.reason}`,
      }),
    })

    return {
      ok: false,
      code: 'ineligible',
      message: `Post is no longer eligible for publication: ${elig.reason}`,
      postId,
    }
  }

  // 2. Future tool execution boundary check
  const prep = prepareToolExecution({
    workspaceId: input.workspaceId,
    toolKey: 'platform.publish',
    args: {
      accountId: elig.accountId,
      contentVariantId: elig.contentVariantId,
    },
    caller: {
      agentId: 'publisher',
      agentName: 'Publisher',
      agentStatus: 'disabled',
      agentVersionId: 'publisher-v1',
      capabilities: ['publish'],
    },
  })

  // Since platform.publish is unavailable in STEP 15E.2:
  await emitEventSafe(db, {
    workspaceId: input.workspaceId,
    eventType: 'publication.dispatch_unavailable',
    actorType: 'system',
    subjectType: 'post',
    subjectId: postId,
    payloadJson: JSON.stringify({
      postId,
      approvalRequestId: req.id,
      reason: prep.ok ? 'Platform publication adapter is not configured.' : prep.error.message,
    }),
  })

  await writeAuditLog(db, {
    workspaceId: input.workspaceId,
    actorType: 'system',
    action: 'update',
    entityType: 'post',
    entityId: postId,
    newValueJson: JSON.stringify({
      postId,
      approvalRequestId: req.id,
      success: false,
      reason: 'Platform publication adapter is not configured or available.',
    }),
  })

  return {
    ok: false,
    code: 'not_configured',
    message:
      'Platform publication adapter is not configured or available yet. Zero external network publishing performed.',
    postId,
  }
}
