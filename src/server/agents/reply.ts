import type { Message } from '~/types/domain'

import { composeAgentPrompt } from '../ai/composer.ts'
import { type ExecuteAIDeps, executeAI } from '../ai/executor.ts'
import type { AIExecutionTraceSummary } from '../ai/types.ts'
import { buildContext, ContextError, type ContextPackage } from '../context/index.ts'
import { emitEventSafe } from '../db/event.ts'
import { appendMessage, findMessageByClientRequestId } from '../db/message.ts'
import { newId, type SqlDatabase } from '../db/sql.ts'
import { type AgentHandle, resolveChatAgent } from './registry.ts'

/**
 * Generic direct-chat execution for registry agents.
 *
 * Flow per send (STEP 8):
 *   resolve agent (server-authoritative)
 *   → current immutable agent version
 *   → Context Engine (the ONLY context source)
 *   → composer (ContextPackage → provider-neutral messages)
 *   → AI execution layer (timeout/retry/policy)
 *   → persisted assistant message (agent id + version + safe trace)
 *
 * No bypasses: agents never query the database for context themselves,
 * clients never supply instructions, and non-direct_model execution types
 * fail controlled instead of faking a run.
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
}

export type AgentReply =
  | { ok: true; message: Message; execution: AIExecutionTraceSummary }
  | { ok: false; userMessage: string; errorCode: string }

/** Safe, user-facing failure text. Provider internals stay server-side. */
function userFacingFailure(agentName: string, code: string): string {
  switch (code) {
    case 'not_configured':
      return `${agentName} is not connected to a model yet. Check the setup in Settings.`
    case 'invalid_model_config':
      return `${agentName} is misconfigured. Check the model configuration in Settings.`
    case 'timeout':
      return `${agentName} took too long to respond. Try again.`
    case 'rate_limited':
      return `${agentName} is busy right now. Try again in a moment.`
    default:
      return `${agentName} couldn't respond. Try again.`
  }
}

/** Why a non-direct_model agent cannot run yet, in normal-user words. */
function unavailableMessage(handle: AgentHandle): string {
  if (handle.agent.executionType === 'external_agent') {
    return `${handle.agent.name} is an external agent and has no connection yet. Connect it on the Agents page before chatting with it.`
  }
  if (handle.agent.executionType === 'router') {
    return `${handle.agent.name} uses smart routing, which is not enabled yet.`
  }
  return `${handle.agent.name} cannot run yet.`
}

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
  const { agent, version, config } = handle

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
      userMessage: unavailableMessage(handle),
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

  const composed = composeAgentPrompt(config.instructions, pkg)
  const executionId = newId()

  await emitEventSafe(db, {
    workspaceId,
    eventType: 'ai.execution.started',
    actorType: 'agent',
    actorId: agent.id,
    subjectType: 'conversation',
    subjectId: conversationId,
    payloadJson: JSON.stringify({
      executionId,
      agentVersionId: version.id,
      scopeSource: composed.contextSummary.scopeSource,
      counts: composed.contextSummary.counts,
    }),
  })

  const result = await executeAI(
    {
      executionId,
      agent: {
        agentId: agent.id,
        name: agent.name,
        versionId: version.id,
        version: version.version,
        executionType: agent.executionType,
      },
      messages: composed.messages,
      model: config.model,
      generation: config.generation,
      metadata: {
        conversationId,
        workspaceId,
        scopeSource: composed.contextSummary.scopeSource,
      },
    },
    deps,
  )

  const execution: AIExecutionTraceSummary = {
    executionId,
    provider: result.provider,
    model: result.model,
    strategy: config.model.strategy,
    agentId: agent.id,
    agentVersionId: version.id,
    agentVersion: version.version,
    usage: result.usage,
    latencyMs: result.latencyMs,
    attempts: result.attempts,
    finishReason: result.finishReason,
    contextGeneratedAt: pkg.generatedAt,
    scopeSource: composed.contextSummary.scopeSource,
  }

  if (result.status === 'failed' || result.content === null) {
    await emitEventSafe(db, {
      workspaceId,
      eventType: 'ai.execution.failed',
      actorType: 'agent',
      actorId: agent.id,
      subjectType: 'conversation',
      subjectId: conversationId,
      payloadJson: JSON.stringify({
        executionId,
        agentVersionId: version.id,
        provider: result.provider,
        model: result.model,
        code: result.error?.code ?? 'unknown',
        retryable: result.error?.retryable ?? false,
        latencyMs: result.latencyMs,
        attempts: result.attempts,
      }),
    })
    return {
      ok: false,
      userMessage: userFacingFailure(agent.name, result.error?.code ?? 'unknown'),
      errorCode: result.error?.code ?? 'unknown',
    }
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
      ...execution,
      contextCounts: composed.contextSummary.counts,
    }),
  })

  await emitEventSafe(db, {
    workspaceId,
    eventType: 'ai.execution.completed',
    actorType: 'agent',
    actorId: agent.id,
    subjectType: 'conversation',
    subjectId: conversationId,
    payloadJson: JSON.stringify({
      ...execution,
      messageId: assistant.id,
      contextCounts: composed.contextSummary.counts,
      trace: pkg.trace,
    }),
  })

  return { ok: true, message: assistant, execution }
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
