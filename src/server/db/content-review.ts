import { z } from 'zod'

import type { ContentReviewDetail, ContentStatus, ReviewVerdict } from '../../types/domain.ts'
import {
  composeContentReviewTask,
  computeReviewHash,
  type GeneratedContentReview,
  parseContentReviewOutput,
} from '../agents/content-review.ts'
import { ensureBuiltinAgents } from '../agents/registry.ts'
import { executeAgentTask } from '../agents/task.ts'
import type { ExecuteAIDeps } from '../ai/executor.ts'
import { buildContext } from '../context/engine.ts'
import { getAgentById, getAgentVersion } from './agent.ts'
import { writeAuditLog } from './audit.ts'
import { type ContentRow, toCampaignContentItem } from './content.ts'
import { type ContentVariantRow, toContentVariantDetail } from './content-variant.ts'
import { emitEventSafe } from './event.ts'
import { IntegrityError } from './relations.ts'
import { execute, newId, nowIso, queryAll, queryFirst, type SqlDatabase } from './sql.ts'

export interface CriticReviewProvenance {
  candidateId?: string | null
  criticAgentId: string
  criticAgentName: string
  criticAgentVersionId: string
  versionNumber: number
  executionId: string
  model: string | null
  provider?: string | null
  createdAt: string
  reviewHash?: string | null
}

export interface GenerateContentReviewSuccess {
  ok: true
  candidateId: string
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
  candidateId: z.string().uuid(),
})

export type SaveContentReviewInput = z.input<typeof saveContentReviewInput>

export interface ContentReviewCandidateRow {
  id: string
  workspace_id: string
  campaign_id: string
  content_id: string
  content_variant_id: string
  critic_agent_id: string
  critic_agent_version_id: string
  ai_execution_id: string
  provider: string | null
  model: string | null
  verdict: 'pass' | 'revise'
  review_json: string
  review_hash: string
  created_at: string
  saved_at: string | null
  saved_review_id: string | null
}

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
 * Generate an editorial review candidate for ONE saved Campaign content variant using the Critic agent.
 * Persists a server-authoritative candidate record with hash and lineage, but does NOT create final content_review.
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
  const reviewHash = computeReviewHash(review)
  const candidateId = newId()
  const now = nowIso()
  const model = result.execution.model ?? null
  const provider = result.execution.provider ?? null

  // 9. Persist review candidate server-side
  await execute(
    db,
    `INSERT INTO content_review_candidate (
      id, workspace_id, campaign_id, content_id, content_variant_id,
      critic_agent_id, critic_agent_version_id, ai_execution_id, provider, model,
      verdict, review_json, review_hash, created_at, saved_at, saved_review_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    [
      candidateId,
      data.workspaceId,
      data.campaignId,
      data.contentId,
      data.contentVariantId,
      criticHandle.agent.id,
      criticHandle.version.id,
      result.execution.executionId,
      provider,
      model,
      review.verdict,
      JSON.stringify(review),
      reviewHash,
      now,
    ],
  )

  // 10. Construct generation provenance
  const provenance: CriticReviewProvenance = {
    candidateId,
    criticAgentId: criticHandle.agent.id,
    criticAgentName: criticHandle.agent.name,
    criticAgentVersionId: criticHandle.version.id,
    versionNumber: criticHandle.version.version,
    executionId: result.execution.executionId,
    model,
    provider,
    createdAt: now,
    reviewHash,
  }

  // 11. Emit domain event (safe audit log)
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
      reviewCandidateId: candidateId,
      executionId: result.execution.executionId,
      agentVersionId: criticHandle.version.id,
      verdict: review.verdict,
    }),
  })

  return {
    ok: true,
    candidateId,
    review,
    provenance,
    contentVariantId: data.contentVariantId,
  }
}

/**
 * Persist an editorial review for a saved content variant.
 * Derives review data, verdict, and provenance authoritatively from a server-side content_review_candidate.
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

  // 4. Load and Validate Review Candidate
  const candidate = await queryFirst<ContentReviewCandidateRow>(
    db,
    `SELECT * FROM content_review_candidate WHERE id = ?`,
    [data.candidateId],
  )
  if (!candidate || candidate.workspace_id !== data.workspaceId) {
    throw new IntegrityError('Candidate review not found in this workspace.')
  }
  if (candidate.campaign_id !== data.campaignId) {
    throw new IntegrityError('Candidate review does not belong to this campaign.')
  }
  if (candidate.content_id !== data.contentId) {
    throw new IntegrityError('Candidate review does not belong to this content item.')
  }
  if (candidate.content_variant_id !== data.contentVariantId) {
    throw new IntegrityError('Candidate review does not belong to this content variant.')
  }
  if (candidate.saved_at !== null || candidate.saved_review_id !== null) {
    throw new IntegrityError('Candidate review has already been saved.')
  }

  // 5. Validate Critic Agent & Version Integrity
  const criticAgent = await getAgentById(db, candidate.critic_agent_id)
  if (!criticAgent || criticAgent.workspaceId !== data.workspaceId) {
    throw new IntegrityError('Critic agent associated with this candidate is invalid.')
  }
  const criticVersion = await getAgentVersion(db, candidate.critic_agent_version_id)
  if (!criticVersion || criticVersion.agentId !== criticAgent.id) {
    throw new IntegrityError('Critic agent version associated with this candidate is invalid.')
  }

  const reviewId = newId()

  // 6. Insert immutable content_review row derived strictly from candidate
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
      candidate.critic_agent_id,
      candidate.critic_agent_version_id,
      candidate.ai_execution_id,
      candidate.verdict,
      candidate.review_json,
      now,
    ],
  )

  // 7. Mark candidate as saved / consumed
  await execute(
    db,
    `UPDATE content_review_candidate SET saved_at = ?, saved_review_id = ? WHERE id = ?`,
    [now, reviewId, candidate.id],
  )

  // 8. Write Audit Log
  await writeAuditLog(db, {
    workspaceId: data.workspaceId,
    actorType: 'agent',
    actorId: candidate.critic_agent_id,
    action: 'create',
    entityType: 'content_review',
    entityId: reviewId,
    newValueJson: JSON.stringify({
      campaignId: data.campaignId,
      contentId: data.contentId,
      contentVariantId: data.contentVariantId,
      verdict: candidate.verdict,
      reviewCandidateId: candidate.id,
      criticAgentId: candidate.critic_agent_id,
      criticAgentVersionId: candidate.critic_agent_version_id,
      executionId: candidate.ai_execution_id,
    }),
  })

  // 9. Emit Domain Event
  await emitEventSafe(db, {
    workspaceId: data.workspaceId,
    eventType: 'content.review_saved',
    actorType: 'user',
    subjectType: 'content',
    subjectId: data.contentId,
    payloadJson: JSON.stringify({
      reviewId,
      reviewCandidateId: candidate.id,
      campaignId: data.campaignId,
      contentId: data.contentId,
      contentVariantId: data.contentVariantId,
      verdict: candidate.verdict,
      criticAgentId: candidate.critic_agent_id,
      criticAgentVersionId: candidate.critic_agent_version_id,
      executionId: candidate.ai_execution_id,
    }),
  })

  let parsedJson: {
    summary?: string
    strengths?: string[]
    issues?: Array<{ category: string; severity: 'low' | 'medium' | 'high'; message: string }>
    recommendedChanges?: string[]
  } = {}
  try {
    parsedJson = JSON.parse(candidate.review_json)
  } catch {
    // fallback
  }

  return {
    id: reviewId,
    workspaceId: data.workspaceId,
    contentId: data.contentId,
    contentVariantId: data.contentVariantId,
    criticAgentId: candidate.critic_agent_id,
    criticAgentVersionId: candidate.critic_agent_version_id,
    aiExecutionId: candidate.ai_execution_id,
    verdict: candidate.verdict,
    reviewJson: candidate.review_json,
    createdAt: now,
    criticAgentName: criticAgent.name,
    criticAgentVersionNumber: criticVersion.version,
    summary:
      parsedJson.summary ??
      (candidate.verdict === 'pass'
        ? 'Draft passes editorial review.'
        : 'Draft requires revisions.'),
    strengths: Array.isArray(parsedJson.strengths) ? parsedJson.strengths : [],
    issues: Array.isArray(parsedJson.issues) ? parsedJson.issues : [],
    recommendedChanges: Array.isArray(parsedJson.recommendedChanges)
      ? parsedJson.recommendedChanges
      : [],
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
