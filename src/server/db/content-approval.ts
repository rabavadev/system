import { z } from 'zod'

import type {
  CampaignContentItem,
  ContentApproval,
  ContentApprovalDetail,
  ContentApprovalStatus,
  ReviewVerdict,
} from '~/types/domain'
import { writeAuditLog } from './audit.ts'
import { type ContentRow, getCampaignContentDetail, toCampaignContentItem } from './content.ts'
import { type ContentReviewRow, getLatestContentReview } from './content-review.ts'
import {
  type ContentVariantDetail,
  type ContentVariantRow,
  toContentVariantDetail,
} from './content-variant.ts'
import { emitEventSafe } from './event.ts'
import { IntegrityError } from './relations.ts'
import { execute, newId, nowIso, queryAll, queryFirst, type SqlDatabase } from './sql.ts'

export interface ContentApprovalRow {
  id: string
  workspace_id: string
  campaign_id: string
  content_id: string
  content_variant_id: string
  status: ContentApprovalStatus
  actor_type: 'user' | 'system'
  actor_id: string | null
  critic_override: number
  note: string | null
  created_at: string
}

export function toContentApprovalDetail(
  row: ContentApprovalRow,
  criticVerdict?: ReviewVerdict | null,
): ContentApprovalDetail {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    campaignId: row.campaign_id,
    contentId: row.content_id,
    contentVariantId: row.content_variant_id,
    status: row.status,
    actorType: row.actor_type,
    actorId: row.actor_id,
    criticOverride: Boolean(row.critic_override),
    note: row.note,
    createdAt: row.created_at,
    criticVerdict: criticVerdict ?? null,
  }
}

export const approveContentVariantInput = z.object({
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  contentId: z.string().uuid(),
  contentVariantId: z.string().uuid(),
  note: z.string().trim().max(1000).nullable().optional(),
  overrideCritic: z.boolean().optional(),
})

export type ApproveContentVariantInput = z.input<typeof approveContentVariantInput>

export const revokeContentVariantApprovalInput = z.object({
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  contentId: z.string().uuid(),
  note: z.string().trim().max(1000).nullable().optional(),
})

export type RevokeContentVariantApprovalInput = z.input<typeof revokeContentVariantApprovalInput>

export interface ApproveContentVariantResult {
  approval: ContentApprovalDetail
  contentItem: CampaignContentItem
}

/**
 * Record human editorial approval for one exact saved content variant.
 * Sets the parent content status to 'ready' and designates the approved variant.
 * Does NOT mutate the variant content text, provenance, or hashes.
 * Does NOT perform any external publishing or trigger publisher agents.
 */
export async function approveCampaignContentVariant(
  db: SqlDatabase,
  rawInput: unknown,
  nowOverride?: string,
): Promise<ApproveContentVariantResult> {
  const data = approveContentVariantInput.parse(rawInput)
  const now = nowOverride ?? nowIso()

  // 1. Validate Campaign
  const campaign = await queryFirst<{
    id: string
    workspace_id: string
    deleted_at: string | null
  }>(db, `SELECT id, workspace_id, deleted_at FROM campaign WHERE id = ?`, [data.campaignId])
  if (!campaign || campaign.workspace_id !== data.workspaceId || campaign.deleted_at !== null) {
    throw new IntegrityError('Campaign not found in this workspace.')
  }

  // 2. Validate Content Item
  const contentRow = await queryFirst<ContentRow>(
    db,
    `SELECT * FROM content WHERE id = ? AND workspace_id = ? AND campaign_id = ?`,
    [data.contentId, data.workspaceId, data.campaignId],
  )
  if (!contentRow || contentRow.deleted_at !== null || contentRow.status === 'archived') {
    throw new IntegrityError('Content item not found or is archived.')
  }

  // 3. Validate Exact Content Variant
  const variantRow = await queryFirst<ContentVariantRow>(
    db,
    `SELECT * FROM content_variant WHERE id = ? AND content_id = ? AND deleted_at IS NULL`,
    [data.contentVariantId, data.contentId],
  )
  if (!variantRow) {
    throw new IntegrityError('Saved content variant not found or belongs to another content item.')
  }

  // 4. Check Latest Critic Review on this variant
  const latestReview = await getLatestContentReview(db, data.workspaceId, data.contentVariantId)
  const isCriticRevise = latestReview?.verdict === 'revise'
  const criticOverride = isCriticRevise && Boolean(data.overrideCritic || data.note)

  // 5. Idempotency Check: if this variant is already the active approved variant
  if (contentRow.status === 'ready' && contentRow.selected_variant_id === data.contentVariantId) {
    const existingApproval = await queryFirst<ContentApprovalRow>(
      db,
      `SELECT * FROM content_approval 
       WHERE content_variant_id = ? AND status = 'approved'
       ORDER BY created_at DESC LIMIT 1`,
      [data.contentVariantId],
    )
    if (existingApproval) {
      const updatedContent = await getCampaignContentDetail(db, data.workspaceId, data.contentId)
      if (updatedContent) {
        return {
          approval: toContentApprovalDetail(existingApproval, latestReview?.verdict),
          contentItem: updatedContent,
        }
      }
    }
  }

  const approvalId = newId()
  const cleanNote = data.note ? data.note.trim() : null

  // 6. Insert immutable content_approval record
  await execute(
    db,
    `INSERT INTO content_approval (
       id, workspace_id, campaign_id, content_id, content_variant_id,
       status, actor_type, actor_id, critic_override, note, created_at
     ) VALUES (?, ?, ?, ?, ?, 'approved', 'user', NULL, ?, ?, ?)`,
    [
      approvalId,
      data.workspaceId,
      data.campaignId,
      data.contentId,
      data.contentVariantId,
      criticOverride ? 1 : 0,
      cleanNote,
      now,
    ],
  )

  // 7. Update parent content to 'ready' and set selected_variant_id
  await execute(
    db,
    `UPDATE content SET status = 'ready', selected_variant_id = ?, updated_at = ? WHERE id = ?`,
    [data.contentVariantId, now, data.contentId],
  )

  // 8. Write Audit Log (safe metadata)
  await writeAuditLog(db, {
    workspaceId: data.workspaceId,
    actorType: 'user',
    action: 'create',
    entityType: 'content_approval',
    entityId: approvalId,
    newValueJson: JSON.stringify({
      campaignId: data.campaignId,
      contentId: data.contentId,
      contentVariantId: data.contentVariantId,
      status: 'approved',
      criticOverride,
      hasNote: Boolean(cleanNote),
    }),
  })

  // 9. Emit Domain Event
  await emitEventSafe(db, {
    workspaceId: data.workspaceId,
    eventType: 'content.variant_approved',
    actorType: 'user',
    subjectType: 'content',
    subjectId: data.contentId,
    payloadJson: JSON.stringify({
      approvalId,
      campaignId: data.campaignId,
      contentId: data.contentId,
      variantId: data.contentVariantId,
      criticOverride,
      hasNote: Boolean(cleanNote),
    }),
  })

  // 10. Fetch updated content item detail
  const updatedContentItem = await getCampaignContentDetail(db, data.workspaceId, data.contentId)
  if (!updatedContentItem) {
    throw new Error('Failed to retrieve updated content item.')
  }

  const approvalDetail: ContentApprovalDetail = {
    id: approvalId,
    workspaceId: data.workspaceId,
    campaignId: data.campaignId,
    contentId: data.contentId,
    contentVariantId: data.contentVariantId,
    status: 'approved',
    actorType: 'user',
    actorId: null,
    criticOverride,
    note: cleanNote,
    createdAt: now,
    criticVerdict: latestReview?.verdict ?? null,
  }

  return {
    approval: approvalDetail,
    contentItem: updatedContentItem,
  }
}

/**
 * Revoke readiness for a content item.
 * Preserves historical approval records and writes an immutable revocation record.
 * Sets the parent content status back to 'draft' and clears selected_variant_id.
 */
export async function revokeCampaignContentApproval(
  db: SqlDatabase,
  rawInput: unknown,
  nowOverride?: string,
): Promise<CampaignContentItem> {
  const data = revokeContentVariantApprovalInput.parse(rawInput)
  const now = nowOverride ?? nowIso()

  // 1. Validate Campaign
  const campaign = await queryFirst<{
    id: string
    workspace_id: string
    deleted_at: string | null
  }>(db, `SELECT id, workspace_id, deleted_at FROM campaign WHERE id = ?`, [data.campaignId])
  if (!campaign || campaign.workspace_id !== data.workspaceId || campaign.deleted_at !== null) {
    throw new IntegrityError('Campaign not found in this workspace.')
  }

  // 2. Validate Content Item
  const contentRow = await queryFirst<ContentRow>(
    db,
    `SELECT * FROM content WHERE id = ? AND workspace_id = ? AND campaign_id = ?`,
    [data.contentId, data.workspaceId, data.campaignId],
  )
  if (!contentRow || contentRow.deleted_at !== null || contentRow.status === 'archived') {
    throw new IntegrityError('Content item not found or is archived.')
  }

  // 3. If content is not ready or has no selected variant, nothing to revoke (idempotent)
  if (contentRow.status !== 'ready' || !contentRow.selected_variant_id) {
    const item = await getCampaignContentDetail(db, data.workspaceId, data.contentId)
    if (!item) throw new Error('Failed to retrieve content item.')
    return item
  }

  const variantIdBeingRevoked = contentRow.selected_variant_id
  const revocationId = newId()
  const cleanNote = data.note ? data.note.trim() : null

  // 4. Insert immutable revocation record in content_approval
  await execute(
    db,
    `INSERT INTO content_approval (
       id, workspace_id, campaign_id, content_id, content_variant_id,
       status, actor_type, actor_id, critic_override, note, created_at
     ) VALUES (?, ?, ?, ?, ?, 'revoked', 'user', NULL, 0, ?, ?)`,
    [
      revocationId,
      data.workspaceId,
      data.campaignId,
      data.contentId,
      variantIdBeingRevoked,
      cleanNote,
      now,
    ],
  )

  // 5. Update content table back to 'draft' and clear selected_variant_id
  await execute(
    db,
    `UPDATE content SET status = 'draft', selected_variant_id = NULL, updated_at = ? WHERE id = ?`,
    [now, data.contentId],
  )

  // 6. Write Audit Log
  await writeAuditLog(db, {
    workspaceId: data.workspaceId,
    actorType: 'user',
    action: 'update',
    entityType: 'content_approval',
    entityId: revocationId,
    newValueJson: JSON.stringify({
      campaignId: data.campaignId,
      contentId: data.contentId,
      contentVariantId: variantIdBeingRevoked,
      status: 'revoked',
      hasNote: Boolean(cleanNote),
    }),
  })

  // 7. Emit Domain Event
  await emitEventSafe(db, {
    workspaceId: data.workspaceId,
    eventType: 'content.approval_revoked',
    actorType: 'user',
    subjectType: 'content',
    subjectId: data.contentId,
    payloadJson: JSON.stringify({
      revocationId,
      campaignId: data.campaignId,
      contentId: data.contentId,
      variantId: variantIdBeingRevoked,
      hasNote: Boolean(cleanNote),
    }),
  })

  // 8. Return updated content item
  const updatedItem = await getCampaignContentDetail(db, data.workspaceId, data.contentId)
  if (!updatedItem) {
    throw new Error('Failed to retrieve updated content item.')
  }
  return updatedItem
}

/**
 * List all approval/revocation history records for a content item or variant.
 */
export async function listContentApprovals(
  db: SqlDatabase,
  workspaceId: string,
  contentId: string,
  variantId?: string,
): Promise<ContentApprovalDetail[]> {
  const clauses = ['workspace_id = ?', 'content_id = ?']
  const args: unknown[] = [workspaceId, contentId]

  if (variantId) {
    clauses.push('content_variant_id = ?')
    args.push(variantId)
  }

  const rows = await queryAll<ContentApprovalRow>(
    db,
    `SELECT * FROM content_approval WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, rowid DESC`,
    args,
  )

  return rows.map((row) => toContentApprovalDetail(row))
}

/**
 * Get latest approval record for a content variant.
 */
export async function getLatestContentApproval(
  db: SqlDatabase,
  workspaceId: string,
  contentVariantId: string,
): Promise<ContentApprovalDetail | null> {
  const row = await queryFirst<ContentApprovalRow>(
    db,
    `SELECT * FROM content_approval 
     WHERE workspace_id = ? AND content_variant_id = ? 
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    [workspaceId, contentVariantId],
  )
  return row ? toContentApprovalDetail(row) : null
}

/**
 * Clean future invariant helper for publishing systems:
 * Returns the currently approved, ready variant for publication.
 * Returns null if content is not in 'ready' status or has no approved variant.
 */
export async function getApprovedPublicationVariant(
  db: SqlDatabase,
  workspaceId: string,
  contentId: string,
): Promise<{
  content: CampaignContentItem
  variant: ContentVariantDetail
  approval: ContentApprovalDetail
} | null> {
  const contentRow = await queryFirst<ContentRow>(
    db,
    `SELECT c.*, a.handle AS account_handle, a.display_name AS account_display_name,
            a.platform_id, p.name AS platform_name
     FROM content c
     LEFT JOIN account a ON a.id = c.target_account_id
     LEFT JOIN platform p ON p.id = a.platform_id
     WHERE c.id = ? AND c.workspace_id = ? AND c.deleted_at IS NULL`,
    [contentId, workspaceId],
  )

  if (!contentRow || contentRow.status !== 'ready' || !contentRow.selected_variant_id) {
    return null
  }

  const variantRow = await queryFirst<ContentVariantRow>(
    db,
    `SELECT v.*, p.name AS platform_name
     FROM content_variant v
     JOIN platform p ON p.id = v.platform_id
     WHERE v.id = ? AND v.content_id = ? AND v.deleted_at IS NULL`,
    [contentRow.selected_variant_id, contentId],
  )
  if (!variantRow) {
    return null
  }

  const latestApproval = await queryFirst<ContentApprovalRow>(
    db,
    `SELECT * FROM content_approval 
     WHERE workspace_id = ? AND content_id = ? AND content_variant_id = ? AND status = 'approved'
     ORDER BY created_at DESC LIMIT 1`,
    [workspaceId, contentId, contentRow.selected_variant_id],
  )
  if (!latestApproval) {
    return null
  }

  return {
    content: toCampaignContentItem(contentRow),
    variant: toContentVariantDetail(variantRow),
    approval: toContentApprovalDetail(latestApproval),
  }
}
