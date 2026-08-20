import { createServerFn } from '@tanstack/react-start'
import { getCookie } from '@tanstack/react-start/server'
import { z } from 'zod'
import { ACTIVE_BRAND_COOKIE } from '~/features/workspace/server'
import { runAgentReply } from '~/server/agents/reply'
import { resolveAiRuntime } from '~/server/ai/runtime'
import { listAgents } from '~/server/db/agent'
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
import type { SqlDatabase } from '~/server/db/sql'
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
  scopeType: z.enum(['brand', 'product', 'account', 'campaign']).nullable().optional(),
  scopeId: z.string().uuid().nullable().optional(),
})
const renameConversationWire = z.object({
  id: z.uuid(),
  title: z.string().trim().min(1, 'Give the conversation a name.').max(120),
})
// Note: no role/sender field here by design. The client can only ever send
// user messages; the role is fixed server-side. clientRequestId is an
// idempotency key, not a role/metadata channel. agentId selects WHO answers;
// instructions/config are resolved server-side and can never be injected.
const sendMessageWire = z.object({
  conversationId: z.uuid(),
  agentId: z.uuid().optional(),
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

/** An agent as the Chat UI needs it: identity + whether it can run now. */
export interface ChatAgentOption {
  id: string
  name: string
  role: string | null
  status: 'active' | 'disabled' | 'archived'
  origin: 'builtin' | 'custom'
  executionType: 'direct_model' | 'external_agent' | 'router'
  /** True when the agent can be picked for a new execution right now. */
  selectable: boolean
}

export interface ConversationPageData {
  conversation: ConversationSummary
  messages: Message[]
  /** Live agents, for the selector and per-message author labels. */
  agents: ChatAgentOption[]
}

/** Registry agents reduced to what Chat needs. Never exposes config. */
export async function listChatAgents(
  db: SqlDatabase,
  workspaceId: string,
): Promise<ChatAgentOption[]> {
  const agents = await listAgents(db, workspaceId)
  return agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    role: agent.role,
    status: agent.status,
    origin: agent.origin,
    executionType: agent.executionType,
    selectable: agent.status === 'active' && agent.executionType === 'direct_model',
  }))
}

/**
 * Resolve the selected agent from URL state. Unknown, disabled or otherwise
 * unselectable values fall back cleanly to Chief (then any selectable).
 */
export function resolveSelectedAgent(
  agents: ChatAgentOption[],
  requestedId: string | undefined,
): ChatAgentOption | null {
  const selectable = agents.filter((agent) => agent.selectable)
  if (requestedId) {
    const requested = selectable.find((agent) => agent.id === requestedId)
    if (requested) {
      return requested
    }
  }
  return (
    selectable.find((agent) => agent.name === 'Chief' && agent.origin === 'builtin') ??
    selectable[0] ??
    null
  )
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
    const agents = await listChatAgents(db, workspace.id)
    return { conversation, messages, agents }
  })

/**
 * Create a conversation. When explicit scope is provided, it uses that;
 * when a brand is currently selected (cookie), the conversation is associated
 * with that brand; otherwise it is a general workspace conversation.
 */
export const createConversationFn = createServerFn({ method: 'POST' })
  .validator(createConversationWire)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const workspace = await requireWorkspace()
    const db = getDb()

    let scopeType: 'brand' | 'product' | 'account' | 'campaign' | null = data.scopeType ?? null
    let scopeId: string | null = data.scopeId ?? null
    if (!scopeType || !scopeId) {
      const activeBrandId = getCookie(ACTIVE_BRAND_COOKIE)
      if (activeBrandId) {
        const brand = await getBrandById(activeBrandId)
        if (brand && !brand.deletedAt && brand.workspaceId === workspace.id) {
          scopeType = 'brand'
          scopeId = brand.id
        }
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
  /** The selected agent's reply. Null when execution failed (assistantError). */
  assistantMessage: Message | null
  /** User-safe failure text when the agent could not respond. */
  assistantError: string | null
  /** True when an idempotent retry returned the already-processed send. */
  deduplicated: boolean
}

/**
 * Send a user message, then run the selected registry agent (default: the
 * Workspace Chief): Context Engine → AI execution → persisted assistant
 * reply. Rejects archived conversations.
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
          `${data.clientRequestId}:reply`,
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

    const reply = await runAgentReply({
      db,
      workspaceId: workspace.id,
      conversationId: conversation.id,
      ...(data.agentId ? { agentId: data.agentId } : {}),
      userText: data.content,
      uiBrandId: getCookie(ACTIVE_BRAND_COOKIE) ?? null,
      ...(data.clientRequestId ? { clientRequestId: `${data.clientRequestId}:reply` } : {}),
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
