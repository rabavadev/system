import { z } from 'zod'

import type { Agent, AgentExecutionType, AgentVersion } from '~/types/domain'

import { execute, newId, nowIso, queryFirst, type SqlDatabase } from './sql.ts'

/**
 * Agent / agent_version repository. Structural SqlDatabase (no
 * cloudflare:workers import) so it runs in plain node tests.
 *
 * Versioning doctrine (docs/database.md): agent is a mutable shell holding
 * current_version_id; agent_version rows are immutable snapshots, keyed
 * UNIQUE(agent_id, version). New configuration = a new version, never an
 * edit, so every message's agent_version_id keeps pointing at exactly the
 * configuration that produced it.
 */

interface AgentRow {
  id: string
  workspace_id: string
  name: string
  role: string | null
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
  created_at: string
}

function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    role: row.role,
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
    createdAt: row.created_at,
  }
}

export const createAgentInput = z.object({
  workspaceId: z.uuid(),
  name: z.string().trim().min(1).max(80),
  role: z.string().trim().min(1).max(120).nullable().optional(),
  executionType: z.enum(['direct_model', 'external_agent', 'router']).default('direct_model'),
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

export async function getAgentById(db: SqlDatabase, id: string): Promise<Agent | null> {
  const row = await queryFirst<AgentRow>(db, `SELECT * FROM agent WHERE id = ?`, [id])
  return row ? toAgent(row) : null
}

export async function getAgentVersion(db: SqlDatabase, id: string): Promise<AgentVersion | null> {
  const row = await queryFirst<AgentVersionRow>(db, `SELECT * FROM agent_version WHERE id = ?`, [
    id,
  ])
  return row ? toAgentVersion(row) : null
}

export async function createAgent(db: SqlDatabase, input: CreateAgentInput): Promise<Agent> {
  const data = createAgentInput.parse(input)
  const id = newId()
  const now = nowIso()
  await execute(
    db,
    `INSERT INTO agent (id, workspace_id, name, role, execution_type, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    [id, data.workspaceId, data.name, data.role ?? null, data.executionType, now, now],
  )
  const created = await getAgentById(db, id)
  if (!created) {
    throw new Error('agent insert did not produce a readable row')
  }
  return created
}

/**
 * Append a new immutable version and point the agent at it. Versions are
 * never updated in place.
 */
export async function addAgentVersion(
  db: SqlDatabase,
  agentId: string,
  configJson: string,
): Promise<AgentVersion> {
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
    `INSERT INTO agent_version (id, agent_id, version, config, created_at) VALUES (?, ?, ?, ?, ?)`,
    [id, agentId, version, configJson, now],
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
