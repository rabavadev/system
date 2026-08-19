import { z } from 'zod'

import { execute, newId, nowIso, queryAll, type SqlDatabase } from './sql.ts'

/**
 * Event repository (structural SqlDatabase; testable in plain node).
 * Domain events are fire-and-forget history: they must never break the
 * operation that emitted them, so callers wrap emission in try/catch or
 * use `emitEventSafe`. Payloads must never contain secrets.
 */

export const emitEventInput = z.object({
  workspaceId: z.uuid().nullable().optional(),
  eventType: z.string().trim().min(1).max(120),
  actorType: z.enum(['user', 'agent', 'workflow', 'system']).default('system'),
  actorId: z.uuid().nullable().optional(),
  subjectType: z.string().trim().max(60).nullable().optional(),
  subjectId: z.uuid().nullable().optional(),
  /** JSON-safe payload; callers are responsible for keeping secrets out. */
  payloadJson: z.string().max(8000).nullable().optional(),
})
export type EmitEventInput = z.input<typeof emitEventInput>

export async function emitEvent(db: SqlDatabase, input: EmitEventInput): Promise<string> {
  const data = emitEventInput.parse(input)
  const id = newId()
  await execute(
    db,
    `INSERT INTO event (id, workspace_id, event_type, actor_type, actor_id, subject_type, subject_id, payload, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.workspaceId ?? null,
      data.eventType,
      data.actorType,
      data.actorId ?? null,
      data.subjectType ?? null,
      data.subjectId ?? null,
      data.payloadJson ?? null,
      nowIso(),
    ],
  )
  return id
}

/** Emit and swallow failures: telemetry must not break the request. */
export async function emitEventSafe(db: SqlDatabase, input: EmitEventInput): Promise<void> {
  try {
    await emitEvent(db, input)
  } catch (error) {
    console.warn('event emission failed:', error instanceof Error ? error.message : error)
  }
}

export interface EventRow {
  id: string
  workspace_id: string | null
  event_type: string
  actor_type: string
  actor_id: string | null
  subject_type: string | null
  subject_id: string | null
  payload: string | null
  occurred_at: string
}

/** Recent events of one type prefix (dev inspector). */
export async function listRecentEvents(
  db: SqlDatabase,
  workspaceId: string,
  eventTypePrefix: string,
  limit: number,
): Promise<EventRow[]> {
  return queryAll<EventRow>(
    db,
    `SELECT * FROM event WHERE workspace_id = ? AND event_type LIKE ?
     ORDER BY occurred_at DESC, rowid DESC LIMIT ?`,
    [workspaceId, `${eventTypePrefix}%`, limit],
  )
}
