import { getAgentById, listAgents } from '../db/agent.ts'
import { emitEventSafe } from '../db/event.ts'
import type { SqlDatabase } from '../db/sql.ts'
import {
  addWorkflowVersion,
  createWorkflow,
  getWorkflowById,
  getWorkflowVersion,
  setWorkflowStatus,
  updateWorkflowShell,
} from '../db/workflow.ts'
import { parseWorkflowDefinition, type WorkflowDefinition } from './definition.ts'
import { validateWorkflowDefinition, type WorkflowValidation } from './validate.ts'

/** Validation options (e.g. injected tool definitions in tests). */
export interface ValidationOptions {
  toolDefinitions?: readonly { key: string }[]
}

/**
 * Workflow authoring service: creation, versioning, status changes.
 * Definitions are validated BEFORE a version is stored as current, and a
 * stored version is never mutated — editing appends vN+1 (§22). Rollback
 * is "new version copied from an old one", never rewriting history.
 */

export type ServiceResult<T> = { ok: true; value: T } | { ok: false; message: string }

export async function createWorkflowWithVersion(
  db: SqlDatabase,
  input: {
    workspaceId: string
    name: string
    description?: string | null
    definition: unknown
    changeNote?: string | null
    activate?: boolean
  },
  opts?: ValidationOptions,
): Promise<ServiceResult<{ workflowId: string; versionId: string }>> {
  const validation = await validateWorkflowDefinition(db, input.workspaceId, input.definition, opts)
  if (!validation.ok || !validation.definition) {
    return { ok: false, message: validation.errors[0] ?? 'The workflow definition is invalid.' }
  }
  const workflow = await createWorkflow(db, {
    workspaceId: input.workspaceId,
    name: input.name,
    description: input.description ?? null,
  })
  const version = await addWorkflowVersion(db, {
    workflowId: workflow.id,
    definitionJson: JSON.stringify(validation.definition),
    changeNote: input.changeNote ?? 'First version',
  })
  if (input.activate !== false) {
    await setWorkflowStatus(db, workflow.id, 'active')
  }
  await emitEventSafe(db, {
    workspaceId: input.workspaceId,
    eventType: 'workflow.created',
    actorType: 'user',
    subjectType: 'workflow',
    subjectId: workflow.id,
    payloadJson: JSON.stringify({ name: workflow.name }),
  })
  await emitEventSafe(db, {
    workspaceId: input.workspaceId,
    eventType: 'workflow.version_created',
    actorType: 'user',
    subjectType: 'workflow',
    subjectId: workflow.id,
    payloadJson: JSON.stringify({ version: version.version, changeNote: version.changeNote }),
  })
  return { ok: true, value: { workflowId: workflow.id, versionId: version.id } }
}

/**
 * Save a definition edit as version N+1. The previous version is untouched,
 * so in-flight and historical runs keep their exact definition.
 */
export async function saveWorkflowVersion(
  db: SqlDatabase,
  input: {
    workspaceId: string
    workflowId: string
    definition: unknown
    changeNote?: string | null
  },
  opts?: ValidationOptions,
): Promise<ServiceResult<{ versionId: string; version: number }>> {
  const workflow = await getWorkflowById(db, input.workflowId)
  if (!workflow || workflow.workspaceId !== input.workspaceId || workflow.deletedAt) {
    return { ok: false, message: 'That workflow could not be found.' }
  }
  if (workflow.status === 'archived') {
    return { ok: false, message: 'Archived workflows cannot be edited.' }
  }
  const validation = await validateWorkflowDefinition(db, input.workspaceId, input.definition, opts)
  if (!validation.ok || !validation.definition) {
    return { ok: false, message: validation.errors[0] ?? 'The workflow definition is invalid.' }
  }
  const version = await addWorkflowVersion(db, {
    workflowId: workflow.id,
    definitionJson: JSON.stringify(validation.definition),
    changeNote: input.changeNote ?? null,
  })
  await emitEventSafe(db, {
    workspaceId: input.workspaceId,
    eventType: 'workflow.version_created',
    actorType: 'user',
    subjectType: 'workflow',
    subjectId: workflow.id,
    payloadJson: JSON.stringify({ version: version.version, changeNote: version.changeNote }),
  })
  return { ok: true, value: { versionId: version.id, version: version.version } }
}

export async function updateWorkflowDetails(
  db: SqlDatabase,
  input: { workspaceId: string; workflowId: string; name?: string; description?: string | null },
): Promise<ServiceResult<null>> {
  const workflow = await getWorkflowById(db, input.workflowId)
  if (!workflow || workflow.workspaceId !== input.workspaceId || workflow.deletedAt) {
    return { ok: false, message: 'That workflow could not be found.' }
  }
  await updateWorkflowShell(db, {
    id: workflow.id,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
  })
  return { ok: true, value: null }
}

export async function changeWorkflowStatus(
  db: SqlDatabase,
  input: { workspaceId: string; workflowId: string; status: 'active' | 'disabled' | 'archived' },
): Promise<ServiceResult<null>> {
  const workflow = await getWorkflowById(db, input.workflowId)
  if (!workflow || workflow.workspaceId !== input.workspaceId || workflow.deletedAt) {
    return { ok: false, message: 'That workflow could not be found.' }
  }
  if (input.status === 'active' && !workflow.currentVersionId) {
    return { ok: false, message: 'Add a definition before activating this workflow.' }
  }
  await setWorkflowStatus(db, workflow.id, input.status)
  return { ok: true, value: null }
}

/** Validation preview for the editor (no writes). */
export async function checkWorkflowDefinition(
  db: SqlDatabase,
  workspaceId: string,
  definition: unknown,
): Promise<WorkflowValidation> {
  return validateWorkflowDefinition(db, workspaceId, definition)
}

/** Parse the stored definition of a version (throws on corruption). */
export function definitionOf(definitionJson: string): WorkflowDefinition {
  return parseWorkflowDefinition(definitionJson)
}

export { getAgentById, getWorkflowVersion, listAgents }
