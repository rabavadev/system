import type { Id, IsoTimestamp } from '../../types/domain.ts'
import type { ToolRisk } from '../tools/types.ts'

/**
 * Core Policy vocabulary (STEP 11A).
 * Canonical modes: 'auto' | 'review' | 'blocked'
 * User-facing labels: 'Auto' | 'Review first' | 'Blocked'
 */
export const POLICY_MODES = ['auto', 'review', 'blocked'] as const
export type PolicyMode = (typeof POLICY_MODES)[number]

export const POLICY_MODE_LABELS: Record<PolicyMode, string> = {
  auto: 'Auto',
  review: 'Review first',
  blocked: 'Blocked',
}

/**
 * Stable, platform-neutral action keys.
 */
export const ACTION_KEYS = [
  'workspace.read',
  'workflow.run',
  'workflow.create',
  'workflow.modify',
  'memory.verify',
  'external.read',
  'external.write',
  'content.publish',
  'account.modify',
  'destructive.delete',
] as const
export type ActionKey = (typeof ACTION_KEYS)[number]

export interface ActionDefinition {
  key: ActionKey
  label: string
  description: string
  category: 'read' | 'workflow' | 'memory' | 'external' | 'content' | 'account' | 'system'
  defaultMode: PolicyMode
  inherentRisks: readonly ToolRisk[]
}

export const ACTION_DEFINITIONS: Record<ActionKey, ActionDefinition> = {
  'workspace.read': {
    key: 'workspace.read',
    label: 'Research / read information',
    description: 'Read workspace context, products, and platform metadata.',
    category: 'read',
    defaultMode: 'auto',
    inherentRisks: ['read'],
  },
  'workflow.run': {
    key: 'workflow.run',
    label: 'Run workflows',
    description: 'Execute active multi-step workflows.',
    category: 'workflow',
    defaultMode: 'review',
    inherentRisks: ['write'],
  },
  'workflow.create': {
    key: 'workflow.create',
    label: 'Create workflows',
    description: 'Create new workflow definitions and version drafts.',
    category: 'workflow',
    defaultMode: 'review',
    inherentRisks: ['write'],
  },
  'workflow.modify': {
    key: 'workflow.modify',
    label: 'Change workflows',
    description: 'Save new versions of existing workflows.',
    category: 'workflow',
    defaultMode: 'review',
    inherentRisks: ['write'],
  },
  'memory.verify': {
    key: 'memory.verify',
    label: 'Verify learned memory',
    description: 'Graduate candidate hypotheses into verified workspace memory.',
    category: 'memory',
    defaultMode: 'review',
    inherentRisks: ['write'],
  },
  'external.read': {
    key: 'external.read',
    label: 'Read external services',
    description:
      'Search or read information from connected external services without changing them.',
    category: 'external',
    defaultMode: 'review',
    inherentRisks: ['read', 'external'],
  },
  'external.write': {
    key: 'external.write',
    label: 'Outside service changes',
    description: 'Perform state-mutating operations on connected external platforms.',
    category: 'external',
    defaultMode: 'review',
    inherentRisks: ['write', 'external'],
  },
  'content.publish': {
    key: 'content.publish',
    label: 'Publish content',
    description: 'Publish posts and media to connected channels.',
    category: 'content',
    defaultMode: 'review',
    inherentRisks: ['write', 'external'],
  },
  'account.modify': {
    key: 'account.modify',
    label: 'Modify account settings',
    description: 'Update connected platform account configurations.',
    category: 'account',
    defaultMode: 'review',
    inherentRisks: ['write', 'sensitive'],
  },
  'destructive.delete': {
    key: 'destructive.delete',
    label: 'Delete important data',
    description: 'Hard or permanent deletion of workspace entities.',
    category: 'system',
    defaultMode: 'blocked',
    inherentRisks: ['destructive'],
  },
}

/** Supported policy scopes. Precedence: brand > workspace > default. */
export const POLICY_SCOPE_TYPES = ['workspace', 'brand', 'account', 'platform', 'workflow'] as const
export type PolicyScopeType = (typeof POLICY_SCOPE_TYPES)[number]

/** Request origin for policy evaluation. */
export const POLICY_REQUEST_ORIGINS = [
  'user',
  'chief',
  'agent',
  'workflow',
  'tool',
  'system',
] as const
export type PolicyRequestOrigin = (typeof POLICY_REQUEST_ORIGINS)[number]

/** Policy source that determined the final mode. */
export const POLICY_SOURCES = [
  'hard_security',
  'brand_override',
  'workspace_policy',
  'risk_fallback',
  'system_default',
] as const
export type PolicySource = (typeof POLICY_SOURCES)[number]

/** Database record for approval_policy table. */
export interface ApprovalPolicyRecord {
  id: Id
  workspaceId: Id
  scopeType: PolicyScopeType
  scopeId: Id
  actionKey: ActionKey
  mode: PolicyMode
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

/** Input to resolveApprovalPolicy. */
export interface PolicyResolutionRequest {
  action: ActionKey | string
  workspaceId: Id
  brandId?: Id | null
  origin: PolicyRequestOrigin
  risk?: readonly ToolRisk[] | ToolRisk | null
  target?: {
    entityType?: string
    entityId?: string
    isSecret?: boolean
    crossWorkspace?: boolean
    executionBypass?: boolean
    arbitraryCode?: boolean
  }
}

export interface PolicyTraceStep {
  step: string
  matched: boolean
  mode?: PolicyMode | null
  source?: PolicySource | null
  detail: string
}

export interface PolicyTrace {
  action: string
  origin: PolicyRequestOrigin
  workspaceId: Id
  brandId: Id | null
  steps: PolicyTraceStep[]
  resolvedMode: PolicyMode
  source: PolicySource
  reason: string
}

export interface PolicyResolutionResult {
  action: ActionKey
  mode: PolicyMode
  source: PolicySource
  reason: string
  hasOverride: boolean
  origin: PolicyRequestOrigin
  trace: PolicyTrace
}
