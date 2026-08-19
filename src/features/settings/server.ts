import { createServerFn } from '@tanstack/react-start'
import { type AgentCapability, parseAgentVersionConfig } from '~/server/agents/config'
import { ensureBuiltinAgents } from '~/server/agents/registry'
import { resolveAiRuntime } from '~/server/ai/runtime'
import { getCurrentAgentVersion, listAgents } from '~/server/db/agent'
import { getDb } from '~/server/db/client'
import { getDefaultWorkspace } from '~/server/db/workspace'
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
    return {
      tools: listToolDescriptors().map((tool) => ({
        ...tool,
        usedBy: activeAgents
          .filter((agent) => agent.capabilities.includes(tool.requiredCapability))
          .map((agent) => agent.name),
      })),
    }
  },
)
