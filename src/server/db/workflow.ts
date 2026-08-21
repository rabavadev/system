import { z } from 'zod'

import type {
  Workflow,
  WorkflowRun,
  WorkflowRunScopeType,
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
  scope_type: WorkflowRunScopeType | null
  scope_id: string | null
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
    scopeType: row.scope_type ?? null,
    scopeId: row.scope_id ?? null,
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

export const WORKFLOW_RUN_SCOPE_TYPES = [
  'workspace',
  'brand',
  'niche',
  'product',
  'account',
  'campaign',
] as const

/**
 * Validates that a requested workflow run scope target exists, belongs to the
 * workspace, and is active (not archived/deleted).
 */
export async function validateWorkflowRunScope(
  db: SqlDatabase,
  workspaceId: string,
  scopeType: WorkflowRunScopeType,
  scopeId: string,
): Promise<void> {
  if (!scopeId || typeof scopeId !== 'string' || scopeId.trim().length === 0) {
    throw new Error('Scope target ID cannot be empty.')
  }

  if (scopeType === 'workspace') {
    if (scopeId !== workspaceId) {
      throw new Error('The scope target belongs to a different workspace.')
    }
    const row = await queryFirst<{ id: string; deleted_at: string | null }>(
      db,
      `SELECT id, deleted_at FROM workspace WHERE id = ?`,
      [scopeId],
    )
    if (!row) {
      throw new Error('That workspace could not be found.')
    }
    if (row.deleted_at) {
      throw new Error('That workspace is archived.')
    }
    return
  }

  if (scopeType === 'niche') {
    const row = await queryFirst<{
      id: string
      workspace_id: string
      deleted_at: string | null
      brand_deleted_at: string | null
    }>(
      db,
      `SELECT n.id, b.workspace_id, n.deleted_at, b.deleted_at AS brand_deleted_at
       FROM niche n
       JOIN brand b ON b.id = n.brand_id
       WHERE n.id = ?`,
      [scopeId],
    )
    if (!row || row.workspace_id !== workspaceId) {
      throw new Error('The scope target belongs to a different workspace.')
    }
    if (row.deleted_at || row.brand_deleted_at) {
      throw new Error('That item is archived.')
    }
    return
  }

  if (scopeType === 'product') {
    const row = await queryFirst<{
      id: string
      workspace_id: string
      status: string
      deleted_at: string | null
      brand_deleted_at: string | null
    }>(
      db,
      `SELECT p.id, b.workspace_id, p.status, p.deleted_at, b.deleted_at AS brand_deleted_at
       FROM product p
       JOIN brand b ON b.id = p.brand_id
       WHERE p.id = ?`,
      [scopeId],
    )
    if (!row || row.workspace_id !== workspaceId) {
      throw new Error('The scope target belongs to a different workspace.')
    }
    if (row.deleted_at || row.status === 'archived' || row.brand_deleted_at) {
      throw new Error('That item is archived.')
    }
    return
  }

  if (scopeType === 'brand') {
    const row = await queryFirst<{ id: string; workspace_id: string; deleted_at: string | null }>(
      db,
      `SELECT id, workspace_id, deleted_at FROM brand WHERE id = ?`,
      [scopeId],
    )
    if (!row || row.workspace_id !== workspaceId) {
      throw new Error('The scope target belongs to a different workspace.')
    }
    if (row.deleted_at) {
      throw new Error('That item is archived.')
    }
    return
  }

  if (scopeType === 'account') {
    const row = await queryFirst<{
      id: string
      workspace_id: string
      status: string
      deleted_at: string | null
    }>(
      db,
      `SELECT id, workspace_id, status, deleted_at FROM account WHERE id = ?`,
      [scopeId],
    )
    if (!row || row.workspace_id !== workspaceId) {
      throw new Error('The scope target belongs to a different workspace.')
    }
    if (row.deleted_at || row.status === 'archived') {
      throw new Error('That item is archived.')
    }
    return
  }

  if (scopeType === 'campaign') {
    const row = await queryFirst<{
      id: string
      workspace_id: string
      status: string
      deleted_at: string | null
    }>(
      db,
      `SELECT id, workspace_id, status, deleted_at FROM campaign WHERE id = ?`,
      [scopeId],
    )
    if (!row || row.workspace_id !== workspaceId) {
      throw new Error('The scope target belongs to a different workspace.')
    }
    if (row.deleted_at || row.status === 'archived') {
      throw new Error('That item is archived.')
    }
    return
  }

  throw new Error(`Unsupported scope type: ${scopeType}`)
}

export interface CreateWorkflowRunData {
  workflowId: string
  workflowVersionId: string
  triggerType: WorkflowRun['triggerType']
  inputJson: string | null
  contextJson: string | null
  planJson: string | null
  stateJson: string | null
  scopeType?: WorkflowRunScopeType | null
  scopeId?: string | null
}

export async function createWorkflowRun(
  db: SqlDatabase,
  data: CreateWorkflowRunData,
): Promise<WorkflowRun> {
  const id = newId()
  const now = nowIso()
  const scopeType = data.scopeType ?? null
  const scopeId = data.scopeId ?? null

  if ((scopeType === null) !== (scopeId === null)) {
    throw new Error('scopeType and scopeId must be set together or both null.')
  }

  await execute(
    db,
    `INSERT INTO workflow_run
       (id, workflow_id, workflow_version_id, status, trigger_type, input,
        context_json, plan_json, state_json, started_at, created_at, updated_at,
        scope_type, scope_id)
     VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      scopeType,
      scopeId,
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

export interface ListWorkflowRunsByScopeParams {
  workspaceId: string
  scopeType: WorkflowRunScopeType
  scopeId: string
  limit?: number
}

export async function listWorkflowRunsByScope(
  db: SqlDatabase,
  params: ListWorkflowRunsByScopeParams,
): Promise<WorkflowRun[]> {
  const limit = Math.min(params.limit ?? 20, 100)
  const rows = await queryAll<WorkflowRunRow>(
    db,
    `SELECT r.*
     FROM workflow_run r
     JOIN workflow w ON w.id = r.workflow_id
     WHERE w.workspace_id = ?
       AND r.scope_type = ?
       AND r.scope_id = ?
     ORDER BY r.created_at DESC, r.rowid DESC
     LIMIT ?`,
    [params.workspaceId, params.scopeType, params.scopeId, limit],
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
