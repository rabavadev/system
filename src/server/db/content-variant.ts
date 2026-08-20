import { z } from 'zod'
import type { ContentStatus } from '~/types/domain'
import {
  composeContentDraftTask,
  type GeneratedContentDraft,
  parseContentDraftOutput,
} from '../agents/content-draft.ts'
import { ensureBuiltinAgents } from '../agents/registry.ts'
import { executeAgentTask } from '../agents/task.ts'
import type { ExecuteAIDeps } from '../ai/executor.ts'
import { buildContext } from '../context/engine.ts'
import { writeAuditLog } from './audit.ts'
import { type ContentRow, getCampaignContentDetail, toCampaignContentItem } from './content.ts'
import { emitEventSafe } from './event.ts'
import { IntegrityError } from './relations.ts'
import { execute, newId, nowIso, queryAll, queryFirst, type SqlDatabase } from './sql.ts'

export interface DraftProvenance {
  agentId: string
  agentName: string
  agentVersionId: string
  versionNumber: number
  executionId: string
  model: string
  createdAt: string
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
      draft: GeneratedContentDraft
      provenance: DraftProvenance
    }
  | {
      ok: false
      errorCode: string
      message: string
    }

/**
 * Generate a candidate draft using the platform-neutral Creator agent and Campaign Context.
 * Does NOT immediately persist to the database. Human review is required before saving.
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

  const contentItem = toCampaignContentItem(contentRow)

  // 3. Resolve Creator Agent Handle
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

  // 4. Gather Campaign Context through the canonical Context Engine
  const pkg = await buildContext(db, {
    workspaceId: data.workspaceId,
    campaignId: data.campaignId,
  })

  // 5. Compose the draft task
  const platformName = contentItem.platformName ?? null
  const task = composeContentDraftTask(contentItem, platformName)

  // 6. Execute Creator Agent Task
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

  // 7. Parse structured draft response
  const draft = parseContentDraftOutput(result.content)

  // 8. Construct generation provenance
  const provenance: DraftProvenance = {
    agentId: creatorHandle.agent.id,
    agentName: creatorHandle.agent.name,
    agentVersionId: creatorHandle.version.id,
    versionNumber: creatorHandle.version.version,
    executionId: result.execution.executionId,
    model: result.execution.model ?? 'default',
    createdAt: nowIso(),
  }

  // 9. Emit domain event (safe audit log)
  await emitEventSafe(db, {
    workspaceId: data.workspaceId,
    eventType: 'content.draft_generated',
    actorType: 'agent',
    actorId: creatorHandle.agent.id,
    subjectType: 'content',
    subjectId: data.contentId,
    payloadJson: JSON.stringify({
      campaignId: data.campaignId,
      contentId: data.contentId,
      executionId: result.execution.executionId,
      agentVersionId: creatorHandle.version.id,
      model: result.execution.model,
    }),
  })

  return {
    ok: true,
    draft,
    provenance,
  }
}

export const saveContentDraftInput = z.object({
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  contentId: z.string().uuid(),
  draft: z.object({
    headline: z.string().nullable().optional(),
    body: z.string().min(1, 'Draft body cannot be empty'),
    callToAction: z.string().nullable().optional(),
    creativeDirection: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
  }),
  provenance: z
    .object({
      agentId: z.string().uuid(),
      agentName: z.string(),
      agentVersionId: z.string().uuid(),
      versionNumber: z.number(),
      executionId: z.string().uuid(),
      model: z.string(),
      createdAt: z.string(),
    })
    .nullable()
    .optional(),
})

export type SaveContentDraftInput = z.input<typeof saveContentDraftInput>

/**
 * Explicitly persist a reviewed content draft to content_variant, and update the content item status to 'draft'.
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

  // 3. Resolve Platform ID for the variant
  let platformId = contentRow.platform_id
  if (!platformId) {
    const defaultPlatform = await queryFirst<{ id: string }>(
      db,
      `SELECT id FROM platform ORDER BY name ASC LIMIT 1`,
    )
    if (!defaultPlatform) {
      throw new IntegrityError('No platforms registered in database.')
    }
    platformId = defaultPlatform.id
  }

  const variantId = newId()
  const metadata: ContentVariantMetadata = {
    headline: data.draft.headline?.trim() || null,
    callToAction: data.draft.callToAction?.trim() || null,
    creativeDirection: data.draft.creativeDirection?.trim() || null,
    notes: data.draft.notes?.trim() || null,
    provenance: data.provenance ?? null,
  }

  // 4. Insert into content_variant
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

  // 5. Update content item status to 'draft' if currently 'idea' or 'planned'
  if (contentRow.status === 'idea' || contentRow.status === 'planned') {
    await execute(db, `UPDATE content SET status = 'draft', updated_at = ? WHERE id = ?`, [
      now,
      data.contentId,
    ])
  }

  // 6. Write Audit Log
  await writeAuditLog(db, {
    workspaceId: data.workspaceId,
    actorType: 'user',
    action: 'create',
    entityType: 'content_variant',
    entityId: variantId,
    newValueJson: JSON.stringify({
      contentId: data.contentId,
      platformId,
      headline: data.draft.headline,
      hasProvenance: !!data.provenance,
      agentId: data.provenance?.agentId ?? null,
      agentVersionId: data.provenance?.agentVersionId ?? null,
    }),
  })

  // 7. Emit Domain Event
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
      agentId: data.provenance?.agentId ?? null,
      agentVersionId: data.provenance?.agentVersionId ?? null,
      executionId: data.provenance?.executionId ?? null,
    }),
  })

  // 8. Fetch updated content item & saved variant
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
