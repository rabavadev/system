import { z } from 'zod'
import {
  findPendingApproval,
  getApprovalRequest,
  getApprovalRequestById,
  insertApprovalRequest,
  normalizeStoredRisks,
  updateApprovalDecision,
} from '../db/approval.ts'

export {
  findPendingApproval,
  getApprovalRequest,
  getApprovalRequestById,
  insertApprovalRequest,
  normalizeStoredRisks,
  updateApprovalDecision,
}
import { writeAuditLog } from '../db/audit.ts'
import { emitEventSafe } from '../db/event.ts'
import { newId, nowIso, queryFirst, type SqlDatabase } from '../db/sql.ts'
import { resolveApprovalPolicy } from '../policy/resolver.ts'
import {
  ACTION_DEFINITIONS,
  ACTION_KEYS,
  type ActionKey,
  type PolicyMode,
  type PolicySource,
} from '../policy/types.ts'
import {
  computeSnapshotFingerprint,
  createSafeActionSnapshot,
  verifySnapshotIntegrity,
} from './snapshot.ts'
import type {
  ApprovalRequestRecord,
  CreateApprovalRequestInput,
  CreateApprovalResult,
  DecideApprovalInput,
} from './types.ts'

export class ApprovalServiceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApprovalServiceError'
  }
}

function toSafeUuid(val: string | null | undefined): string | null {
  if (!val) return null
  return z.string().uuid().safeParse(val).success ? val : null
}

/**
 * Creates a concrete Approval Request if the action requires review under policy.
 *
 * Behavior:
 * - AUTO: returns { status: 'auto', created: false } without persisting a request.
 * - BLOCKED: returns { status: 'blocked', created: false } without persisting a request.
 * - REVIEW: creates (or reuses an identical pending) Approval Request.
 */
export async function createApprovalRequest(
  db: SqlDatabase,
  input: CreateApprovalRequestInput,
): Promise<CreateApprovalResult> {
  // 1. Validate action key
  if (!ACTION_KEYS.includes(input.actionKey as ActionKey)) {
    throw new ApprovalServiceError(`Unsupported action key: "${input.actionKey}"`)
  }
  const validAction = input.actionKey as ActionKey

  // 2. Validate workspace ID format
  if (!input.workspaceId || typeof input.workspaceId !== 'string') {
    throw new ApprovalServiceError('Workspace ID is required')
  }

  // 3. Validate brand scope if brandId is specified
  if (input.brandId) {
    const brand = await queryFirst<{ id: string; deleted_at: string | null }>(
      db,
      `SELECT id, deleted_at FROM brand WHERE id = ? AND workspace_id = ?`,
      [input.brandId, input.workspaceId],
    )
    if (!brand || brand.deleted_at !== null) {
      throw new ApprovalServiceError('Brand not found or does not belong to workspace')
    }
  }

  // 4. Resolve STEP 11A Policy
  const policyResult = await resolveApprovalPolicy(db, {
    action: validAction,
    workspaceId: input.workspaceId,
    origin: input.origin,
    ...(input.brandId !== undefined ? { brandId: input.brandId } : {}),
    ...(input.risk !== undefined ? { risk: input.risk } : {}),
    ...(input.target !== undefined ? { target: input.target } : {}),
  })

  let effectiveMode: PolicyMode = policyResult.mode
  let effectiveSource: PolicySource = policyResult.source
  let effectiveReason = policyResult.reason

  // Check if minimumMode (e.g. hard tool approval requirement) elevates AUTO to REVIEW
  if (effectiveMode === 'auto' && input.minimumMode === 'review') {
    effectiveMode = 'review'
    effectiveSource = 'tool_requirement'
    effectiveReason = 'Tool definition requires human approval'
  }

  // 4. Handle AUTO and BLOCKED outcomes
  if (effectiveMode === 'auto') {
    return {
      status: 'auto',
      created: false,
      request: null,
      reason: effectiveReason,
    }
  }

  if (effectiveMode === 'blocked') {
    return {
      status: 'blocked',
      created: false,
      request: null,
      reason: effectiveReason,
    }
  }

  // 5. REVIEW mode: construct safe snapshot and compute fingerprint
  const { snapshotJson } = createSafeActionSnapshot(input.payload)
  const fingerprint = computeSnapshotFingerprint(validAction, snapshotJson)

  // 6. Deduplication: reuse active pending request if identical action is waiting
  const existingPending = await findPendingApproval(db, {
    workspaceId: input.workspaceId,
    actionKey: validAction,
    fingerprint,
    executionId: input.executionId ?? null,
  })

  if (existingPending) {
    // Check if expired
    if (!existingPending.expiresAt || existingPending.expiresAt > nowIso()) {
      return {
        status: 'pending',
        created: false,
        isDuplicate: true,
        request: existingPending,
        reason: 'Reusing existing pending approval request',
      }
    }
  }

  // 7. Create new ApprovalRequestRecord
  const id = newId()
  const now = nowIso()
  const summary =
    input.summary ?? ACTION_DEFINITIONS[validAction]?.label ?? `Approval request for ${validAction}`

  let resolvedWorkflowId = input.workflowId ?? null
  if (!resolvedWorkflowId && input.runId) {
    const runRow = await queryFirst<{ workflow_id: string }>(
      db,
      `SELECT workflow_id FROM workflow_run WHERE id = ?`,
      [input.runId],
    )
    if (runRow) {
      resolvedWorkflowId = runRow.workflow_id
    }
  }

  const risks = normalizeStoredRisks(input.risk)

  const record: ApprovalRequestRecord = {
    id,
    workspaceId: input.workspaceId,
    actionKey: validAction,
    origin: input.origin,
    requestedByType: input.requestedByType ?? input.origin,
    requestedById: input.requestedById ?? null,
    subjectType: input.subjectType ?? (input.brandId ? 'brand' : null),
    subjectId: input.subjectId ?? input.brandId ?? null,
    summary,
    reason: effectiveReason,
    resolvedMode: 'review',
    policySource: effectiveSource,
    risks,
    risk: risks[0] ?? null,
    snapshotJson,
    fingerprint,
    status: 'pending',
    expiresAt: input.expiresAt ?? null,
    decision: null,
    decidedByType: null,
    decidedById: null,
    decisionNote: null,
    decidedAt: null,
    workflowId: resolvedWorkflowId,
    runId: input.runId ?? null,
    stepId: input.stepId ?? null,
    executionId: input.executionId ?? null,
    conversationId: input.conversationId ?? null,
    createdAt: now,
    updatedAt: now,
  }

  await insertApprovalRequest(db, record)

  // 8. Audit and domain event emission (safe metadata only)
  await writeAuditLog(db, {
    workspaceId: input.workspaceId,
    actorType: input.origin === 'user' ? 'user' : input.origin === 'agent' ? 'agent' : 'system',
    actorId: toSafeUuid(input.requestedById),
    action: 'create',
    entityType: 'approval',
    entityId: id,
    newValueJson: JSON.stringify({
      actionKey: record.actionKey,
      origin: record.origin,
      status: record.status,
      summary: record.summary,
      fingerprint: record.fingerprint,
      policySource: record.policySource,
      risks: record.risks,
    }),
  })

  await emitEventSafe(db, {
    workspaceId: input.workspaceId,
    eventType: 'approval.requested',
    actorType: input.origin === 'user' ? 'user' : input.origin === 'agent' ? 'agent' : 'system',
    actorId: toSafeUuid(input.requestedById),
    subjectType: 'approval',
    subjectId: id,
    payloadJson: JSON.stringify({
      actionKey: record.actionKey,
      origin: record.origin,
      summary: record.summary,
      fingerprint: record.fingerprint,
      risk: record.risk,
      risks: record.risks,
      policySource: record.policySource,
    }),
  })

  return {
    status: 'pending',
    created: true,
    isDuplicate: false,
    request: record,
    reason: effectiveReason,
  }
}

/**
 * Executes a human decision (approve, reject, cancel) on an Approval Request.
 *
 * Rules:
 * - Strictly forbids AI agents, Chief, or Tools from self-approving.
 * - Enforces immutable snapshot integrity check.
 * - Idempotent for double-decisions.
 * - Disallows decisions on expired requests.
 */
export async function decideApprovalRequest(
  db: SqlDatabase,
  input: DecideApprovalInput,
): Promise<ApprovalRequestRecord> {
  // 1. Anti-self-approval: AI, Chief, Tools cannot decide approvals
  if (input.actor.actorType !== 'user' && input.actor.actorType !== 'system') {
    throw new ApprovalServiceError(
      `Only human users or system can decide approval requests (received: ${input.actor.actorType})`,
    )
  }

  // 2. Fetch existing request
  const existing = await getApprovalRequest(db, {
    workspaceId: input.workspaceId,
    id: input.requestId,
  })

  if (!existing) {
    throw new ApprovalServiceError('Approval request not found')
  }

  // 3. Lazy expiry check: if past expires_at, transition to expired and block decision
  if (existing.status === 'pending' && existing.expiresAt && existing.expiresAt <= nowIso()) {
    const expiredAt = nowIso()
    await updateApprovalDecision(db, {
      id: existing.id,
      workspaceId: existing.workspaceId,
      status: 'expired',
      decision: 'expired',
      decidedByType: 'system',
      decidedById: null,
      decisionNote: 'Request expired automatically',
      decidedAt: expiredAt,
    })

    await emitEventSafe(db, {
      workspaceId: existing.workspaceId,
      eventType: 'approval.expired',
      actorType: 'system',
      subjectType: 'approval',
      subjectId: existing.id,
      payloadJson: JSON.stringify({
        actionKey: existing.actionKey,
        expiresAt: existing.expiresAt,
      }),
    })

    throw new ApprovalServiceError('Cannot decide on an expired approval request')
  }

  // 4. Idempotency: if already decided with identical status, return existing
  if (existing.status === input.decision) {
    return existing
  }

  // 5. State validation: only pending requests can be decided
  if (existing.status !== 'pending') {
    throw new ApprovalServiceError(
      `Cannot ${input.decision} a request that is already ${existing.status}`,
    )
  }

  // 6. Snapshot Integrity check: verify stored snapshot matches fingerprint
  const isIntact = verifySnapshotIntegrity(
    existing.actionKey,
    existing.snapshotJson,
    existing.fingerprint,
  )
  if (!isIntact) {
    throw new ApprovalServiceError('Approval request snapshot integrity violation')
  }

  // 7. Update status in database
  const decidedAt = nowIso()
  await updateApprovalDecision(db, {
    id: existing.id,
    workspaceId: existing.workspaceId,
    status: input.decision,
    decision: input.decision,
    decidedByType: input.actor.actorType,
    decidedById: input.actor.actorId ?? null,
    decisionNote: input.note ?? null,
    decidedAt,
  })

  const updated: ApprovalRequestRecord = {
    ...existing,
    status: input.decision,
    decision: input.decision,
    decidedByType: input.actor.actorType,
    decidedById: input.actor.actorId ?? null,
    decisionNote: input.note ?? null,
    decidedAt,
    updatedAt: decidedAt,
  }

  // 8. Audit log and domain event
  await writeAuditLog(db, {
    workspaceId: input.workspaceId,
    actorType: input.actor.actorType,
    actorId: toSafeUuid(input.actor.actorId),
    action: 'update',
    entityType: 'approval',
    entityId: existing.id,
    previousValueJson: JSON.stringify({
      status: existing.status,
      decision: existing.decision,
    }),
    newValueJson: JSON.stringify({
      status: updated.status,
      decision: updated.decision,
      note: updated.decisionNote,
    }),
  })

  await emitEventSafe(db, {
    workspaceId: input.workspaceId,
    eventType: `approval.${input.decision}`,
    actorType: input.actor.actorType,
    actorId: toSafeUuid(input.actor.actorId),
    subjectType: 'approval',
    subjectId: existing.id,
    payloadJson: JSON.stringify({
      actionKey: updated.actionKey,
      decision: updated.decision,
      note: updated.decisionNote,
    }),
  })

  return updated
}

/**
 * Fetches an approval request with lazy expiry evaluation.
 */
export async function getApprovalWithExpiryCheck(
  db: SqlDatabase,
  filter: { workspaceId?: string; id: string },
): Promise<ApprovalRequestRecord | null> {
  const request = filter.workspaceId
    ? await getApprovalRequest(db, { workspaceId: filter.workspaceId, id: filter.id })
    : await getApprovalRequestById(db, filter.id)
  if (!request) return null

  if (request.status === 'pending' && request.expiresAt && request.expiresAt <= nowIso()) {
    const expiredAt = nowIso()
    await updateApprovalDecision(db, {
      id: request.id,
      workspaceId: request.workspaceId,
      status: 'expired',
      decision: 'expired',
      decidedByType: 'system',
      decidedById: null,
      decisionNote: 'Request expired automatically',
      decidedAt: expiredAt,
    })

    await emitEventSafe(db, {
      workspaceId: request.workspaceId,
      eventType: 'approval.expired',
      actorType: 'system',
      subjectType: 'approval',
      subjectId: request.id,
      payloadJson: JSON.stringify({
        actionKey: request.actionKey,
        expiresAt: request.expiresAt,
      }),
    })

    return {
      ...request,
      status: 'expired',
      decision: 'expired',
      decidedByType: 'system',
      decidedById: null,
      decisionNote: 'Request expired automatically',
      decidedAt: expiredAt,
      updatedAt: expiredAt,
    }
  }

  return request
}
