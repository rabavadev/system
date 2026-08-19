import { createServerFn } from '@tanstack/react-start'
import { getCookie } from '@tanstack/react-start/server'
import { z } from 'zod'
import { ACTIVE_BRAND_COOKIE } from '~/features/workspace/server'
import { runChiefReply } from '~/server/agents/chief'
import { resolveAiRuntime } from '~/server/ai/runtime'
import { getBrandById } from '~/server/db/brand'
import { getDb } from '~/server/db/client'
import {
  archiveConversation,
  type ConversationSummary,
  createConversation,
  deriveConversationTitle,
  getConversationById,
  getConversationSummary,
  listArchivedConversations,
  listConversations,
  renameConversation,
  restoreConversation,
  touchConversation,
} from '~/server/db/conversation'
import {
  appendUserMessage,
  findMessageByClientRequestId,
  listMessages,
  MAX_MESSAGE_CHARS,
} from '~/server/db/message'
import { getDefaultWorkspace } from '~/server/db/workspace'
import type { Message } from '~/types/domain'

/**
 * Server functions for chat. The client never passes a workspace id; the
 * default workspace is resolved server-side and every conversation access
 * is checked against it.
 *
 * Wire schemas are declared locally (not derived from repository schemas at
 * module level) so the client build can strip every server/db import.
 */

const idWire = z.object({ id: z.uuid() })
const createConversationWire = z.object({
  title: z.string().trim().min(1).max(120).optional(),
})
const renameConversationWire = z.object({
  id: z.uuid(),
  title: z.string().trim().min(1, 'Give the conversation a name.').max(120),
})
// Note: no role/sender field here by design. The client can only ever send
// user messages; the role is fixed server-side. clientRequestId is an
// idempotency key, not a role/metadata channel.
const sendMessageWire = z.object({
  conversationId: z.uuid(),
  content: z
    .string()
    .trim()
    .min(1, 'Write a message first.')
    .max(MAX_MESSAGE_CHARS, `Keep messages under ${MAX_MESSAGE_CHARS} characters.`),
  clientRequestId: z.uuid().optional(),
})

export interface ChatSidebarData {
  conversations: ConversationSummary[]
  archivedConversations: ConversationSummary[]
}

export interface ConversationPageData {
  conversation: ConversationSummary
  messages: Message[]
}

async function requireWorkspace() {
  const workspace = await getDefaultWorkspace()
  if (!workspace) {
    throw new Error('Workspace is not set up yet.')
  }
  return workspace
}

/** Fetch a conversation and prove it belongs to the workspace. */
async function requireOwnedConversation(id: string, workspaceId: string) {
  const conversation = await getConversationById(getDb(), id)
  if (!conversation || conversation.workspaceId !== workspaceId) {
    throw new Error('Conversation not found.')
  }
  return conversation
}

export const getChatSidebarData = createServerFn({ method: 'GET' }).handler(
  async (): Promise<ChatSidebarData> => {
    const workspace = await getDefaultWorkspace()
    if (!workspace) {
      return { conversations: [], archivedConversations: [] }
    }
    const db = getDb()
    const [conversations, archivedConversations] = await Promise.all([
      listConversations(db, workspace.id),
      listArchivedConversations(db, workspace.id),
    ])
    return { conversations, archivedConversations }
  },
)

/** Conversation + full message history. Null when unknown or foreign. */
export const getConversationPageData = createServerFn({ method: 'GET' })
  .validator(idWire)
  .handler(async ({ data }): Promise<ConversationPageData | null> => {
    const workspace = await getDefaultWorkspace()
    if (!workspace) {
      return null
    }
    const db = getDb()
    const conversation = await getConversationSummary(db, data.id)
    if (!conversation || conversation.workspaceId !== workspace.id) {
      return null
    }
    const messages = await listMessages(db, conversation.id)
    return { conversation, messages }
  })

/**
 * Create a conversation. When a brand is currently selected (cookie), the
 * conversation is associated with that brand; otherwise it is a general
 * workspace conversation.
 */
export const createConversationFn = createServerFn({ method: 'POST' })
  .validator(createConversationWire)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const workspace = await requireWorkspace()
    const db = getDb()

    let scopeType: 'brand' | null = null
    let scopeId: string | null = null
    const activeBrandId = getCookie(ACTIVE_BRAND_COOKIE)
    if (activeBrandId) {
      const brand = await getBrandById(activeBrandId)
      if (brand && !brand.deletedAt && brand.workspaceId === workspace.id) {
        scopeType = 'brand'
        scopeId = brand.id
      }
    }

    const conversation = await createConversation(db, {
      workspaceId: workspace.id,
      title: data.title,
      scopeType,
      scopeId,
    })
    return { id: conversation.id }
  })

export const renameConversationFn = createServerFn({ method: 'POST' })
  .validator(renameConversationWire)
  .handler(async ({ data }): Promise<void> => {
    const workspace = await requireWorkspace()
    await requireOwnedConversation(data.id, workspace.id)
    await renameConversation(getDb(), { id: data.id, title: data.title })
  })

export const archiveConversationFn = createServerFn({ method: 'POST' })
  .validator(idWire)
  .handler(async ({ data }): Promise<void> => {
    const workspace = await requireWorkspace()
    await requireOwnedConversation(data.id, workspace.id)
    await archiveConversation(getDb(), data.id)
  })

export const restoreConversationFn = createServerFn({ method: 'POST' })
  .validator(idWire)
  .handler(async ({ data }): Promise<void> => {
    const workspace = await requireWorkspace()
    await requireOwnedConversation(data.id, workspace.id)
    await restoreConversation(getDb(), data.id)
  })

export interface SendMessageResult {
  userMessage: Message
  /** Chief's reply. Null when AI execution failed (see assistantError). */
  assistantMessage: Message | null
  /** User-safe failure text when Chief could not respond. */
  assistantError: string | null
  /** True when an idempotent retry returned the already-processed send. */
  deduplicated: boolean
}

/**
 * Send a user message, then run the Workspace Chief: Context Engine → AI
 * execution → persisted assistant reply. Rejects archived conversations.
 * The first message of an untitled conversation becomes its title.
 *
 * AI failures never throw and never create fake assistant messages: the
 * user message stays persisted and assistantError carries safe text.
 * clientRequestId makes retries/double-submits idempotent.
 */
export const sendMessageFn = createServerFn({ method: 'POST' })
  .validator(sendMessageWire)
  .handler(async ({ data }): Promise<SendMessageResult> => {
    const workspace = await requireWorkspace()
    const conversation = await requireOwnedConversation(data.conversationId, workspace.id)
    if (conversation.deletedAt) {
      throw new Error('This conversation is archived. Restore it to send messages.')
    }
    const db = getDb()

    if (data.clientRequestId) {
      const existingUser = await findMessageByClientRequestId(
        db,
        conversation.id,
        data.clientRequestId,
      )
      if (existingUser && existingUser.senderType === 'user') {
        const existingAssistant = await findMessageByClientRequestId(
          db,
          conversation.id,
          `${data.clientRequestId}:chief`,
        )
        return {
          userMessage: existingUser,
          assistantMessage: existingAssistant,
          assistantError: null,
          deduplicated: true,
        }
      }
    }

    const userMessage = await appendUserMessage(db, {
      conversationId: conversation.id,
      content: data.content,
      ...(data.clientRequestId ? { clientRequestId: data.clientRequestId } : {}),
    })
    if (conversation.title === null) {
      await renameConversation(db, {
        id: conversation.id,
        title: deriveConversationTitle(data.content),
      })
    } else {
      await touchConversation(db, conversation.id)
    }

    const reply = await runChiefReply({
      db,
      workspaceId: workspace.id,
      conversationId: conversation.id,
      userText: data.content,
      uiBrandId: getCookie(ACTIVE_BRAND_COOKIE) ?? null,
      ...(data.clientRequestId ? { clientRequestId: `${data.clientRequestId}:chief` } : {}),
      deps: resolveAiRuntime().deps,
    })

    if (!reply.ok) {
      return {
        userMessage,
        assistantMessage: null,
        assistantError: reply.userMessage,
        deduplicated: false,
      }
    }
    return {
      userMessage,
      assistantMessage: reply.message,
      assistantError: null,
      deduplicated: false,
    }
  })
