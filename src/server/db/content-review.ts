import { z } from 'zod'

import type { ContentReviewDetail, ContentStatus, ReviewVerdict } from '../../types/domain.ts'
import {
  composeContentReviewTask,
  type GeneratedContentReview,
  parseContentReviewOutput,
} from '../agents/content-review.ts'
import { ensureBuiltinAgents } from '../agents/registry.ts'
import { executeAgentTask } from '../agents/task.ts'
import type { ExecuteAIDeps } from '../ai/executor.ts'
import { buildContext } from '../context/engine.ts'
import { writeAuditLog } from './audit.ts'
import { type ContentRow, toCampaignContentItem } from './content.ts'
import { type ContentVariantRow, toContentVariantDetail } from './content-variant.ts'
import { emitEventSafe } from './event.ts'
import { IntegrityError } from './relations.ts'
import { execute, nowIso, queryAll, queryFirst, type SqlDatabase } from './sql.ts'

export interface CriticReviewProvenance {
  criticAgentId: string
  criticAgentName: string
  criticAgentVersionId: string
  versionNumber: number
  executionId: string
  model: string
  createdAt: string
}

export interface GenerateContentReviewSuccess {
  ok: true
  review: GeneratedContentReview
  provenance: CriticReviewProvenance
  contentVariantId: string
}

export interface GenerateContentReviewFailure {
  ok: false
  errorCode: string
  message: string
}

export type GenerateContentReviewResult =
  | GenerateContentReviewSuccess
  | GenerateContentReviewFailure

export const generateContentReviewInput = z.object({
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  contentId: z.string().uuid(),
  contentVariantId: z.string().uuid(),
})

export const saveContentReviewInput = z.object({
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  contentId: z.string().uuid(),
  contentVariantId: z.string().uuid(),
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
})

export interface ContentReviewRow {
  id: string
  workspace_id: string
  content_id: string
  content_variant_id: string
  critic_agent_id: string
  critic_agent_version_id: string
  ai_execution_id: string
  verdict: string
  review_json: string
  created_at: string
  critic_agent_name?: string | null
  critic_version_number?: number | null
}

export function toContentReviewDetail(row: ContentReviewRow): ContentReviewDetail {
  let parsedJson: {
    summary?: string
    strengths?: string[]
    issues?: Array<{ category: string; severity: 'low' | 'medium' | 'high'; message: string }>
    recommendedChanges?: string[]
  } = {}

  try {
    parsedJson = JSON.parse(row.review_json)
  } catch {
    // fallback
  }

  const verdict: ReviewVerdict = row.verdict === 'pass' ? 'pass' : 'revise'

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    contentId: row.content_id,
    contentVariantId: row.content_variant_id,
    criticAgentId: row.critic_agent_id,
    criticAgentVersionId: row.critic_agent_version_id,
    aiExecutionId: row.ai_execution_id,
    verdict,
    reviewJson: row.review_json,
    createdAt: row.created_at,
    criticAgentName: row.critic_agent_name ?? 'Critic',
    criticAgentVersionNumber:
      typeof row.critic_version_number === 'number' ? row.critic_version_number : 1,
    summary:
      parsedJson.summary ??
      (verdict === 'pass' ? 'Draft passes editorial review.' : 'Draft requires revisions.'),
    strengths: Array.isArray(parsedJson.strengths) ? parsedJson.strengths : [],
    issues: Array.isArray(parsedJson.issues) ? parsedJson.issues : [],
    recommendedChanges: Array.isArray(parsedJson.recommendedChanges)
      ? parsedJson.recommendedChanges
      : [],
  }
}

/**
 * Generate an editorial review for ONE saved Campaign content variant using the Critic agent.
 * Does NOT persist review to database.
 */
export async function generateCampaignContentReview(
  db: SqlDatabase,
  rawInput: unknown,
  deps: ExecuteAIDeps,
): Promise<GenerateContentReviewResult> {
  const data = generateContentReviewInput.parse(rawInput)

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
    `SELECT c.*, a.handle AS account_handle, a.display_name AS account_display_name,
            a.platform_id, p.name AS platform_name
     FROM content c
     LEFT JOIN account a ON a.id = c.target_account_id
     LEFT JOIN platform p ON p.id = a.platform_id
     WHERE c.id = ? AND c.campaign_id = ? AND c.deleted_at IS NULL`,
    [data.contentId, data.campaignId],
  )
  if (!contentRow) {
    throw new IntegrityError('Content item not found or is archived.')
  }
  const contentItem = toCampaignContentItem(contentRow)

  // 3. Validate Exact Content Variant
  const variantRow = await queryFirst<ContentVariantRow>(
    db,
    `SELECT cv.*, p.name AS platform_name
     FROM content_variant cv
     LEFT JOIN platform p ON p.id = cv.platform_id
     WHERE cv.id = ? AND cv.content_id = ? AND cv.deleted_at IS NULL`,
    [data.contentVariantId, data.contentId],
  )
  if (!variantRow) {
    throw new IntegrityError('Saved content variant not found or is archived.')
  }
  const variantDetail = toContentVariantDetail(variantRow)

  // 4. Resolve Built-in Critic Agent
  const agentMap = await ensureBuiltinAgents(db, data.workspaceId)
  const criticHandle = agentMap.get('critic')
  if (!criticHandle) {
    return {
      ok: false,
      errorCode: 'agent_not_found',
      message: 'Critic agent is not available in this workspace.',
    }
  }

  if (criticHandle.agent.status !== 'active') {
    return {
      ok: false,
      errorCode: 'agent_inactive',
      message: 'Critic agent is currently disabled.',
    }
  }

  // 5. Gather Campaign Context via Context Engine
  const pkg = await buildContext(db, {
    workspaceId: data.workspaceId,
    campaignId: data.campaignId,
  })

  // 6. Compose Review Task
  const platformName = contentItem.platformName ?? variantDetail.platformName ?? null
  const task = composeContentReviewTask(contentItem, variantDetail, platformName)

  // 7. Execute Critic Agent Task
  const result = await executeAgentTask({
    db,
    workspaceId: data.workspaceId,
    handle: criticHandle,
    pkg,
    task,
    eventSubject: { subjectType: 'content', subjectId: data.contentId },
    deps,
    metadata: {
      campaignId: data.campaignId,
      contentId: data.contentId,
      contentVariantId: data.contentVariantId,
    },
  })

  if (!result.ok) {
    return {
      ok: false,
      errorCode: result.errorCode,
      message: result.message,
    }
  }

  // 8. Parse structured review
  const review = parseContentReviewOutput(result.content)

  // 9. Construct generation provenance
  const provenance: CriticReviewProvenance = {
    criticAgentId: criticHandle.agent.id,
    criticAgentName: criticHandle.agent.name,
    criticAgentVersionId: criticHandle.version.id,
    versionNumber: criticHandle.version.version,
    executionId: result.execution.executionId,
    model: result.execution.model ?? 'default',
    createdAt: nowIso(),
  }

  // 10. Emit domain event (safe audit log)
  await emitEventSafe(db, {
    workspaceId: data.workspaceId,
    eventType: 'content.review_generated',
    actorType: 'agent',
    actorId: criticHandle.agent.id,
    subjectType: 'content',
    subjectId: data.contentId,
    payloadJson: JSON.stringify({
      campaignId: data.campaignId,
      contentId: data.contentId,
      contentVariantId: data.contentVariantId,
      executionId: result.execution.executionId,
      agentVersionId: criticHandle.version.id,
      verdict: review.verdict,
    }),
  })

  return {
    ok: true,
    review,
    provenance,
    contentVariantId: data.contentVariantId,
  }
}

/**
 * Persist an editorial review for a saved content variant.
 * Creates an immutable review record without overwriting previous reviews.
 */
export async function saveCampaignContentReview(
  db: SqlDatabase,
  rawInput: unknown,
  nowOverride?: string,
): Promise<ContentReviewDetail> {
  const data = saveContentReviewInput.parse(rawInput)
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
  const content = await queryFirst<{
    id: string
    status: ContentStatus
    deleted_at: string | null
  }>(db, `SELECT id, status, deleted_at FROM content WHERE id = ? AND campaign_id = ?`, [
    data.contentId,
    data.campaignId,
  ])
  if (!content || content.deleted_at !== null) {
    throw new IntegrityError('Content item not found or is archived.')
  }

  // 3. Validate Exact Content Variant
  const variant = await queryFirst<{ id: string; deleted_at: string | null }>(
    db,
    `SELECT id, deleted_at FROM content_variant WHERE id = ? AND content_id = ?`,
    [data.contentVariantId, data.contentId],
  )
  if (!variant || variant.deleted_at !== null) {
    throw new IntegrityError('Content variant not found or is archived.')
  }

  // 4. Resolve Critic Agent Identity & Version
  const agentMap = await ensureBuiltinAgents(db, data.workspaceId)
  const criticHandle = agentMap.get('critic')
  const criticAgentId =
    data.provenance?.criticAgentId ?? criticHandle?.agent.id ?? crypto.randomUUID()
  const criticAgentVersionId =
    data.provenance?.criticAgentVersionId ?? criticHandle?.version.id ?? crypto.randomUUID()
  const criticAgentName = data.provenance?.criticAgentName ?? criticHandle?.agent.name ?? 'Critic'
  const criticVersionNumber = data.provenance?.versionNumber ?? criticHandle?.version.version ?? 1
  const executionId = data.provenance?.executionId ?? crypto.randomUUID()

  const reviewId = crypto.randomUUID()
  const reviewJson = JSON.stringify(data.review)

  // 5. Insert immutable content_review row
  await execute(
    db,
    `INSERT INTO content_review (
       id, workspace_id, content_id, content_variant_id,
       critic_agent_id, critic_agent_version_id, ai_execution_id,
       verdict, review_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      reviewId,
      data.workspaceId,
      data.contentId,
      data.contentVariantId,
      criticAgentId,
      criticAgentVersionId,
      executionId,
      data.verdict,
      reviewJson,
      now,
    ],
  )

  // 6. Write Audit Log
  await writeAuditLog(db, {
    workspaceId: data.workspaceId,
    actorType: 'user',
    action: 'create',
    entityType: 'content_review',
    entityId: reviewId,
    newValueJson: JSON.stringify({
      campaignId: data.campaignId,
      contentId: data.contentId,
      contentVariantId: data.contentVariantId,
      verdict: data.verdict,
      criticAgentId,
      criticAgentVersionId,
      executionId,
    }),
  })

  // 7. Emit Domain Event
  await emitEventSafe(db, {
    workspaceId: data.workspaceId,
    eventType: 'content.review_saved',
    actorType: 'user',
    subjectType: 'content',
    subjectId: data.contentId,
    payloadJson: JSON.stringify({
      reviewId,
      campaignId: data.campaignId,
      contentId: data.contentId,
      contentVariantId: data.contentVariantId,
      verdict: data.verdict,
      criticAgentId,
      criticAgentVersionId,
      executionId,
    }),
  })

  return {
    id: reviewId,
    workspaceId: data.workspaceId,
    contentId: data.contentId,
    contentVariantId: data.contentVariantId,
    criticAgentId,
    criticAgentVersionId,
    aiExecutionId: executionId,
    verdict: data.verdict,
    reviewJson,
    createdAt: now,
    criticAgentName,
    criticAgentVersionNumber: criticVersionNumber,
    summary: data.review.summary,
    strengths: data.review.strengths,
    issues: data.review.issues,
    recommendedChanges: data.review.recommendedChanges,
  }
}

/**
 * List all saved editorial reviews for a given content variant in reverse chronological order.
 */
export async function listContentReviews(
  db: SqlDatabase,
  workspaceId: string,
  contentVariantId: string,
): Promise<ContentReviewDetail[]> {
  const rows = await queryAll<ContentReviewRow>(
    db,
    `SELECT cr.*, a.name AS critic_agent_name, av.version AS critic_version_number
     FROM content_review cr
     LEFT JOIN agent a ON a.id = cr.critic_agent_id
     LEFT JOIN agent_version av ON av.id = cr.critic_agent_version_id
     WHERE cr.workspace_id = ? AND cr.content_variant_id = ?
     ORDER BY cr.created_at DESC`,
    [workspaceId, contentVariantId],
  )

  return rows.map(toContentReviewDetail)
}

/**
 * Get the latest saved editorial review for a content variant.
 */
export async function getLatestContentReview(
  db: SqlDatabase,
  workspaceId: string,
  contentVariantId: string,
): Promise<ContentReviewDetail | null> {
  const row = await queryFirst<ContentReviewRow>(
    db,
    `SELECT cr.*, a.name AS critic_agent_name, av.version AS critic_version_number
     FROM content_review cr
     LEFT JOIN agent a ON a.id = cr.critic_agent_id
     LEFT JOIN agent_version av ON av.id = cr.critic_agent_version_id
     WHERE cr.workspace_id = ? AND cr.content_variant_id = ?
     ORDER BY cr.created_at DESC
     LIMIT 1`,
    [workspaceId, contentVariantId],
  )

  return row ? toContentReviewDetail(row) : null
}
