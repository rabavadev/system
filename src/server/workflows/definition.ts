import { z } from 'zod'

import { WORKFLOW_LIMITS } from './limits.ts'

/**
 * The ONE declarative workflow definition format. A WorkflowDefinition is
 * DATA: it is validated with zod, stored as JSON in workflow_version, and
 * interpreted by the engine. There is no executable code anywhere in it —
 * no eval, no expressions, no template language. Steps reference registered
 * agents and tools by identity; values flow through typed bindings.
 */

/** A JSON-serializable value. Bindings and outputs only carry these. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue }

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string().max(WORKFLOW_LIMITS.maxInputValueChars),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
)

const stepIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(WORKFLOW_LIMITS.maxStepIdChars)
  .regex(/^[a-z][a-z0-9_-]*$/, 'Step ids look like research-product or review_2.')

/** Dotted path into plain JSON data. Never an expression, never evaluated. */
const pathSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_.-]+$/, 'Paths are dotted keys like result.score.')

/** Safe value sources. The engine resolves these; nothing is code. */
const bindingSourceSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('workflow_input'), path: pathSchema }).strict(),
  z
    .object({
      source: z.literal('step_output'),
      stepId: stepIdSchema,
      path: pathSchema,
    })
    .strict(),
  z.object({ source: z.literal('literal'), value: jsonValueSchema }).strict(),
  z
    .object({
      source: z.literal('run'),
      path: z.enum(['runId', 'workflowId', 'workflowVersionId']),
    })
    .strict(),
])
export type BindingSource = z.infer<typeof bindingSourceSchema>

const bindingSchema = z
  .object({
    /** Name under which the value appears in the step's resolved inputs. */
    key: z.string().trim().min(1).max(60),
    value: bindingSourceSchema,
  })
  .strict()
export type StepBinding = z.infer<typeof bindingSchema>

/** Declared workflow inputs; validated before a run is allowed to start. */
export const workflowInputSchema = z
  .object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .regex(/^[a-z][a-z0-9_]*$/, 'Input keys look like product_id.'),
    label: z.string().trim().min(1).max(80),
    /** Entity kinds become explicit Context Engine references at run start. */
    kind: z.enum(['text', 'brand', 'niche', 'product', 'account', 'campaign']),
    required: z.boolean().default(true),
  })
  .strict()
export type WorkflowInputDecl = z.infer<typeof workflowInputSchema>

/**
 * Agent version policy. `current_at_run` resolves the agent's current
 * version ONCE at run start and freezes it for the whole run. `pinned`
 * names an exact immutable agent version.
 */
const agentRefSchema = z.discriminatedUnion('versionPolicy', [
  z
    .object({
      agentId: z.uuid(),
      versionPolicy: z.literal('current_at_run'),
    })
    .strict(),
  z
    .object({
      agentId: z.uuid(),
      versionPolicy: z.literal('pinned'),
      agentVersionId: z.uuid(),
    })
    .strict(),
])
export type AgentRef = z.infer<typeof agentRefSchema>

const retrySchema = z
  .object({
    /** Bounded retries for RETRYABLE failures only. Never for bad input. */
    maxAttempts: z.number().int().min(1).max(3),
  })
  .strict()

const failureActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('fail') }).strict(),
  z.object({ action: z.literal('goto'), stepId: stepIdSchema }).strict(),
])
export type FailureAction = z.infer<typeof failureActionSchema>

const stepBase = {
  id: stepIdSchema,
  next: stepIdSchema.nullable(),
  onFailure: failureActionSchema.optional(),
  /**
   * Per-step visit bound for loops. Omitted = the run limit applies.
   * Explicit null requests NO bound, which validation rejects when the step
   * sits inside a cycle (unbounded cycles are never allowed).
   */
  maxVisits: z.number().int().min(1).max(WORKFLOW_LIMITS.maxVisitsPerStep).nullish(),
}

export const agentStepSchema = z
  .object({
    ...stepBase,
    type: z.literal('agent'),
    agent: agentRefSchema,
    /** The step's task. Agent IDENTITY instructions stay in agent_version. */
    task: z.string().trim().min(1).max(WORKFLOW_LIMITS.maxTaskChars),
    inputs: z.array(bindingSchema).max(WORKFLOW_LIMITS.maxBindingsPerStep).default([]),
    retry: retrySchema.optional(),
  })
  .strict()

export const toolStepSchema = z
  .object({
    ...stepBase,
    type: z.literal('tool'),
    toolKey: z.string().trim().min(1).max(120),
    /** The agent role responsible for the call; capability checks apply. */
    requestedBy: agentRefSchema,
    inputs: z.array(bindingSchema).max(WORKFLOW_LIMITS.maxBindingsPerStep).default([]),
    retry: retrySchema.optional(),
  })
  .strict()

export const CONDITION_OPERATORS = [
  'equals',
  'not_equals',
  'exists',
  'not_exists',
  'greater_than',
  'greater_or_equal',
  'less_than',
  'less_or_equal',
] as const
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number]

export const conditionStepSchema = z
  .object({
    id: stepIdSchema,
    type: z.literal('condition'),
    condition: z
      .object({
        left: bindingSourceSchema,
        operator: z.enum(CONDITION_OPERATORS),
        /** Comparison value for relational/equality operators. */
        value: jsonValueSchema.optional(),
      })
      .strict(),
    /** Branch targets. `null` terminates the run on that branch. */
    branches: z
      .object({
        yes: stepIdSchema.nullable(),
        no: stepIdSchema.nullable(),
      })
      .strict(),
    onFailure: failureActionSchema.optional(),
    maxVisits: z.number().int().min(1).max(WORKFLOW_LIMITS.maxVisitsPerStep).nullish(),
  })
  .strict()

/** Explicit terminal step. `next: null` on any step also terminates. */
export const endStepSchema = z
  .object({
    id: stepIdSchema,
    type: z.literal('end'),
  })
  .strict()

export const workflowStepSchema = z.discriminatedUnion('type', [
  agentStepSchema,
  toolStepSchema,
  conditionStepSchema,
  endStepSchema,
])
export type WorkflowStepDef = z.infer<typeof workflowStepSchema>

const FORBIDDEN_VALUE = /^(sk-|xox[baprs]-|Bearer\s+|-----BEGIN )/i

function containsSecretLike(value: unknown): boolean {
  if (typeof value === 'string') return FORBIDDEN_VALUE.test(value)
  if (Array.isArray(value)) return value.some(containsSecretLike)
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(containsSecretLike)
  }
  return false
}

export const workflowDefinitionSchema = z
  .object({
    entryStepId: stepIdSchema,
    inputs: z.array(workflowInputSchema).max(WORKFLOW_LIMITS.maxInputsPerDefinition).default([]),
    steps: z.array(workflowStepSchema).min(1).max(WORKFLOW_LIMITS.maxStepsPerDefinition),
    /** Which step's output becomes the run result. */
    output: z
      .object({
        stepId: stepIdSchema,
        path: pathSchema.optional(),
      })
      .strict()
      .optional(),
    /** May only tighten the global bounds (limits.ts clamps them anyway). */
    limits: z
      .object({
        maxStepExecutions: z.number().int().min(1).optional(),
        maxVisitsPerStep: z.number().int().min(1).optional(),
        maxAgentExecutions: z.number().int().min(1).optional(),
        maxToolExecutions: z.number().int().min(1).optional(),
        maxRunDurationMs: z.number().int().min(1000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((definition, ctx) => {
    const seen = new Set<string>()
    for (const step of definition.steps) {
      if (seen.has(step.id)) {
        ctx.addIssue({ code: 'custom', message: `Duplicate step id '${step.id}'.` })
      }
      seen.add(step.id)
      if (step.type === 'agent' || step.type === 'tool') {
        for (const binding of step.inputs) {
          if (binding.value.source === 'literal' && containsSecretLike(binding.value.value)) {
            ctx.addIssue({
              code: 'custom',
              message: `Step '${step.id}' binding '${binding.key}' looks like a secret.`,
            })
          }
        }
      }
    }
    const inputKeys = new Set<string>()
    for (const input of definition.inputs) {
      if (inputKeys.has(input.key)) {
        ctx.addIssue({ code: 'custom', message: `Duplicate input key '${input.key}'.` })
      }
      inputKeys.add(input.key)
    }
  })
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>

/** Parse + structural-validate a definition. Throws zod errors. */
export function parseWorkflowDefinition(json: string): WorkflowDefinition {
  if (json.length > WORKFLOW_LIMITS.maxDefinitionChars) {
    throw new Error('Workflow definition is too large.')
  }
  return workflowDefinitionSchema.parse(JSON.parse(json))
}
