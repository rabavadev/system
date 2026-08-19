import { z } from 'zod'

import type {
  Workflow,
  WorkflowRun,
  WorkflowStatus,
  WorkflowStepRun,
  WorkflowVersion,
} from '~/types/domain'

import { execute, newId, nowIso, queryAll, queryFirst, type SqlDatabase } from './sql.ts'

/**
 * Workflow / workflow_version / workflow_run / workflow_step_run
 * repository. Structural SqlDatabase (no cloudflare:workers import) so it
 * runs in plain node tests.
 *
 * Versioning doctrine (docs/database.md): workflow is a mutable shell
 * holding current_version_id; workflow_version rows are immutable snapshots
 * keyed UNIQUE(workflow_id, version). Editing a definition appends version
 * N+1 and never mutates a row a run already references. Rollback means
 * "create a new version copied from an old one".
 *
 * Runs and step runs are history: they are never deleted and never
 * rewritten once finished, so "what exactly happened" stays answerable.
 */

interface WorkflowRow {
  id: string
  workspace_id: string
  name: string
  description: string | null
  status: WorkflowStatus
  current_version_id: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

interface WorkflowVersionRow {
  id: string
  workflow_id: string
  version: number
  definition: string
  change_note: string | null
  created_at: string
}

interface WorkflowRunRow {
  id: string
  workflow_id: string
  workflow_version_id: string
  status: WorkflowRun['status']
  trigger_type: WorkflowRun['triggerType']
  input: string | null
  output: string | null
  error: string | null
  context_json: string | null
  plan_json: string | null
  state_json: string | null
  started_at: string | null
  finished_at: string | null
  created_at: string
  updated_at: string
}

interface WorkflowStepRunRow {
  id: string
  workflow_run_id: string
  step_key: string
  step_type: WorkflowStepRun['stepType']
  status: WorkflowStepRun['status']
  attempt: number
  agent_version_id: string | null
  tool_execution_id: string | null
  input: string | null
  output: string | null
  error: string | null
  decision: string | null
  started_at: string | null
  finished_at: string | null
  created_at: string
}

function toWorkflow(row: WorkflowRow): Workflow {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description,
    status: row.status,
    currentVersionId: row.current_version_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }
}

function toWorkflowVersion(row: WorkflowVersionRow): WorkflowVersion {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    version: row.version,
    definitionJson: row.definition,
    changeNote: row.change_note,
    createdAt: row.created_at,
  }
}

function toWorkflowRun(row: WorkflowRunRow): WorkflowRun {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowVersionId: row.workflow_version_id,
    status: row.status,
    triggerType: row.trigger_type,
    inputJson: row.input,
    outputJson: row.output,
    error: row.error,
    contextJson: row.context_json,
    planJson: row.plan_json,
    stateJson: row.state_json,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toWorkflowStepRun(row: WorkflowStepRunRow): WorkflowStepRun {
  return {
    id: row.id,
    workflowRunId: row.workflow_run_id,
    stepKey: row.step_key,
    stepType: row.step_type,
    status: row.status,
    attempt: row.attempt,
    agentVersionId: row.agent_version_id,
    toolExecutionId: row.tool_execution_id,
    inputJson: row.input,
    outputJson: row.output,
    error: row.error,
    decisionJson: row.decision,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
  }
}

export const WORKFLOW_NAME_MAX = 80

export const createWorkflowInput = z.object({
  workspaceId: z.uuid(),
  name: z.string().trim().min(1).max(WORKFLOW_NAME_MAX),
  description: z.string().trim().max(280).nullable().optional(),
})
export type CreateWorkflowInput = z.input<typeof createWorkflowInput>

export async function createWorkflow(
  db: SqlDatabase,
  input: CreateWorkflowInput,
): Promise<Workflow> {
  const data = createWorkflowInput.parse(input)
  const id = newId()
  const now = nowIso()
  await execute(
    db,
    `INSERT INTO workflow (id, workspace_id, name, description, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'draft', ?, ?)`,
    [id, data.workspaceId, data.name, data.description ?? null, now, now],
  )
  const created = await getWorkflowById(db, id)
  if (!created) throw new Error('workflow insert did not produce a readable row')
  return created
}

export async function getWorkflowById(db: SqlDatabase, id: string): Promise<Workflow | null> {
  const row = await queryFirst<WorkflowRow>(db, `SELECT * FROM workflow WHERE id = ?`, [id])
  return row ? toWorkflow(row) : null
}

/** All live workflows of a workspace, archived included, by name. */
export async function listWorkflows(db: SqlDatabase, workspaceId: string): Promise<Workflow[]> {
  const rows = await queryAll<WorkflowRow>(
    db,
    `SELECT * FROM workflow WHERE workspace_id = ? AND deleted_at IS NULL
     ORDER BY lower(name) ASC`,
    [workspaceId],
  )
  return rows.map(toWorkflow)
}

/** Update identity-level display metadata (name, purpose). Never versioned. */
export async function updateWorkflowShell(
  db: SqlDatabase,
  input: { id: string; name?: string; description?: string | null },
): Promise<Workflow> {
  const data = z
    .object({
      id: z.uuid(),
      name: z.string().trim().min(1).max(WORKFLOW_NAME_MAX).optional(),
      description: z.string().trim().max(280).nullable().optional(),
    })
    .parse(input)
  const workflow = await getWorkflowById(db, data.id)
  if (!workflow) throw new Error('Workflow not found.')
  await execute(db, `UPDATE workflow SET name = ?, description = ?, updated_at = ? WHERE id = ?`, [
    data.name ?? workflow.name,
    data.description === undefined ? workflow.description : data.description,
    nowIso(),
    data.id,
  ])
  const updated = await getWorkflowById(db, data.id)
  if (!updated) throw new Error('workflow update did not produce a readable row')
  return updated
}

export async function setWorkflowStatus(
  db: SqlDatabase,
  workflowId: string,
  status: WorkflowStatus,
): Promise<Workflow> {
  await execute(db, `UPDATE workflow SET status = ?, updated_at = ? WHERE id = ?`, [
    status,
    nowIso(),
    workflowId,
  ])
  const updated = await getWorkflowById(db, workflowId)
  if (!updated) throw new Error('workflow status update did not produce a readable row')
  return updated
}

/**
 * Append a new immutable version and (when requested) point the workflow at
 * it. Versions are never updated in place: a run must always be able to
 * re-read the exact definition it executed.
 */
export async function addWorkflowVersion(
  db: SqlDatabase,
  input: {
    workflowId: string
    definitionJson: string
    changeNote?: string | null
    makeCurrent?: boolean
  },
): Promise<WorkflowVersion> {
  const note = z.string().trim().max(200).nullable().optional().parse(input.changeNote)
  const latest = await queryFirst<{ version: number }>(
    db,
    `SELECT version FROM workflow_version WHERE workflow_id = ? ORDER BY version DESC LIMIT 1`,
    [input.workflowId],
  )
  const id = newId()
  const version = (latest?.version ?? 0) + 1
  await execute(
    db,
    `INSERT INTO workflow_version (id, workflow_id, version, definition, change_note, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, input.workflowId, version, input.definitionJson, note ?? null, nowIso()],
  )
  if (input.makeCurrent !== false) {
    await execute(db, `UPDATE workflow SET current_version_id = ?, updated_at = ? WHERE id = ?`, [
      id,
      nowIso(),
      input.workflowId,
    ])
  }
  const created = await getWorkflowVersion(db, id)
  if (!created) throw new Error('workflow_version insert did not produce a readable row')
  return created
}

export async function getWorkflowVersion(
  db: SqlDatabase,
  id: string,
): Promise<WorkflowVersion | null> {
  const row = await queryFirst<WorkflowVersionRow>(
    db,
    `SELECT * FROM workflow_version WHERE id = ?`,
    [id],
  )
  return row ? toWorkflowVersion(row) : null
}

export async function listWorkflowVersions(
  db: SqlDatabase,
  workflowId: string,
): Promise<WorkflowVersion[]> {
  const rows = await queryAll<WorkflowVersionRow>(
    db,
    `SELECT * FROM workflow_version WHERE workflow_id = ? ORDER BY version DESC`,
    [workflowId],
  )
  return rows.map(toWorkflowVersion)
}

/* ---- Runs ---- */

export interface CreateWorkflowRunData {
  workflowId: string
  workflowVersionId: string
  triggerType: WorkflowRun['triggerType']
  inputJson: string | null
  contextJson: string | null
  planJson: string | null
  stateJson: string | null
}

export async function createWorkflowRun(
  db: SqlDatabase,
  data: CreateWorkflowRunData,
): Promise<WorkflowRun> {
  const id = newId()
  const now = nowIso()
  await execute(
    db,
    `INSERT INTO workflow_run
       (id, workflow_id, workflow_version_id, status, trigger_type, input,
        context_json, plan_json, state_json, started_at, created_at, updated_at)
     VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.workflowId,
      data.workflowVersionId,
      data.triggerType,
      data.inputJson,
      data.contextJson,
      data.planJson,
      data.stateJson,
      now,
      now,
      now,
    ],
  )
  const created = await getWorkflowRunById(db, id)
  if (!created) throw new Error('workflow_run insert did not produce a readable row')
  return created
}

export async function getWorkflowRunById(db: SqlDatabase, id: string): Promise<WorkflowRun | null> {
  const row = await queryFirst<WorkflowRunRow>(db, `SELECT * FROM workflow_run WHERE id = ?`, [id])
  return row ? toWorkflowRun(row) : null
}

export async function listWorkflowRuns(
  db: SqlDatabase,
  workflowId: string,
  limit = 20,
): Promise<WorkflowRun[]> {
  const rows = await queryAll<WorkflowRunRow>(
    db,
    `SELECT * FROM workflow_run WHERE workflow_id = ?
     ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    [workflowId, limit],
  )
  return rows.map(toWorkflowRun)
}

export async function getLatestWorkflowRun(
  db: SqlDatabase,
  workflowId: string,
): Promise<WorkflowRun | null> {
  const row = await queryFirst<WorkflowRunRow>(
    db,
    `SELECT * FROM workflow_run WHERE workflow_id = ?
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    [workflowId],
  )
  return row ? toWorkflowRun(row) : null
}

/**
 * Engine state transitions. `expectedStatus` makes the update conditional:
 * a cancelled run cannot be overwritten by a late engine tick (the engine
 * reloads and stops instead).
 */
export async function updateWorkflowRun(
  db: SqlDatabase,
  runId: string,
  patch: {
    status?: WorkflowRun['status']
    outputJson?: string | null
    error?: string | null
    stateJson?: string | null
    finishedAt?: string | null
  },
): Promise<WorkflowRun> {
  const current = await getWorkflowRunById(db, runId)
  if (!current) throw new Error('Workflow run not found.')
  await execute(
    db,
    `UPDATE workflow_run SET status = ?, output = ?, error = ?, state_json = ?,
       finished_at = ?, updated_at = ? WHERE id = ?`,
    [
      patch.status ?? current.status,
      patch.outputJson === undefined ? current.outputJson : patch.outputJson,
      patch.error === undefined ? current.error : patch.error,
      patch.stateJson === undefined ? current.stateJson : patch.stateJson,
      patch.finishedAt === undefined ? current.finishedAt : patch.finishedAt,
      nowIso(),
      runId,
    ],
  )
  const updated = await getWorkflowRunById(db, runId)
  if (!updated) throw new Error('workflow_run update did not produce a readable row')
  return updated
}

/* ---- Step runs ---- */

export interface CreateWorkflowStepRunData {
  workflowRunId: string
  stepKey: string
  stepType: WorkflowStepRun['stepType']
  attempt: number
  agentVersionId?: string | null
  inputJson?: string | null
}

export async function createWorkflowStepRun(
  db: SqlDatabase,
  data: CreateWorkflowStepRunData,
): Promise<WorkflowStepRun> {
  const id = newId()
  const now = nowIso()
  await execute(
    db,
    `INSERT INTO workflow_step_run
       (id, workflow_run_id, step_key, step_type, status, attempt, agent_version_id,
        input, started_at, created_at)
     VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
    [
      id,
      data.workflowRunId,
      data.stepKey,
      data.stepType,
      data.attempt,
      data.agentVersionId ?? null,
      data.inputJson ?? null,
      now,
      now,
    ],
  )
  const created = await getWorkflowStepRunById(db, id)
  if (!created) throw new Error('workflow_step_run insert did not produce a readable row')
  return created
}

export async function getWorkflowStepRunById(
  db: SqlDatabase,
  id: string,
): Promise<WorkflowStepRun | null> {
  const row = await queryFirst<WorkflowStepRunRow>(
    db,
    `SELECT * FROM workflow_step_run WHERE id = ?`,
    [id],
  )
  return row ? toWorkflowStepRun(row) : null
}

/** Full step history of a run, oldest first (execution order). */
export async function listWorkflowStepRuns(
  db: SqlDatabase,
  workflowRunId: string,
): Promise<WorkflowStepRun[]> {
  const rows = await queryAll<WorkflowStepRunRow>(
    db,
    `SELECT * FROM workflow_step_run WHERE workflow_run_id = ?
     ORDER BY created_at ASC, rowid ASC`,
    [workflowRunId],
  )
  return rows.map(toWorkflowStepRun)
}

export async function finishWorkflowStepRun(
  db: SqlDatabase,
  stepRunId: string,
  patch: {
    status: WorkflowStepRun['status']
    outputJson?: string | null
    error?: string | null
    decisionJson?: string | null
    toolExecutionId?: string | null
  },
): Promise<WorkflowStepRun> {
  const current = await getWorkflowStepRunById(db, stepRunId)
  if (!current) throw new Error('Workflow step run not found.')
  await execute(
    db,
    `UPDATE workflow_step_run SET status = ?, output = ?, error = ?, decision = ?,
       tool_execution_id = ?, finished_at = ? WHERE id = ?`,
    [
      patch.status,
      patch.outputJson === undefined ? current.outputJson : patch.outputJson,
      patch.error === undefined ? current.error : patch.error,
      patch.decisionJson === undefined ? current.decisionJson : patch.decisionJson,
      patch.toolExecutionId === undefined ? current.toolExecutionId : patch.toolExecutionId,
      nowIso(),
      stepRunId,
    ],
  )
  const updated = await getWorkflowStepRunById(db, stepRunId)
  if (!updated) throw new Error('workflow_step_run update did not produce a readable row')
  return updated
}
