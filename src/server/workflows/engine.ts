import { executeAgentTask } from '../agents/task.ts'
import type { ExecuteAIDeps } from '../ai/executor.ts'
import { createApprovalRequest, getApprovalWithExpiryCheck } from '../approval/service.ts'
import {
  computeSnapshotFingerprint,
  createSafeActionSnapshot,
  verifySnapshotIntegrity,
} from '../approval/snapshot.ts'
import {
  buildContext,
  ContextError,
  type ContextPackage,
  type ContextRequest,
} from '../context/index.ts'
import { getAgentById } from '../db/agent.ts'
import { updateApprovalDecision } from '../db/approval.ts'
import { emitEventSafe } from '../db/event.ts'
import { nowIso, queryAll, type SqlDatabase } from '../db/sql.ts'
import {
  createWorkflowRun,
  createWorkflowStepRun,
  finishWorkflowStepRun,
  getWorkflowById,
  getWorkflowRunById,
  getWorkflowVersion,
  listWorkflowStepRuns,
  updateWorkflowRun,
} from '../db/workflow.ts'
import { type ExecuteToolDeps, executeTool } from '../tools/index.ts'
import {
  type BindingScope,
  getPathValue,
  resolveBindingSource,
  resolveBindings,
} from './bindings.ts'
import { evaluateCondition } from './conditions.ts'
import {
  type JsonValue,
  parseWorkflowDefinition,
  type WorkflowInputDecl,
  type WorkflowStepDef,
} from './definition.ts'
import { boundedSnapshot, WORKFLOW_LIMITS } from './limits.ts'
import { frozenAgentHandle, type ResolvedAgent, type RunPlan, resolveRunPlan } from './plan.ts'
import { resolveActionKeyForTool } from './policy.ts'
import { validateWorkflowDefinition } from './validate.ts'

/**
 * The Workflow Engine (STEP 10 & 11C). Owns the run lifecycle:
 *
 *   startWorkflowRun           — validate everything, freeze the plan, snapshot
 *                                context, persist the run, then drive it.
 *   driveRun                   — the step loop. State is persisted after EVERY
 *                                transition, so a run never depends on one request
 *                                staying alive.
 *   resumeWorkflowRun          — continue a queued/running/waiting run.
 *   resumeWorkflowAfterApproval— continue a waiting run following a human approval decision.
 *   cancelWorkflowRun          — stop a pending/active run; history is kept and
 *                                pending approvals are cancelled.
 *
 * The engine is provider-neutral (agents run via executeAgentTask) and
 * platform-neutral (tools run via executeTool only). It never writes chat
 * messages and never becomes a super-user: tool steps execute with the
 * capabilities of a resolved agent version.
 */

/** Tool failures worth a bounded retry. Capability/input/approval are not. */
const RETRYABLE_TOOL_CODES = new Set(['timeout'])

/** Persisted engine state. Small by design; history lives in step runs. */
export interface EngineState {
  nextStepId: string | null
  visits: Record<string, number>
  counts: { steps: number; agents: number; tools: number }
  startedAtMs: number
  waitingApprovalId?: string | null
}

export interface AuthorizedApproval {
  approvalRequestId: string
  stepId: string
  fingerprint: string
}

export interface DriveRunOptions {
  authorizedApproval?: AuthorizedApproval
}

export interface WorkflowEngineDeps {
  ai: ExecuteAIDeps
  tools?: ExecuteToolDeps
  now?: () => number
}

export type StartRunResult = { ok: true; runId: string } | { ok: false; message: string }

/* ---- input validation ---- */

function validateInputs(
  declared: readonly WorkflowInputDecl[],
  inputs: Record<string, unknown>,
): { ok: true; values: Record<string, JsonValue> } | { ok: false; message: string } {
  if (JSON.stringify(inputs).length > WORKFLOW_LIMITS.maxInputValueChars * 4) {
    return { ok: false, message: 'The workflow inputs are too large.' }
  }
  const values: Record<string, JsonValue> = {}
  for (const decl of declared) {
    const raw = inputs[decl.key]
    const missing = raw === undefined || raw === null || raw === ''
    if (missing) {
      if (decl.required) {
        return { ok: false, message: `"${decl.label}" is required before this workflow can start.` }
      }
      continue
    }
    if (decl.kind === 'text') {
      if (typeof raw !== 'string' || raw.length > WORKFLOW_LIMITS.maxInputValueChars) {
        return { ok: false, message: `"${decl.label}" must be a short text.` }
      }
      values[decl.key] = raw
    } else {
      if (typeof raw !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(raw)) {
        return { ok: false, message: `"${decl.label}" is not a valid selection.` }
      }
      values[decl.key] = raw
    }
  }
  return { ok: true, values }
}

/** Entity-kind inputs become explicit Context Engine references (§8). */
function contextRequestFromInputs(
  workspaceId: string,
  declared: readonly WorkflowInputDecl[],
  values: Record<string, JsonValue>,
  explicitScope?: {
    type: 'workspace' | 'brand' | 'niche' | 'product' | 'account' | 'campaign'
    id: string
  } | null,
): ContextRequest {
  const request: ContextRequest = { workspaceId }
  if (explicitScope) {
    if (explicitScope.type === 'campaign') request.campaignId = explicitScope.id
    else if (explicitScope.type === 'brand') request.brandId = explicitScope.id
    else if (explicitScope.type === 'product') request.productId = explicitScope.id
    else if (explicitScope.type === 'niche') request.nicheId = explicitScope.id
    else if (explicitScope.type === 'account') request.accountId = explicitScope.id
  }
  for (const decl of declared) {
    const value = values[decl.key]
    if (typeof value !== 'string') continue
    switch (decl.kind) {
      case 'brand':
        request.brandId = value
        break
      case 'niche':
        request.nicheId = value
        break
      case 'product':
        request.productId = value
        break
      case 'account':
        request.accountId = value
        break
      case 'campaign':
        request.campaignId = value
        break
    }
  }
  return request
}

function workflowEvent(
  db: SqlDatabase,
  run: { id: string; workflowId: string; workflowVersionId: string },
  workspaceId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  return emitEventSafe(db, {
    workspaceId,
    eventType,
    actorType: 'workflow',
    actorId: run.id,
    subjectType: 'workflow_run',
    subjectId: run.id,
    payloadJson: JSON.stringify({
      workflowId: run.workflowId,
      workflowVersionId: run.workflowVersionId,
      ...payload,
    }),
  })
}

function parseState(json: string | null, entryStepId: string): EngineState {
  if (json) {
    try {
      const parsed = JSON.parse(json) as EngineState
      if (parsed && typeof parsed === 'object' && 'nextStepId' in parsed) return parsed
    } catch {
      // fall through to a fresh state
    }
  }
  return {
    nextStepId: entryStepId,
    visits: {},
    counts: { steps: 0, agents: 0, tools: 0 },
    startedAtMs: Date.now(),
  }
}

/* ---- start ---- */

export interface StartWorkflowRunInput {
  db: SqlDatabase
  workspaceId: string
  workflowId: string
  inputs: Record<string, unknown>
  scope?: {
    type: 'workspace' | 'brand' | 'niche' | 'product' | 'account' | 'campaign'
    id: string
  } | null
  triggerType?: 'manual' | 'schedule' | 'event' | 'agent'
  deps: WorkflowEngineDeps
  /** Drive inline after creation (the default runtime). Tests can skip. */
  drive?: boolean
}

export async function startWorkflowRun(input: StartWorkflowRunInput): Promise<StartRunResult> {
  const { db, workspaceId, deps } = input

  const workflow = await getWorkflowById(db, input.workflowId)
  if (!workflow || workflow.workspaceId !== workspaceId || workflow.deletedAt) {
    return { ok: false, message: 'That workflow could not be found.' }
  }
  if (workflow.status !== 'active') {
    return {
      ok: false,
      message:
        workflow.status === 'draft'
          ? 'This workflow is still a draft. Activate it before running it.'
          : `This workflow is ${workflow.status}.`,
    }
  }
  if (!workflow.currentVersionId) {
    return { ok: false, message: 'This workflow has no definition yet.' }
  }
  const version = await getWorkflowVersion(db, workflow.currentVersionId)
  if (!version) {
    return { ok: false, message: 'This workflow has no definition yet.' }
  }

  // Defensive re-validation: versions are validated at creation, but a
  // version could reference an agent/tool that disappeared afterwards.
  const validation = await validateWorkflowDefinition(
    db,
    workspaceId,
    JSON.parse(version.definitionJson),
    deps.tools?.definitions ? { toolDefinitions: deps.tools.definitions } : undefined,
  )
  if (!validation.ok || !validation.definition) {
    return {
      ok: false,
      message: `This workflow's definition is no longer valid: ${validation.errors[0]}`,
    }
  }
  const definition = validation.definition

  // Inputs are validated BEFORE anything starts (§11).
  const inputs = validateInputs(definition.inputs, input.inputs)
  if (!inputs.ok) return { ok: false, message: inputs.message }

  // Scope goes through the Context Engine. Cross-workspace ids, archived
  // entities and broken relationships reject here, not three steps later.
  let pkg: ContextPackage
  try {
    pkg = await buildContext(
      db,
      contextRequestFromInputs(workspaceId, definition.inputs, inputs.values, input.scope),
    )
  } catch (error) {
    if (error instanceof ContextError) return { ok: false, message: error.message }
    return { ok: false, message: 'The workflow context could not be loaded.' }
  }

  // Freeze every agent version for the whole run (§5/§6).
  const resolved = await resolveRunPlan(db, workspaceId, definition)
  if (!resolved.ok) return { ok: false, message: resolved.message }

  const plan: RunPlan = {
    workflowVersionId: version.id,
    entryStepId: resolved.plan.entryStepId,
    agents: resolved.plan.agents,
    limits: resolved.plan.limits,
  }
  const state = parseState(null, plan.entryStepId)

  const run = await createWorkflowRun(db, {
    workflowId: workflow.id,
    workflowVersionId: version.id,
    triggerType: input.triggerType ?? 'manual',
    inputJson: boundedSnapshot(inputs.values, WORKFLOW_LIMITS.maxRunOutputChars),
    contextJson: boundedSnapshot(pkg, WORKFLOW_LIMITS.maxStepSnapshotChars * 4),
    planJson: JSON.stringify(plan),
    stateJson: JSON.stringify(state),
  })

  await workflowEvent(db, run, workspaceId, 'workflow.run_started', {
    inputs: Object.keys(inputs.values),
    scope: { type: pkg.activeScope.type, id: pkg.activeScope.id },
    agents: plan.agents,
    limits: plan.limits,
  })

  if (pkg.campaign) {
    await emitEventSafe(db, {
      workspaceId,
      eventType: 'campaign.workflow_started',
      actorType: 'user',
      subjectType: 'workflow_run',
      subjectId: run.id,
      payloadJson: JSON.stringify({
        campaignId: pkg.campaign.id,
        workflowId: workflow.id,
        runId: run.id,
      }),
    })
  }

  if (input.drive !== false) {
    await driveRun(db, run.id, deps)
  }
  return { ok: true, runId: run.id }
}

/* ---- step execution ---- */

interface StepOutcome {
  /** Where control flow goes next. null = terminate the run. */
  next: string | null
  output: JsonValue
  decision?: Record<string, JsonValue | null>
  toolExecutionId?: string | null
  agentVersionId?: string | null
}

type StepFailure =
  | { kind: 'retryable'; message: string }
  | { kind: 'fatal'; message: string }
  | { kind: 'waiting'; message: string; toolExecutionId: string; approvalRequestId?: string }

async function executeStep(
  db: SqlDatabase,
  workspaceId: string,
  runId: string,
  plan: RunPlan,
  pkg: ContextPackage,
  scope: BindingScope,
  step: WorkflowStepDef,
  attempt: number,
  deps: WorkflowEngineDeps,
  options?: DriveRunOptions,
): Promise<StepOutcome | StepFailure> {
  if (step.type === 'end') {
    return { next: null, output: { kind: 'end' } }
  }

  if (step.type === 'condition') {
    const left = resolveBindingSource(step.condition.left, scope)
    const evaluation = evaluateCondition(left, step.condition.operator, step.condition.value)
    const branch = evaluation.result ? 'yes' : 'no'
    const target = step.branches[branch]
    return {
      next: target,
      output: {
        kind: 'condition',
        left: evaluation.left ?? null,
        operator: evaluation.operator,
        compareTo: evaluation.compareTo ?? null,
        result: evaluation.result,
      },
      decision: { branch, target },
    }
  }

  const resolvedAgent: ResolvedAgent | undefined = plan.agents[step.id]
  if (!resolvedAgent) {
    return { kind: 'fatal', message: `Step '${step.id}' has no resolved agent.` }
  }
  const handle = await frozenAgentHandle(db, resolvedAgent)
  if (!handle) {
    return { kind: 'fatal', message: 'The resolved agent version could not be loaded.' }
  }
  // Agent status is re-checked at execution time: an agent disabled mid-run
  // must stop the step, not keep running on the frozen version.
  if (handle.agent.status !== 'active') {
    return {
      kind: 'fatal',
      message: `${handle.agent.name} is ${handle.agent.status}; the step cannot run.`,
    }
  }

  if (step.type === 'agent') {
    const stepInputs = resolveBindings(step.inputs, scope)
    const result = await executeAgentTask({
      db,
      workspaceId,
      handle,
      pkg,
      task: step.task,
      stepInputs,
      eventSubject: { subjectType: 'workflow_run', subjectId: runId },
      metadata: { workflowRunId: runId, stepId: step.id },
      deps: deps.ai,
    })
    if (!result.ok) {
      return result.retryable
        ? { kind: 'retryable', message: result.message }
        : { kind: 'fatal', message: result.message }
    }
    return {
      next: step.next,
      agentVersionId: handle.version.id,
      output: {
        kind: 'agent',
        content: result.content,
        agentId: handle.agent.id,
        agentName: handle.agent.name,
        agentVersionId: handle.version.id,
        agentVersion: handle.version.version,
        executionId: result.execution.executionId,
        provider: result.execution.provider,
        model: result.execution.model,
        usage: result.execution.usage
          ? {
              inputTokens: result.execution.usage.inputTokens,
              outputTokens: result.execution.usage.outputTokens,
              totalTokens: result.execution.usage.totalTokens,
            }
          : null,
        latencyMs: result.execution.latencyMs,
      },
    }
  }

  // Tool step — ALWAYS through executeTool with the resolved agent version
  // as caller. The workflow is never a super-user.
  const args = resolveBindings(step.inputs, scope)
  const toolDefinition = (deps.tools?.definitions ?? []).find((d) => d.key === step.toolKey) ?? null
  const actionKey = resolveActionKeyForTool(step.toolKey, toolDefinition)
  const brandId =
    pkg.activeScope?.type === 'brand' ? (pkg.activeScope.id ?? null) : (pkg.brand?.id ?? null)

  const authorized = options?.authorizedApproval
  const isAuthorizedForStep = authorized && authorized.stepId === step.id

  if (isAuthorizedForStep) {
    // Re-verify snapshot fingerprint matching
    const { snapshotJson } = createSafeActionSnapshot({
      toolKey: step.toolKey,
      args,
      stepId: step.id,
    })
    const currentFingerprint = computeSnapshotFingerprint(actionKey, snapshotJson)
    if (currentFingerprint !== authorized.fingerprint) {
      return {
        kind: 'fatal',
        message: `Action parameters changed since approval: snapshot mismatch (expected ${authorized.fingerprint}, got ${currentFingerprint}).`,
      }
    }
  } else {
    // Check approval policy via central Approval Request service
    const approvalResult = await createApprovalRequest(db, {
      workspaceId,
      actionKey,
      origin: 'workflow',
      requestedByType: 'workflow',
      requestedById: plan.workflowVersionId,
      brandId,
      runId,
      stepId: step.id,
      executionId: `${runId}:${step.id}:${attempt}`,
      summary: `Execute ${step.toolKey} in workflow step "${step.id}"`,
      payload: {
        toolKey: step.toolKey,
        args,
        stepId: step.id,
      },
    })

    if (approvalResult.status === 'blocked') {
      return {
        kind: 'fatal',
        message: `Step "${step.id}" is blocked by policy: ${approvalResult.reason}`,
      }
    }

    if (approvalResult.status === 'pending' && approvalResult.request) {
      return {
        kind: 'waiting',
        approvalRequestId: approvalResult.request.id,
        message: approvalResult.reason ?? 'This step needs approval.',
        toolExecutionId: `${runId}:${step.id}:${attempt}`,
      }
    }
  }

  const toolResult = await executeTool(
    {
      db,
      workspaceId,
      toolKey: step.toolKey,
      args,
      caller: {
        agentId: handle.agent.id,
        agentVersionId: handle.version.id,
        agentName: handle.agent.name,
        agentStatus: handle.agent.status,
        capabilities: handle.config.capabilities,
      },
      context: { taskText: `workflow ${runId} step ${step.id}` },
      // Idempotency foundation: stable per run+step+attempt, so a retried
      // attempt gets a new key but a replayed one never does.
      idempotencyKey: `${runId}:${step.id}:${attempt}`,
      approvalGranted: true,
    },
    deps.tools ?? {},
  )

  if (!toolResult.ok) {
    const code = toolResult.error?.code ?? 'execution_failed'
    if (code === 'approval_required') {
      // §47/§48: a controlled pause, neither failure nor success.
      return {
        kind: 'waiting',
        message: toolResult.error?.message ?? 'This step needs approval.',
        toolExecutionId: toolResult.executionId,
      }
    }
    const message = toolResult.error?.message ?? 'The tool step failed.'
    return RETRYABLE_TOOL_CODES.has(code)
      ? { kind: 'retryable', message }
      : { kind: 'fatal', message }
  }

  return {
    next: step.next,
    toolExecutionId: toolResult.executionId,
    agentVersionId: handle.version.id,
    output: {
      kind: 'tool',
      toolKey: toolResult.toolKey,
      executionId: toolResult.executionId,
      durationMs: toolResult.durationMs,
      data: (toolResult.data ?? null) as JsonValue,
    },
  }
}

/* ---- the drive loop ---- */

export async function driveRun(
  db: SqlDatabase,
  runId: string,
  deps: WorkflowEngineDeps,
  options?: DriveRunOptions,
): Promise<void> {
  const now = deps.now ?? Date.now
  let currentOptions = options

  for (;;) {
    const run = await getWorkflowRunById(db, runId)
    if (run?.status !== 'running') return

    const workflow = await getWorkflowById(db, run.workflowId)
    const workspaceId = workflow?.workspaceId
    if (!workflow || !workspaceId) {
      await updateWorkflowRun(db, runId, {
        status: 'failed',
        error: 'The workflow disappeared.',
        finishedAt: nowIso(),
      })
      return
    }

    const version = await getWorkflowVersion(db, run.workflowVersionId)
    if (!version) {
      await failRun(db, run, workspaceId, 'The workflow version disappeared.')
      return
    }
    const definition = parseWorkflowDefinition(version.definitionJson)
    const plan = JSON.parse(run.planJson ?? '{}') as RunPlan
    const state = parseState(run.stateJson, plan.entryStepId)
    const pkg = JSON.parse(run.contextJson ?? 'null') as ContextPackage | null
    if (!pkg) {
      await failRun(db, run, workspaceId, 'The run context snapshot is missing.')
      return
    }

    /* Terminal: map the run output and finish. */
    if (state.nextStepId === null) {
      const outputs = await loadStepOutputs(db, runId)
      let output: JsonValue = null
      if (definition.output) {
        const from = outputs[definition.output.stepId]
        output = definition.output.path
          ? (getPathValue(from, definition.output.path) ?? null)
          : (from ?? null)
      }
      await updateWorkflowRun(db, runId, {
        status: 'succeeded',
        outputJson: boundedSnapshot(output, WORKFLOW_LIMITS.maxRunOutputChars),
        finishedAt: nowIso(),
      })
      await workflowEvent(db, run, workspaceId, 'workflow.run_completed', {
        steps: state.counts,
      })
      return
    }

    const step = definition.steps.find((candidate) => candidate.id === state.nextStepId)
    if (!step) {
      await failRun(db, run, workspaceId, `Unknown step '${state.nextStepId}'.`)
      return
    }

    /* Centralized limits, checked before every step. */
    if (state.counts.steps >= plan.limits.maxStepExecutions) {
      await failRun(db, run, workspaceId, 'This run reached its step limit.')
      return
    }
    if (now() - state.startedAtMs > plan.limits.maxRunDurationMs) {
      await failRun(db, run, workspaceId, 'This run ran out of time.')
      return
    }
    const visits = state.visits[step.id] ?? 0
    const maxVisits = stepMaxVisits(step, plan.limits.maxVisitsPerStep)
    if (maxVisits !== null && visits >= maxVisits) {
      await failRun(
        db,
        run,
        workspaceId,
        `Step '${step.id}' reached its visit limit (${maxVisits}). Loops are bounded.`,
      )
      return
    }

    /* An interrupted attempt from a crashed drive: record it, then run a
       NEW attempt (the old one never completed). Completed steps are never
       re-executed — state.nextStepId already points past them. */
    const priorRuns = await listWorkflowStepRuns(db, runId)
    const stale = priorRuns.find((s) => s.stepKey === step.id && s.status === 'running')
    if (stale) {
      await finishWorkflowStepRun(db, stale.id, {
        status: 'failed',
        error: 'Interrupted before completion.',
      })
    }
    const attempt = priorRuns.filter((s) => s.stepKey === step.id).length + 1

    const scope = await buildBindingScope(db, run)

    const stepRun = await createWorkflowStepRun(db, {
      workflowRunId: runId,
      stepKey: step.id,
      stepType: step.type,
      attempt,
      agentVersionId: plan.agents[step.id]?.agentVersionId ?? null,
      inputJson:
        step.type === 'agent' || step.type === 'tool'
          ? boundedSnapshot(
              resolveBindings(step.inputs, scope),
              WORKFLOW_LIMITS.maxStepSnapshotChars,
            )
          : null,
    })
    await workflowEvent(db, run, workspaceId, 'workflow.step_started', {
      stepId: step.id,
      stepType: step.type,
      attempt,
    })

    const outcome = await executeStep(
      db,
      workspaceId,
      runId,
      plan,
      pkg,
      scope,
      step,
      attempt,
      deps,
      currentOptions,
    )

    /* Waiting: an approval-gated tool paused the run (§47/§48). */
    if ('kind' in outcome && outcome.kind === 'waiting') {
      currentOptions = undefined
      await finishWorkflowStepRun(db, stepRun.id, {
        status: 'waiting',
        error: outcome.message,
        toolExecutionId: outcome.toolExecutionId,
      })
      const waitingState: EngineState = {
        ...state,
        waitingApprovalId: outcome.approvalRequestId ?? null,
      }
      await updateWorkflowRun(db, runId, {
        status: 'waiting',
        stateJson: JSON.stringify(waitingState),
      })
      await workflowEvent(db, run, workspaceId, 'workflow.waiting_for_approval', {
        stepId: step.id,
        approvalRequestId: outcome.approvalRequestId ?? null,
        message: outcome.message,
      })
      return
    }

    /* Failure: bounded retry, explicit fallback, or fail the run. */
    if ('kind' in outcome) {
      const retry = step.type === 'agent' || step.type === 'tool' ? step.retry : undefined
      const maxAttempts = retry?.maxAttempts ?? 1
      const canRetry = outcome.kind === 'retryable' && attempt < maxAttempts
      await finishWorkflowStepRun(db, stepRun.id, { status: 'failed', error: outcome.message })
      await workflowEvent(db, run, workspaceId, 'workflow.step_failed', {
        stepId: step.id,
        attempt,
        retryable: outcome.kind === 'retryable',
        willRetry: canRetry,
        message: outcome.message,
      })
      if (canRetry) {
        // nextStepId stays the same; the loop re-executes as attempt+1, reusing currentOptions.
        continue
      }
      currentOptions = undefined
      const onFailure = 'onFailure' in step ? step.onFailure : undefined
      if (onFailure?.action === 'goto') {
        state.nextStepId = onFailure.stepId
        state.counts.steps += 1
        await updateWorkflowRun(db, runId, { stateJson: JSON.stringify(state) })
        continue
      }
      await failRun(db, run, workspaceId, outcome.message)
      return
    }

    /* Success. */
    currentOptions = undefined
    await finishWorkflowStepRun(db, stepRun.id, {
      status: 'succeeded',
      outputJson: boundedSnapshot(outcome.output, WORKFLOW_LIMITS.maxStepSnapshotChars),
      decisionJson: outcome.decision ? JSON.stringify(outcome.decision) : null,
      toolExecutionId: outcome.toolExecutionId ?? null,
    })
    await workflowEvent(db, run, workspaceId, 'workflow.step_completed', {
      stepId: step.id,
      stepType: step.type,
      attempt,
      next: outcome.next,
    })

    state.visits[step.id] = visits + 1
    state.counts.steps += 1
    if (step.type === 'agent') state.counts.agents += 1
    if (step.type === 'tool') state.counts.tools += 1
    state.nextStepId = outcome.next
    await updateWorkflowRun(db, runId, { stateJson: JSON.stringify(state) })
  }
}

function stepMaxVisits(step: WorkflowStepDef, runLimit: number): number | null {
  if (step.type === 'end') return 1
  if (step.maxVisits === null) return null // validation rejects this inside cycles
  return Math.min(step.maxVisits ?? runLimit, runLimit)
}

async function failRun(
  db: SqlDatabase,
  run: { id: string; workflowId: string; workflowVersionId: string },
  workspaceId: string,
  message: string,
): Promise<void> {
  await updateWorkflowRun(db, run.id, { status: 'failed', error: message, finishedAt: nowIso() })
  await workflowEvent(db, run, workspaceId, 'workflow.run_failed', { message })
}

/* ---- resume & cancel ---- */

/**
 * Resume a queued/running/waiting run. Completed steps NEVER re-execute:
 * the persisted state's nextStepId already points past them. A step left
 * 'running' by an interrupted drive is recorded as failed and re-executed
 * as a new attempt.
 */
export async function resumeWorkflowRun(
  db: SqlDatabase,
  runId: string,
  deps: WorkflowEngineDeps,
): Promise<{ ok: boolean; message?: string }> {
  const run = await getWorkflowRunById(db, runId)
  if (!run) return { ok: false, message: 'That run could not be found.' }
  if (run.status === 'waiting' || run.status === 'queued') {
    await updateWorkflowRun(db, runId, { status: 'running' })
  } else if (run.status !== 'running') {
    return { ok: false, message: `This run is ${run.status}; it cannot be resumed.` }
  }
  await driveRun(db, runId, deps)
  return { ok: true }
}

/**
 * Resumes a waiting workflow run after an Approval Request has been decided.
 *
 * Verifications:
 * 1. Request status must be 'approved' and not expired.
 * 2. If 'rejected', 'cancelled', or 'expired': resolves the waiting workflow safely.
 * 3. Validates snapshot integrity.
 * 4. Verifies linked workflow run is in 'waiting' state.
 * 5. Re-evaluates snapshot fingerprint against current step inputs (mismatch prevention).
 * 6. Re-verifies Agent status, Tool status, and capability grant.
 * 7. Completed steps NEVER re-execute.
 * 8. Resumes execution via driveRun with authorized approval.
 */
export async function resumeWorkflowAfterApproval(
  db: SqlDatabase,
  approvalRequestId: string,
  deps: WorkflowEngineDeps,
): Promise<{ ok: boolean; code?: string; message?: string }> {
  const request = await getApprovalWithExpiryCheck(db, { id: approvalRequestId })
  if (!request) {
    return { ok: false, message: 'Approval request not found.' }
  }

  // Find linked run
  if (!request.runId) {
    return { ok: false, message: 'Approval request is not linked to any workflow run.' }
  }

  const run = await getWorkflowRunById(db, request.runId)
  if (!run) {
    return { ok: false, message: 'Linked workflow run could not be found.' }
  }

  const workflow = await getWorkflowById(db, run.workflowId)
  const workspaceId = workflow?.workspaceId
  if (!workflow || !workspaceId) {
    return { ok: false, message: 'The workflow disappeared.' }
  }

  // Handle terminal/non-approved request states
  if (request.status === 'rejected') {
    if (run.status === 'waiting') {
      const stepRuns = await listWorkflowStepRuns(db, run.id)
      const waitingStep = stepRuns.find(
        (s) => s.status === 'waiting' && s.stepKey === request.stepId,
      )
      if (waitingStep) {
        await finishWorkflowStepRun(db, waitingStep.id, {
          status: 'failed',
          error: 'Approval was rejected.',
          decisionJson: JSON.stringify({ decision: 'rejected' }),
        })
      }
      await updateWorkflowRun(db, run.id, {
        status: 'failed',
        error: 'Approval was rejected.',
        finishedAt: nowIso(),
      })
      await workflowEvent(db, run, workspaceId, 'workflow.approval_rejected', {
        approvalRequestId: request.id,
        stepId: request.stepId,
        decisionNote: request.decisionNote,
      })
    }
    return { ok: false, code: 'approval_rejected', message: 'Approval request was rejected.' }
  }

  if (request.status === 'cancelled') {
    if (run.status === 'waiting') {
      const stepRuns = await listWorkflowStepRuns(db, run.id)
      const waitingStep = stepRuns.find(
        (s) => s.status === 'waiting' && s.stepKey === request.stepId,
      )
      if (waitingStep) {
        await finishWorkflowStepRun(db, waitingStep.id, {
          status: 'cancelled',
          error: 'Approval request was cancelled.',
        })
      }
      await updateWorkflowRun(db, run.id, {
        status: 'cancelled',
        finishedAt: nowIso(),
      })
      await workflowEvent(db, run, workspaceId, 'workflow.run_cancelled', {
        approvalRequestId: request.id,
        stepId: request.stepId,
      })
    }
    return { ok: false, code: 'approval_cancelled', message: 'Approval request was cancelled.' }
  }

  if (request.status === 'expired') {
    if (run.status === 'waiting') {
      const stepRuns = await listWorkflowStepRuns(db, run.id)
      const waitingStep = stepRuns.find(
        (s) => s.status === 'waiting' && s.stepKey === request.stepId,
      )
      if (waitingStep) {
        await finishWorkflowStepRun(db, waitingStep.id, {
          status: 'failed',
          error: 'Approval request expired.',
          decisionJson: JSON.stringify({ decision: 'expired' }),
        })
      }
      await updateWorkflowRun(db, run.id, {
        status: 'failed',
        error: 'Approval request expired.',
        finishedAt: nowIso(),
      })
      await workflowEvent(db, run, workspaceId, 'workflow.approval_expired', {
        approvalRequestId: request.id,
        stepId: request.stepId,
      })
    }
    return { ok: false, code: 'approval_expired', message: 'Approval request expired.' }
  }

  if (request.status === 'pending') {
    return { ok: false, message: 'Approval request is still pending.' }
  }

  if (request.status !== 'approved') {
    return { ok: false, message: `Approval request is ${request.status}.` }
  }

  if (!request.stepId) {
    return { ok: false, message: 'Approval request is missing step identifier.' }
  }

  // Request is approved!
  // Verify snapshot integrity
  const isIntact = verifySnapshotIntegrity(
    request.actionKey,
    request.snapshotJson,
    request.fingerprint,
  )
  if (!isIntact) {
    return {
      ok: false,
      code: 'integrity_violation',
      message: 'Approval request snapshot integrity violation.',
    }
  }

  // Idempotency: if run is already succeeded, return ok
  if (run.status === 'succeeded') {
    return { ok: true, message: 'Workflow run is already completed.' }
  }
  if (run.status === 'failed') {
    return { ok: false, message: 'Workflow run has failed.' }
  }
  if (run.status === 'cancelled') {
    return { ok: false, message: 'Workflow run was cancelled and cannot be resumed.' }
  }
  if (run.status !== 'waiting' && run.status !== 'running') {
    return { ok: false, message: `Workflow run is ${run.status}; cannot resume.` }
  }

  // Check waiting step matching
  const plan = JSON.parse(run.planJson ?? '{}') as RunPlan
  const state = parseState(run.stateJson, plan.entryStepId)
  if (state.nextStepId !== request.stepId) {
    // If the step already completed (e.g. concurrent/duplicate resume call)
    const stepRuns = await listWorkflowStepRuns(db, run.id)
    const stepCompleted = stepRuns.some(
      (s) => s.stepKey === request.stepId && s.status === 'succeeded',
    )
    if (stepCompleted) {
      return { ok: true, message: 'Step already completed.' }
    }
    return { ok: false, message: 'Waiting step does not match approval request.' }
  }

  // Re-verify snapshot matching: reconstruct inputs and check fingerprint
  const version = await getWorkflowVersion(db, run.workflowVersionId)
  if (!version) {
    return { ok: false, message: 'Workflow version disappeared.' }
  }
  const definition = parseWorkflowDefinition(version.definitionJson)
  const step = definition.steps.find((s) => s.id === request.stepId)
  if (step?.type !== 'tool') {
    return { ok: false, message: 'Waiting step is not a valid tool step.' }
  }

  const scope = await buildBindingScope(db, run)
  const currentArgs = resolveBindings(step.inputs, scope)
  const toolDefinition = (deps.tools?.definitions ?? []).find((d) => d.key === step.toolKey) ?? null
  const actionKey = resolveActionKeyForTool(step.toolKey, toolDefinition)
  const { snapshotJson } = createSafeActionSnapshot({
    toolKey: step.toolKey,
    args: currentArgs,
    stepId: step.id,
  })
  const currentFingerprint = computeSnapshotFingerprint(actionKey, snapshotJson)
  if (currentFingerprint !== request.fingerprint) {
    const stepRuns = await listWorkflowStepRuns(db, run.id)
    const waitingStep = stepRuns.find((s) => s.status === 'waiting' && s.stepKey === request.stepId)
    if (waitingStep) {
      await finishWorkflowStepRun(db, waitingStep.id, {
        status: 'failed',
        error: `Action parameters changed since approval: snapshot mismatch (expected ${request.fingerprint}, got ${currentFingerprint}).`,
      })
    }
    await updateWorkflowRun(db, run.id, {
      status: 'failed',
      error: `Step "${step.id}" inputs changed after approval: snapshot mismatch.`,
      finishedAt: nowIso(),
    })
    await workflowEvent(db, run, workspaceId, 'workflow.step_failed', {
      stepId: step.id,
      code: 'approval_snapshot_mismatch',
    })
    return {
      ok: false,
      code: 'approval_snapshot_mismatch',
      message: 'Action parameters changed since approval: snapshot mismatch.',
    }
  }

  // Re-verify Agent and Tool capabilities and status
  const agentHandle = plan.agents[step.id]
  if (agentHandle) {
    const agent = await getAgentById(db, agentHandle.agentId)
    if (!agent || agent.status === 'disabled' || agent.workspaceId !== workspaceId) {
      await updateWorkflowRun(db, run.id, {
        status: 'failed',
        error: `Agent '${agentHandle.agentId}' is disabled or unavailable.`,
        finishedAt: nowIso(),
      })
      return { ok: false, message: 'Agent is disabled or unavailable.' }
    }
  }

  // Update run status to running
  await updateWorkflowRun(db, run.id, { status: 'running' })
  await workflowEvent(db, run, workspaceId, 'workflow.resumed_after_approval', {
    approvalRequestId: request.id,
    stepId: request.stepId,
  })

  // Drive the run forward with authorized approval
  await driveRun(db, run.id, deps, {
    authorizedApproval: {
      approvalRequestId: request.id,
      stepId: request.stepId,
      fingerprint: request.fingerprint,
    },
  })

  return { ok: true }
}

/** Cancellation prevents future steps; completed history stays intact. */
export async function cancelWorkflowRun(
  db: SqlDatabase,
  runId: string,
): Promise<{ ok: boolean; message?: string }> {
  const run = await getWorkflowRunById(db, runId)
  if (!run) return { ok: false, message: 'That run could not be found.' }
  if (run.status !== 'queued' && run.status !== 'running' && run.status !== 'waiting') {
    return { ok: false, message: `This run is already ${run.status}.` }
  }
  const stepRuns = await listWorkflowStepRuns(db, runId)
  for (const stepRun of stepRuns) {
    if (stepRun.status === 'running' || stepRun.status === 'waiting') {
      await finishWorkflowStepRun(db, stepRun.id, { status: 'cancelled', error: 'Run cancelled.' })
    }
  }
  await updateWorkflowRun(db, runId, { status: 'cancelled', finishedAt: nowIso() })

  // Cancel any pending approval requests linked to this run
  const pendingApprovals = await queryAll<{ id: string; workspace_id: string }>(
    db,
    `SELECT id, workspace_id FROM approval WHERE run_id = ? AND status = 'pending'`,
    [runId],
  )
  for (const pa of pendingApprovals) {
    await updateApprovalDecision(db, {
      id: pa.id,
      workspaceId: pa.workspace_id,
      status: 'cancelled',
      decision: 'cancelled',
      decidedByType: 'system',
      decidedById: null,
      decisionNote: 'Workflow run was cancelled.',
      decidedAt: nowIso(),
    })
    await emitEventSafe(db, {
      workspaceId: pa.workspace_id,
      eventType: 'approval.cancelled',
      actorType: 'system',
      subjectType: 'approval',
      subjectId: pa.id,
      payloadJson: JSON.stringify({ reason: 'Workflow run was cancelled.' }),
    })
  }

  const workflow = await getWorkflowById(db, run.workflowId)
  if (workflow) {
    await workflowEvent(db, run, workflow.workspaceId, 'workflow.run_cancelled', {})
  }
  return { ok: true }
}

/* ---- helpers ---- */

async function loadStepOutputs(db: SqlDatabase, runId: string): Promise<Record<string, JsonValue>> {
  const stepRuns = await listWorkflowStepRuns(db, runId)
  const outputs: Record<string, JsonValue> = {}
  for (const stepRun of stepRuns) {
    if (stepRun.status === 'succeeded' && stepRun.outputJson) {
      try {
        outputs[stepRun.stepKey] = JSON.parse(stepRun.outputJson) as JsonValue
      } catch {
        // skip unparseable output; bindings resolve to undefined
      }
    }
  }
  return outputs
}

async function buildBindingScope(
  db: SqlDatabase,
  run: {
    id: string
    workflowId: string
    workflowVersionId: string
    inputJson: string | null
  },
): Promise<BindingScope> {
  let workflowInputs: Record<string, JsonValue> = {}
  if (run.inputJson) {
    try {
      workflowInputs = JSON.parse(run.inputJson) as Record<string, JsonValue>
    } catch {
      workflowInputs = {}
    }
  }
  return {
    workflowInputs,
    stepOutputs: await loadStepOutputs(db, run.id),
    run: { runId: run.id, workflowId: run.workflowId, workflowVersionId: run.workflowVersionId },
  }
}
