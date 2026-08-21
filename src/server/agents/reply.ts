import type { Message } from '~/types/domain'

import type { ExecuteAIDeps } from '../ai/executor.ts'
import type { AIExecutionTraceSummary } from '../ai/types.ts'
import { buildContext, ContextError, type ContextPackage } from '../context/index.ts'
import { emitEventSafe } from '../db/event.ts'
import { appendMessage, findMessageByClientRequestId } from '../db/message.ts'
import type { SqlDatabase } from '../db/sql.ts'
import type { ExecuteToolDeps } from '../tools/index.ts'
import { resolveChatAgent } from './registry.ts'
import { agentFailureMessage, agentUnavailableMessage, executeAgentTask } from './task.ts'

/**
 * Direct-chat execution for registry agents — a WRAPPER around the generic
 * agent task executor (task.ts):
 *
 *   resolve agent (server-authoritative)
 *   → current immutable agent version
 *   → Context Engine (the ONLY context source)
 *   → executeAgentTask (composer + AI execution layer + safe events)
 *   → persisted assistant message (agent id + version + safe trace)
 *
 * The Workflow Engine uses executeAgentTask directly with its own frozen
 * versions and context snapshots; nothing here is workflow-specific and no
 * workflow step ever writes chat messages.
 */

export interface AgentReplyInput {
  db: SqlDatabase
  workspaceId: string
  conversationId: string
  /** Selected agent. Null/undefined = the Workspace Chief. */
  agentId?: string | null
  /** The user message that triggered this reply (already persisted). */
  userText: string
  /** Current UI selection; weaker than the conversation's persisted scope. */
  uiBrandId?: string | null
  /** Client-generated idempotency key (prevents duplicate executions). */
  clientRequestId?: string
  /** Test seam: inject adapters instead of the Worker runtime. */
  deps: ExecuteAIDeps
  /** Test seam: inject tool adapters instead of default runtime. */
  toolDeps?: ExecuteToolDeps
}

export type AgentReply =
  | { ok: true; message: Message; execution: AIExecutionTraceSummary }
  | { ok: false; userMessage: string; errorCode: string }

export async function runAgentReply(input: AgentReplyInput): Promise<AgentReply> {
  const { db, workspaceId, conversationId, userText, uiBrandId, clientRequestId, deps } = input

  // Idempotent re-entry: an assistant reply already exists for this client
  // request (browser retry / double submit) — do not execute twice.
  if (clientRequestId) {
    const existing = await findMessageByClientRequestId(db, conversationId, clientRequestId)
    if (existing && existing.senderType === 'agent') {
      return { ok: true, message: existing, execution: executionSummaryFromMessage(existing) }
    }
  }

  const resolved = await resolveChatAgent(db, workspaceId, input.agentId)
  if (!resolved.ok) {
    return { ok: false, userMessage: resolved.userMessage, errorCode: 'agent_unavailable' }
  }
  const handle = resolved.handle
  const { agent, version } = handle

  // external_agent / router are declared execution types. STEP 8 configures
  // them but does not execute them — a controlled failure, never a fake.
  if (agent.executionType !== 'direct_model') {
    await emitEventSafe(db, {
      workspaceId,
      eventType: 'ai.execution.failed',
      actorType: 'agent',
      actorId: agent.id,
      subjectType: 'conversation',
      subjectId: conversationId,
      payloadJson: JSON.stringify({
        stage: 'dispatch',
        code: 'unsupported_execution_type',
        agentVersionId: version.id,
      }),
    })
    return {
      ok: false,
      userMessage: agentUnavailableMessage(handle),
      errorCode: 'unsupported_execution_type',
    }
  }

  let pkg: ContextPackage
  try {
    pkg = await buildContext(db, {
      workspaceId,
      conversationId,
      agentId: agent.id,
      ...(uiBrandId ? { uiSelection: { brandId: uiBrandId } } : {}),
      task: { text: userText },
    })
  } catch (error) {
    const code = error instanceof ContextError ? error.code : 'unknown'
    await emitEventSafe(db, {
      workspaceId,
      eventType: 'ai.execution.failed',
      actorType: 'agent',
      actorId: agent.id,
      subjectType: 'conversation',
      subjectId: conversationId,
      payloadJson: JSON.stringify({ stage: 'context', code, agentVersionId: version.id }),
    })
    const message =
      error instanceof ContextError
        ? error.message
        : `${agent.name} could not load the workspace context.`
    return { ok: false, userMessage: message, errorCode: code }
  }

  const result = await executeAgentTask({
    db,
    workspaceId,
    handle,
    pkg,
    task: userText,
    eventSubject: { subjectType: 'conversation', subjectId: conversationId },
    metadata: { conversationId },
    deps,
    ...(input.toolDeps ? { toolDeps: input.toolDeps } : {}),
  })

  if (!result.ok) {
    return { ok: false, userMessage: result.message, errorCode: result.errorCode }
  }

  // Persist the assistant reply with agent/version + provider metadata and
  // the safe trace summary. provider_metadata never carries secrets.
  const assistant = await appendMessage(db, {
    conversationId,
    senderType: 'agent',
    agentId: agent.id,
    agentVersionId: version.id,
    content: result.content,
    providerMetadataJson: JSON.stringify({
      ...(clientRequestId ? { clientRequestId } : {}),
      ...result.execution,
    }),
  })

  return { ok: true, message: assistant, execution: result.execution }
}

function executionSummaryFromMessage(message: Message): AIExecutionTraceSummary {
  const fallback: AIExecutionTraceSummary = {
    executionId: message.id,
    provider: null,
    model: null,
    strategy: 'default',
    agentId: message.agentId ?? '',
    agentVersionId: message.agentVersionId ?? '',
    agentVersion: 0,
    usage: null,
    latencyMs: 0,
    attempts: 1,
    finishReason: null,
    contextGeneratedAt: null,
    scopeSource: null,
  }
  if (!message.providerMetadataJson) return fallback
  try {
    return { ...fallback, ...JSON.parse(message.providerMetadataJson) }
  } catch {
    return fallback
  }
}

// Re-exported for existing callers (chat failure wording lives in task.ts).
export { agentFailureMessage as userFacingFailure }
