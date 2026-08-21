import { composeAgentPrompt, composeTaskPrompt } from '../ai/composer.ts'
import { type ExecuteAIDeps, executeAI } from '../ai/executor.ts'
import type {
  AIExecutionTraceSummary,
  AIMessage,
  AISourceReference,
  AIToolDefinition,
  AIToolTraceSummary,
} from '../ai/types.ts'
import { createApprovalRequest } from '../approval/index.ts'
import type { ContextPackage } from '../context/index.ts'
import { emitEventSafe } from '../db/event.ts'
import { newId, type SqlDatabase } from '../db/sql.ts'
import {
  type ExecuteToolDeps,
  executeTool,
  getAvailableTools,
  getToolDefinition,
  listToolDefinitions,
  prepareToolExecution,
  type ToolCaller,
  type ToolKey,
  toAIToolDefinition,
} from '../tools/index.ts'
import type { AgentHandle } from './registry.ts'

/**
 * Generic server-side agent task execution (STEP 10 & STEP 13B). ONE path runs an
 * agent version against a ContextPackage with bounded provider-neutral tool calling:
 *
 *   Agent Version + ContextPackage + task + structured step inputs
 *     → composer → executeAI → (bounded tool-call loop via executeTool) → structured AgentTaskResult
 *
 * Chat (reply.ts) is a WRAPPER around this: it resolves the chat agent,
 * builds chat context, calls executeAgentTask, then persists the assistant
 * message. The Workflow Engine calls the same function with the run's
 * frozen agent version and context snapshot — without touching Chat at all.
 *
 * There is no second agent execution architecture.
 */

export const MAX_AGENT_TOOL_CALLS = 3

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
  /** Test seam: inject tool adapters instead of default runtime. */
  toolDeps?: ExecuteToolDeps
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

  const caller: ToolCaller = {
    agentId: agent.id,
    agentVersionId: version.id,
    agentName: agent.name,
    agentStatus: agent.status,
    capabilities: config.capabilities,
  }

  const availableTools = getAvailableTools(caller, input.toolDeps)
  const allDefinitions = input.toolDeps?.definitions ?? listToolDefinitions()
  const defMap = new Map(allDefinitions.map((d) => [d.key, d]))
  const modelTools: AIToolDefinition[] = availableTools
    .map((t) => {
      const def = defMap.get(t.key) ?? getToolDefinition(t.key)
      return def ? toAIToolDefinition(def) : null
    })
    .filter((t): t is AIToolDefinition => t !== null)

  let toolCallCount = 0
  const toolTraces: AIToolTraceSummary[] = []
  const searchSources: AISourceReference[] = []
  const currentMessages: AIMessage[] = [...composed.messages]
  let lastContent: string | null = null
  let lastFinishReason: string | null = null
  let totalAttempts = 0
  let totalLatencyMs = 0
  let hasUsage = false
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalTokens = 0
  let lastProvider: string | null = null
  let lastModel: string | null = null

  while (true) {
    const aiResult = await executeAI(
      {
        executionId: toolCallCount === 0 ? executionId : `${executionId}-step-${toolCallCount}`,
        agent: {
          agentId: agent.id,
          name: agent.name,
          versionId: version.id,
          version: version.version,
          executionType: agent.executionType,
        },
        messages: currentMessages,
        ...(toolCallCount < MAX_AGENT_TOOL_CALLS && modelTools.length > 0
          ? { tools: modelTools }
          : {}),
        model: config.model,
        generation: config.generation,
        metadata: {
          workspaceId,
          scopeSource: composed.contextSummary.scopeSource,
          toolCallCount,
          ...metadata,
        },
      },
      deps,
    )

    totalAttempts += aiResult.attempts
    totalLatencyMs += aiResult.latencyMs
    lastProvider = aiResult.provider
    lastModel = aiResult.model
    lastFinishReason = aiResult.finishReason

    if (aiResult.usage) {
      hasUsage = true
      totalInputTokens += aiResult.usage.inputTokens ?? 0
      totalOutputTokens += aiResult.usage.outputTokens ?? 0
      totalTokens += aiResult.usage.totalTokens ?? 0
    }

    if (aiResult.status === 'failed') {
      const code = aiResult.error?.code ?? 'unknown'
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
          provider: aiResult.provider,
          model: aiResult.model,
          code,
          retryable: aiResult.error?.retryable ?? false,
          latencyMs: totalLatencyMs,
          attempts: totalAttempts,
        }),
      })
      return {
        ok: false,
        errorCode: code,
        message: agentFailureMessage(agent.name, code),
        retryable: aiResult.error?.retryable ?? false,
      }
    }

    lastContent = aiResult.content
    const requestedCalls = aiResult.toolCalls

    if (!requestedCalls || requestedCalls.length === 0 || toolCallCount >= MAX_AGENT_TOOL_CALLS) {
      break
    }

    // Append model assistant turn with tool calls
    currentMessages.push({
      role: 'assistant',
      content: aiResult.content ?? '',
      ...(requestedCalls ? { toolCalls: requestedCalls } : {}),
    })

    // Execute requested tools
    for (const call of requestedCalls) {
      if (toolCallCount >= MAX_AGENT_TOOL_CALLS) break
      toolCallCount += 1
      const toolStart = Date.now()

      // 1. Pre-execution validation: identity, capability, status, config, schemas
      const prepared = prepareToolExecution(
        {
          workspaceId,
          toolKey: call.toolKey,
          args: call.args,
          caller,
        },
        input.toolDeps,
      )

      if (!prepared.ok) {
        const durationMs = Math.max(0, Date.now() - toolStart)
        currentMessages.push({
          role: 'tool',
          toolCallId: call.id,
          toolKey: call.toolKey,
          content: JSON.stringify({
            error: prepared.error.code,
            message: prepared.error.message,
          }),
        })
        toolTraces.push({
          toolKey: call.toolKey,
          callNumber: toolCallCount,
          args: call.args,
          resultCount: 0,
          status: 'failed',
          durationMs,
          error: prepared.error.code,
        })
        continue
      }

      const metaObj = metadata as { conversationId?: unknown } | undefined
      const conversationId =
        typeof metaObj?.conversationId === 'string' ? metaObj.conversationId : undefined

      // 2. Policy resolution & approval request creation using server-derived context
      const brandId =
        pkg.activeScope?.type === 'brand' ? (pkg.activeScope.id ?? null) : (pkg.brand?.id ?? null)

      const approvalResult = await createApprovalRequest(db, {
        workspaceId,
        actionKey: prepared.actionKey,
        origin: 'agent',
        requestedByType: 'agent',
        requestedById: agent.id,
        brandId,
        conversationId: conversationId ?? null,
        executionId,
        summary: `${agent.name} requests ${prepared.definition.name}`,
        ...(prepared.definition.approval === 'required' ? { minimumMode: 'review' as const } : {}),
        payload: {
          toolKey: call.toolKey,
          args: prepared.parsedArgs,
          agentId: agent.id,
          agentVersionId: version.id,
        },
        risk: prepared.definition.risk,
      })

      // 3. Handle BLOCKED mode
      if (approvalResult.status === 'blocked') {
        const durationMs = Math.max(0, Date.now() - toolStart)
        currentMessages.push({
          role: 'tool',
          toolCallId: call.id,
          toolKey: call.toolKey,
          content: JSON.stringify({
            error: 'blocked',
            message: approvalResult.reason ?? 'This action is blocked by your Autonomy settings.',
          }),
        })
        toolTraces.push({
          toolKey: call.toolKey,
          callNumber: toolCallCount,
          args: call.args,
          resultCount: 0,
          status: 'failed',
          durationMs,
          error: 'blocked',
        })
        continue
      }

      // 4. Handle REVIEW mode
      if (approvalResult.status === 'pending') {
        const durationMs = Math.max(0, Date.now() - toolStart)
        currentMessages.push({
          role: 'tool',
          toolCallId: call.id,
          toolKey: call.toolKey,
          content: JSON.stringify({
            error: 'approval_required',
            message: 'This action needs user approval before it can run.',
          }),
        })
        toolTraces.push({
          toolKey: call.toolKey,
          callNumber: toolCallCount,
          args: call.args,
          resultCount: 0,
          status: 'failed',
          durationMs,
          error: 'approval_required',
        })
        continue
      }

      // 5. AUTO mode: execute authorized tool
      const toolExecResult = await executeTool(
        {
          db,
          workspaceId,
          toolKey: call.toolKey as ToolKey,
          args: call.args,
          caller,
          context: {
            ...(conversationId ? { conversationId } : {}),
            taskText: task,
          },
          approvalGranted: true,
        },
        input.toolDeps,
      )

      const durationMs = Math.max(0, Date.now() - toolStart)

      if (!toolExecResult.ok) {
        currentMessages.push({
          role: 'tool',
          toolCallId: call.id,
          toolKey: call.toolKey,
          content: JSON.stringify({
            error: toolExecResult.error?.code ?? 'execution_failed',
            message: toolExecResult.error?.message ?? 'Tool execution failed.',
          }),
        })
        toolTraces.push({
          toolKey: call.toolKey,
          callNumber: toolCallCount,
          args: call.args,
          resultCount: 0,
          status: 'failed',
          durationMs,
          ...(toolExecResult.error?.code ? { error: toolExecResult.error.code } : {}),
        })
      } else {
        const resultData = toolExecResult.data as { results?: unknown }
        const rawResults = resultData.results
        const resultsArray = Array.isArray(rawResults) ? (rawResults as unknown[]) : []

        if (call.toolKey === 'web.search' && Array.isArray(rawResults)) {
          for (const r of rawResults) {
            if (typeof r === 'object' && r !== null) {
              const item = r as {
                title?: unknown
                url?: unknown
                publisher?: unknown
                publishedAt?: unknown
                retrievedAt?: unknown
                snippet?: unknown
              }
              const title = typeof item.title === 'string' ? item.title : ''
              const url = typeof item.url === 'string' ? item.url : ''
              if (title && url) {
                const publisher = typeof item.publisher === 'string' ? item.publisher : null
                const publishedAt = typeof item.publishedAt === 'string' ? item.publishedAt : null
                const retrievedAt =
                  typeof item.retrievedAt === 'string' ? item.retrievedAt : new Date().toISOString()
                const snippet = typeof item.snippet === 'string' ? item.snippet : null
                searchSources.push({
                  title,
                  url,
                  publisher,
                  publishedAt,
                  retrievedAt,
                  ...(snippet ? { snippet } : {}),
                })
              }
            }
          }
        }

        currentMessages.push({
          role: 'tool',
          toolCallId: call.id,
          toolKey: call.toolKey,
          content: JSON.stringify(toolExecResult.data),
        })

        toolTraces.push({
          toolKey: call.toolKey,
          callNumber: toolCallCount,
          args: call.args,
          resultCount: resultsArray.length,
          status: 'succeeded',
          durationMs,
        })
      }
    }
  }

  const execution: AIExecutionTraceSummary = {
    executionId,
    provider: lastProvider,
    model: lastModel,
    strategy: config.model.strategy,
    agentId: agent.id,
    agentVersionId: version.id,
    agentVersion: version.version,
    usage: hasUsage
      ? {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          totalTokens: totalTokens,
        }
      : null,
    latencyMs: totalLatencyMs,
    attempts: totalAttempts,
    finishReason: lastFinishReason,
    contextGeneratedAt: pkg.generatedAt,
    scopeSource: composed.contextSummary.scopeSource,
    ...(toolTraces.length > 0 ? { toolCalls: toolTraces } : {}),
    ...(searchSources.length > 0 ? { sources: searchSources } : {}),
  }

  if (lastContent === null || lastContent.trim().length === 0) {
    // If model ended after tool calls without final content, provide a safe fallback or error
    const code = 'malformed_response'
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
        code,
        latencyMs: totalLatencyMs,
        attempts: totalAttempts,
      }),
    })
    return {
      ok: false,
      errorCode: code,
      message: agentFailureMessage(agent.name, code),
      retryable: false,
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

  return { ok: true, content: lastContent, execution }
}
