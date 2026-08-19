import { z } from 'zod'

import type { Conversation, ConversationScopeType } from '~/types/domain'

import { execute, newId, nowIso, queryAll, queryFirst, type SqlDatabase } from './sql.ts'

/**
 * Conversation repository. Unlike the STEP 3 repositories, functions take
 * the database as their first parameter (typed as the structural
 * SqlDatabase, which D1Database satisfies) so the module carries no
 * `cloudflare:workers` import and runs under plain node tests.
 */

interface ConversationRow {
  id: string
  workspace_id: string
  title: string | null
  scope_type: ConversationScopeType | null
  scope_id: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }
}

/** Conversation plus list-screen extras. */
export interface ConversationSummary extends Conversation {
  messageCount: number
  /** Last message text (truncated), for the sidebar preview. */
  lastMessagePreview: string | null
  /** Last message time, falling back to creation time. */
  lastActivityAt: string
  /** Display name of the scoped entity (brand name, account handle, ...). */
  scopeName: string | null
}

const SCOPE_LABEL: Record<ConversationScopeType, { table: string; label: string }> = {
  brand: { table: 'brand', label: 'name' },
  product: { table: 'product', label: 'name' },
  account: { table: 'account', label: 'COALESCE(display_name, handle)' },
  campaign: { table: 'campaign', label: 'name' },
}

const SCOPE_TYPES = ['brand', 'product', 'account', 'campaign'] as const

export const createConversationInput = z
  .object({
    workspaceId: z.uuid(),
    title: z.string().trim().min(1).max(120).optional(),
    scopeType: z.enum(SCOPE_TYPES).nullable().optional(),
    scopeId: z.uuid().nullable().optional(),
  })
  .refine((value) => (value.scopeType == null) === (value.scopeId == null), {
    message: 'scopeType and scopeId must be set together.',
  })
export type CreateConversationInput = z.input<typeof createConversationInput>

export const renameConversationInput = z.object({
  id: z.uuid(),
  title: z.string().trim().min(1, 'Give the conversation a name.').max(120),
})
export type RenameConversationInput = z.input<typeof renameConversationInput>

/** Scope target must exist, belong to the workspace, and not be archived. */
async function requireScopeTarget(
  db: SqlDatabase,
  workspaceId: string,
  scopeType: ConversationScopeType,
  scopeId: string,
): Promise<void> {
  const { table } = SCOPE_LABEL[scopeType]
  const row = await queryFirst<{ id: string; workspace_id: string; deleted_at: string | null }>(
    db,
    `SELECT id, workspace_id, deleted_at FROM ${table} WHERE id = ?`,
    [scopeId],
  )
  if (!row || row.workspace_id !== workspaceId) {
    throw new Error('That item is not available in this workspace.')
  }
  if (row.deleted_at) {
    throw new Error('That item is archived.')
  }
}

const SUMMARY_SELECT = `
  SELECT c.*,
    (SELECT COUNT(*) FROM message m WHERE m.conversation_id = c.id) AS message_count,
    (SELECT m.content FROM message m WHERE m.conversation_id = c.id
      ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS last_message_preview,
    COALESCE(
      (SELECT MAX(m.created_at) FROM message m WHERE m.conversation_id = c.id),
      c.created_at
    ) AS last_activity_at,
    CASE c.scope_type
      WHEN 'brand' THEN (SELECT b.name FROM brand b WHERE b.id = c.scope_id)
      WHEN 'product' THEN (SELECT p.name FROM product p WHERE p.id = c.scope_id)
      WHEN 'account' THEN (SELECT COALESCE(a.display_name, a.handle) FROM account a WHERE a.id = c.scope_id)
      WHEN 'campaign' THEN (SELECT ca.name FROM campaign ca WHERE ca.id = c.scope_id)
    END AS scope_name
  FROM conversation c`

interface ConversationSummaryRow extends ConversationRow {
  message_count: number
  last_message_preview: string | null
  last_activity_at: string
  scope_name: string | null
}

function toSummary(row: ConversationSummaryRow): ConversationSummary {
  return {
    ...toConversation(row),
    messageCount: row.message_count,
    lastMessagePreview:
      row.last_message_preview === null
        ? null
        : row.last_message_preview.length > 80
          ? `${row.last_message_preview.slice(0, 80)}…`
          : row.last_message_preview,
    lastActivityAt: row.last_activity_at,
    scopeName: row.scope_name,
  }
}

/** Active conversations of a workspace, most recently active first. */
export async function listConversations(
  db: SqlDatabase,
  workspaceId: string,
): Promise<ConversationSummary[]> {
  const rows = await queryAll<ConversationSummaryRow>(
    db,
    `${SUMMARY_SELECT} WHERE c.workspace_id = ? AND c.deleted_at IS NULL ORDER BY last_activity_at DESC, c.rowid DESC`,
    [workspaceId],
  )
  return rows.map(toSummary)
}

/** Archived conversations, most recently archived first. */
export async function listArchivedConversations(
  db: SqlDatabase,
  workspaceId: string,
): Promise<ConversationSummary[]> {
  const rows = await queryAll<ConversationSummaryRow>(
    db,
    `${SUMMARY_SELECT} WHERE c.workspace_id = ? AND c.deleted_at IS NOT NULL ORDER BY c.deleted_at DESC`,
    [workspaceId],
  )
  return rows.map(toSummary)
}

/** Fetch a conversation regardless of archive state. */
export async function getConversationById(
  db: SqlDatabase,
  id: string,
): Promise<Conversation | null> {
  const row = await queryFirst<ConversationRow>(db, `SELECT * FROM conversation WHERE id = ?`, [id])
  return row ? toConversation(row) : null
}

/** Fetch one conversation with list-screen extras (header context). */
export async function getConversationSummary(
  db: SqlDatabase,
  id: string,
): Promise<ConversationSummary | null> {
  const row = await queryFirst<ConversationSummaryRow>(db, `${SUMMARY_SELECT} WHERE c.id = ?`, [id])
  return row ? toSummary(row) : null
}

export async function createConversation(
  db: SqlDatabase,
  input: CreateConversationInput,
): Promise<Conversation> {
  const data = createConversationInput.parse(input)
  if (data.scopeType && data.scopeId) {
    await requireScopeTarget(db, data.workspaceId, data.scopeType, data.scopeId)
  }
  const id = newId()
  const now = nowIso()
  await execute(
    db,
    `INSERT INTO conversation (id, workspace_id, title, scope_type, scope_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.workspaceId,
      data.title ?? null,
      data.scopeType ?? null,
      data.scopeId ?? null,
      now,
      now,
    ],
  )
  const created = await getConversationById(db, id)
  if (!created) {
    throw new Error('conversation insert did not produce a readable row')
  }
  return created
}

export async function renameConversation(
  db: SqlDatabase,
  input: RenameConversationInput,
): Promise<Conversation> {
  const data = renameConversationInput.parse(input)
  const existing = await getConversationById(db, data.id)
  if (!existing) {
    throw new Error('Conversation not found.')
  }
  await execute(db, `UPDATE conversation SET title = ?, updated_at = ? WHERE id = ?`, [
    data.title,
    nowIso(),
    data.id,
  ])
  const updated = await getConversationById(db, data.id)
  if (!updated) {
    throw new Error('conversation rename did not produce a readable row')
  }
  return updated
}

/** Archive = soft delete. Messages keep their rows and history. */
export async function archiveConversation(db: SqlDatabase, id: string): Promise<void> {
  const existing = await getConversationById(db, id)
  if (!existing) {
    throw new Error('Conversation not found.')
  }
  if (existing.deletedAt) {
    return
  }
  await execute(db, `UPDATE conversation SET deleted_at = ?, updated_at = ? WHERE id = ?`, [
    nowIso(),
    nowIso(),
    id,
  ])
}

export async function restoreConversation(db: SqlDatabase, id: string): Promise<void> {
  const existing = await getConversationById(db, id)
  if (!existing) {
    throw new Error('Conversation not found.')
  }
  if (!existing.deletedAt) {
    return
  }
  await execute(db, `UPDATE conversation SET deleted_at = NULL, updated_at = ? WHERE id = ?`, [
    nowIso(),
    id,
  ])
}

/** Bump the conversation's activity timestamp (on new messages). */
export async function touchConversation(db: SqlDatabase, id: string): Promise<void> {
  await execute(db, `UPDATE conversation SET updated_at = ? WHERE id = ?`, [nowIso(), id])
}

/** Default title from the first user message: first line, truncated. */
export function deriveConversationTitle(content: string): string {
  const firstLine = content.trim().split('\n')[0] ?? ''
  return firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine
}
