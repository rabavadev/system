import type {
  AccountStatus,
  AgentExecutionType,
  CampaignStatus,
  ConnectionStatus,
  ConversationScopeType,
  GoalScopeType,
  Id,
  IsoTimestamp,
  MemoryClass,
  MemoryScopeType,
  MemorySourceType,
  MessageSenderType,
  ProductStatus,
  ResearchStatus,
} from '~/types/domain'

/**
 * Context Engine types.
 *
 * Everything here is provider-neutral and JSON-serializable: no database
 * clients, no SDK objects, no classes with behavior, no secrets. A
 * ContextPackage must survive `JSON.stringify` unchanged so future
 * workflow/agent execution can persist "what context did this run get".
 */

/** Scope kinds the engine can resolve as the active scope. */
export type ContextScopeType = 'workspace' | 'brand' | 'niche' | 'product' | 'account' | 'campaign'

/** A resolved scope pointer. `id` is null only for the workspace-wide scope. */
export interface ScopeRef {
  type: ContextScopeType
  id: Id | null
}

/**
 * Which source decided the active scope. Deterministic precedence:
 * explicit > conversation > ui > workspace (see docs/context-engine.md).
 */
export type ContextScopeSource = 'explicit' | 'conversation' | 'ui' | 'workspace'

/** The caller's current task/request, provider-neutral. */
export interface ContextTask {
  text?: string
  metadataJson?: string | null
}

/** Central retrieval limits; see config.ts for defaults. */
export interface ContextLimits {
  recentMessages: number
  maxMemories: number
  maxResearch: number
  maxGoals: number
  /** Completed research older than this (by verification/update) is "aging". */
  researchAgingDays: number
}

/**
 * A context request. Callers ask for context; they never assemble
 * repository queries themselves. All identifiers are optional.
 *
 * - `uiSelection` is the current UI state (source 3). It never overrides a
 *   persisted conversation scope or an explicit identifier.
 * - `campaignId` / `agentId` resolve structurally only (campaigns exist in
 *   the schema; agents return identity metadata, never config/secrets).
 */
export interface ContextRequest {
  workspaceId?: Id
  conversationId?: Id
  brandId?: Id
  nicheId?: Id
  productId?: Id
  accountId?: Id
  campaignId?: Id
  agentId?: Id
  platformId?: Id
  uiSelection?: { brandId?: Id | null }
  task?: ContextTask
  limits?: Partial<ContextLimits>
}

/* ---- Safe entity snapshots (no secrets, no internal columns) ---- */

export interface WorkspaceContext {
  id: Id
  name: string
  slug: string | null
}

export interface BrandContext {
  id: Id
  name: string
  description: string | null
}

export interface NicheContext {
  id: Id
  brandId: Id
  name: string
  description: string | null
}

export interface ProductContext {
  id: Id
  brandId: Id
  nicheId: Id | null
  name: string
  description: string | null
  url: string | null
  status: ProductStatus
}

/**
 * Safe platform metadata. NEVER contains tokens, secrets, or secret_ref
 * pointers — only display identity and connection state.
 */
export interface PlatformContext {
  id: Id
  name: string
  connectionStatus: ConnectionStatus | null
}

export interface AccountContext {
  id: Id
  handle: string
  displayName: string | null
  status: AccountStatus
  /** Active (non-archived) associated niches. */
  nicheIds: Id[]
  platform: PlatformContext
}

export interface CampaignContext {
  id: Id
  name: string
  status: CampaignStatus
  brandId: Id | null
  productId: Id | null
  startsAt: IsoTimestamp | null
  endsAt: IsoTimestamp | null
}

/** Structural agent identity only. Config/instructions are never included. */
export interface AgentContext {
  id: Id
  name: string
  role: string | null
  executionType: AgentExecutionType
}

export interface ConversationContext {
  id: Id
  title: string | null
  scopeType: ConversationScopeType | null
  scopeId: Id | null
  createdAt: IsoTimestamp
}

/**
 * A message as context. `providerMetadataJson` is deliberately NOT carried
 * over: the Context Engine stays provider-neutral end to end.
 */
export interface ContextMessage {
  id: Id
  senderType: MessageSenderType
  agentId: Id | null
  content: string
  createdAt: IsoTimestamp
}

/* ---- Ranked knowledge ---- */

/** Derived freshness. Computed, never stored, so it cannot drift. */
export type Freshness = 'current' | 'aging' | 'stale' | 'expired'

/**
 * How much authority a memory carries. `proposed_learning` is always
 * `hypothesis` and must never be presented as fact downstream.
 */
export type MemoryAuthority = 'fact' | 'trusted' | 'hypothesis' | 'ephemeral'

export interface ContextMemory {
  id: Id
  memoryClass: MemoryClass
  authority: MemoryAuthority
  content: string
  scopeType: MemoryScopeType
  scopeId: Id | null
  confidence: number | null
  sourceType: MemorySourceType
  sourceId: string | null
  evidenceJson: string | null
  /** Included memories are always 'current'; expired ones are excluded. */
  freshness: Freshness
  lastVerifiedAt: IsoTimestamp | null
  expiresAt: IsoTimestamp | null
  createdAt: IsoTimestamp
}

export interface ContextResearch {
  id: Id
  subject: string
  findings: string | null
  status: ResearchStatus
  confidence: number | null
  scopeType: MemoryScopeType | null
  scopeId: Id | null
  /** 'stale' research may be included but is always marked as such. */
  freshness: Freshness
  lastVerifiedAt: IsoTimestamp | null
  updatedAt: IsoTimestamp
  createdAt: IsoTimestamp
}

export interface ContextGoal {
  id: Id
  title: string
  description: string | null
  scopeType: GoalScopeType
  scopeId: Id | null
  targetMetricKey: string | null
  targetValue: number | null
  dueAt: IsoTimestamp | null
}

/* ---- Trace ---- */

export type ContextTraceAction = 'included' | 'excluded' | 'precedence' | 'note'

/**
 * One trace entry. Contains only ids, display labels and reasons — never
 * row dumps, never secrets.
 */
export interface ContextTraceEntry {
  action: ContextTraceAction
  targetType: string
  targetId: Id | null
  label: string | null
  reason: string
}

export interface ContextTrace {
  /** Echo of the requested identifiers (ids only). */
  request: Record<string, string | null>
  /** Which source won scope precedence. */
  scopeSource: ContextScopeSource
  entries: ContextTraceEntry[]
}

/* ---- The package ---- */

export interface ContextPackage {
  generatedAt: IsoTimestamp
  workspace: WorkspaceContext
  /** The most specific resolved scope. */
  activeScope: ScopeRef
  scopeSource: ContextScopeSource
  brand: BrandContext | null
  niche: NicheContext | null
  product: ProductContext | null
  account: AccountContext | null
  platform: PlatformContext | null
  campaign: CampaignContext | null
  agent: AgentContext | null
  conversation: ConversationContext | null
  /** Bounded, chronological (oldest first). */
  recentMessages: ContextMessage[]
  memories: ContextMemory[]
  research: ContextResearch[]
  goals: ContextGoal[]
  currentTask: ContextTask | null
  metadata: {
    limits: ContextLimits
    counts: { messages: number; memories: number; research: number; goals: number }
  }
  trace: ContextTrace
}
