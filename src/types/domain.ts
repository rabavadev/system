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

export interface Agent {
  id: Id
  workspaceId: Id
  name: string
  role: string | null
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
  createdAt: IsoTimestamp
}

export type WorkflowStatus = 'draft' | 'active' | 'disabled' | 'archived'
export type WorkflowRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

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
  startedAt: IsoTimestamp | null
  finishedAt: IsoTimestamp | null
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

/* ---- Conversations ---- */

export interface Conversation {
  id: Id
  workspaceId: Id
  title: string | null
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

export interface Campaign {
  id: Id
  workspaceId: Id
  brandId: Id | null
  productId: Id | null
  goalId: Id | null
  name: string
  audience: string | null
  angle: string | null
  status: CampaignStatus
  startsAt: IsoTimestamp | null
  endsAt: IsoTimestamp | null
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
  deletedAt: IsoTimestamp | null
}

export type ContentStatus = 'draft' | 'in_review' | 'approved' | 'archived'

export interface Content {
  id: Id
  workspaceId: Id
  campaignId: Id | null
  productId: Id | null
  title: string | null
  brief: string | null
  body: string | null
  status: ContentStatus
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
  deletedAt: IsoTimestamp | null
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
