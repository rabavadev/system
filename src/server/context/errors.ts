/**
 * Typed context failures. Expected resolution problems (unknown ids,
 * archived entities, conflicting scopes, cross-workspace references) throw
 * ContextError with a stable code — never a generic 500. Messages are
 * user-safe: they name the kind of problem, not database internals.
 */

export type ContextErrorCode =
  | 'workspace_not_found'
  | 'entity_not_found'
  | 'entity_archived'
  | 'workspace_mismatch'
  | 'scope_conflict'
  | 'invalid_relationship'
  | 'conversation_mismatch'

export class ContextError extends Error {
  readonly code: ContextErrorCode
  readonly entityType: string | null
  readonly entityId: string | null

  constructor(code: ContextErrorCode, message: string, entity?: { type: string; id: string }) {
    super(message)
    this.name = 'ContextError'
    this.code = code
    this.entityType = entity?.type ?? null
    this.entityId = entity?.id ?? null
  }
}

/** Safe public shape of a context failure (for server functions). */
export function toContextErrorPayload(error: unknown): {
  code: ContextErrorCode | 'internal'
  message: string
} {
  if (error instanceof ContextError) {
    return { code: error.code, message: error.message }
  }
  return { code: 'internal', message: 'Context could not be resolved.' }
}
