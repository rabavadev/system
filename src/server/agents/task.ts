import { composeAgentPrompt, composeTaskPrompt } from '../ai/composer.ts'
import { type ExecuteAIDeps, executeAI } from '../ai/executor.ts'
import type { AIExecutionTraceSummary } from '../ai/types.ts'
import type { ContextPackage } from '../context/index.ts'
import { emitEventSafe } from '../db/event.ts'
import { newId, type SqlDatabase } from '../db/sql.ts'
import type { AgentHandle } from './registry.ts'

/**
 * Generic server-side agent task execution (STEP 10). ONE path runs an
 * agent version against a ContextPackage:
 *
 *   Agent Version + ContextPackage + task + structured step inputs
 *     → composer → executeAI → structured AgentTaskResult
 *
 * Chat (reply.ts) is a WRAPPER around this: it resolves the chat agent,
 * builds chat context, calls executeAgentTask, then persists the assistant
 * message. The Workflow Engine calls the same function with the run's
 * frozen agent version and context snapshot — without touching Chat at all.
 *
 * There is no second agent execution architecture.
 */

export interface AgentTaskInput {
  db: SqlDatabase
  workspaceId: string
  /** The exact agent + immutable version to run (frozen by the caller). */
  handle: AgentHandle
  /** Context from the Context Engine (or a persisted snapshot of one). */
  pkg: ContextPackage
  /** The caller's task/request text. */
  task: string
  /** Structured step inputs, rendered as a data section. Workflows only. */
  stepInputs?: Record<string, unknown>
  /** Where execution events point (conversation or workflow_run). */
  eventSubject: { subjectType: string; subjectId: string }
  /** Extra safe metadata for the AI execution request. */
  metadata?: Record<string, string | number | boolean | null>
  /** Test seam: inject adapters instead of the Worker runtime. */
  deps: ExecuteAIDeps
}

export type AgentTaskResult =
  | { ok: true; content: string; execution: AIExecutionTraceSummary }
  | {
      ok: false
      errorCode: string
      /** Safe, user-facing message. Provider internals stay server-side. */
      message: string
      retryable: boolean
    }

/** Safe, user-facing failure text. Provider internals stay server-side. */
export function agentFailureMessage(agentName: string, code: string): string {
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
export function agentUnavailableMessage(handle: AgentHandle): string {
  if (handle.agent.executionType === 'external_agent') {
    return `${handle.agent.name} is an external agent and has no connection yet. Connect it on the Agents page before chatting with it.`
  }
  if (handle.agent.executionType === 'router') {
    return `${handle.agent.name} uses smart routing, which is not enabled yet.`
  }
  return `${handle.agent.name} cannot run yet.`
}

export async function executeAgentTask(input: AgentTaskInput): Promise<AgentTaskResult> {
  const { db, workspaceId, handle, pkg, task, stepInputs, eventSubject, metadata, deps } = input
  const { agent, version, config } = handle

  // external_agent / router are declared execution types. They fail
  // controlled instead of faking a run.
  if (agent.executionType !== 'direct_model') {
    await emitEventSafe(db, {
      workspaceId,
      eventType: 'ai.execution.failed',
      actorType: 'agent',
      actorId: agent.id,
      subjectType: eventSubject.subjectType,
      subjectId: eventSubject.subjectId,
      payloadJson: JSON.stringify({
        stage: 'dispatch',
        code: 'unsupported_execution_type',
        agentVersionId: version.id,
      }),
    })
    return {
      ok: false,
      errorCode: 'unsupported_execution_type',
      message: agentUnavailableMessage(handle),
      retryable: false,
    }
  }

  const composed = stepInputs
    ? composeTaskPrompt(config.instructions, pkg, task, stepInputs)
    : composeAgentPrompt(config.instructions, { ...pkg, currentTask: { text: task } })
  const executionId = newId()

  await emitEventSafe(db, {
    workspaceId,
    eventType: 'ai.execution.started',
    actorType: 'agent',
    actorId: agent.id,
    subjectType: eventSubject.subjectType,
    subjectId: eventSubject.subjectId,
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
        workspaceId,
        scopeSource: composed.contextSummary.scopeSource,
        ...metadata,
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
    const code = result.error?.code ?? 'unknown'
    await emitEventSafe(db, {
      workspaceId,
      eventType: 'ai.execution.failed',
      actorType: 'agent',
      actorId: agent.id,
      subjectType: eventSubject.subjectType,
      subjectId: eventSubject.subjectId,
      payloadJson: JSON.stringify({
        executionId,
        agentVersionId: version.id,
        provider: result.provider,
        model: result.model,
        code,
        retryable: result.error?.retryable ?? false,
        latencyMs: result.latencyMs,
        attempts: result.attempts,
      }),
    })
    return {
      ok: false,
      errorCode: code,
      message: agentFailureMessage(agent.name, code),
      retryable: result.error?.retryable ?? false,
    }
  }

  await emitEventSafe(db, {
    workspaceId,
    eventType: 'ai.execution.completed',
    actorType: 'agent',
    actorId: agent.id,
    subjectType: eventSubject.subjectType,
    subjectId: eventSubject.subjectId,
    payloadJson: JSON.stringify({
      ...execution,
      contextCounts: composed.contextSummary.counts,
      trace: pkg.trace,
    }),
  })

  return { ok: true, content: result.content, execution }
}
