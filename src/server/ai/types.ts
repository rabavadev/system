import type { AgentExecutionType, Id, IsoTimestamp } from '~/types/domain'

/**
 * Provider-neutral AI execution types.
 *
 * These are OUR types. They are deliberately not shaped like OpenAI
 * ChatCompletion, Anthropic MessageParam or Gemini Content; each provider
 * adapter translates them at the boundary and nothing provider-specific
 * ever flows back out. Everything here is JSON-serializable.
 */

/** Provider-neutral conversation roles. */
export type AIMessageRole = 'system' | 'user' | 'assistant'

export interface AIMessage {
  role: AIMessageRole
  content: string
}

/**
 * Named model strategies. Business logic refers to a strategy, never to a
 * provider/model string; config.ts maps strategy → provider + model.
 */
export type ModelStrategy = 'default' | 'fast' | 'reasoning' | 'cheap' | 'vision'

/** Which agent configuration produced this execution. */
export interface AIAgentRef {
  agentId: Id
  name: string
  versionId: Id
  version: number
  executionType: AgentExecutionType
}

/** Generation settings, provider-neutral subset. */
export interface AIGenerationSettings {
  maxTokens: number
  temperature: number
}

/** Safe, structured metadata for traceability. Never contains secrets. */
export interface AIExecutionMetadata {
  conversationId?: Id
  workspaceId?: Id
  /** Where the context scope came from (explicit/conversation/ui/workspace). */
  scopeSource?: string
  [key: string]: string | number | boolean | null | undefined
}

export interface AIExecutionRequest {
  /** Caller-generated id; used for idempotency and trace correlation. */
  executionId: Id
  agent: AIAgentRef
  /** Provider-neutral messages, already composed (instructions + context). */
  messages: AIMessage[]
  model: { strategy: ModelStrategy }
  generation: AIGenerationSettings
  /** Hard cap for one provider attempt; config supplies the default. */
  timeoutMs?: number
  metadata?: AIExecutionMetadata
}

/** Token usage as reported by the provider, when available. */
export interface AIUsage {
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
}

export type AIErrorCode =
  | 'not_configured'
  | 'invalid_model_config'
  | 'unsupported_execution_type'
  | 'provider_unavailable'
  | 'rate_limited'
  | 'timeout'
  | 'network'
  | 'malformed_response'
  | 'unknown'

export interface AIExecutionError {
  code: AIErrorCode
  /** Safe diagnostic message (server-side). No secrets, no stack traces. */
  message: string
  retryable: boolean
}

export type AIExecutionStatus = 'succeeded' | 'failed'

export interface AIExecutionResult {
  executionId: Id
  status: AIExecutionStatus
  /** Assistant text. Null on failure; a failure NEVER invents content. */
  content: string | null
  finishReason: string | null
  /** Adapter key (e.g. 'workers-ai'), null when nothing ran. */
  provider: string | null
  model: string | null
  usage: AIUsage | null
  latencyMs: number
  /** Number of provider attempts made (1 = no retry happened). */
  attempts: number
  error: AIExecutionError | null
}

/**
 * The adapter contract. An adapter receives OUR request plus the resolved
 * model id and returns a normalized raw response. Adapters are the ONLY
 * place provider SDKs/bindings may be imported.
 */
export interface AIProviderAdapter {
  /** Stable adapter key, e.g. 'workers-ai'. */
  readonly key: string
  execute(input: {
    model: string
    messages: AIMessage[]
    generation: AIGenerationSettings
    signal: AbortSignal
  }): Promise<AIAdapterRawResponse>
}

/** What an adapter returns; the executor normalizes this into a result. */
export interface AIAdapterRawResponse {
  content: string
  finishReason: string | null
  usage: AIUsage | null
}

/** Error thrown BY adapters; the executor maps it to AIExecutionError. */
export class AIAdapterError extends Error {
  readonly code: AIErrorCode
  readonly retryable: boolean

  constructor(code: AIErrorCode, message: string, retryable: boolean) {
    super(message)
    this.name = 'AIAdapterError'
    this.code = code
    this.retryable = retryable
  }
}

/** Snapshot persisted on assistant messages / execution events. Safe only. */
export interface AIExecutionTraceSummary {
  executionId: Id
  provider: string | null
  model: string | null
  strategy: ModelStrategy
  agentId: Id
  agentVersionId: Id
  agentVersion: number
  usage: AIUsage | null
  latencyMs: number
  attempts: number
  finishReason: string | null
  contextGeneratedAt: IsoTimestamp | null
  scopeSource: string | null
}
