/**
 * Core domain model, mirroring the D1 schema in camelCase.
 *
 * Conventions:
 *   * Ids are UUID strings, generated application-side.
 *   * Timestamps are ISO-8601 UTC strings.
 *   * `*Json` fields are raw JSON text as stored; parse at the point of use.
 *   * Scoped references (scopeType/scopeId, subjectType/subjectId) are
 *     validated application-side, not by foreign keys. See docs/database.md.
 *
 * These types carry no behavior. Database access lives in `src/server/db`,
 * UI in `src/features`.
 */

export type Id = string
export type IsoTimestamp = string

/* ---- Scoped reference vocabularies ---- */

export type MemoryScopeType =
  | 'workspace'
  | 'brand'
  | 'niche'
  | 'account'
  | 'platform'
  | 'product'
  | 'campaign'

export type GoalScopeType = 'workspace' | 'brand' | 'product' | 'campaign'

/** Entities a conversation can optionally be about. NULL scope = general. */
export type ConversationScopeType = 'brand' | 'product' | 'account' | 'campaign'

/* ---- Commercial hierarchy ---- */

export interface Workspace {
  id: Id
  name: string
  slug: string | null
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
  deletedAt: IsoTimestamp | null
}

export interface Brand {
  id: Id
  workspaceId: Id
  name: string
  description: string | null
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
  deletedAt: IsoTimestamp | null
}

export interface Niche {
  id: Id
  brandId: Id
  name: string
  description: string | null
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
  deletedAt: IsoTimestamp | null
}

export type ProductStatus = 'draft' | 'active' | 'archived'

export interface Product {
  id: Id
  brandId: Id
  nicheId: Id | null
  name: string
  description: string | null
  url: string | null
  status: ProductStatus
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
  deletedAt: IsoTimestamp | null
}

export interface Platform {
  id: Id
  adapterKey: string
  name: string
  createdAt: IsoTimestamp
}

export type AccountStatus = 'active' | 'paused' | 'disconnected' | 'archived'

export interface Account {
  id: Id
  workspaceId: Id
  platformId: Id
  handle: string
  displayName: string | null
  primaryNicheId: Id | null
  status: AccountStatus
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
  deletedAt: IsoTimestamp | null
}

export type ConnectionStatus = 'connected' | 'expired' | 'error' | 'disconnected'

export interface PlatformConnection {
  id: Id
  accountId: Id
  status: ConnectionStatus
  /** Reference to an externally stored secret. Never the secret itself. */
  secretRef: string | null
  scopes: string | null
  metadataJson: string | null
  connectedAt: IsoTimestamp | null
  lastSyncedAt: IsoTimestamp | null
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

export type GoalStatus = 'active' | 'achieved' | 'abandoned'

export interface Goal {
  id: Id
  workspaceId: Id
  scopeType: GoalScopeType
  scopeId: Id | null
  title: string
  description: string | null
  targetMetricKey: string | null
  targetValue: number | null
  status: GoalStatus
  dueAt: IsoTimestamp | null
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
  deletedAt: IsoTimestamp | null
}

/* ---- Intelligence ---- */

export type AgentExecutionType = 'direct_model' | 'external_agent' | 'router'
export type AgentStatus = 'active' | 'disabled' | 'archived'
/** 'builtin' identities are shipped by the app and protected from deletion. */
export type AgentOrigin = 'builtin' | 'custom'

export interface Agent {
  id: Id
  workspaceId: Id
  name: string
  role: string | null
  /** Identity-level purpose shown in the registry. */
  description: string | null
  origin: AgentOrigin
  executionType: AgentExecutionType
  status: AgentStatus
  currentVersionId: Id | null
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
  deletedAt: IsoTimestamp | null
}

export interface AgentVersion {
  id: Id
  agentId: Id
  version: number
  configJson: string
  /** Short human note about why this version exists. Display only. */
  changeNote: string | null
  createdAt: IsoTimestamp
}

export type WorkflowStatus = 'draft' | 'active' | 'disabled' | 'archived'
export type WorkflowRunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
export type WorkflowStepType = 'agent' | 'tool' | 'condition' | 'end'
export type WorkflowStepRunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'skipped'

export interface Workflow {
  id: Id
  workspaceId: Id
  name: string
  description: string | null
  status: WorkflowStatus
  currentVersionId: Id | null
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
  deletedAt: IsoTimestamp | null
}

export interface WorkflowVersion {
  id: Id
  workflowId: Id
  version: number
  definitionJson: string
  /** Short human note about why this version exists. Display only. */
  changeNote: string | null
  createdAt: IsoTimestamp
}

export interface WorkflowRun {
  id: Id
  workflowId: Id
  workflowVersionId: Id
  status: WorkflowRunStatus
  triggerType: 'manual' | 'schedule' | 'event' | 'agent'
  inputJson: string | null
  outputJson: string | null
  error: string | null
  /** Safe ContextPackage snapshot from run start. Never secrets. */
  contextJson: string | null
  /** Resolved run plan: frozen agent versions, limits, entry step. */
  planJson: string | null
  /** Resumable engine state: next step, visit counts, counters. */
  stateJson: string | null
  startedAt: IsoTimestamp | null
  finishedAt: IsoTimestamp | null
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

export interface WorkflowStepRun {
  id: Id
  workflowRunId: Id
  stepKey: string
  stepType: WorkflowStepType
  status: WorkflowStepRunStatus
  attempt: number
  /** Exact agent version that executed an agent/tool step. */
  agentVersionId: Id | null
  /** Tool Registry execution id for tool steps. */
  toolExecutionId: Id | null
  inputJson: string | null
  outputJson: string | null
  error: string | null
  /** JSON: condition evaluation / chosen branch / next step. */
  decisionJson: string | null
  startedAt: IsoTimestamp | null
  finishedAt: IsoTimestamp | null
  createdAt: IsoTimestamp
}

/* ---- Conversations ---- */

export interface Conversation {
  id: Id
  workspaceId: Id
  title: string | null
  /** Optional business context. Validated application-side, not an FK. */
  scopeType: ConversationScopeType | null
  scopeId: Id | null
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
  deletedAt: IsoTimestamp | null
}

export type MessageSenderType = 'user' | 'agent' | 'system'

export interface Message {
  id: Id
  conversationId: Id
  senderType: MessageSenderType
  agentId: Id | null
  agentVersionId: Id | null
  content: string
  /** JSON: provider, model, tokens. Per-message, so no provider coupling. */
  providerMetadataJson: string | null
  createdAt: IsoTimestamp
}

/* ---- Memory ---- */

export type MemoryClass =
  | 'permanent_fact'
  | 'verified_learning'
  | 'proposed_learning'
  | 'temporary_context'

export type MemoryStatus = 'active' | 'superseded' | 'archived' | 'rejected'
export type MemorySourceType = 'user' | 'agent' | 'research' | 'observation' | 'import' | 'manual'

export interface Memory {
  id: Id
  workspaceId: Id
  memoryClass: MemoryClass
  content: string
  scopeType: MemoryScopeType
  scopeId: Id | null
  status: MemoryStatus
  confidence: number | null
  sourceType: MemorySourceType
  sourceId: string | null
  evidenceJson: string | null
  supersededBy: Id | null
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
  lastVerifiedAt: IsoTimestamp | null
  expiresAt: IsoTimestamp | null
}

/* ---- Research ---- */

export type ResearchStatus = 'draft' | 'in_progress' | 'completed' | 'stale' | 'archived'

export interface Research {
  id: Id
  workspaceId: Id
  subject: string
  findings: string | null
  status: ResearchStatus
  confidence: number | null
  scopeType: MemoryScopeType | null
  scopeId: Id | null
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
  lastVerifiedAt: IsoTimestamp | null
  expiresAt: IsoTimestamp | null
  deletedAt: IsoTimestamp | null
}

export interface ResearchSource {
  id: Id
  researchId: Id
  sourceType: 'url' | 'file' | 'platform' | 'manual' | 'agent'
  uri: string | null
  title: string | null
  metadataJson: string | null
  retrievedAt: IsoTimestamp | null
  createdAt: IsoTimestamp
}

/* ---- Campaigns and content ---- */

export type CampaignStatus = 'draft' | 'active' | 'paused' | 'completed' | 'archived'

export type CampaignObjective =
  | 'revenue'
  | 'conversions'
  | 'traffic'
  | 'leads'
  | 'awareness'
  | 'engagement'
  | 'retention'
  | 'validation'

export type CampaignPriority = 'high' | 'normal' | 'low'

export type AudienceAwarenessLevel =
  | 'unaware'
  | 'problem_aware'
  | 'solution_aware'
  | 'product_aware'
  | 'most_aware'

export interface CampaignAudience {
  summary: string
  problem?: string | null
  awarenessLevel?: AudienceAwarenessLevel | null
  geography?: string | null
  notes?: string | null
}

export interface CampaignStrategy {
  positioning?: string | null
  coreAngle?: string | null
  offerMessage?: string | null
  hypothesis?: string | null
}

export type CampaignMetricKey =
  | 'revenue'
  | 'conversions'
  | 'orders'
  | 'conversion_rate'
  | 'qualified_visits'
  | 'clicks'
  | 'outbound_clicks'
  | 'ctr'
  | 'leads'
  | 'saves'
  | 'engagements'
  | 'impressions'

export interface CampaignTarget {
  id: Id
  metricKey: CampaignMetricKey
  targetValue: number
  unit?: string | null
  isPrimary: boolean
  orderIndex: number
}

export interface Campaign {
  id: Id
  workspaceId: Id
  brandId: Id | null
  productId: Id | null
  goalId: Id | null
  name: string
  audience: string | null
  angle: string | null
  objective: CampaignObjective | null
  priority: CampaignPriority
  positioning: string | null
  offerMessage: string | null
  hypothesis: string | null
  audienceJson: string | null
  targetsJson: string | null
  status: CampaignStatus
  startsAt: IsoTimestamp | null
  endsAt: IsoTimestamp | null
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
  deletedAt: IsoTimestamp | null
}

export type ContentType =
  | 'post'
  | 'short_form'
  | 'long_form'
  | 'image'
  | 'video'
  | 'thread'
  | 'email'
  | 'other'

export type ContentPurpose =
  | 'awareness'
  | 'traffic'
  | 'conversion'
  | 'engagement'
  | 'education'
  | 'retention'
  | 'validation'

export type ContentStatus =
  | 'idea'
  | 'planned'
  | 'draft'
  | 'ready'
  | 'in_review'
  | 'approved'
  | 'archived'

export interface Content {
  id: Id
  workspaceId: Id
  campaignId: Id | null
  productId: Id | null
  targetAccountId: Id | null
  title: string | null
  contentType: ContentType
  purpose: ContentPurpose | null
  theme: string | null
  brief: string | null
  body: string | null
  status: ContentStatus
  plannedAt: IsoTimestamp | null
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
  deletedAt: IsoTimestamp | null
}

export interface CampaignContentItem extends Content {
  accountHandle?: string | null
  accountDisplayName?: string | null
  platformId?: string | null
  platformName?: string | null
  variantCount?: number
  latestVariantId?: string | null
}

export interface ContentVariant {
  id: Id
  contentId: Id
  platformId: Id
  body: string | null
  metadataJson: string | null
  status: ContentStatus
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
  deletedAt: IsoTimestamp | null
}

export type ReviewVerdict = 'pass' | 'revise'
export type IssueSeverity = 'low' | 'medium' | 'high'

export interface ReviewIssue {
  category: string
  severity: IssueSeverity
  message: string
}

export interface ContentReview {
  id: Id
  workspaceId: Id
  contentId: Id
  contentVariantId: Id
  criticAgentId: Id
  criticAgentVersionId: Id
  aiExecutionId: string
  verdict: ReviewVerdict
  reviewJson: string
  createdAt: IsoTimestamp
}

export interface ContentReviewDetail extends ContentReview {
  criticAgentName: string
  criticAgentVersionNumber: number
  summary: string
  strengths: string[]
  issues: ReviewIssue[]
  recommendedChanges: string[]
}

export type PostStatus = 'draft' | 'scheduled' | 'publishing' | 'published' | 'failed' | 'removed'

export interface Post {
  id: Id
  contentVariantId: Id
  accountId: Id
  status: PostStatus
  externalId: string | null
  url: string | null
  scheduledAt: IsoTimestamp | null
  publishedAt: IsoTimestamp | null
  error: string | null
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

/* ---- Analytics ---- */

export interface MetricDefinition {
  id: Id
  /** NULL means a built-in normalized metric shared by all workspaces. */
  workspaceId: Id | null
  key: string
  name: string
  description: string | null
  unit: string | null
  createdAt: IsoTimestamp
}

export interface MetricObservation {
  id: Id
  workspaceId: Id
  metricDefinitionId: Id
  subjectType: string
  subjectId: Id
  value: number
  granularity: 'total' | 'day' | 'hour'
  observedAt: IsoTimestamp
  source: 'platform_sync' | 'manual' | 'derived'
  metadataJson: string | null
  createdAt: IsoTimestamp
}

/* ---- Governance ---- */

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled'

export interface Approval {
  id: Id
  workspaceId: Id
  actionType: string
  subjectType: string
  subjectId: Id
  payloadJson: string | null
  status: ApprovalStatus
  decisionNote: string | null
  decidedAt: IsoTimestamp | null
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

export type ActorType = 'user' | 'agent' | 'workflow' | 'system'

export interface Event {
  id: Id
  workspaceId: Id | null
  eventType: string
  actorType: ActorType
  actorId: string | null
  subjectType: string | null
  subjectId: Id | null
  payloadJson: string | null
  occurredAt: IsoTimestamp
}

export interface AuditLogEntry {
  id: Id
  workspaceId: Id | null
  actorType: ActorType
  actorId: string | null
  action: 'create' | 'update' | 'delete' | 'restore'
  entityType: string
  entityId: Id
  /** JSON snapshots. Must never contain secrets. */
  previousValueJson: string | null
  newValueJson: string | null
  createdAt: IsoTimestamp
}

/* ---- Files ---- */

export interface FileAsset {
  id: Id
  workspaceId: Id
  kind: 'image' | 'video' | 'audio' | 'document' | 'other'
  name: string
  mimeType: string | null
  sizeBytes: number | null
  storageBackend: 'none' | 'r2' | 'external'
  storageKey: string | null
  source: 'upload' | 'generated' | 'imported'
  metadataJson: string | null
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
  deletedAt: IsoTimestamp | null
}
