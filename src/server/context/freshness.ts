import type { Freshness } from './types.ts'

/**
 * Pure freshness logic. Freshness is always derived from stored fields
 * (never a stored column), so it cannot drift. `now` is an ISO-8601 UTC
 * string; ISO strings compare lexicographically, which keeps these
 * functions total and unit-testable without a clock.
 */

export function isExpiredAt(expiresAt: string | null, now: string): boolean {
  return expiresAt !== null && expiresAt <= now
}

/**
 * Memory freshness (docs/database.md): a memory is fresh iff
 * `status = 'active'` and not past `expires_at`. Status-based states
 * (superseded/archived/rejected) are exclusions, not freshness values, so
 * this only distinguishes current vs expired.
 */
export function memoryFreshness(
  input: { expiresAt: string | null },
  now: string,
): 'current' | 'expired' {
  return isExpiredAt(input.expiresAt, now) ? 'expired' : 'current'
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Research freshness:
 *   expired — past `expires_at` or status 'archived'
 *   stale   — explicitly marked stale; may still be returned, always marked
 *   aging   — completed but not verified/updated within `agingDays`
 *   current — everything else (recently verified/updated completed work)
 *
 * 'draft' / 'in_progress' research is not ready and never reaches this
 * function (the engine excludes it with a trace entry).
 */
export function researchFreshness(
  input: {
    status: string
    expiresAt: string | null
    lastVerifiedAt: string | null
    updatedAt: string
  },
  now: string,
  agingDays: number,
): Freshness {
  if (input.status === 'archived' || isExpiredAt(input.expiresAt, now)) {
    return 'expired'
  }
  if (input.status === 'stale') {
    return 'stale'
  }
  const basis = input.lastVerifiedAt ?? input.updatedAt
  const ageMs = Date.parse(now) - Date.parse(basis)
  if (Number.isFinite(ageMs) && ageMs > agingDays * DAY_MS) {
    return 'aging'
  }
  return 'current'
}
