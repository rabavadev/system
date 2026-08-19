/**
 * Public surface of the Context Engine. Callers import `buildContext` and
 * the request/package types — nothing else. Repository details, ranking
 * internals and SQL stay behind this module boundary.
 */

export { DEFAULT_CONTEXT_LIMITS, resolveLimits } from './config.ts'
export { buildContext } from './engine.ts'
export type { ContextErrorCode } from './errors.ts'
export { ContextError, toContextErrorPayload } from './errors.ts'
export type {
  AccountContext,
  AgentContext,
  BrandContext,
  CampaignContext,
  ContextGoal,
  ContextLimits,
  ContextMemory,
  ContextMessage,
  ContextPackage,
  ContextRequest,
  ContextResearch,
  ContextScopeSource,
  ContextScopeType,
  ContextTask,
  ContextTrace,
  ContextTraceEntry,
  ConversationContext,
  Freshness,
  MemoryAuthority,
  NicheContext,
  PlatformContext,
  ProductContext,
  ScopeRef,
  WorkspaceContext,
} from './types.ts'
