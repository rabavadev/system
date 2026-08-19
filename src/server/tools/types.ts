import type { z } from 'zod'
import type { Id, IsoTimestamp } from '~/types/domain'
import type { AgentCapability } from '../agents/config.ts'

/**
 * Provider-neutral Tool Registry types.
 *
 * A ToolDefinition is OUR contract: stable key, human metadata, category,
 * server-side input/output schemas, the agent capability required to even
 * attempt it, risk classification, status and execution policy. It is
 * deliberately NOT an OpenAI/Anthropic tool schema; provider-specific tool
 * schemas are generated later by adapters from these definitions.
 *
 * Everything crossing the boundary is JSON-serializable and secret-free.
 * Adapter SDK payloads never leak out of `adapters/*`.
 */

/** Stable tool keys. Never rename; add new keys instead. */
export const TOOL_KEYS = [
  'workspace.get_current_context',
  'workspace.get_product',
  'workspace.list_products',
  'workspace.get_account',
  'workspace.list_accounts',
  'memory.list_relevant',
  'research.list_relevant',
  'analytics.read',
  'web.search',
  'files.list',
  'files.read',
  'image.generate',
  'platform.get_posts',
  'platform.get_analytics',
  'platform.publish',
] as const
export type ToolKey = (typeof TOOL_KEYS)[number]

export const TOOL_CATEGORIES = [
  'workspace',
  'memory',
  'research',
  'files',
  'web',
  'content',
  'analytics',
  'media',
  'platform',
  'system',
] as const
export type ToolCategory = (typeof TOOL_CATEGORIES)[number]

/** Risk is a set: platform.publish is both 'external' and 'write'. */
export const TOOL_RISKS = ['read', 'write', 'external', 'sensitive', 'destructive'] as const
export type ToolRisk = (typeof TOOL_RISKS)[number]

export const TOOL_STATUSES = ['available', 'disabled', 'needs_setup', 'unavailable'] as const
export type ToolStatus = (typeof TOOL_STATUSES)[number]

/** Internal tools use our repositories; external tools reach outside later. */
export type ToolOrigin = 'internal' | 'external'
export type ToolExecutionMode = 'sync'
export type ToolCostClass = 'none' | 'metered'

export interface ToolDefinition {
  key: ToolKey
  /** Human name ("Web search"), never a function signature. */
  name: string
  description: string
  category: ToolCategory
  /** Server-side validation. AI- or client-supplied arguments are never trusted. */
  inputSchema: z.ZodTypeAny
  /** Adapter output must satisfy this contract before it reaches a caller. */
  outputSchema: z.ZodTypeAny
  /** The STEP 8 capability required to request this tool. */
  requiredCapability: AgentCapability
  risk: readonly ToolRisk[]
  executionMode: ToolExecutionMode
  status: ToolStatus
  origin: ToolOrigin
  version: number
  /** Central timeout policy override. Defaults live in executor.ts. */
  timeoutMs?: number
  cost: ToolCostClass
  /**
   * Approval is a separate layer from capability and availability. Only
   * future write/external tools opt in; STEP 9 builds no approval workflow,
   * but executeTool can already return approval_required instead of running.
   */
  approval?: 'never' | 'required'
  /** Safe argument summary for audit/dev traces. Never secrets. */
  summarizeInput?: (input: unknown) => Record<string, string | number | boolean | null>
}

/** Who is asking. Resolved server-side from the Agent Registry; never client config. */
export interface ToolCaller {
  agentId: Id
  agentVersionId: Id
  agentName: string
  agentStatus: 'active' | 'disabled' | 'archived'
  capabilities: readonly AgentCapability[]
}

/** Optional execution context so read tools can stay inside the Context Engine. */
export interface ToolExecutionContext {
  conversationId?: Id
  uiBrandId?: Id | null
  taskText?: string
}

export const TOOL_ERROR_CODES = [
  'tool_not_found',
  'tool_disabled',
  'capability_denied',
  'invalid_input',
  'scope_denied',
  'approval_required',
  'not_configured',
  'no_data',
  'execution_failed',
  'timeout',
] as const
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number]

/** Controlled error adapters may throw. Messages must be user/agent safe. */
export class ToolError extends Error {
  readonly code: ToolErrorCode

  constructor(code: ToolErrorCode, message: string) {
    super(message)
    this.name = 'ToolError'
    this.code = code
  }
}

export type ToolExecutionStatus = 'succeeded' | 'failed'

export interface ToolExecutionResult {
  executionId: Id
  toolKey: ToolKey | string
  ok: boolean
  status: ToolExecutionStatus
  data: unknown | null
  error: { code: ToolErrorCode; message: string } | null
  durationMs: number
  /** Safe trace metadata only: ids, labels, counts. Never secrets/args dumps. */
  metadata: {
    workspaceId: Id
    agentId: Id
    agentVersionId: Id
    category: ToolCategory | null
    risk: readonly ToolRisk[]
    requiredCapability: AgentCapability | null
    idempotencyKey: string | null
    createdAt: IsoTimestamp
  }
}

/** The adapter contract. Implementations live in adapters/* and never leak SDKs. */
export interface ToolAdapter {
  readonly key: ToolKey
  run(input: {
    db: import('../db/sql.ts').SqlDatabase
    workspaceId: Id
    args: unknown
    caller: ToolCaller
    context?: ToolExecutionContext
  }): Promise<unknown>
}

/** Safe descriptor for UI/discovery. No schemas, no handlers, no secrets. */
export interface ToolDescriptor {
  key: ToolKey
  name: string
  description: string
  category: ToolCategory
  status: ToolStatus
  risk: readonly ToolRisk[]
  requiredCapability: AgentCapability
  origin: ToolOrigin
  version: number
  cost: ToolCostClass
}
