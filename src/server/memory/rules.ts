import type { Memory, MemoryClass, MemoryStatus } from '~/types/domain'

/**
 * Central memory behavior rules. Pure and Worker-free so repositories,
 * server functions and tests all share the same transitions.
 *
 * The database stores precise values where useful; this module owns the
 * small user-facing vocabulary and the state transitions that must never
 * be scattered across UI components.
 */

export type ConfidenceLevel = 'low' | 'medium' | 'high'

export const CONFIDENCE_VALUE: Record<ConfidenceLevel, number> = {
  low: 0.25,
  medium: 0.55,
  high: 0.85,
}

export function confidenceLevelFromValue(value: number | null): ConfidenceLevel | null {
  if (value === null) return null
  if (value < 0.4) return 'low'
  if (value < 0.75) return 'medium'
  return 'high'
}

export const MEMORY_TYPE_LABEL: Record<MemoryClass, string> = {
  permanent_fact: 'Important Fact',
  verified_learning: 'Verified Learning',
  proposed_learning: 'Needs Verification',
  temporary_context: 'Temporary',
}

export const MEMORY_STATUS_LABEL: Record<MemoryStatus, string> = {
  active: 'Active',
  superseded: 'Replaced',
  archived: 'Archived',
  rejected: 'Rejected',
}

/** Evidence is deliberately lightweight in STEP 7: notes plus provenance. */
export interface MemoryEvidenceItem {
  type: 'note' | 'conversation' | 'message' | 'manual'
  text: string
  referenceId?: string
}

function isEvidenceItem(value: unknown): value is MemoryEvidenceItem {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<MemoryEvidenceItem>
  return (
    (item.type === 'note' ||
      item.type === 'conversation' ||
      item.type === 'message' ||
      item.type === 'manual') &&
    typeof item.text === 'string'
  )
}

export function evidenceTextToJson(
  text: string | null | undefined,
  reference?: { type: MemoryEvidenceItem['type']; id?: string },
): string | null {
  const trimmed = text?.trim() ?? ''
  if (!trimmed) return null
  const item: MemoryEvidenceItem = {
    type: reference?.type ?? 'note',
    text: trimmed,
    ...(reference?.id ? { referenceId: reference.id } : {}),
  }
  return JSON.stringify([item])
}

export function parseEvidence(evidenceJson: string | null): MemoryEvidenceItem[] {
  if (!evidenceJson) return []
  try {
    const parsed: unknown = JSON.parse(evidenceJson)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isEvidenceItem)
  } catch {
    return []
  }
}

export function evidenceSummary(evidenceJson: string | null): string | null {
  const items = parseEvidence(evidenceJson)
  if (items.length === 0) return null
  const first = items[0]?.text ?? ''
  return items.length === 1 ? first : `${first} (+${items.length - 1} more)`
}

export function isExpiredAt(expiresAt: string | null, now: string): boolean {
  return expiresAt !== null && expiresAt <= now
}

/** Memory freshness is derived, never stored: active + unexpired is current. */
export function memoryFreshness(
  memory: Pick<Memory, 'status' | 'expiresAt'>,
  now: string,
): 'current' | 'expired' | 'inactive' {
  if (memory.status !== 'active') return 'inactive'
  return isExpiredAt(memory.expiresAt, now) ? 'expired' : 'current'
}

/** Class-specific write rules that keep hypotheses visibly unverified. */
export function assertMemoryClassRules(input: {
  memoryClass: MemoryClass
  confidence: number | null
  evidenceJson: string | null
  expiresAt: string | null
}): void {
  if (input.confidence !== null && (input.confidence < 0 || input.confidence > 1)) {
    throw new Error('Confidence must be between 0 and 1.')
  }

  if (input.memoryClass === 'verified_learning') {
    if (input.confidence === null) {
      throw new Error('Add a confidence level before saving a verified learning.')
    }
    if (parseEvidence(input.evidenceJson).length === 0) {
      throw new Error('Add evidence before saving a verified learning.')
    }
  }

  if (input.memoryClass === 'temporary_context' && input.confidence !== null) {
    throw new Error('Temporary context does not use confidence.')
  }

  if (input.expiresAt !== null && input.expiresAt.length === 0) {
    throw new Error('Expiry must be a valid date.')
  }
}

export type MemoryTransition = 'archive' | 'restore' | 'verify' | 'reject' | 'supersede'

/** Reject impossible state changes in one place. */
export function assertMemoryTransition(
  memory: Pick<Memory, 'id' | 'memoryClass' | 'status' | 'expiresAt'>,
  transition: MemoryTransition,
  now: string,
): void {
  switch (transition) {
    case 'archive':
      if (memory.status === 'archived') return
      if (memory.status !== 'active' && memory.status !== 'rejected') {
        throw new Error('Only current or rejected memory can be archived.')
      }
      return
    case 'restore':
      if (memory.status !== 'archived') {
        throw new Error('Only archived memory can be restored.')
      }
      return
    case 'verify':
      if (memory.status !== 'active' || memory.memoryClass !== 'proposed_learning') {
        throw new Error('Only an active proposed learning can be verified.')
      }
      if (isExpiredAt(memory.expiresAt, now)) {
        throw new Error('Expired memory cannot be verified. Restore or replace it first.')
      }
      return
    case 'reject':
      if (memory.status !== 'active' || memory.memoryClass !== 'proposed_learning') {
        throw new Error('Only an active proposed learning can be rejected.')
      }
      return
    case 'supersede':
      if (memory.status !== 'active') {
        throw new Error('Only current memory can be replaced.')
      }
      if (memory.memoryClass === 'temporary_context') {
        throw new Error('Temporary context should expire or be archived, not replaced.')
      }
      if (isExpiredAt(memory.expiresAt, now)) {
        throw new Error('Expired memory cannot be replaced. Create a new memory instead.')
      }
      return
  }
}

export function assertSupersessionAllowed(
  memory: Pick<Memory, 'id' | 'memoryClass' | 'status' | 'expiresAt'>,
  replacementId: string,
  now: string,
): void {
  if (memory.id === replacementId) {
    throw new Error('A memory cannot replace itself.')
  }
  assertMemoryTransition(memory, 'supersede', now)
}
