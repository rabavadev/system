import { z } from 'zod'
import type { ContentStatus } from '~/types/domain'
import {
  composeContentDraftTask,
  computeDraftHash,
  type GeneratedContentDraft,
  parseContentDraftOutput,
} from '../agents/content-draft.ts'
import { ensureBuiltinAgents } from '../agents/registry.ts'
import { executeAgentTask } from '../agents/task.ts'
import type { ExecuteAIDeps } from '../ai/executor.ts'
import { buildContext } from '../context/engine.ts'
import { getAgentById, getAgentVersion } from './agent.ts'
import { writeAuditLog } from './audit.ts'
import { type ContentRow, getCampaignContentDetail, toCampaignContentItem } from './content.ts'
import { emitEventSafe } from './event.ts'
import { IntegrityError } from './relations.ts'
import { execute, newId, nowIso, queryAll, queryFirst, type SqlDatabase } from './sql.ts'

export interface DraftProvenance {
  candidateId?: string | null
  agentId: string
  agentName: string
  agentVersionId: string
  versionNumber: number
  executionId: string
  model: string | null
  provider?: string | null
  createdAt: string
  humanEdited?: boolean
  generatedHash?: string | null
  savedHash?: string | null
}

export interface ContentVariantMetadata {
  headline?: string | null
  callToAction?: string | null
  creativeDirection?: string | null
  notes?: string | null
  provenance?: DraftProvenance | null
}

export interface ContentVariantDetail {
  id: string
  contentId: string
  platformId: string
  platformName: string | null
  body: string | null
  headline: string | null
  callToAction: string | null
  creativeDirection: string | null
  notes: string | null
  status: ContentStatus
  provenance: DraftProvenance | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export interface ContentVariantRow {
  id: string
  content_id: string
  platform_id: string
  body: string | null
  metadata: string | null
  status: ContentStatus
  created_at: string
  updated_at: string
  deleted_at: string | null
  platform_name?: string | null
}

export interface ContentDraftCandidateRow {
  id: string
  workspace_id: string
  campaign_id: string
  content_id: string
  account_id: string
  platform_id: string
  creator_agent_id: string
  creator_agent_version_id: string
  ai_execution_id: string
  provider: string | null
  model: string | null
  generated_json: string
  generated_hash: string
  created_at: string
  saved_at: string | null
  saved_variant_id: string | null
}

export function toContentVariantDetail(row: ContentVariantRow): ContentVariantDetail {
  let meta: ContentVariantMetadata = {}
  if (row.metadata) {
    try {
      meta = JSON.parse(row.metadata)
    } catch {
      meta = {}
    }
  }

  return {
    id: row.id,
    contentId: row.content_id,
    platformId: row.platform_id,
    platformName: row.platform_name ?? null,
    body: row.body,
    headline: meta.headline ?? null,
    callToAction: meta.callToAction ?? null,
    creativeDirection: meta.creativeDirection ?? null,
    notes: meta.notes ?? null,
    status: row.status,
    provenance: meta.provenance ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }
}

export const generateContentDraftInput = z.object({
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  contentId: z.string().uuid(),
})

export type GenerateContentDraftInput = z.input<typeof generateContentDraftInput>

export type GenerateContentDraftResult =
  | {
      ok: true
      candidateId: string
      draft: GeneratedContentDraft
      provenance: DraftProvenance
    }
  | {
      ok: false
      errorCode: string
      message: string
    }

/**
 * Generate a candidate draft using the Creator agent and Campaign Context.
 * Stores a server-authoritative candidate record in content_draft_candidate.
 * Does NOT immediately persist to content_variant. Human review/save is required.
 */
export async function generateCampaignContentDraft(
  db: SqlDatabase,
  rawInput: unknown,
  deps: ExecuteAIDeps,
): Promise<GenerateContentDraftResult> {
  const data = generateContentDraftInput.parse(rawInput)

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
     WHERE c.id = ? AND c.workspace_id = ? AND c.campaign_id = ?`,
    [data.contentId, data.workspaceId, data.campaignId],
  )
  if (!contentRow || contentRow.deleted_at !== null || contentRow.status === 'archived') {
    throw new IntegrityError('Content item not found or is archived.')
  }

  // 3. Verify target Account exists (required for platform drafts)
  if (!contentRow.target_account_id) {
    return {
      ok: false,
      errorCode: 'account_required',
      message: 'Choose an account before generating a platform draft.',
    }
  }

  const accountRow = await queryFirst<{
    id: string
    workspace_id: string
    platform_id: string
    status: string
    deleted_at: string | null
  }>(
    db,
    `SELECT id, workspace_id, platform_id, status, deleted_at FROM account WHERE id = ? AND workspace_id = ?`,
    [contentRow.target_account_id, data.workspaceId],
  )
  if (!accountRow || accountRow.deleted_at !== null || accountRow.status === 'archived') {
    return {
      ok: false,
      errorCode: 'invalid_account',
      message: 'Target account is invalid, foreign, or archived.',
    }
  }

  const platformRow = await queryFirst<{ id: string; name: string }>(
    db,
    `SELECT id, name FROM platform WHERE id = ?`,
    [accountRow.platform_id],
  )
  if (!platformRow) {
    return {
      ok: false,
      errorCode: 'invalid_platform',
      message: 'Target account platform is invalid or missing.',
    }
  }

  const contentItem = toCampaignContentItem(contentRow)

  // 4. Resolve Creator Agent Handle
  const agentMap = await ensureBuiltinAgents(db, data.workspaceId)
  const creatorHandle = agentMap.get('creator')
  if (!creatorHandle) {
    throw new IntegrityError('Creator agent is not installed in this workspace.')
  }
  if (creatorHandle.agent.status !== 'active') {
    return {
      ok: false,
      errorCode: 'agent_inactive',
      message: 'Creator agent is currently disabled.',
    }
  }

  // 5. Gather Campaign Context through the canonical Context Engine
  const pkg = await buildContext(db, {
    workspaceId: data.workspaceId,
    campaignId: data.campaignId,
  })

  // 6. Compose the draft task
  const platformName = platformRow.name
  const task = composeContentDraftTask(contentItem, platformName)

  // 7. Execute Creator Agent Task
  const result = await executeAgentTask({
    db,
    workspaceId: data.workspaceId,
    handle: creatorHandle,
    pkg,
    task,
    eventSubject: { subjectType: 'content', subjectId: data.contentId },
    deps,
    metadata: {
      campaignId: data.campaignId,
      contentId: data.contentId,
      contentType: contentItem.contentType,
      targetAccountId: contentItem.targetAccountId,
    },
  })

  if (!result.ok) {
    return {
      ok: false,
      errorCode: result.errorCode,
      message: result.message,
    }
  }

  // 8. Parse structured draft response strictly
  let draft: GeneratedContentDraft
  try {
    draft = parseContentDraftOutput(result.content)
  } catch (err) {
    return {
      ok: false,
      errorCode: 'malformed_response',
      message:
        err instanceof Error
          ? err.message
          : 'Creator generated a malformed or invalid draft format.',
    }
  }

  // 9. Compute deterministic canonical hash of generated draft
  const generatedHash = computeDraftHash(draft)
  const candidateId = newId()
  const now = nowIso()
  const model = result.execution.model ?? null
  const provider = result.execution.provider ?? null

  // 10. Persist candidate record server-side
  await execute(
    db,
    `INSERT INTO content_draft_candidate (
      id, workspace_id, campaign_id, content_id, account_id, platform_id,
      creator_agent_id, creator_agent_version_id, ai_execution_id, provider, model,
      generated_json, generated_hash, created_at, saved_at, saved_variant_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    [
      candidateId,
      data.workspaceId,
      data.campaignId,
      data.contentId,
      accountRow.id,
      platformRow.id,
      creatorHandle.agent.id,
      creatorHandle.version.id,
      result.execution.executionId,
      provider,
      model,
      JSON.stringify(draft),
      generatedHash,
      now,
    ],
  )

  // 11. Construct generation provenance
  const provenance: DraftProvenance = {
    candidateId,
    agentId: creatorHandle.agent.id,
    agentName: creatorHandle.agent.name,
    agentVersionId: creatorHandle.version.id,
    versionNumber: creatorHandle.version.version,
    executionId: result.execution.executionId,
    model,
    provider,
    createdAt: now,
    humanEdited: false,
    generatedHash,
    savedHash: generatedHash,
  }

  // 12. Emit domain event (safe metadata only)
  await emitEventSafe(db, {
    workspaceId: data.workspaceId,
    eventType: 'content.draft_generated',
    actorType: 'agent',
    actorId: creatorHandle.agent.id,
    subjectType: 'content',
    subjectId: data.contentId,
    payloadJson: JSON.stringify({
      candidateId,
      campaignId: data.campaignId,
      contentId: data.contentId,
      executionId: result.execution.executionId,
      agentVersionId: creatorHandle.version.id,
      model,
    }),
  })

  return {
    ok: true,
    candidateId,
    draft,
    provenance,
  }
}

export const saveContentDraftInput = z.object({
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  contentId: z.string().uuid(),
  candidateId: z.string().uuid(),
  draft: z.object({
    headline: z.string().max(300).nullable().optional(),
    body: z.string().min(1, 'Draft body cannot be empty').max(20000),
    callToAction: z.string().max(500).nullable().optional(),
    creativeDirection: z.string().max(2000).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
  }),
})

export type SaveContentDraftInput = z.input<typeof saveContentDraftInput>

/**
 * Explicitly persist a reviewed content draft to content_variant.
 * Derives provenance authoritatively from the server-side candidate record.
 */
export async function saveCampaignContentDraft(
  db: SqlDatabase,
  rawInput: unknown,
  nowOverride?: string,
): Promise<{
  variant: ContentVariantDetail
  contentItem: ReturnType<typeof toCampaignContentItem>
}> {
  const data = saveContentDraftInput.parse(rawInput)
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
    `SELECT c.*, a.handle AS account_handle, a.display_name AS account_display_name,
            a.platform_id, p.name AS platform_name
     FROM content c
     LEFT JOIN account a ON a.id = c.target_account_id
     LEFT JOIN platform p ON p.id = a.platform_id
     WHERE c.id = ? AND c.workspace_id = ? AND c.campaign_id = ?`,
    [data.contentId, data.workspaceId, data.campaignId],
  )
  if (!contentRow || contentRow.deleted_at !== null || contentRow.status === 'archived') {
    throw new IntegrityError('Content item not found or is archived.')
  }

  if (!contentRow.target_account_id) {
    throw new IntegrityError(
      'Content item must have a target account before saving a platform variant.',
    )
  }

  // 3. Load and Validate Candidate
  const candidate = await queryFirst<ContentDraftCandidateRow>(
    db,
    `SELECT * FROM content_draft_candidate WHERE id = ?`,
    [data.candidateId],
  )
  if (!candidate || candidate.workspace_id !== data.workspaceId) {
    throw new IntegrityError('Candidate draft not found in this workspace.')
  }
  if (candidate.campaign_id !== data.campaignId) {
    throw new IntegrityError('Candidate draft does not belong to this campaign.')
  }
  if (candidate.content_id !== data.contentId) {
    throw new IntegrityError('Candidate draft does not belong to this content item.')
  }
  if (candidate.saved_at !== null || candidate.saved_variant_id !== null) {
    throw new IntegrityError('Candidate draft has already been saved.')
  }

  // 4. Validate Account & Platform consistency
  const accountRow = await queryFirst<{
    id: string
    workspace_id: string
    platform_id: string
    status: string
    deleted_at: string | null
  }>(
    db,
    `SELECT id, workspace_id, platform_id, status, deleted_at FROM account WHERE id = ? AND workspace_id = ?`,
    [candidate.account_id, data.workspaceId],
  )
  if (!accountRow || accountRow.deleted_at !== null || accountRow.status === 'archived') {
    throw new IntegrityError('Target account is invalid or archived.')
  }

  const platformId = accountRow.platform_id
  const platformRow = await queryFirst<{ id: string; name: string }>(
    db,
    `SELECT id, name FROM platform WHERE id = ?`,
    [platformId],
  )
  if (!platformRow) {
    throw new IntegrityError('Platform not found for target account.')
  }

  // 5. Compare hashes to determine human editing lineage
  const savedHash = computeDraftHash(data.draft)
  const humanEdited = savedHash !== candidate.generated_hash

  // 6. Fetch authoritative creator agent and version metadata
  const creatorAgent = await getAgentById(db, candidate.creator_agent_id)
  const creatorVersion = await getAgentVersion(db, candidate.creator_agent_version_id)

  const provenance: DraftProvenance = {
    candidateId: candidate.id,
    agentId: candidate.creator_agent_id,
    agentName: creatorAgent?.name ?? 'Creator',
    agentVersionId: candidate.creator_agent_version_id,
    versionNumber: creatorVersion?.version ?? 1,
    executionId: candidate.ai_execution_id,
    model: candidate.model,
    provider: candidate.provider,
    createdAt: candidate.created_at,
    humanEdited,
    generatedHash: candidate.generated_hash,
    savedHash,
  }

  const variantId = newId()
  const metadata: ContentVariantMetadata = {
    headline: data.draft.headline?.trim() || null,
    callToAction: data.draft.callToAction?.trim() || null,
    creativeDirection: data.draft.creativeDirection?.trim() || null,
    notes: data.draft.notes?.trim() || null,
    provenance,
  }

  // 7. Insert into content_variant
  await execute(
    db,
    `INSERT INTO content_variant (
      id, content_id, platform_id, body, metadata, status, created_at, updated_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, NULL)`,
    [
      variantId,
      data.contentId,
      platformId,
      data.draft.body.trim(),
      JSON.stringify(metadata),
      now,
      now,
    ],
  )

  // 8. Mark candidate as saved / consumed
  await execute(
    db,
    `UPDATE content_draft_candidate SET saved_at = ?, saved_variant_id = ? WHERE id = ?`,
    [now, variantId, candidate.id],
  )

  // 9. Update content item status to 'draft' if currently 'idea' or 'planned'
  if (contentRow.status === 'idea' || contentRow.status === 'planned') {
    await execute(db, `UPDATE content SET status = 'draft', updated_at = ? WHERE id = ?`, [
      now,
      data.contentId,
    ])
  }

  // 10. Write Audit Log (safe metadata)
  await writeAuditLog(db, {
    workspaceId: data.workspaceId,
    actorType: 'user',
    action: 'create',
    entityType: 'content_variant',
    entityId: variantId,
    newValueJson: JSON.stringify({
      contentId: data.contentId,
      platformId,
      candidateId: candidate.id,
      humanEdited,
      agentId: candidate.creator_agent_id,
      agentVersionId: candidate.creator_agent_version_id,
      executionId: candidate.ai_execution_id,
    }),
  })

  // 11. Emit Domain Event
  await emitEventSafe(db, {
    workspaceId: data.workspaceId,
    eventType: 'content.draft_saved',
    actorType: 'user',
    subjectType: 'content',
    subjectId: data.contentId,
    payloadJson: JSON.stringify({
      campaignId: data.campaignId,
      contentId: data.contentId,
      variantId,
      candidateId: candidate.id,
      humanEdited,
      agentId: candidate.creator_agent_id,
      agentVersionId: candidate.creator_agent_version_id,
      executionId: candidate.ai_execution_id,
    }),
  })

  // 12. Fetch updated content item & saved variant
  const updatedContent = await getCampaignContentDetail(db, data.workspaceId, data.contentId)
  if (!updatedContent) {
    throw new Error('Failed to retrieve updated content item.')
  }

  const variantRow = await queryFirst<ContentVariantRow>(
    db,
    `SELECT v.*, p.name AS platform_name
     FROM content_variant v
     JOIN platform p ON p.id = v.platform_id
     WHERE v.id = ?`,
    [variantId],
  )
  if (!variantRow) {
    throw new Error('Failed to retrieve saved content variant.')
  }

  return {
    variant: toContentVariantDetail(variantRow),
    contentItem: updatedContent,
  }
}

/**
 * List all saved variants for a content item.
 */
export async function listContentVariants(
  db: SqlDatabase,
  workspaceId: string,
  contentId: string,
): Promise<ContentVariantDetail[]> {
  const content = await queryFirst<{ id: string }>(
    db,
    `SELECT id FROM content WHERE id = ? AND workspace_id = ?`,
    [contentId, workspaceId],
  )
  if (!content) return []

  const rows = await queryAll<ContentVariantRow>(
    db,
    `SELECT v.*, p.name AS platform_name
     FROM content_variant v
     JOIN platform p ON p.id = v.platform_id
     WHERE v.content_id = ? AND v.deleted_at IS NULL
     ORDER BY v.created_at DESC`,
    [contentId],
  )

  return rows.map(toContentVariantDetail)
}

/**
 * Get the latest saved variant for a content item.
 */
export async function getLatestContentVariant(
  db: SqlDatabase,
  workspaceId: string,
  contentId: string,
): Promise<ContentVariantDetail | null> {
  const variants = await listContentVariants(db, workspaceId, contentId)
  return variants[0] ?? null
}
