import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { ensureBuiltinAgents } from '~/server/agents/registry'
import { resolveAiRuntime } from '~/server/ai/runtime'
import { listAccounts } from '~/server/db/account'
import { listAgents, listAgentVersions } from '~/server/db/agent'
import { listBrands } from '~/server/db/brand'
import { getDb } from '~/server/db/client'
import { listProducts } from '~/server/db/product'
import {
  getWorkflowById,
  getWorkflowRunById,
  getWorkflowVersion,
  listWorkflowRuns,
  listWorkflowStepRuns,
  listWorkflows,
  listWorkflowVersions,
  createWorkflow as repoCreateWorkflow,
} from '~/server/db/workflow'
import { getDefaultWorkspace } from '~/server/db/workspace'
import { listToolDescriptors } from '~/server/tools'
import type { WorkflowDefinition } from '~/server/workflows'
import {
  cancelWorkflowRun,
  changeWorkflowStatus,
  checkWorkflowDefinition,
  definitionOf,
  resolveWorkflowRuntime,
  resumeWorkflowRun,
  saveWorkflowVersion,
  startWorkflowRun,
  updateWorkflowDetails,
} from '~/server/workflows'
import type { Workflow, WorkflowRun, WorkflowStepRun } from '~/types/domain'

/**
 * Server functions for the Workflows UI. The client never passes a
 * workspace id; the default workspace is resolved server-side and every
 * workflow/run access is checked against it. Definitions arrive as plain
 * JSON DATA and are validated server-side before anything is stored; the
 * client can never inject executable behavior.
 */

/** JSON-safe value for server-function payloads (serialization-checked). */
export type JsonData = string | number | boolean | null | JsonData[] | { [k: string]: JsonData }

const idWire = z.object({ id: z.uuid() })

const createWorkflowWire = z.object({
  name: z.string().trim().min(1, 'Give the workflow a name.').max(80),
  description: z.string().trim().max(280).optional(),
})

const saveDefinitionWire = z.object({
  workflowId: z.uuid(),
  /** Plain JSON data. Validated against workflowDefinitionSchema server-side. */
  definition: z.unknown(),
  changeNote: z.string().trim().max(200).optional(),
})

const updateDetailsWire = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(280).nullable().optional(),
})

const setStatusWire = z.object({
  id: z.uuid(),
  status: z.enum(['active', 'disabled', 'archived']),
})

const startRunWire = z.object({
  workflowId: z.uuid(),
  inputs: z.record(z.string(), z.unknown()).default({}),
})

const runIdWire = z.object({ runId: z.uuid() })

/* ---- list ---- */

export interface WorkflowListItem {
  id: string
  name: string
  purpose: string | null
  status: Workflow['status']
  currentVersion: number | null
  lastRun: { id: string; status: WorkflowRun['status']; createdAt: string } | null
}

export const getWorkflowsData = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ workflows: WorkflowListItem[] }> => {
    const db = getDb()
    const workspace = await getDefaultWorkspace()
    if (!workspace) throw new Error('No workspace exists yet.')
    const workflows = await listWorkflows(db, workspace.id)
    const items: WorkflowListItem[] = []
    for (const workflow of workflows) {
      let currentVersion: number | null = null
      if (workflow.currentVersionId) {
        const version = await getWorkflowVersion(db, workflow.currentVersionId)
        currentVersion = version?.version ?? null
      }
      const [lastRun] = await listWorkflowRuns(db, workflow.id, 1)
      items.push({
        id: workflow.id,
        name: workflow.name,
        purpose: workflow.description,
        status: workflow.status,
        currentVersion,
        lastRun: lastRun
          ? { id: lastRun.id, status: lastRun.status, createdAt: lastRun.createdAt }
          : null,
      })
    }
    return { workflows: items }
  },
)

/* ---- detail ---- */

export interface AgentOption {
  id: string
  name: string
  status: 'active' | 'disabled' | 'archived'
  versions: { id: string; version: number }[]
}

export interface ToolOption {
  key: string
  name: string
  status: string
}

export interface EntityOption {
  id: string
  name: string
}

export interface WorkflowDetailData {
  workflow: {
    id: string
    name: string
    purpose: string | null
    status: Workflow['status']
    currentVersionId: string | null
  }
  /** Parsed current definition for the editor/summary. Safe data only. */
  definition: WorkflowDefinition | null
  versions: {
    id: string
    version: number
    changeNote: string | null
    createdAt: string
    isCurrent: boolean
    stepCount: number
  }[]
  runs: {
    id: string
    status: WorkflowRun['status']
    createdAt: string
    finishedAt: string | null
    error: string | null
    version: number
  }[]
  agents: AgentOption[]
  tools: ToolOption[]
  entities: {
    brands: EntityOption[]
    products: (EntityOption & { brandId: string })[]
    accounts: EntityOption[]
  }
}

export const getWorkflowDetailData = createServerFn({ method: 'GET' })
  .inputValidator(idWire)
  .handler(async ({ data }): Promise<WorkflowDetailData | null> => {
    const db = getDb()
    const workspace = await getDefaultWorkspace()
    if (!workspace) throw new Error('No workspace exists yet.')
    const workflow = await getWorkflowById(db, data.id)
    if (!workflow || workflow.workspaceId !== workspace.id || workflow.deletedAt) return null

    const versions = await listWorkflowVersions(db, workflow.id)
    const current = workflow.currentVersionId
      ? await getWorkflowVersion(db, workflow.currentVersionId)
      : null
    let definition: WorkflowDefinition | null = null
    if (current) {
      try {
        definition = definitionOf(current.definitionJson)
      } catch {
        definition = null
      }
    }

    const runs = await listWorkflowRuns(db, workflow.id, 20)
    const runItems = []
    for (const run of runs) {
      const version = await getWorkflowVersion(db, run.workflowVersionId)
      runItems.push({
        id: run.id,
        status: run.status,
        createdAt: run.createdAt,
        finishedAt: run.finishedAt,
        error: run.error,
        version: version?.version ?? 0,
      })
    }

    // Agents (for editor dropdowns). Provisioning built-ins is idempotent.
    await ensureBuiltinAgents(db, workspace.id)
    const agentRows = await listAgents(db, workspace.id)
    const agents: AgentOption[] = []
    for (const agent of agentRows) {
      if (agent.status === 'archived') continue
      const versions = await listAgentVersions(db, agent.id)
      agents.push({
        id: agent.id,
        name: agent.name,
        status: agent.status,
        versions: versions.map((v) => ({ id: v.id, version: v.version })),
      })
    }

    const tools = listToolDescriptors().map((tool) => ({
      key: tool.key,
      name: tool.name,
      status: tool.status,
    }))

    const [brands, products, accounts] = await Promise.all([
      listBrands(workspace.id),
      listProducts(workspace.id),
      listAccounts(workspace.id),
    ])

    return {
      workflow: {
        id: workflow.id,
        name: workflow.name,
        purpose: workflow.description,
        status: workflow.status,
        currentVersionId: workflow.currentVersionId,
      },
      definition,
      versions: versions.map((v) => ({
        id: v.id,
        version: v.version,
        changeNote: v.changeNote,
        createdAt: v.createdAt,
        isCurrent: v.id === workflow.currentVersionId,
        stepCount: safeStepCount(v.definitionJson),
      })),
      runs: runItems,
      agents,
      tools,
      entities: {
        brands: brands.map((b) => ({ id: b.id, name: b.name })),
        products: products.map((p) => ({ id: p.id, name: p.name, brandId: p.brandId })),
        accounts: accounts.map((a) => ({ id: a.id, name: a.displayName ?? a.handle })),
      },
    }
  })

function safeStepCount(definitionJson: string): number {
  try {
    return definitionOf(definitionJson).steps.length
  } catch {
    return 0
  }
}

/* ---- mutations ---- */

export const createWorkflowShell = createServerFn({ method: 'POST' })
  .inputValidator(createWorkflowWire)
  .handler(async ({ data }): Promise<{ ok: true; id: string } | { ok: false; message: string }> => {
    const db = getDb()
    const workspace = await getDefaultWorkspace()
    if (!workspace) throw new Error('No workspace exists yet.')
    const workflow = await repoCreateWorkflow(db, {
      workspaceId: workspace.id,
      name: data.name,
      description: data.description ?? null,
    })
    return { ok: true, id: workflow.id }
  })

export const saveWorkflowDefinition = createServerFn({ method: 'POST' })
  .inputValidator(saveDefinitionWire)
  .handler(async ({ data }) => {
    const db = getDb()
    const workspace = await getDefaultWorkspace()
    if (!workspace) throw new Error('No workspace exists yet.')
    return saveWorkflowVersion(db, {
      workspaceId: workspace.id,
      workflowId: data.workflowId,
      definition: data.definition,
      changeNote: data.changeNote ?? null,
    })
  })

export const updateWorkflow = createServerFn({ method: 'POST' })
  .inputValidator(updateDetailsWire)
  .handler(async ({ data }) => {
    const db = getDb()
    const workspace = await getDefaultWorkspace()
    if (!workspace) throw new Error('No workspace exists yet.')
    return updateWorkflowDetails(db, {
      workspaceId: workspace.id,
      workflowId: data.id,
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.description !== undefined ? { description: data.description } : {}),
    })
  })

export const setWorkflowStatusFn = createServerFn({ method: 'POST' })
  .inputValidator(setStatusWire)
  .handler(async ({ data }) => {
    const db = getDb()
    const workspace = await getDefaultWorkspace()
    if (!workspace) throw new Error('No workspace exists yet.')
    return changeWorkflowStatus(db, {
      workspaceId: workspace.id,
      workflowId: data.id,
      status: data.status,
    })
  })

/* ---- runs ---- */

export const startWorkflowRunFn = createServerFn({ method: 'POST' })
  .inputValidator(startRunWire)
  .handler(async ({ data }) => {
    const db = getDb()
    const workspace = await getDefaultWorkspace()
    if (!workspace) throw new Error('No workspace exists yet.')
    const { deps } = resolveAiRuntime()
    const engineDeps = { ai: deps }
    // The runtime adapter decides HOW the run is driven (inline today);
    // the engine semantics are identical either way.
    const started = await startWorkflowRun({
      db,
      workspaceId: workspace.id,
      workflowId: data.workflowId,
      inputs: data.inputs,
      deps: engineDeps,
      drive: false,
    })
    if (!started.ok) return started
    await resolveWorkflowRuntime().drive(db, started.runId, engineDeps)
    return started
  })

export const resumeWorkflowRunFn = createServerFn({ method: 'POST' })
  .inputValidator(runIdWire)
  .handler(async ({ data }) => {
    const db = getDb()
    const workspace = await getDefaultWorkspace()
    if (!workspace) throw new Error('No workspace exists yet.')
    const run = await getWorkflowRunById(db, data.runId)
    if (!run) return { ok: false as const, message: 'That run could not be found.' }
    const workflow = await getWorkflowById(db, run.workflowId)
    if (!workflow || workflow.workspaceId !== workspace.id) {
      return { ok: false as const, message: 'That run could not be found.' }
    }
    const { deps } = resolveAiRuntime()
    return resumeWorkflowRun(db, data.runId, { ai: deps })
  })

export const cancelWorkflowRunFn = createServerFn({ method: 'POST' })
  .inputValidator(runIdWire)
  .handler(async ({ data }) => {
    const db = getDb()
    const workspace = await getDefaultWorkspace()
    if (!workspace) throw new Error('No workspace exists yet.')
    const run = await getWorkflowRunById(db, data.runId)
    if (!run) return { ok: false as const, message: 'That run could not be found.' }
    const workflow = await getWorkflowById(db, run.workflowId)
    if (!workflow || workflow.workspaceId !== workspace.id) {
      return { ok: false as const, message: 'That run could not be found.' }
    }
    return cancelWorkflowRun(db, data.runId)
  })

/* ---- run detail ---- */

export interface RunStepItem {
  id: string
  stepKey: string
  stepType: WorkflowStepRun['stepType']
  status: WorkflowStepRun['status']
  attempt: number
  summary: string
  agentName: string | null
  toolKey: string | null
  error: string | null
  startedAt: string | null
  finishedAt: string | null
  /** Dev trace only (import.meta.env.DEV). */
  input?: JsonData
  output?: JsonData
  decision?: JsonData
}

export interface RunDetailData {
  run: {
    id: string
    status: WorkflowRun['status']
    triggerType: WorkflowRun['triggerType']
    createdAt: string
    startedAt: string | null
    finishedAt: string | null
    error: string | null
    output: JsonData
  }
  workflow: { id: string; name: string }
  version: number
  scope: { type: string; label: string } | null
  steps: RunStepItem[]
  /** Dev-only detailed trace. Never secrets. */
  devTrace: JsonData
}

export const getRunDetailData = createServerFn({ method: 'GET' })
  .inputValidator(runIdWire)
  .handler(async ({ data }): Promise<RunDetailData | null> => {
    const db = getDb()
    const workspace = await getDefaultWorkspace()
    if (!workspace) throw new Error('No workspace exists yet.')
    const run = await getWorkflowRunById(db, data.runId)
    if (!run) return null
    const workflow = await getWorkflowById(db, run.workflowId)
    if (!workflow || workflow.workspaceId !== workspace.id) return null
    const version = await getWorkflowVersion(db, run.workflowVersionId)

    const stepRuns = await listWorkflowStepRuns(db, run.id)
    const steps: RunStepItem[] = stepRuns.map((stepRun) => summarizeStep(stepRun))

    let scope: RunDetailData['scope'] = null
    let devTrace: JsonData = null
    if (run.contextJson) {
      try {
        const pkg = JSON.parse(run.contextJson) as {
          activeScope?: { type: string }
          product?: { name: string } | null
          brand?: { name: string } | null
          account?: { handle: string } | null
        }
        const label =
          pkg.product?.name ?? pkg.brand?.name ?? pkg.account?.handle ?? 'Entire workspace'
        scope = { type: pkg.activeScope?.type ?? 'workspace', label }
      } catch {
        scope = null
      }
    }

    if (import.meta.env.DEV) {
      devTrace = {
        runId: run.id,
        workflowVersionId: run.workflowVersionId,
        input: safeParse(run.inputJson),
        plan: safeParse(run.planJson),
        state: safeParse(run.stateJson),
        context: safeParse(run.contextJson),
        steps: stepRuns.map((s) => ({
          id: s.id,
          stepKey: s.stepKey,
          stepType: s.stepType,
          status: s.status,
          attempt: s.attempt,
          agentVersionId: s.agentVersionId,
          toolExecutionId: s.toolExecutionId,
          input: safeParse(s.inputJson),
          output: safeParse(s.outputJson),
          decision: safeParse(s.decisionJson),
          error: s.error,
          startedAt: s.startedAt,
          finishedAt: s.finishedAt,
        })),
      }
    }

    return {
      run: {
        id: run.id,
        status: run.status,
        triggerType: run.triggerType,
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        error: run.error,
        output: safeParse(run.outputJson),
      },
      workflow: { id: workflow.id, name: workflow.name },
      version: version?.version ?? 0,
      scope,
      steps,
      devTrace,
    }
  })

function safeParse(json: string | null): JsonData {
  if (!json) return null
  try {
    return JSON.parse(json) as JsonData
  } catch {
    return null
  }
}

/** Loosely-typed step output for summary rendering. */
interface StepOutputShape {
  kind?: unknown
  agentName?: unknown
  content?: unknown
  toolKey?: unknown
  result?: unknown
}

/** Human step summary for the run detail page; no raw JSON in normal UI. */
function summarizeStep(stepRun: WorkflowStepRun): RunStepItem {
  let summary = ''
  let agentName: string | null = null
  let toolKey: string | null = null
  const outputJson = safeParse(stepRun.outputJson)
  const output =
    outputJson !== null && typeof outputJson === 'object' && !Array.isArray(outputJson)
      ? (outputJson as StepOutputShape)
      : null
  if (output) {
    if (output.kind === 'agent') {
      agentName = typeof output.agentName === 'string' ? output.agentName : null
      const content = typeof output.content === 'string' ? output.content : ''
      summary = content.length > 180 ? `${content.slice(0, 180)}…` : content
    } else if (output.kind === 'tool') {
      toolKey = typeof output.toolKey === 'string' ? output.toolKey : null
      summary = toolKey ? `Used ${toolKey}.` : 'Tool step completed.'
    } else if (output.kind === 'condition') {
      summary = output.result === true ? 'Condition matched: yes.' : 'Condition matched: no.'
    } else if (output.kind === 'end') {
      summary = 'Workflow finished.'
    }
  }
  const base: RunStepItem = {
    id: stepRun.id,
    stepKey: stepRun.stepKey,
    stepType: stepRun.stepType,
    status: stepRun.status,
    attempt: stepRun.attempt,
    summary,
    agentName,
    toolKey,
    error: stepRun.error,
    startedAt: stepRun.startedAt,
    finishedAt: stepRun.finishedAt,
  }
  if (import.meta.env.DEV) {
    base.input = safeParse(stepRun.inputJson)
    base.output = outputJson
    base.decision = safeParse(stepRun.decisionJson)
  }
  return base
}

/* ---- editor validation preview ---- */

const checkDefinitionWire = z.object({ definition: z.unknown() })

export const checkWorkflowDefinitionFn = createServerFn({ method: 'POST' })
  .inputValidator(checkDefinitionWire)
  .handler(async ({ data }) => {
    const db = getDb()
    const workspace = await getDefaultWorkspace()
    if (!workspace) throw new Error('No workspace exists yet.')
    return checkWorkflowDefinition(db, workspace.id, data.definition)
  })
