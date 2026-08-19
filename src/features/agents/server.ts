import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { agentVersionConfigSchema } from '~/server/agents/config'
import { assertAgentNameAvailable, ensureBuiltinAgents } from '~/server/agents/registry'
import {
  AGENT_NAME_MAX,
  addAgentVersion,
  createAgent,
  getAgentById,
  getAgentVersion,
  listAgents,
  listAgentVersions,
  setAgentStatus,
  updateAgentShell,
} from '~/server/db/agent'
import { writeAuditLog } from '~/server/db/audit'
import { getDb } from '~/server/db/client'
import { emitEventSafe } from '~/server/db/event'
import { getDefaultWorkspace } from '~/server/db/workspace'
import type { Agent, AgentVersion } from '~/types/domain'

/**
 * Server functions for the Agent Registry UI. The client never passes a
 * workspace id; the default workspace is resolved server-side and every
 * agent access is checked against it.
 *
 * Wire schemas are declared locally (not derived from repository schemas at
 * module level) so the client build can strip every server/db import.
 *
 * Identity vs version: name/purpose live on the agent shell; instructions,
 * model strategy, generation, capabilities and external/router config are
 * VERSIONED — editing them appends version N+1 and never mutates history.
 */

const MODEL_STRATEGY_VALUES = ['default', 'fast', 'reasoning', 'cheap', 'vision'] as const
const CAPABILITY_VALUES = [
  'read_context',
  'read_memory',
  'read_research',
  'read_analytics',
  'create_draft',
  'propose_memory',
  'request_workflow',
  'publish',
  'modify_account',
] as const
const EXECUTION_TYPE_VALUES = ['direct_model', 'external_agent', 'router'] as const

const idWire = z.object({ id: z.uuid() })

const externalWire = z
  .object({
    endpoint: z
      .string()
      .trim()
      .max(500)
      .url()
      .refine((value) => value.startsWith('https://'), 'External endpoints must be https URLs.')
      .optional(),
    agentRef: z.string().trim().min(1).max(120).optional(),
    credentialRef: z
      .string()
      .trim()
      .regex(/^[A-Z][A-Z0-9_]{0,63}$/, 'Credential references look like MY_SECRET_NAME.')
      .optional(),
  })
  .strict()

const versionFieldsWire = {
  instructions: z.string().trim().min(1, 'Instructions are required.').max(6000),
  modelStrategy: z.enum(MODEL_STRATEGY_VALUES),
  capabilities: z.array(z.enum(CAPABILITY_VALUES)).max(CAPABILITY_VALUES.length),
}

const createCustomAgentWire = z.object({
  name: z.string().trim().min(1, 'Give the agent a name.').max(AGENT_NAME_MAX),
  description: z.string().trim().max(280).optional(),
  executionType: z.enum(EXECUTION_TYPE_VALUES).default('direct_model'),
  external: externalWire.optional(),
  ...versionFieldsWire,
})

const updateAgentDetailsWire = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(AGENT_NAME_MAX).optional(),
  description: z.string().trim().max(280).nullable().optional(),
})

const saveAgentVersionWire = z.object({
  id: z.uuid(),
  changeNote: z.string().trim().max(200).optional(),
  ...versionFieldsWire,
})

const setStatusWire = z.object({
  id: z.uuid(),
  status: z.enum(['active', 'disabled']),
})

/** An agent row as the registry list renders it. No config, no secrets. */
export interface AgentListItem {
  id: string
  name: string
  purpose: string | null
  status: Agent['status']
  origin: Agent['origin']
  executionType: Agent['executionType']
  currentVersion: number | null
}

/** A version as the history UI renders it. Config is parsed, never raw. */
export interface AgentVersionItem {
  id: string
  version: number
  changeNote: string | null
  createdAt: string
  isCurrent: boolean
  instructions: string
  modelStrategy: string
  capabilities: string[]
  /** Present only when this is an external agent version. */
  external: { endpoint: string | null; agentRef: string | null; hasCredential: boolean } | null
  /** Present only when this is a router version. */
  router: { allowedStrategies: string[] } | null
}

export interface AgentDetailData {
  agent: AgentListItem & { createdAt: string }
  versions: AgentVersionItem[]
}

async function requireWorkspace() {
  const workspace = await getDefaultWorkspace()
  if (!workspace) {
    throw new Error('Workspace is not set up yet.')
  }
  return workspace
}

async function requireOwnedAgent(id: string, workspaceId: string): Promise<Agent> {
  const agent = await getAgentById(getDb(), id)
  if (!agent || agent.workspaceId !== workspaceId || agent.deletedAt) {
    throw new Error('Agent not found.')
  }
  return agent
}

function toListItem(agent: Agent, currentVersion: number | null): AgentListItem {
  return {
    id: agent.id,
    name: agent.name,
    purpose: agent.description,
    status: agent.status,
    origin: agent.origin,
    executionType: agent.executionType,
    currentVersion,
  }
}

/** Tolerant view over stored config JSON (never trust the row blindly). */
interface RawConfigShape {
  instructions?: unknown
  model?: { strategy?: unknown }
  capabilities?: unknown
  generation?: unknown
  external?: { endpoint?: unknown; agentRef?: unknown; credentialRef?: unknown } | null
  router?: { allowedStrategies?: unknown } | null
}

/** Parse a version row into safe display shape. Invalid config → marked. */
function toVersionItem(version: AgentVersion, currentVersionId: string | null): AgentVersionItem {
  const fallback = {
    id: version.id,
    version: version.version,
    changeNote: version.changeNote,
    createdAt: version.createdAt,
    isCurrent: version.id === currentVersionId,
    instructions: '',
    modelStrategy: 'default',
    capabilities: [] as string[],
    external: null,
    router: null,
  }
  try {
    const raw: unknown = JSON.parse(version.configJson)
    if (raw === null || typeof raw !== 'object') {
      return fallback
    }
    const config = raw as RawConfigShape
    return {
      ...fallback,
      instructions: typeof config.instructions === 'string' ? config.instructions : '',
      modelStrategy: typeof config.model?.strategy === 'string' ? config.model.strategy : 'default',
      capabilities: Array.isArray(config.capabilities)
        ? (config.capabilities as unknown[]).filter((c): c is string => typeof c === 'string')
        : [],
      external: config.external
        ? {
            endpoint:
              typeof config.external.endpoint === 'string' ? config.external.endpoint : null,
            agentRef:
              typeof config.external.agentRef === 'string' ? config.external.agentRef : null,
            hasCredential: typeof config.external.credentialRef === 'string',
          }
        : null,
      router: config.router
        ? {
            allowedStrategies: Array.isArray(config.router.allowedStrategies)
              ? (config.router.allowedStrategies as unknown[]).filter(
                  (s): s is string => typeof s === 'string',
                )
              : [],
          }
        : null,
    }
  } catch {
    return fallback
  }
}

/** Registry list. Lazily provisions the built-in agents on first view. */
export const getAgentsPageData = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ agents: AgentListItem[] }> => {
    const workspace = await getDefaultWorkspace()
    if (!workspace) {
      return { agents: [] }
    }
    const db = getDb()
    await ensureBuiltinAgents(db, workspace.id)
    const agents = await listAgents(db, workspace.id)
    const items = await Promise.all(
      agents.map(async (agent) => {
        const version = agent.currentVersionId
          ? await getAgentVersion(db, agent.currentVersionId)
          : null
        return toListItem(agent, version?.version ?? null)
      }),
    )
    return { agents: items }
  },
)

export const getAgentDetailData = createServerFn({ method: 'GET' })
  .validator(idWire)
  .handler(async ({ data }): Promise<AgentDetailData | null> => {
    const workspace = await getDefaultWorkspace()
    if (!workspace) {
      return null
    }
    const db = getDb()
    const agent = await getAgentById(db, data.id)
    if (!agent || agent.workspaceId !== workspace.id || agent.deletedAt) {
      return null
    }
    const versions = await listAgentVersions(db, agent.id)
    const current = agent.currentVersionId
      ? await getAgentVersion(db, agent.currentVersionId)
      : null
    return {
      agent: { ...toListItem(agent, current?.version ?? null), createdAt: agent.createdAt },
      versions: versions.map((version) => toVersionItem(version, agent.currentVersionId)),
    }
  })

export const createCustomAgentFn = createServerFn({ method: 'POST' })
  .validator(createCustomAgentWire)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const workspace = await requireWorkspace()
    const db = getDb()
    await ensureBuiltinAgents(db, workspace.id)
    await assertAgentNameAvailable(db, workspace.id, data.name)

    // Validate the versioned config server-side (secret guard included).
    const configResult = agentVersionConfigSchema.safeParse({
      instructions: data.instructions,
      model: { strategy: data.modelStrategy },
      capabilities: data.capabilities,
      source: 'user',
      ...(data.executionType === 'external_agent' && data.external
        ? { external: data.external }
        : {}),
      ...(data.executionType === 'router'
        ? { router: { allowedStrategies: [...MODEL_STRATEGY_VALUES] } }
        : {}),
    })
    if (!configResult.success) {
      throw new Error(configResult.error.issues.at(0)?.message ?? 'Invalid agent configuration.')
    }

    const agent = await createAgent(db, {
      workspaceId: workspace.id,
      name: data.name,
      description: data.description ?? null,
      origin: 'custom',
      executionType: data.executionType,
    })
    const version = await addAgentVersion(db, agent.id, JSON.stringify(configResult.data))
    await emitEventSafe(db, {
      workspaceId: workspace.id,
      eventType: 'agent.created',
      actorType: 'user',
      subjectType: 'agent',
      subjectId: agent.id,
      payloadJson: JSON.stringify({ name: agent.name, executionType: agent.executionType }),
    })
    await writeAuditLog(db, {
      workspaceId: workspace.id,
      action: 'create',
      entityType: 'agent',
      entityId: agent.id,
      newValueJson: JSON.stringify({
        name: agent.name,
        origin: 'custom',
        version: version.version,
      }),
    })
    return { id: agent.id }
  })

/** Edit identity-level metadata. Built-in names are stable: purpose only. */
export const updateAgentDetailsFn = createServerFn({ method: 'POST' })
  .validator(updateAgentDetailsWire)
  .handler(async ({ data }): Promise<void> => {
    const workspace = await requireWorkspace()
    const db = getDb()
    const agent = await requireOwnedAgent(data.id, workspace.id)
    if (data.name && data.name !== agent.name) {
      if (agent.origin === 'builtin') {
        throw new Error('Built-in agents keep their name.')
      }
      await assertAgentNameAvailable(db, workspace.id, data.name, agent.id)
    }
    await updateAgentShell(db, {
      id: agent.id,
      ...(data.name ? { name: data.name } : {}),
      ...(data.description !== undefined ? { description: data.description } : {}),
    })
  })

/**
 * Save edited versioned configuration. Always appends version N+1 (the old
 * version stays immutable); external/router blocks carry over from the
 * current version so a pure instruction edit cannot silently drop them.
 */
export const saveAgentVersionFn = createServerFn({ method: 'POST' })
  .validator(saveAgentVersionWire)
  .handler(async ({ data }): Promise<{ version: number }> => {
    const workspace = await requireWorkspace()
    const db = getDb()
    const agent = await requireOwnedAgent(data.id, workspace.id)

    const current = agent.currentVersionId
      ? await getAgentVersion(db, agent.currentVersionId)
      : null
    let carry: RawConfigShape = {}
    if (current) {
      try {
        const parsed: unknown = JSON.parse(current.configJson)
        if (parsed !== null && typeof parsed === 'object') {
          carry = parsed as RawConfigShape
        }
      } catch {
        carry = {}
      }
    }

    const configResult = agentVersionConfigSchema.safeParse({
      instructions: data.instructions,
      model: { strategy: data.modelStrategy },
      ...(carry.generation ? { generation: carry.generation } : {}),
      capabilities: data.capabilities,
      source: 'user',
      ...(agent.executionType === 'external_agent' && carry.external
        ? { external: carry.external }
        : {}),
      ...(agent.executionType === 'router' && carry.router ? { router: carry.router } : {}),
    })
    if (!configResult.success) {
      throw new Error(configResult.error.issues.at(0)?.message ?? 'Invalid agent configuration.')
    }

    const version = await addAgentVersion(
      db,
      agent.id,
      JSON.stringify(configResult.data),
      data.changeNote ?? null,
    )
    await emitEventSafe(db, {
      workspaceId: workspace.id,
      eventType: 'agent.version_created',
      actorType: 'user',
      subjectType: 'agent',
      subjectId: agent.id,
      payloadJson: JSON.stringify({
        version: version.version,
        changeNote: data.changeNote ?? null,
      }),
    })
    await writeAuditLog(db, {
      workspaceId: workspace.id,
      action: 'update',
      entityType: 'agent',
      entityId: agent.id,
      newValueJson: JSON.stringify({ newVersion: version.version }),
    })
    return { version: version.version }
  })

/** Enable/disable. Disabled agents cannot run new executions; history stays. */
export const setAgentStatusFn = createServerFn({ method: 'POST' })
  .validator(setStatusWire)
  .handler(async ({ data }): Promise<void> => {
    const workspace = await requireWorkspace()
    const db = getDb()
    const agent = await requireOwnedAgent(data.id, workspace.id)
    await setAgentStatus(db, agent.id, data.status)
    await emitEventSafe(db, {
      workspaceId: workspace.id,
      eventType: data.status === 'disabled' ? 'agent.disabled' : 'agent.enabled',
      actorType: 'user',
      subjectType: 'agent',
      subjectId: agent.id,
      payloadJson: JSON.stringify({ name: agent.name }),
    })
  })

/** Archive a custom agent. Built-ins are protected (repository enforces). */
export const archiveAgentFn = createServerFn({ method: 'POST' })
  .validator(idWire)
  .handler(async ({ data }): Promise<void> => {
    const workspace = await requireWorkspace()
    const db = getDb()
    const agent = await requireOwnedAgent(data.id, workspace.id)
    await setAgentStatus(db, agent.id, 'archived')
    await emitEventSafe(db, {
      workspaceId: workspace.id,
      eventType: 'agent.archived',
      actorType: 'user',
      subjectType: 'agent',
      subjectId: agent.id,
      payloadJson: JSON.stringify({ name: agent.name }),
    })
  })
