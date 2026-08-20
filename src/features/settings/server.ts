import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { type AgentCapability, parseAgentVersionConfig } from '~/server/agents/config'
import { ensureBuiltinAgents } from '~/server/agents/registry'
import { resolveAiRuntime } from '~/server/ai/runtime'
import { getCurrentAgentVersion, listAgents } from '~/server/db/agent'
import { listBrands } from '~/server/db/brand'
import { getDb } from '~/server/db/client'
import {
  clearApprovalPolicyOverride,
  listApprovalPolicies,
  setApprovalPolicy,
} from '~/server/db/policy'
import { getDefaultWorkspace } from '~/server/db/workspace'
import {
  ACTION_DEFINITIONS,
  ACTION_KEYS,
  type ActionKey,
  type PolicyMode,
  type PolicyResolutionResult,
  resolveApprovalPolicy,
} from '~/server/policy'
import { listToolDescriptors, type ToolDescriptor } from '~/server/tools'

/**
 * Minimal AI/Chief status for the settings screen. Reports configuration
 * state only — never secrets, never raw env values beyond the provider key.
 */
export interface ChiefStatus {
  configured: boolean
  provider: string
  detail: string
}

export const getChiefStatus = createServerFn({ method: 'GET' }).handler(
  async (): Promise<ChiefStatus> => {
    return resolveAiRuntime().status
  },
)

export interface ToolOverviewItem extends ToolDescriptor {
  /** Normal-user capability label key is resolved in the UI. */
  usedBy: string[]
}

export interface ToolsOverview {
  tools: ToolOverviewItem[]
}

import { resolveWebSearchRuntime } from '~/server/tools/adapters/web/runtime'

/**
 * Compact, non-technical Tools overview for Settings. Descriptors never
 * include input/output schemas; usedBy is resolved server-side from real
 * agent versions (active agents only) so the UI cannot invent permissions.
 */
export const getToolsOverview = createServerFn({ method: 'GET' }).handler(
  async (): Promise<ToolsOverview> => {
    const workspace = await getDefaultWorkspace()
    if (!workspace) {
      return { tools: [] }
    }
    const db = getDb()
    await ensureBuiltinAgents(db, workspace.id)
    const agents = await listAgents(db, workspace.id)
    const activeAgents: { name: string; capabilities: AgentCapability[] }[] = []
    for (const agent of agents) {
      if (agent.status !== 'active') continue
      const version = await getCurrentAgentVersion(db, agent)
      const config = version ? parseAgentVersionConfig(version.configJson) : null
      if (config) {
        activeAgents.push({ name: agent.name, capabilities: config.capabilities })
      }
    }
    const webSearchRuntime = resolveWebSearchRuntime()
    return {
      tools: listToolDescriptors().map((tool) => {
        let status = tool.status
        if (tool.key === 'web.search') {
          status = webSearchRuntime.status.configured ? 'available' : 'needs_setup'
        }
        return {
          ...tool,
          status,
          usedBy: activeAgents
            .filter((agent) => agent.capabilities.includes(tool.requiredCapability))
            .map((agent) => agent.name),
        }
      }),
    }
  },
)

export interface AutonomyOverviewItem {
  key: ActionKey
  label: string
  description: string
  category: string
  defaultMode: PolicyMode
  workspaceMode: PolicyMode
  isWorkspaceCustom: boolean
  brandOverrideMode: PolicyMode | null
  effectiveMode: PolicyMode
}

export interface AutonomyOverview {
  workspaceId: string
  selectedBrandId: string | null
  brands: Array<{ id: string; name: string }>
  items: AutonomyOverviewItem[]
}

const getAutonomyOverviewWire = z.object({
  brandId: z.uuid().nullable().optional(),
})

export const getAutonomyOverview = createServerFn({ method: 'GET' })
  .validator((data?: { brandId?: string | null }) => getAutonomyOverviewWire.parse(data ?? {}))
  .handler(async ({ data }): Promise<AutonomyOverview> => {
    const workspace = await getDefaultWorkspace()
    if (!workspace) {
      return {
        workspaceId: '',
        selectedBrandId: null,
        brands: [],
        items: [],
      }
    }
    const db = getDb()
    const brands = await listBrands(workspace.id)
    const activeBrands = brands.map((b) => ({ id: b.id, name: b.name }))

    const workspacePolicies = await listApprovalPolicies(db, {
      workspaceId: workspace.id,
      scopeType: 'workspace',
      scopeId: workspace.id,
    })
    const wsMap = new Map(workspacePolicies.map((p) => [p.actionKey, p.mode]))

    let brandMap = new Map<ActionKey, PolicyMode>()
    if (data.brandId) {
      const brandPolicies = await listApprovalPolicies(db, {
        workspaceId: workspace.id,
        scopeType: 'brand',
        scopeId: data.brandId,
      })
      brandMap = new Map(brandPolicies.map((p) => [p.actionKey, p.mode]))
    }

    const items: AutonomyOverviewItem[] = ACTION_KEYS.map((key) => {
      const def = ACTION_DEFINITIONS[key]
      const defaultMode = def.defaultMode
      const customWsMode = wsMap.get(key)
      const workspaceMode = customWsMode ?? defaultMode
      const brandOverrideMode = data.brandId ? (brandMap.get(key) ?? null) : null
      const effectiveMode = brandOverrideMode ?? workspaceMode

      return {
        key,
        label: def.label,
        description: def.description,
        category: def.category,
        defaultMode,
        workspaceMode,
        isWorkspaceCustom: customWsMode !== undefined,
        brandOverrideMode,
        effectiveMode,
      }
    })

    return {
      workspaceId: workspace.id,
      selectedBrandId: data.brandId ?? null,
      brands: activeBrands,
      items,
    }
  })

const setPolicyWire = z.object({
  scopeType: z.enum(['workspace', 'brand']),
  scopeId: z.uuid(),
  actionKey: z.enum(ACTION_KEYS),
  mode: z.enum(['auto', 'review', 'blocked']),
})

export const setPolicyFn = createServerFn({ method: 'POST' })
  .validator((d: z.infer<typeof setPolicyWire>) => setPolicyWire.parse(d))
  .handler(async ({ data }) => {
    const workspace = await getDefaultWorkspace()
    if (!workspace) {
      throw new Error('No workspace found')
    }
    const db = getDb()
    return setApprovalPolicy(db, {
      workspaceId: workspace.id,
      scopeType: data.scopeType,
      scopeId: data.scopeId,
      actionKey: data.actionKey,
      mode: data.mode,
    })
  })

const clearPolicyOverrideWire = z.object({
  scopeId: z.uuid(),
  actionKey: z.enum(ACTION_KEYS),
})

export const clearPolicyOverrideFn = createServerFn({ method: 'POST' })
  .validator((d: z.infer<typeof clearPolicyOverrideWire>) => clearPolicyOverrideWire.parse(d))
  .handler(async ({ data }) => {
    const workspace = await getDefaultWorkspace()
    if (!workspace) {
      throw new Error('No workspace found')
    }
    const db = getDb()
    return clearApprovalPolicyOverride(db, {
      workspaceId: workspace.id,
      scopeType: 'brand',
      scopeId: data.scopeId,
      actionKey: data.actionKey,
    })
  })

const getPolicyTraceWire = z.object({
  actionKey: z.enum(ACTION_KEYS),
  brandId: z.uuid().nullable().optional(),
})

export const getPolicyTraceFn = createServerFn({ method: 'GET' })
  .validator((d: z.infer<typeof getPolicyTraceWire>) => getPolicyTraceWire.parse(d))
  .handler(async ({ data }): Promise<PolicyResolutionResult> => {
    const workspace = await getDefaultWorkspace()
    if (!workspace) {
      throw new Error('No workspace found')
    }
    const db = getDb()
    return resolveApprovalPolicy(db, {
      action: data.actionKey,
      workspaceId: workspace.id,
      brandId: data.brandId ?? null,
      origin: 'user',
    })
  })
