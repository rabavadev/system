import { parseAgentVersionConfig } from '../agents/config.ts'
import type { AgentHandle } from '../agents/registry.ts'
import { getAgentById, getAgentVersion, getCurrentAgentVersion } from '../db/agent.ts'
import type { SqlDatabase } from '../db/sql.ts'
import type { AgentRef, WorkflowDefinition } from './definition.ts'
import { type RunLimits, resolveRunLimits } from './limits.ts'

/**
 * Resolved run plan (STEP 10 §6). At run start every mutable reference is
 * frozen: the exact workflow version, the exact agent version per step
 * (current_at_run resolves NOW; pinned names it), the effective limits and
 * the entry step. Persisted as plan_json so the run never depends on
 * "current" settings after it starts — retries and resumes re-resolve
 * nothing.
 */

export interface ResolvedAgent {
  agentId: string
  agentName: string
  agentVersionId: string
  agentVersion: number
  /** Agent status at resolution time; re-checked at every step execution. */
  status: 'active' | 'disabled' | 'archived'
}

export interface RunPlan {
  workflowVersionId: string
  entryStepId: string
  /** stepId → frozen agent resolution (agent steps and tool requestedBy). */
  agents: Record<string, ResolvedAgent>
  limits: RunLimits
}

export type ResolvePlanResult =
  | { ok: true; plan: Omit<RunPlan, 'workflowVersionId'> }
  | { ok: false; message: string }

/** Resolve (and thereby freeze) every agent reference in the definition. */
export async function resolveRunPlan(
  db: SqlDatabase,
  workspaceId: string,
  definition: WorkflowDefinition,
): Promise<ResolvePlanResult> {
  const agents: Record<string, ResolvedAgent> = {}

  const resolveRef = async (stepId: string, ref: AgentRef): Promise<string | null> => {
    const agent = await getAgentById(db, ref.agentId)
    if (!agent || agent.workspaceId !== workspaceId || agent.deletedAt) {
      return `Step '${stepId}' references an unknown agent.`
    }
    if (agent.status === 'disabled') {
      return `${agent.name} is disabled right now. Enable it before running this workflow.`
    }
    if (agent.status === 'archived') {
      return `${agent.name} is archived.`
    }
    const version =
      ref.versionPolicy === 'pinned'
        ? await getAgentVersion(db, ref.agentVersionId)
        : await getCurrentAgentVersion(db, agent)
    if (!version || version.agentId !== agent.id) {
      return `${agent.name} has no usable configuration.`
    }
    if (!parseAgentVersionConfig(version.configJson)) {
      return `${agent.name}'s configuration is invalid.`
    }
    agents[stepId] = {
      agentId: agent.id,
      agentName: agent.name,
      agentVersionId: version.id,
      agentVersion: version.version,
      status: agent.status,
    }
    return null
  }

  for (const step of definition.steps) {
    if (step.type === 'agent') {
      const error = await resolveRef(step.id, step.agent)
      if (error) return { ok: false, message: error }
    }
    if (step.type === 'tool') {
      const error = await resolveRef(step.id, step.requestedBy)
      if (error) return { ok: false, message: error }
    }
  }

  return {
    ok: true,
    plan: {
      entryStepId: definition.entryStepId,
      agents,
      limits: resolveRunLimits(definition.limits),
    },
  }
}

/**
 * Rebuild an AgentHandle for a frozen plan entry. The version is loaded by
 * ID (immutable), never re-resolved to "current" — this is what makes a run
 * reproducible and keeps a mid-run version change from affecting it.
 */
export async function frozenAgentHandle(
  db: SqlDatabase,
  resolved: ResolvedAgent,
): Promise<AgentHandle | null> {
  const agent = await getAgentById(db, resolved.agentId)
  const version = await getAgentVersion(db, resolved.agentVersionId)
  if (!agent || !version || version.agentId !== agent.id) return null
  const config = parseAgentVersionConfig(version.configJson)
  if (!config) return null
  return { agent, version, config }
}
