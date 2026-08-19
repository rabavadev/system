import { z } from 'zod'

import { execute, newId, nowIso, type SqlDatabase } from './sql.ts'

/**
 * Mutation audit trail. This is intentionally small: repositories write a
 * before/after snapshot for meaningful user-visible mutations. Snapshots
 * must never contain secrets.
 */

export const writeAuditInput = z.object({
  workspaceId: z.uuid().nullable().optional(),
  actorType: z.enum(['user', 'agent', 'workflow', 'system']).default('user'),
  actorId: z.uuid().nullable().optional(),
  action: z.enum(['create', 'update', 'delete', 'restore']),
  entityType: z.string().trim().min(1).max(60),
  entityId: z.uuid(),
  previousValueJson: z.string().max(12000).nullable().optional(),
  newValueJson: z.string().max(12000).nullable().optional(),
})
export type WriteAuditInput = z.input<typeof writeAuditInput>

export async function writeAuditLog(db: SqlDatabase, input: WriteAuditInput): Promise<string> {
  const data = writeAuditInput.parse(input)
  const id = newId()
  await execute(
    db,
    `INSERT INTO audit_log (
       id, workspace_id, actor_type, actor_id, action, entity_type, entity_id,
       previous_value, new_value, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.workspaceId ?? null,
      data.actorType,
      data.actorId ?? null,
      data.action,
      data.entityType,
      data.entityId,
      data.previousValueJson ?? null,
      data.newValueJson ?? null,
      nowIso(),
    ],
  )
  return id
}

export interface AuditLogRow {
  id: string
  workspace_id: string | null
  actor_type: string
  actor_id: string | null
  action: string
  entity_type: string
  entity_id: string
  previous_value: string | null
  new_value: string | null
  created_at: string
}
