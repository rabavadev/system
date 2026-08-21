import type {
  ActionKey,
  PolicyMode,
  PolicyResolutionRequest,
  PolicySource,
} from '../policy/types.ts'
import type { ToolRisk } from '../tools/types.ts'

export const APPROVAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'cancelled',
  'expired',
] as const
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]

export const APPROVAL_ORIGINS = ['user', 'chief', 'agent', 'workflow', 'tool', 'system'] as const
export type ApprovalOrigin = (typeof APPROVAL_ORIGINS)[number]

export const APPROVAL_DECISION_ACTOR_TYPES = ['user', 'system'] as const
export type ApprovalDecisionActorType = (typeof APPROVAL_DECISION_ACTOR_TYPES)[number]

export const APPROVAL_DECISIONS = ['approved', 'rejected', 'cancelled', 'expired'] as const
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number]

/**
 * Concrete Approval Request entity representing an exact action snapshot
 * waiting for human authorization.
 */
export interface ApprovalRequestRecord {
  id: string
  workspaceId: string
  actionKey: ActionKey
  origin: ApprovalOrigin
  requestedByType: ApprovalOrigin
  requestedById: string | null
  subjectType: string | null
  subjectId: string | null
  summary: string
  reason: string
  resolvedMode: PolicyMode
  policySource: PolicySource
  risk: ToolRisk | null
  snapshotJson: string
  fingerprint: string
  status: ApprovalStatus
  expiresAt: string | null
  decision: ApprovalDecision | null
  decidedByType: ApprovalDecisionActorType | null
  decidedById: string | null
  decisionNote: string | null
  decidedAt: string | null
  workflowId: string | null
  runId: string | null
  stepId: string | null
  executionId: string | null
  conversationId: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateApprovalRequestInput {
  workspaceId: string
  actionKey: ActionKey | string
  origin: ApprovalOrigin
  requestedByType?: ApprovalOrigin
  requestedById?: string | null
  brandId?: string | null
  subjectType?: string | null
  subjectId?: string | null
  summary?: string
  risk?: readonly ToolRisk[] | ToolRisk | null
  target?: PolicyResolutionRequest['target']
  payload: Record<string, unknown>
  expiresAt?: string | null
  workflowId?: string | null
  runId?: string | null
  stepId?: string | null
  executionId?: string | null
  conversationId?: string | null
}

export type CreateApprovalResult =
  | {
      status: 'pending'
      created: boolean
      isDuplicate?: boolean
      request: ApprovalRequestRecord
      reason: string
    }
  | {
      status: 'auto'
      created: false
      request: null
      reason: string
    }
  | {
      status: 'blocked'
      created: false
      request: null
      reason: string
    }

export interface DecideApprovalInput {
  workspaceId: string
  requestId: string
  decision: 'approved' | 'rejected' | 'cancelled'
  actor: {
    actorType: 'user' | 'system'
    actorId?: string | null
  }
  note?: string | null
}

export interface ListApprovalsFilter {
  workspaceId: string
  status?: ApprovalStatus
  actionKey?: ActionKey | string
  subjectType?: string
  subjectId?: string
  limit?: number
  offset?: number
}
