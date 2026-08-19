import { z } from 'zod'

import type { Message, MessageSenderType } from '~/types/domain'

import { execute, newId, nowIso, queryAll, type SqlDatabase } from './sql.ts'

/**
 * Message repository. Same structural-database pattern as conversation.ts:
 * no `cloudflare:workers` import, so it runs under plain node tests.
 *
 * Role policy: `appendUserMessage` is the only path the client-facing send
 * endpoint uses, and it hard-codes sender_type 'user'. The generic
 * `appendMessage` exists for trusted server-side code (future AI execution)
 * and is never exposed through a client-callable server function.
 */

/** Sensible abuse ceiling for a single message. */
export const MAX_MESSAGE_CHARS = 4000

interface MessageRow {
  id: string
  conversation_id: string
  sender_type: MessageSenderType
  agent_id: string | null
  agent_version_id: string | null
  content: string
  provider_metadata: string | null
  created_at: string
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderType: row.sender_type,
    agentId: row.agent_id,
    agentVersionId: row.agent_version_id,
    content: row.content,
    providerMetadataJson: row.provider_metadata,
    createdAt: row.created_at,
  }
}

const appendMessageInput = z.object({
  conversationId: z.uuid(),
  senderType: z.enum(['user', 'agent', 'system']),
  content: z
    .string()
    .trim()
    .min(1, 'Write a message first.')
    .max(MAX_MESSAGE_CHARS, `Keep messages under ${MAX_MESSAGE_CHARS} characters.`),
  agentId: z.uuid().nullable().optional(),
  agentVersionId: z.uuid().nullable().optional(),
  providerMetadataJson: z.string().max(4000).nullable().optional(),
})
export type AppendMessageInput = z.input<typeof appendMessageInput>

/** All messages of a conversation, oldest first. */
export async function listMessages(db: SqlDatabase, conversationId: string): Promise<Message[]> {
  const rows = await queryAll<MessageRow>(
    db,
    `SELECT * FROM message WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC`,
    [conversationId],
  )
  return rows.map(toMessage)
}

/**
 * The most recent `limit` messages, returned in chronological order
 * (oldest first). Ordering is explicit on (created_at, rowid) both ways —
 * never accidental database order. Used by the Context Engine.
 */
export async function listRecentMessages(
  db: SqlDatabase,
  conversationId: string,
  limit: number,
): Promise<Message[]> {
  const rows = await queryAll<MessageRow>(
    db,
    `SELECT * FROM (
       SELECT m.*, m.rowid AS _seq FROM message m WHERE m.conversation_id = ?
       ORDER BY m.created_at DESC, _seq DESC LIMIT ?
     ) ORDER BY created_at ASC, _seq ASC`,
    [conversationId, limit],
  )
  return rows.map(toMessage)
}

/**
 * Trusted append path (server-side only). Accepts any schema-valid role;
 * future AI execution writes 'agent'/'system' messages through here.
 */
export async function appendMessage(db: SqlDatabase, input: AppendMessageInput): Promise<Message> {
  const data = appendMessageInput.parse(input)
  const id = newId()
  const now = nowIso()
  await execute(
    db,
    `INSERT INTO message (id, conversation_id, sender_type, agent_id, agent_version_id, content, provider_metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.conversationId,
      data.senderType,
      data.agentId ?? null,
      data.agentVersionId ?? null,
      data.content,
      data.providerMetadataJson ?? null,
      now,
    ],
  )
  return {
    id,
    conversationId: data.conversationId,
    senderType: data.senderType,
    agentId: data.agentId ?? null,
    agentVersionId: data.agentVersionId ?? null,
    content: data.content,
    providerMetadataJson: data.providerMetadataJson ?? null,
    createdAt: now,
  }
}

/**
 * The only client-reachable append path: the role is fixed to 'user', so a
 * client can never fabricate assistant/system messages.
 */
export async function appendUserMessage(
  db: SqlDatabase,
  input: { conversationId: string; content: string },
): Promise<Message> {
  return appendMessage(db, {
    conversationId: input.conversationId,
    senderType: 'user',
    content: input.content,
  })
}
