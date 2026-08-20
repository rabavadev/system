export { composeChiefPrompt } from './composer.ts'
export { AI_GENERATION_DEFAULTS, AI_RETRY, AI_TIMEOUTS, resolveModel } from './config.ts'
export { type ExecuteAIDeps, executeAI } from './executor.ts'
// Note: runtime.ts (Worker env wiring) is intentionally NOT re-exported
// here; it imports cloudflare:workers and would break plain-node tests.
export {
  AIAdapterError,
  type AIAdapterRawResponse,
  type AIErrorCode,
  type AIExecutionError,
  type AIExecutionMetadata,
  type AIExecutionRequest,
  type AIExecutionResult,
  type AIExecutionTraceSummary,
  type AIMessage,
  type AIProviderAdapter,
  type AISourceReference,
  type AIToolCall,
  type AIToolDefinition,
  type AIToolTraceSummary,
  type AIUsage,
  type ModelStrategy,
} from './types.ts'
