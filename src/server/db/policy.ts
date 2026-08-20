import { z } from 'zod'
import {
  ACTION_KEYS,
  type ActionKey,
  type ApprovalPolicyRecord,
  POLICY_MODES,
  POLICY_SCOPE_TYPES,
  type PolicyMode,
  type PolicyScopeType,
} from '../policy/types.ts'
import { writeAuditLog } from './audit.ts'
import { emitEventSafe } from './event.ts'
import { execute, newId, nowIso, queryAll, queryFirst, type SqlDatabase } from './sql.ts'

export interface ApprovalPolicyRow {
  id: string
  workspace_id: string
  scope_type: string
  scope_id: string
  action_key: string
  mode: string
  created_at: string
  updated_at: string
}

function mapRow(row: ApprovalPolicyRow): ApprovalPolicyRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    scopeType: row.scope_type as PolicyScopeType,
    scopeId: row.scope_id,
    actionKey: row.action_key as ActionKey,
    mode: row.mode as PolicyMode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export const setApprovalPolicyInput = z.object({
  workspaceId: z.uuid(),
  scopeType: z.enum(POLICY_SCOPE_TYPES),
  scopeId: z.uuid(),
  actionKey: z.enum(ACTION_KEYS),
  mode: z.enum(POLICY_MODES),
  actor: z
    .object({
      actorType: z.enum(['user', 'agent', 'workflow', 'system']).default('user'),
      actorId: z.uuid().nullable().optional(),
    })
    .optional(),
})
export type SetApprovalPolicyInput = z.input<typeof setApprovalPolicyInput>

export const clearApprovalPolicyInput = z.object({
  workspaceId: z.uuid(),
  scopeType: z.enum(POLICY_SCOPE_TYPES),
  scopeId: z.uuid(),
  actionKey: z.enum(ACTION_KEYS),
  actor: z
    .object({
      actorType: z.enum(['user', 'agent', 'workflow', 'system']).default('user'),
      actorId: z.uuid().nullable().optional(),
    })
    .optional(),
})
export type ClearApprovalPolicyInput = z.input<typeof clearApprovalPolicyInput>

/**
 * Reads an exact policy row by workspace, scope, and action key.
 */
export async function getApprovalPolicy(
  db: SqlDatabase,
  query: {
    workspaceId: string
    scopeType: PolicyScopeType
    scopeId: string
    actionKey: ActionKey | string
  },
): Promise<ApprovalPolicyRecord | null> {
  const row = await queryFirst<ApprovalPolicyRow>(
    db,
    `SELECT id, workspace_id, scope_type, scope_id, action_key, mode, created_at, updated_at
     FROM approval_policy
     WHERE workspace_id = ? AND scope_type = ? AND scope_id = ? AND action_key = ?`,
    [query.workspaceId, query.scopeType, query.scopeId, query.actionKey],
  )
  return row ? mapRow(row) : null
}

/**
 * Lists all policy rows for a workspace, optionally filtered by scope.
 */
export async function listApprovalPolicies(
  db: SqlDatabase,
  query: {
    workspaceId: string
    scopeType?: PolicyScopeType
    scopeId?: string
  },
): Promise<ApprovalPolicyRecord[]> {
  if (query.scopeType && query.scopeId) {
    const rows = await queryAll<ApprovalPolicyRow>(
      db,
      `SELECT id, workspace_id, scope_type, scope_id, action_key, mode, created_at, updated_at
       FROM approval_policy
       WHERE workspace_id = ? AND scope_type = ? AND scope_id = ?
       ORDER BY action_key ASC`,
      [query.workspaceId, query.scopeType, query.scopeId],
    )
    return rows.map(mapRow)
  }

  const rows = await queryAll<ApprovalPolicyRow>(
    db,
    `SELECT id, workspace_id, scope_type, scope_id, action_key, mode, created_at, updated_at
     FROM approval_policy
     WHERE workspace_id = ?
     ORDER BY scope_type ASC, action_key ASC`,
    [query.workspaceId],
  )
  return rows.map(mapRow)
}

/**
 * Validates brand ownership and active status for brand-scoped policies.
 */
async function validateBrandScope(
  db: SqlDatabase,
  workspaceId: string,
  brandId: string,
): Promise<void> {
  const brand = await queryFirst<{ id: string; deleted_at: string | null }>(
    db,
    `SELECT id, deleted_at FROM brand WHERE id = ? AND workspace_id = ?`,
    [brandId, workspaceId],
  )
  if (!brand) {
    throw new Error(`Brand ${brandId} not found in workspace ${workspaceId}`)
  }
  if (brand.deleted_at !== null) {
    throw new Error(`Brand ${brandId} is archived and cannot receive policy overrides`)
  }
}

/**
 * Sets or updates an approval policy record.
 * Generates audit_log and event entries.
 */
export async function setApprovalPolicy(
  db: SqlDatabase,
  input: SetApprovalPolicyInput,
): Promise<ApprovalPolicyRecord> {
  const data = setApprovalPolicyInput.parse(input)
  const now = nowIso()

  // Validate scope-specific relationships
  if (data.scopeType === 'brand') {
    await validateBrandScope(db, data.workspaceId, data.scopeId)
  } else if (data.scopeType === 'workspace' && data.scopeId !== data.workspaceId) {
    throw new Error('Workspace policy scopeId must match workspaceId')
  }

  const existing = await queryFirst<ApprovalPolicyRow>(
    db,
    `SELECT id, workspace_id, scope_type, scope_id, action_key, mode, created_at, updated_at
     FROM approval_policy
     WHERE workspace_id = ? AND scope_type = ? AND scope_id = ? AND action_key = ?`,
    [data.workspaceId, data.scopeType, data.scopeId, data.actionKey],
  )

  let result: ApprovalPolicyRecord

  if (existing) {
    await execute(
      db,
      `UPDATE approval_policy
       SET mode = ?, updated_at = ?
       WHERE id = ?`,
      [data.mode, now, existing.id],
    )
    result = {
      id: existing.id,
      workspaceId: existing.workspace_id,
      scopeType: existing.scope_type as PolicyScopeType,
      scopeId: existing.scope_id,
      actionKey: existing.action_key as ActionKey,
      mode: data.mode,
      createdAt: existing.created_at,
      updatedAt: now,
    }

    await writeAuditLog(db, {
      workspaceId: data.workspaceId,
      actorType: data.actor?.actorType ?? 'user',
      actorId: data.actor?.actorId ?? null,
      action: 'update',
      entityType: 'approval_policy',
      entityId: existing.id,
      previousValueJson: JSON.stringify({
        actionKey: existing.action_key,
        mode: existing.mode,
        scopeType: existing.scope_type,
        scopeId: existing.scope_id,
      }),
      newValueJson: JSON.stringify({
        actionKey: data.actionKey,
        mode: data.mode,
        scopeType: data.scopeType,
        scopeId: data.scopeId,
      }),
    })

    await emitEventSafe(db, {
      workspaceId: data.workspaceId,
      eventType: 'policy.updated',
      actorType: data.actor?.actorType ?? 'user',
      actorId: data.actor?.actorId ?? null,
      subjectType: 'approval_policy',
      subjectId: existing.id,
      payloadJson: JSON.stringify({
        actionKey: data.actionKey,
        oldMode: existing.mode,
        newMode: data.mode,
        scopeType: data.scopeType,
        scopeId: data.scopeId,
      }),
    })
  } else {
    const id = newId()
    await execute(
      db,
      `INSERT INTO approval_policy (id, workspace_id, scope_type, scope_id, action_key, mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, data.workspaceId, data.scopeType, data.scopeId, data.actionKey, data.mode, now, now],
    )
    result = {
      id,
      workspaceId: data.workspaceId,
      scopeType: data.scopeType,
      scopeId: data.scopeId,
      actionKey: data.actionKey,
      mode: data.mode,
      createdAt: now,
      updatedAt: now,
    }

    await writeAuditLog(db, {
      workspaceId: data.workspaceId,
      actorType: data.actor?.actorType ?? 'user',
      actorId: data.actor?.actorId ?? null,
      action: 'create',
      entityType: 'approval_policy',
      entityId: id,
      previousValueJson: null,
      newValueJson: JSON.stringify({
        actionKey: data.actionKey,
        mode: data.mode,
        scopeType: data.scopeType,
        scopeId: data.scopeId,
      }),
    })

    await emitEventSafe(db, {
      workspaceId: data.workspaceId,
      eventType: 'policy.created',
      actorType: data.actor?.actorType ?? 'user',
      actorId: data.actor?.actorId ?? null,
      subjectType: 'approval_policy',
      subjectId: id,
      payloadJson: JSON.stringify({
        actionKey: data.actionKey,
        mode: data.mode,
        scopeType: data.scopeType,
        scopeId: data.scopeId,
      }),
    })
  }

  return result
}

/**
 * Clears an approval policy override.
 * Deletes the row and logs an audit record.
 */
export async function clearApprovalPolicyOverride(
  db: SqlDatabase,
  input: ClearApprovalPolicyInput,
): Promise<boolean> {
  const data = clearApprovalPolicyInput.parse(input)

  const existing = await queryFirst<ApprovalPolicyRow>(
    db,
    `SELECT id, workspace_id, scope_type, scope_id, action_key, mode, created_at, updated_at
     FROM approval_policy
     WHERE workspace_id = ? AND scope_type = ? AND scope_id = ? AND action_key = ?`,
    [data.workspaceId, data.scopeType, data.scopeId, data.actionKey],
  )

  if (!existing) {
    return false
  }

  await execute(db, `DELETE FROM approval_policy WHERE id = ?`, [existing.id])

  await writeAuditLog(db, {
    workspaceId: data.workspaceId,
    actorType: data.actor?.actorType ?? 'user',
    actorId: data.actor?.actorId ?? null,
    action: 'delete',
    entityType: 'approval_policy',
    entityId: existing.id,
    previousValueJson: JSON.stringify({
      actionKey: existing.action_key,
      mode: existing.mode,
      scopeType: existing.scope_type,
      scopeId: existing.scope_id,
    }),
    newValueJson: null,
  })

  await emitEventSafe(db, {
    workspaceId: data.workspaceId,
    eventType: 'policy.deleted',
    actorType: data.actor?.actorType ?? 'user',
    actorId: data.actor?.actorId ?? null,
    subjectType: 'approval_policy',
    subjectId: existing.id,
    payloadJson: JSON.stringify({
      actionKey: existing.action_key,
      mode: existing.mode,
      scopeType: existing.scope_type,
      scopeId: existing.scope_id,
    }),
  })

  return true
}
