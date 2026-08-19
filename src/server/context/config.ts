import type { ContextLimits } from './types.ts'

/**
 * Central context retrieval limits. The ONE place bounding how much the
 * Context Engine may load — repositories never hard-code their own limits
 * for context retrieval. This is a count budget, not a token budget; token
 * budgeting belongs to a later provider layer.
 *
 * `recentMessages`: 30 sits inside the agreed 20–40 window — enough for a
 * chat to feel continuous without dragging stale small talk into scope.
 */
export const DEFAULT_CONTEXT_LIMITS: ContextLimits = {
  recentMessages: 30,
  maxMemories: 20,
  maxResearch: 10,
  maxGoals: 10,
  researchAgingDays: 90,
}

/**
 * Candidate over-fetch multipliers. Candidates are fetched slightly wider
 * than the final limit so ranking/filtering (expired, superseded, stale...)
 * has room to drop rows without undershooting; the trace then explains
 * every drop.
 */
export const MEMORY_CANDIDATE_MULTIPLIER = 4
export const RESEARCH_CANDIDATE_MULTIPLIER = 3
export const GOAL_CANDIDATE_MULTIPLIER = 2

/**
 * How many ineligible rows (expired, superseded, draft...) are fetched per
 * knowledge type purely to explain their exclusion in the trace.
 */
export const TRACE_EXCLUSION_SAMPLE = 25

/** Absolute ceiling for any single retrieval limit, override or not. */
const HARD_CAP = 200
const MAX_AGING_DAYS = 3650

function clampInt(value: number, fallback: number, max: number): number {
  if (!Number.isFinite(value)) {
    return fallback
  }
  return Math.min(Math.max(Math.trunc(value), 1), max)
}

/** Merge per-call overrides over the defaults, clamped to sane bounds. */
export function resolveLimits(overrides?: Partial<ContextLimits>): ContextLimits {
  return {
    recentMessages: clampInt(
      overrides?.recentMessages ?? Number.NaN,
      DEFAULT_CONTEXT_LIMITS.recentMessages,
      HARD_CAP,
    ),
    maxMemories: clampInt(
      overrides?.maxMemories ?? Number.NaN,
      DEFAULT_CONTEXT_LIMITS.maxMemories,
      HARD_CAP,
    ),
    maxResearch: clampInt(
      overrides?.maxResearch ?? Number.NaN,
      DEFAULT_CONTEXT_LIMITS.maxResearch,
      HARD_CAP,
    ),
    maxGoals: clampInt(
      overrides?.maxGoals ?? Number.NaN,
      DEFAULT_CONTEXT_LIMITS.maxGoals,
      HARD_CAP,
    ),
    researchAgingDays: clampInt(
      overrides?.researchAgingDays ?? Number.NaN,
      DEFAULT_CONTEXT_LIMITS.researchAgingDays,
      MAX_AGING_DAYS,
    ),
  }
}
