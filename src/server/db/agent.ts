import { z } from 'zod'

import type { Agent, AgentExecutionType, AgentOrigin, AgentVersion } from '~/types/domain'

import { execute, newId, nowIso, queryAll, queryFirst, type SqlDatabase } from './sql.ts'

/**
 * Agent / agent_version repository. Structural SqlDatabase (no
 * cloudflare:workers import) so it runs in plain node tests.
 *
 * Versioning doctrine (docs/database.md): agent is a mutable shell holding
 * current_version_id; agent_version rows are immutable snapshots, keyed
 * UNIQUE(agent_id, version). New configuration = a new version, never an
 * edit, so every message's agent_version_id keeps pointing at exactly the
 * configuration that produced it. Rollback means "create a new version
 * copied from an old one", never rewriting history.
 *
 * Identity vs execution: the shell holds identity (name, purpose, origin,
 * status, execution type). Instructions, model strategy, generation and
 * capability metadata live in the versioned config JSON.
 */

interface AgentRow {
  id: string
  workspace_id: string
  name: string
  role: string | null
  description: string | null
  origin: AgentOrigin
  execution_type: AgentExecutionType
  status: Agent['status']
  current_version_id: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

interface AgentVersionRow {
  id: string
  agent_id: string
  version: number
  config: string
  change_note: string | null
  created_at: string
}

function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    role: row.role,
    description: row.description,
    origin: row.origin,
    executionType: row.execution_type,
    status: row.status,
    currentVersionId: row.current_version_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }
}

function toAgentVersion(row: AgentVersionRow): AgentVersion {
  return {
    id: row.id,
    agentId: row.agent_id,
    version: row.version,
    configJson: row.config,
    changeNote: row.change_note,
    createdAt: row.created_at,
  }
}

export const AGENT_NAME_MAX = 80

export const createAgentInput = z.object({
  workspaceId: z.uuid(),
  name: z.string().trim().min(1).max(AGENT_NAME_MAX),
  role: z.string().trim().min(1).max(120).nullable().optional(),
  description: z.string().trim().max(280).nullable().optional(),
  origin: z.enum(['builtin', 'custom']).default('custom'),
  executionType: z.enum(['direct_model', 'external_agent', 'router']).default('direct_model'),
  status: z.enum(['active', 'disabled']).default('active'),
})
export type CreateAgentInput = z.input<typeof createAgentInput>

/** Find a live agent in a workspace by name + role (built-in lookup). */
export async function findAgent(
  db: SqlDatabase,
  workspaceId: string,
  name: string,
  role: string,
): Promise<Agent | null> {
  const row = await queryFirst<AgentRow>(
    db,
    `SELECT * FROM agent
     WHERE workspace_id = ? AND name = ? AND role = ? AND deleted_at IS NULL
     ORDER BY created_at ASC LIMIT 1`,
    [workspaceId, name, role],
  )
  return row ? toAgent(row) : null
}

/** Case-insensitive name lookup within a workspace (duplicate detection). */
export async function findAgentByName(
  db: SqlDatabase,
  workspaceId: string,
  name: string,
): Promise<Agent | null> {
  const row = await queryFirst<AgentRow>(
    db,
    `SELECT * FROM agent
     WHERE workspace_id = ? AND lower(name) = lower(?) AND deleted_at IS NULL
     ORDER BY created_at ASC LIMIT 1`,
    [workspaceId, name],
  )
  return row ? toAgent(row) : null
}

export async function getAgentById(db: SqlDatabase, id: string): Promise<Agent | null> {
  const row = await queryFirst<AgentRow>(db, `SELECT * FROM agent WHERE id = ?`, [id])
  return row ? toAgent(row) : null
}

/**
 * All live agents of a workspace (any status, including archived rows —
 * the registry UI groups them). Built-ins first, then customs by name.
 */
export async function listAgents(db: SqlDatabase, workspaceId: string): Promise<Agent[]> {
  const rows = await queryAll<AgentRow>(
    db,
    `SELECT * FROM agent
     WHERE workspace_id = ? AND deleted_at IS NULL
     ORDER BY CASE origin WHEN 'builtin' THEN 0 ELSE 1 END,
       CASE WHEN role = 'workspace-chief' THEN 0 ELSE 1 END,
       lower(name) ASC`,
    [workspaceId],
  )
  return rows.map(toAgent)
}

export async function getAgentVersion(db: SqlDatabase, id: string): Promise<AgentVersion | null> {
  const row = await queryFirst<AgentVersionRow>(db, `SELECT * FROM agent_version WHERE id = ?`, [
    id,
  ])
  return row ? toAgentVersion(row) : null
}

/** All versions of an agent, newest first. Versions are never edited. */
export async function listAgentVersions(db: SqlDatabase, agentId: string): Promise<AgentVersion[]> {
  const rows = await queryAll<AgentVersionRow>(
    db,
    `SELECT * FROM agent_version WHERE agent_id = ? ORDER BY version DESC`,
    [agentId],
  )
  return rows.map(toAgentVersion)
}

export async function createAgent(db: SqlDatabase, input: CreateAgentInput): Promise<Agent> {
  const data = createAgentInput.parse(input)
  const id = newId()
  const now = nowIso()
  await execute(
    db,
    `INSERT INTO agent (id, workspace_id, name, role, description, origin, execution_type, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.workspaceId,
      data.name,
      data.role ?? null,
      data.description ?? null,
      data.origin,
      data.executionType,
      data.status,
      now,
      now,
    ],
  )
  const created = await getAgentById(db, id)
  if (!created) {
    throw new Error('agent insert did not produce a readable row')
  }
  return created
}

/**
 * Update identity-level display metadata (name, purpose). These do NOT
 * change how the agent runs, so they stay on the shell and do not create a
 * new version. Anything execution-relevant belongs to agent_version.
 */
export async function updateAgentShell(
  db: SqlDatabase,
  input: { id: string; name?: string; description?: string | null },
): Promise<Agent> {
  const data = z
    .object({
      id: z.uuid(),
      name: z.string().trim().min(1).max(AGENT_NAME_MAX).optional(),
      description: z.string().trim().max(280).nullable().optional(),
    })
    .parse(input)
  const agent = await getAgentById(db, data.id)
  if (!agent) {
    throw new Error('Agent not found.')
  }
  await execute(db, `UPDATE agent SET name = ?, description = ?, updated_at = ? WHERE id = ?`, [
    data.name ?? agent.name,
    data.description === undefined ? agent.description : data.description,
    nowIso(),
    data.id,
  ])
  const updated = await getAgentById(db, data.id)
  if (!updated) {
    throw new Error('agent update did not produce a readable row')
  }
  return updated
}

/**
 * Change agent status. Built-in identities can be disabled and re-enabled
 * but never archived — archive would orphan the built-in registry entry.
 * No hard delete exists for agents at all: history must keep its authors.
 */
export async function setAgentStatus(
  db: SqlDatabase,
  agentId: string,
  status: Agent['status'],
): Promise<Agent> {
  const agent = await getAgentById(db, agentId)
  if (!agent) {
    throw new Error('Agent not found.')
  }
  if (agent.origin === 'builtin' && status === 'archived') {
    throw new Error('Built-in agents cannot be archived. Disable them instead.')
  }
  await execute(db, `UPDATE agent SET status = ?, updated_at = ? WHERE id = ?`, [
    status,
    nowIso(),
    agentId,
  ])
  const updated = await getAgentById(db, agentId)
  if (!updated) {
    throw new Error('agent status update did not produce a readable row')
  }
  return updated
}

/**
 * Append a new immutable version and point the agent at it. Versions are
 * never updated in place; `changeNote` is display-only metadata.
 */
export async function addAgentVersion(
  db: SqlDatabase,
  agentId: string,
  configJson: string,
  changeNote?: string | null,
): Promise<AgentVersion> {
  const note = z.string().trim().max(200).nullable().optional().parse(changeNote)
  const latest = await queryFirst<{ version: number }>(
    db,
    `SELECT version FROM agent_version WHERE agent_id = ? ORDER BY version DESC LIMIT 1`,
    [agentId],
  )
  const id = newId()
  const now = nowIso()
  const version = (latest?.version ?? 0) + 1
  await execute(
    db,
    `INSERT INTO agent_version (id, agent_id, version, config, change_note, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, agentId, version, configJson, note ?? null, now],
  )
  await execute(db, `UPDATE agent SET current_version_id = ?, updated_at = ? WHERE id = ?`, [
    id,
    now,
    agentId,
  ])
  const created = await getAgentVersion(db, id)
  if (!created) {
    throw new Error('agent_version insert did not produce a readable row')
  }
  return created
}

/**
 * The current version of an agent, or null when the agent has none.
 */
export async function getCurrentAgentVersion(
  db: SqlDatabase,
  agent: Agent,
): Promise<AgentVersion | null> {
  if (!agent.currentVersionId) {
    return null
  }
  return getAgentVersion(db, agent.currentVersionId)
}
