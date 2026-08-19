import type { Agent, AgentVersion } from '~/types/domain'

import {
  addAgentVersion,
  createAgent,
  findAgent,
  findAgentByName,
  getAgentById,
  getCurrentAgentVersion,
  updateAgentShell,
} from '../db/agent.ts'
import type { SqlDatabase } from '../db/sql.ts'
import { type AgentVersionConfig, parseAgentVersionConfig } from './config.ts'
import { BUILTIN_AGENTS, type BuiltinAgentDefinition, builtinConfig } from './definitions.ts'

/**
 * Agent Registry provisioning and resolution.
 *
 * Built-in agents are provisioned lazily and idempotently: the first chat
 * send or Agents page load creates any missing built-ins and rotates a new
 * version when the shipped config changed. Existing identities (and their
 * historical versions/messages) are never recreated or rewritten.
 */

export interface AgentHandle {
  agent: Agent
  version: AgentVersion
  config: AgentVersionConfig
}

/** Ensure one built-in exists and its current version matches the shipped config. */
async function ensureBuiltin(
  db: SqlDatabase,
  workspaceId: string,
  def: BuiltinAgentDefinition,
): Promise<AgentHandle> {
  const configJson = JSON.stringify(builtinConfig(def))
  let agent = await findAgent(db, workspaceId, def.name, def.key)
  if (!agent) {
    agent = await createAgent(db, {
      workspaceId,
      name: def.name,
      role: def.key,
      description: def.purpose,
      origin: 'builtin',
      executionType: def.executionType,
      status: def.status === 'disabled' ? 'disabled' : 'active',
    })
  } else if (agent.description !== def.purpose) {
    // Purpose text is identity-level display metadata; keep it in sync.
    agent = await updateAgentShell(db, { id: agent.id, description: def.purpose })
  }
  let version = await getCurrentAgentVersion(db, agent)
  // Rotate when the SHIPPED config changed — but never revert a version the
  // user wrote. Legacy (pre-STEP 8) versions have no source marker and are
  // treated as system versions, so they rotate exactly once.
  const currentSource = versionConfigSource(version?.configJson)
  if (!version || (version.configJson !== configJson && currentSource !== 'user')) {
    version = await addAgentVersion(db, agent.id, configJson)
    agent = { ...agent, currentVersionId: version.id }
  }
  const config = parseAgentVersionConfig(version.configJson)
  if (!config) {
    throw new Error(`Built-in agent '${def.name}' shipped an invalid config.`)
  }
  return { agent, version, config }
}

/**
 * Provision every built-in agent for a workspace. Idempotent and cheap:
 * after first provisioning this only reads rows (plus a version insert when
 * shipped instructions changed).
 */
export async function ensureBuiltinAgents(
  db: SqlDatabase,
  workspaceId: string,
): Promise<Map<string, AgentHandle>> {
  const handles = new Map<string, AgentHandle>()
  for (const def of BUILTIN_AGENTS) {
    handles.set(def.key, await ensureBuiltin(db, workspaceId, def))
  }
  return handles
}

/**
 * Name policy (server-side, the only enforcement that matters): no
 * duplicates and no reserved built-in names, case-insensitive.
 */
export async function assertAgentNameAvailable(
  db: SqlDatabase,
  workspaceId: string,
  name: string,
  exceptAgentId?: string,
): Promise<void> {
  const existing = await findAgentByName(db, workspaceId, name)
  if (existing && existing.id !== exceptAgentId) {
    if (existing.origin === 'builtin') {
      throw new Error(`'${existing.name}' is a built-in agent. Pick another name.`)
    }
    throw new Error(`An agent named '${existing.name}' already exists.`)
  }
}

function versionConfigSource(configJson: string | undefined): string | undefined {
  if (!configJson) {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(configJson)
    if (parsed !== null && typeof parsed === 'object') {
      const { source } = parsed as { source?: unknown }
      return typeof source === 'string' ? source : undefined
    }
  } catch {
    // invalid JSON → treated as system-authored legacy config
  }
  return undefined
}

export type ResolveChatAgent =
  | { ok: true; handle: AgentHandle }
  | { ok: false; userMessage: string }

/**
 * Resolve the agent for one chat execution. The client submits an agent ID
 * only; everything else is authoritative server-side.
 *
 * - No id → the Workspace Chief (default).
 * - Unknown/foreign id → rejected.
 * - Disabled or archived → rejected with safe text (history stays readable;
 *   disabled agents simply cannot run new executions).
 * - Invalid stored config → rejected (never silently repaired).
 */
export async function resolveChatAgent(
  db: SqlDatabase,
  workspaceId: string,
  agentId: string | null | undefined,
): Promise<ResolveChatAgent> {
  const builtins = await ensureBuiltinAgents(db, workspaceId)
  if (!agentId) {
    const chief = builtins.get('workspace-chief')
    if (!chief) {
      return { ok: false, userMessage: 'Chief is not available right now.' }
    }
    return { ok: true, handle: chief }
  }

  const agent = await getAgentById(db, agentId)
  if (!agent || agent.workspaceId !== workspaceId || agent.deletedAt) {
    return { ok: false, userMessage: 'That agent could not be found.' }
  }
  if (agent.status === 'disabled') {
    return { ok: false, userMessage: `${agent.name} is disabled right now. Enable it first.` }
  }
  if (agent.status === 'archived') {
    return { ok: false, userMessage: `${agent.name} is archived.` }
  }
  const version = await getCurrentAgentVersion(db, agent)
  if (!version) {
    return { ok: false, userMessage: `${agent.name} has no configuration yet.` }
  }
  const config = parseAgentVersionConfig(version.configJson)
  if (!config) {
    return { ok: false, userMessage: `${agent.name}'s configuration is invalid.` }
  }
  return { ok: true, handle: { agent, version, config } }
}
