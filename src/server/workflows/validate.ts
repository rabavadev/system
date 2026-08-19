import { getAgentById, getAgentVersion } from '../db/agent.ts'
import type { SqlDatabase } from '../db/sql.ts'
import { listToolDefinitions } from '../tools/registry.ts'
import type { WorkflowDefinition, WorkflowStepDef } from './definition.ts'
import { workflowDefinitionSchema } from './definition.ts'
import { WORKFLOW_LIMITS } from './limits.ts'

/**
 * Static validation of a WorkflowDefinition BEFORE a version can be
 * activated or run. Structural errors come from the zod schema; this module
 * adds graph checks (targets, cycles, termination, reachability) and
 * referential checks (agents exist, pinned versions belong to the agent,
 * tool keys are registered, bindings point at declared inputs/steps).
 *
 * Validation NEVER executes anything and never trusts the client.
 */

export interface WorkflowValidation {
  ok: boolean
  errors: string[]
  warnings: string[]
}

/** Transition targets of a step (next, branches, failure fallback). */
function targetsOf(step: WorkflowStepDef): (string | null)[] {
  if (step.type === 'end') return []
  const targets: (string | null)[] = []
  if (step.type === 'condition') {
    targets.push(step.branches.yes, step.branches.no)
  } else {
    targets.push(step.next)
  }
  if (step.onFailure?.action === 'goto') targets.push(step.onFailure.stepId)
  return targets
}

/** All steps that can reach `stepId` — used to detect cycles via DFS. */
function findCycleSteps(definition: WorkflowDefinition): Set<string> {
  const graph = new Map<string, string[]>()
  for (const step of definition.steps) {
    graph.set(
      step.id,
      targetsOf(step).filter((t): t is string => t !== null),
    )
  }
  const inCycle = new Set<string>()
  const state = new Map<string, 'visiting' | 'done'>()

  const visit = (id: string, stack: string[]) => {
    if (state.get(id) === 'done') return
    if (state.get(id) === 'visiting') {
      // Everything from the first occurrence of id on the stack is in a cycle.
      const start = stack.indexOf(id)
      for (const stepId of stack.slice(start)) inCycle.add(stepId)
      return
    }
    state.set(id, 'visiting')
    for (const next of graph.get(id) ?? []) visit(next, [...stack, id])
    state.set(id, 'done')
  }

  for (const step of definition.steps) visit(step.id, [])
  return inCycle
}

function effectiveMaxVisits(step: WorkflowStepDef): number | null {
  if (step.type === 'end') return 1
  if (step.maxVisits === null) return null // explicit unbounded request
  return step.maxVisits ?? WORKFLOW_LIMITS.maxVisitsPerStep
}

export async function validateWorkflowDefinition(
  db: SqlDatabase,
  workspaceId: string,
  raw: unknown,
  opts?: { toolDefinitions?: readonly { key: string }[] },
): Promise<WorkflowValidation & { definition: WorkflowDefinition | null }> {
  const errors: string[] = []
  const warnings: string[] = []

  const parsed = workflowDefinitionSchema.safeParse(raw)
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 10)) {
      errors.push(`${issue.path.join('.') || 'definition'}: ${issue.message}`)
    }
    return { ok: false, errors, warnings, definition: null }
  }
  const definition = parsed.data
  const byId = new Map(definition.steps.map((step) => [step.id, step]))

  /* ---- Graph ---- */

  if (!byId.has(definition.entryStepId)) {
    errors.push(`Entry step '${definition.entryStepId}' does not exist.`)
  }
  for (const step of definition.steps) {
    for (const target of targetsOf(step)) {
      if (target !== null && !byId.has(target)) {
        errors.push(`Step '${step.id}' points at unknown step '${target}'.`)
      }
    }
  }
  if (definition.output && !byId.has(definition.output.stepId)) {
    errors.push(`Run output references unknown step '${definition.output.stepId}'.`)
  }

  // Reachability from the entry step.
  const reachable = new Set<string>()
  const walk = (id: string | null) => {
    if (id === null || reachable.has(id)) return
    const step = byId.get(id)
    if (!step) return
    reachable.add(id)
    for (const target of targetsOf(step)) walk(target)
  }
  walk(definition.entryStepId)
  for (const step of definition.steps) {
    if (!reachable.has(step.id)) {
      warnings.push(`Step '${step.id}' can never be reached from the entry step.`)
    }
  }

  // At least one reachable path must terminate.
  const terminates = new Set<string>()
  const checkTerminates = (id: string | null, seen: Set<string>): boolean => {
    if (id === null) return true
    if (terminates.has(id)) return true
    if (seen.has(id)) return false
    const step = byId.get(id)
    if (!step) return false
    seen.add(id)
    const targets = targetsOf(step)
    const result = targets.length === 0 || targets.some((t) => checkTerminates(t, seen))
    if (result) terminates.add(id)
    return result
  }
  if (byId.has(definition.entryStepId) && !checkTerminates(definition.entryStepId, new Set())) {
    errors.push('The workflow has no path that reaches an end.')
  }

  // Cycles must be bounded.
  for (const stepId of findCycleSteps(definition)) {
    const step = byId.get(stepId)
    if (step && effectiveMaxVisits(step) === null) {
      errors.push(
        `Step '${stepId}' is inside a loop but declares no visit limit. Loops must be bounded.`,
      )
    }
  }

  /* ---- Bindings ---- */

  const inputKeys = new Set(definition.inputs.map((input) => input.key))
  for (const step of definition.steps) {
    const bindings = step.type === 'agent' || step.type === 'tool' ? step.inputs : []
    for (const binding of bindings) {
      if (binding.value.source === 'workflow_input') {
        const root = binding.value.path.split('.')[0] ?? ''
        if (!inputKeys.has(root)) {
          errors.push(`Step '${step.id}' reads workflow input '${root}', which is not declared.`)
        }
      }
      if (binding.value.source === 'step_output') {
        if (!byId.has(binding.value.stepId)) {
          errors.push(`Step '${step.id}' reads output of unknown step '${binding.value.stepId}'.`)
        } else if (binding.value.stepId === step.id) {
          errors.push(`Step '${step.id}' cannot read its own output.`)
        }
      }
    }
    if (step.type === 'condition' && step.condition.left.source === 'step_output') {
      if (!byId.has(step.condition.left.stepId)) {
        errors.push(
          `Condition '${step.id}' reads output of unknown step '${step.condition.left.stepId}'.`,
        )
      } else if (step.condition.left.stepId === step.id) {
        errors.push(`Condition '${step.id}' cannot read its own output.`)
      }
    }
    if (step.type === 'condition' && step.condition.left.source === 'workflow_input') {
      const root = step.condition.left.path.split('.')[0] ?? ''
      if (!inputKeys.has(root)) {
        errors.push(`Condition '${step.id}' reads undeclared workflow input '${root}'.`)
      }
    }
  }

  /* ---- References ---- */

  const toolKeys = new Set<string>(
    (opts?.toolDefinitions ?? listToolDefinitions()).map((tool) => tool.key),
  )
  for (const step of definition.steps) {
    if (step.type === 'tool' && !toolKeys.has(step.toolKey)) {
      errors.push(`Step '${step.id}' uses unknown tool '${step.toolKey}'.`)
    }
    const refs =
      step.type === 'agent' ? [step.agent] : step.type === 'tool' ? [step.requestedBy] : []
    for (const ref of refs) {
      const agent = await getAgentById(db, ref.agentId)
      if (!agent || agent.workspaceId !== workspaceId || agent.deletedAt) {
        errors.push(`Step '${step.id}' references an unknown agent.`)
        continue
      }
      if (agent.status === 'disabled') {
        warnings.push(`Step '${step.id}' uses ${agent.name}, which is currently disabled.`)
      }
      if (agent.status === 'archived') {
        errors.push(`Step '${step.id}' uses ${agent.name}, which is archived.`)
      }
      if (ref.versionPolicy === 'pinned') {
        const version = await getAgentVersion(db, ref.agentVersionId)
        if (!version || version.agentId !== ref.agentId) {
          errors.push(`Step '${step.id}' pins an agent version that does not exist.`)
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings, definition }
}
