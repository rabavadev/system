import type {
  ApprovalDecision,
  ApprovalDecisionActorType,
  ApprovalOrigin,
  ApprovalRequestRecord,
  ApprovalStatus,
  ListApprovalsFilter,
} from '../approval/types.ts'
import type { ActionKey, PolicyMode, PolicySource } from '../policy/types.ts'
import type { ToolRisk } from '../tools/types.ts'
import { execute, nowIso, queryAll, queryFirst, type SqlDatabase } from './sql.ts'

export interface ApprovalRow {
  id: string
  workspace_id: string
  action_key: string
  origin: string
  requested_by_type: string
  requested_by_id: string | null
  subject_type: string | null
  subject_id: string | null
  summary: string
  reason: string
  resolved_mode: string
  policy_source: string
  risk: string | null
  snapshot_json: string
  fingerprint: string
  status: string
  expires_at: string | null
  decision: string | null
  decided_by_type: string | null
  decided_by_id: string | null
  decision_note: string | null
  decided_at: string | null
  workflow_id: string | null
  run_id: string | null
  step_id: string | null
  execution_id: string | null
  conversation_id: string | null
  created_at: string
  updated_at: string
}

export function toApprovalRecord(row: ApprovalRow): ApprovalRequestRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    actionKey: row.action_key as ActionKey,
    origin: row.origin as ApprovalOrigin,
    requestedByType: row.requested_by_type as ApprovalOrigin,
    requestedById: row.requested_by_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    summary: row.summary,
    reason: row.reason,
    resolvedMode: row.resolved_mode as PolicyMode,
    policySource: row.policy_source as PolicySource,
    risk: (row.risk as ToolRisk) ?? null,
    snapshotJson: row.snapshot_json,
    fingerprint: row.fingerprint,
    status: row.status as ApprovalStatus,
    expiresAt: row.expires_at,
    decision: (row.decision as ApprovalDecision) ?? null,
    decidedByType: (row.decided_by_type as ApprovalDecisionActorType) ?? null,
    decidedById: row.decided_by_id,
    decisionNote: row.decision_note,
    decidedAt: row.decided_at,
    workflowId: row.workflow_id,
    runId: row.run_id,
    stepId: row.step_id,
    executionId: row.execution_id,
    conversationId: row.conversation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Retrieves a single approval request by ID within a workspace.
 */
export async function getApprovalRequest(
  db: SqlDatabase,
  filter: { workspaceId: string; id: string },
): Promise<ApprovalRequestRecord | null> {
  const row = await queryFirst<ApprovalRow>(
    db,
    `SELECT * FROM approval WHERE id = ? AND workspace_id = ?`,
    [filter.id, filter.workspaceId],
  )
  return row ? toApprovalRecord(row) : null
}

/**
 * Retrieves a single approval request by ID across workspaces.
 */
export async function getApprovalRequestById(
  db: SqlDatabase,
  id: string,
): Promise<ApprovalRequestRecord | null> {
  const row = await queryFirst<ApprovalRow>(db, `SELECT * FROM approval WHERE id = ?`, [id])
  return row ? toApprovalRecord(row) : null
}

/**
 * Finds an active pending approval request matching deduplication criteria.
 */
export async function findPendingApproval(
  db: SqlDatabase,
  params: {
    workspaceId: string
    actionKey: string
    fingerprint: string
    executionId?: string | null
  },
): Promise<ApprovalRequestRecord | null> {
  let sql = `SELECT * FROM approval WHERE workspace_id = ? AND action_key = ? AND fingerprint = ? AND status = 'pending'`
  const bindings: unknown[] = [params.workspaceId, params.actionKey, params.fingerprint]

  if (params.executionId) {
    sql += ` AND execution_id = ?`
    bindings.push(params.executionId)
  }

  sql += ` ORDER BY created_at DESC LIMIT 1`

  const row = await queryFirst<ApprovalRow>(db, sql, bindings)
  return row ? toApprovalRecord(row) : null
}

/**
 * Lists approval requests matching optional filter criteria.
 */
export async function listApprovalRequests(
  db: SqlDatabase,
  filter: ListApprovalsFilter,
): Promise<ApprovalRequestRecord[]> {
  const conditions: string[] = ['workspace_id = ?']
  const params: unknown[] = [filter.workspaceId]

  if (filter.status) {
    conditions.push('status = ?')
    params.push(filter.status)
  }
  if (filter.actionKey) {
    conditions.push('action_key = ?')
    params.push(filter.actionKey)
  }
  if (filter.subjectType) {
    conditions.push('subject_type = ?')
    params.push(filter.subjectType)
  }
  if (filter.subjectId) {
    conditions.push('subject_id = ?')
    params.push(filter.subjectId)
  }

  const limit = Math.min(filter.limit ?? 50, 100)
  const offset = filter.offset ?? 0

  const sql = `SELECT * FROM approval WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  params.push(limit, offset)

  const rows = await queryAll<ApprovalRow>(db, sql, params)
  return rows.map(toApprovalRecord)
}

/**
 * Inserts a new Approval Request row.
 */
export async function insertApprovalRequest(
  db: SqlDatabase,
  record: ApprovalRequestRecord,
): Promise<void> {
  await execute(
    db,
    `INSERT INTO approval (
       id, workspace_id, action_key, origin, requested_by_type, requested_by_id,
       subject_type, subject_id, summary, reason, resolved_mode, policy_source,
       risk, snapshot_json, fingerprint, status, expires_at, decision,
       decided_by_type, decided_by_id, decision_note, decided_at,
       workflow_id, run_id, step_id, execution_id, conversation_id,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.id,
      record.workspaceId,
      record.actionKey,
      record.origin,
      record.requestedByType,
      record.requestedById,
      record.subjectType,
      record.subjectId,
      record.summary,
      record.reason,
      record.resolvedMode,
      record.policySource,
      record.risk,
      record.snapshotJson,
      record.fingerprint,
      record.status,
      record.expiresAt,
      record.decision,
      record.decidedByType,
      record.decidedById,
      record.decisionNote,
      record.decidedAt,
      record.workflowId,
      record.runId,
      record.stepId,
      record.executionId,
      record.conversationId,
      record.createdAt,
      record.updatedAt,
    ],
  )
}

/**
 * Updates an approval request with a decision (approved, rejected, cancelled, expired).
 */
export async function updateApprovalDecision(
  db: SqlDatabase,
  params: {
    id: string
    workspaceId: string
    status: ApprovalStatus
    decision: ApprovalDecision
    decidedByType: ApprovalDecisionActorType
    decidedById: string | null
    decisionNote?: string | null
    decidedAt: string
  },
): Promise<void> {
  await execute(
    db,
    `UPDATE approval
     SET status = ?, decision = ?, decided_by_type = ?, decided_by_id = ?, decision_note = ?, decided_at = ?, updated_at = ?
     WHERE id = ? AND workspace_id = ?`,
    [
      params.status,
      params.decision,
      params.decidedByType,
      params.decidedById,
      params.decisionNote ?? null,
      params.decidedAt,
      nowIso(),
      params.id,
      params.workspaceId,
    ],
  )
}

/**
 * Counts currently pending approvals in a workspace.
 */
export async function countPendingApprovals(db: SqlDatabase, workspaceId: string): Promise<number> {
  const row = await queryFirst<{ count: number }>(
    db,
    `SELECT COUNT(*) as count FROM approval WHERE workspace_id = ? AND status = 'pending'`,
    [workspaceId],
  )
  return row?.count ?? 0
}
