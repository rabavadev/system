import { ContextError } from '../context/index.ts'
import { emitEventSafe } from '../db/event.ts'
import { newId, nowIso, type SqlDatabase } from '../db/sql.ts'
import { resolveActionKeyForTool } from '../policy/tool-action.ts'
import type { ActionKey } from '../policy/types.ts'
import { TOOL_ADAPTERS } from './adapters/index.ts'
import { filterToolsForCaller, listToolDefinitions } from './registry.ts'
import type {
  ToolAdapter,
  ToolCaller,
  ToolDefinition,
  ToolDescriptor,
  ToolErrorCode,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolKey,
} from './types.ts'
import { ToolError } from './types.ts'

/**
 * The ONE tool execution boundary. Every current and future agent tool call
 * goes through executeTool:
 *
 *   tool key → registry lookup → agent status → capability check → tool
 *   status/configuration → input validation → adapter presence → approval
 *   gate (separate layer) → adapter → output contract → safe audit event.
 *
 * Adapters are never invoked after capability denial, and external SDK
 * payloads never escape: results are validated against the tool's output
 * contract before returning.
 */

const INTERNAL_TIMEOUT_MS = 5_000
const EXTERNAL_TIMEOUT_MS = 10_000

export interface ExecuteToolInput {
  db: SqlDatabase
  workspaceId: string
  toolKey: string
  args?: unknown
  caller: ToolCaller
  context?: ToolExecutionContext
  /** Foundation for future write tools; read tools ignore it. */
  idempotencyKey?: string
  /** Separate from capability: future write tools may require approval. */
  approvalGranted?: boolean
}

export interface PrepareToolExecutionInput {
  workspaceId: string
  toolKey: string
  args?: unknown
  caller: ToolCaller
}

export type ToolPreparationResult =
  | {
      ok: true
      definition: ToolDefinition
      adapter: ToolAdapter
      parsedArgs: unknown
      actionKey: ActionKey
    }
  | {
      ok: false
      error: {
        code: ToolErrorCode
        message: string
      }
      definition: ToolDefinition | null
    }

export interface ExecuteToolDeps {
  definitions?: readonly ToolDefinition[]
  adapters?: ReadonlyMap<ToolKey, ToolAdapter>
  now?: () => number
}

function definitionMap(
  definitions: readonly ToolDefinition[],
): ReadonlyMap<string, ToolDefinition> {
  return new Map(definitions.map((definition) => [definition.key, definition]))
}

function safeMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback
  return message.slice(0, 300)
}

function contextErrorCode(error: ContextError): ToolErrorCode {
  switch (error.code) {
    case 'entity_not_found':
    case 'entity_archived':
    case 'scope_conflict':
    case 'workspace_mismatch':
    case 'conversation_mismatch':
    case 'invalid_relationship':
      return 'scope_denied'
    default:
      return 'execution_failed'
  }
}

interface FailureArgs {
  input: ExecuteToolInput
  definition: ToolDefinition | null
  startedAt: number
  executionId: string
  code: ToolErrorCode
  message: string
}

async function fail(args: FailureArgs): Promise<ToolExecutionResult> {
  const { input, definition, startedAt, executionId, code, message } = args
  const durationMs = Math.max(0, Date.now() - startedAt)
  await emitEventSafe(input.db, {
    workspaceId: input.workspaceId,
    eventType: 'tool.execution.failed',
    actorType: 'agent',
    actorId: input.caller.agentId,
    subjectType: 'tool',
    payloadJson: JSON.stringify({
      executionId,
      toolKey: input.toolKey.slice(0, 120),
      agentVersionId: input.caller.agentVersionId,
      category: definition?.category ?? null,
      risk: definition?.risk ?? [],
      requiredCapability: definition?.requiredCapability ?? null,
      code,
      durationMs,
      argsSummary: definition?.summarizeInput?.(input.args) ?? {},
      idempotencyKey: input.idempotencyKey ?? null,
    }),
  })
  return {
    executionId,
    toolKey: definition?.key ?? input.toolKey,
    ok: false,
    status: 'failed',
    data: null,
    error: { code, message },
    durationMs,
    metadata: {
      workspaceId: input.workspaceId,
      agentId: input.caller.agentId,
      agentVersionId: input.caller.agentVersionId,
      category: definition?.category ?? null,
      risk: definition?.risk ?? [],
      requiredCapability: definition?.requiredCapability ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      createdAt: nowIso(),
    },
  }
}

async function runWithTimeout(
  definition: ToolDefinition,
  work: Promise<unknown>,
): Promise<unknown> {
  const timeoutMs =
    definition.timeoutMs ??
    (definition.origin === 'external' ? EXTERNAL_TIMEOUT_MS : INTERNAL_TIMEOUT_MS)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new ToolError('timeout', 'The tool took too long to respond.'))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Prepares and validates a requested tool call without executing the adapter.
 * Used by both executeTool and the direct Agent task policy loop to avoid
 * creating approval requests for malformed, unpermitted, or unconfigured tools.
 */
export function prepareToolExecution(
  input: PrepareToolExecutionInput,
  deps: ExecuteToolDeps = {},
): ToolPreparationResult {
  const definitions = deps.definitions ?? listToolDefinitions()
  const definition = definitionMap(definitions).get(input.toolKey) ?? null

  if (!definition) {
    return {
      ok: false,
      error: {
        code: 'tool_not_found',
        message: 'That tool does not exist.',
      },
      definition: null,
    }
  }

  // 1. Agent is allowed to request it. Disabled/archived agents get nothing.
  if (input.caller.agentStatus !== 'active') {
    return {
      ok: false,
      error: {
        code: 'capability_denied',
        message: `${input.caller.agentName} is not active right now.`,
      },
      definition,
    }
  }
  if (!input.caller.capabilities.includes(definition.requiredCapability)) {
    return {
      ok: false,
      error: {
        code: 'capability_denied',
        message: `${input.caller.agentName} is not allowed to use ${definition.name}.`,
      },
      definition,
    }
  }

  // 2. Tool is available/configured. Capability never implies availability.
  if (definition.status === 'disabled') {
    return {
      ok: false,
      error: {
        code: 'tool_disabled',
        message: `${definition.name} is disabled.`,
      },
      definition,
    }
  }
  if (definition.status === 'needs_setup' || definition.status === 'unavailable') {
    return {
      ok: false,
      error: {
        code: 'not_configured',
        message:
          definition.status === 'needs_setup'
            ? `${definition.name} needs setup before it can be used.`
            : `${definition.name} is not available yet.`,
      },
      definition,
    }
  }

  const adapters = deps.adapters ?? TOOL_ADAPTERS
  const adapter = adapters.get(definition.key)
  if (!adapter) {
    return {
      ok: false,
      error: {
        code: 'not_configured',
        message: `${definition.name} has no configured implementation.`,
      },
      definition,
    }
  }
  if (typeof adapter.isConfigured === 'function' && !adapter.isConfigured()) {
    return {
      ok: false,
      error: {
        code: 'not_configured',
        message: `${definition.name} needs setup before it can be used.`,
      },
      definition,
    }
  }

  // 3. Input is validated server-side. AI- or client-supplied args are data,
  // never code and never trusted.
  const parsedInput = definition.inputSchema.safeParse(input.args ?? {})
  if (!parsedInput.success) {
    return {
      ok: false,
      error: {
        code: 'invalid_input',
        message: `Invalid input for ${definition.name}.`,
      },
      definition,
    }
  }

  const actionKey = resolveActionKeyForTool(definition.key, definition)

  return {
    ok: true,
    definition,
    adapter,
    parsedArgs: parsedInput.data,
    actionKey,
  }
}

export async function executeTool(
  input: ExecuteToolInput,
  deps: ExecuteToolDeps = {},
): Promise<ToolExecutionResult> {
  const startedAt = (deps.now ?? Date.now)()
  const executionId = newId()

  const prep = prepareToolExecution(input, deps)
  if (!prep.ok) {
    return fail({
      input,
      definition: prep.definition,
      startedAt,
      executionId,
      code: prep.error.code,
      message: prep.error.message,
    })
  }

  const { definition, adapter, parsedArgs } = prep

  // 4. Approval is a separate gate. STEP 9 has no approval workflow, but an
  // approval-gated tool can never execute merely because capability exists.
  if (definition.approval === 'required' && input.approvalGranted !== true) {
    return fail({
      input,
      definition,
      startedAt,
      executionId,
      code: 'approval_required',
      message: `${definition.name} needs approval before it can run.`,
    })
  }

  let output: unknown
  try {
    output = await runWithTimeout(
      definition,
      adapter.run({
        db: input.db,
        workspaceId: input.workspaceId,
        args: parsedArgs,
        caller: input.caller,
        ...(input.context ? { context: input.context } : {}),
      }),
    )
  } catch (error) {
    if (error instanceof ToolError) {
      return fail({
        input,
        definition,
        startedAt,
        executionId,
        code: error.code,
        message: error.message,
      })
    }
    if (error instanceof ContextError) {
      return fail({
        input,
        definition,
        startedAt,
        executionId,
        code: contextErrorCode(error),
        message: error.message,
      })
    }
    return fail({
      input,
      definition,
      startedAt,
      executionId,
      code: 'execution_failed',
      message: safeMessage(error, `${definition.name} failed.`),
    })
  }

  const parsedOutput = definition.outputSchema.safeParse(output)
  if (!parsedOutput.success) {
    return fail({
      input,
      definition,
      startedAt,
      executionId,
      code: 'execution_failed',
      message: `${definition.name} returned an unexpected result.`,
    })
  }

  const durationMs = Math.max(0, Date.now() - startedAt)
  await emitEventSafe(input.db, {
    workspaceId: input.workspaceId,
    eventType: 'tool.execution.completed',
    actorType: 'agent',
    actorId: input.caller.agentId,
    subjectType: 'tool',
    payloadJson: JSON.stringify({
      executionId,
      toolKey: definition.key,
      agentVersionId: input.caller.agentVersionId,
      category: definition.category,
      risk: definition.risk,
      requiredCapability: definition.requiredCapability,
      durationMs,
      argsSummary: definition.summarizeInput?.(parsedArgs) ?? {},
      idempotencyKey: input.idempotencyKey ?? null,
    }),
  })

  return {
    executionId,
    toolKey: definition.key,
    ok: true,
    status: 'succeeded',
    data: parsedOutput.data,
    error: null,
    durationMs,
    metadata: {
      workspaceId: input.workspaceId,
      agentId: input.caller.agentId,
      agentVersionId: input.caller.agentVersionId,
      category: definition.category,
      risk: definition.risk,
      requiredCapability: definition.requiredCapability,
      idempotencyKey: input.idempotencyKey ?? null,
      createdAt: nowIso(),
    },
  }
}

/**
 * Tool discovery for the AI execution layer: which tools can THIS agent
 * version actually use right now? Unavailable, disabled, unconfigured and
 * unpermitted tools are not sent to a model.
 */
export function getAvailableTools(
  caller: ToolCaller,
  deps: ExecuteToolDeps = {},
): ToolDescriptor[] {
  const adapters = deps.adapters ?? TOOL_ADAPTERS
  return filterToolsForCaller(caller, deps.definitions ?? listToolDefinitions()).filter(
    (descriptor) => {
      const adapter = adapters.get(descriptor.key)
      if (!adapter) return false
      if (typeof adapter.isConfigured === 'function') {
        return adapter.isConfigured()
      }
      return true
    },
  )
}
