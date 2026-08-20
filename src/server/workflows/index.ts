/**
 * Public surface of the Workflow Engine (STEP 10). Callers import from here
 * — internals (bindings, conditions, graph validation) stay behind the
 * module boundary.
 */

export { getPathValue, resolveBindingSource, resolveBindings } from './bindings.ts'
export { evaluateCondition } from './conditions.ts'
export type {
  AgentRef,
  BindingSource,
  ConditionOperator,
  JsonValue,
  StepBinding,
  WorkflowDefinition,
  WorkflowInputDecl,
  WorkflowStepDef,
} from './definition.ts'
export {
  CONDITION_OPERATORS,
  parseWorkflowDefinition,
  workflowDefinitionSchema,
} from './definition.ts'
export type {
  AuthorizedApproval,
  DriveRunOptions,
  StartRunResult,
  WorkflowEngineDeps,
} from './engine.ts'
export {
  cancelWorkflowRun,
  driveRun,
  resumeWorkflowAfterApproval,
  resumeWorkflowRun,
  startWorkflowRun,
} from './engine.ts'
export type { RunLimits } from './limits.ts'
export { boundedSnapshot, resolveRunLimits, WORKFLOW_LIMITS } from './limits.ts'
export type { ResolvedAgent, RunPlan } from './plan.ts'
export { resolveActionKeyForTool } from './policy.ts'
export type { WorkflowRuntime } from './runtime.ts'
export { resolveWorkflowRuntime } from './runtime.ts'
export {
  changeWorkflowStatus,
  checkWorkflowDefinition,
  createWorkflowWithVersion,
  definitionOf,
  saveWorkflowVersion,
  updateWorkflowDetails,
} from './service.ts'
export type { WorkflowValidation } from './validate.ts'
export { validateWorkflowDefinition } from './validate.ts'
