import type { GoalScopeType, MemoryClass, MemoryScopeType } from '~/types/domain'

import type {
  ContextGoal,
  ContextMemory,
  ContextResearch,
  Freshness,
  MemoryAuthority,
} from './types.ts'

/**
 * Pure, deterministic ranking. Every comparator ends in a unique tie-break
 * (id ascending), so output never depends on database or sort accident.
 */

/**
 * Scope specificity: a memory/research item written against a narrow scope
 * is more relevant to a matching request than a broad one.
 * Product ranks above account: a product sits inside the brand→niche
 * hierarchy, while an account is only loosely related to niches.
 */
export const SCOPE_SPECIFICITY: Record<MemoryScopeType, number> = {
  campaign: 70,
  product: 60,
  account: 55,
  niche: 50,
  brand: 40,
  platform: 30,
  workspace: 10,
}

/** Goal scopes are a subset of the memory vocabulary. */
export const GOAL_SCOPE_SPECIFICITY: Record<GoalScopeType, number> = {
  campaign: 40,
  product: 30,
  brand: 20,
  workspace: 10,
}

/** Authority order: permanent fact > verified > proposed > temporary. */
export const MEMORY_AUTHORITY_RANK: Record<MemoryClass, number> = {
  permanent_fact: 40,
  verified_learning: 30,
  proposed_learning: 20,
  temporary_context: 10,
}

export const MEMORY_AUTHORITY_LABEL: Record<MemoryClass, MemoryAuthority> = {
  permanent_fact: 'fact',
  verified_learning: 'trusted',
  proposed_learning: 'hypothesis',
  temporary_context: 'ephemeral',
}

export const FRESHNESS_RANK: Record<Freshness, number> = {
  current: 30,
  aging: 20,
  stale: 10,
  expired: 0,
}

/** Descending, nulls last. */
function compareNullableNumber(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return b - a
}

/** Descending ISO strings, nulls last. */
function compareNullableIso(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return a < b ? 1 : a > b ? -1 : 0
}

function chain(...comparisons: number[]): number {
  for (const c of comparisons) {
    if (c !== 0) return c
  }
  return 0
}

/**
 * Memory order: scope specificity → authority → confidence → verification
 * recency → creation recency → id.
 */
export function compareMemories(a: ContextMemory, b: ContextMemory): number {
  return chain(
    SCOPE_SPECIFICITY[b.scopeType] - SCOPE_SPECIFICITY[a.scopeType],
    MEMORY_AUTHORITY_RANK[b.memoryClass] - MEMORY_AUTHORITY_RANK[a.memoryClass],
    compareNullableNumber(a.confidence, b.confidence),
    compareNullableIso(a.lastVerifiedAt, b.lastVerifiedAt),
    compareNullableIso(a.createdAt, b.createdAt),
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )
}

/** Research order: scope specificity → freshness → confidence → recency. */
export function compareResearch(a: ContextResearch, b: ContextResearch): number {
  const specA = a.scopeType ? SCOPE_SPECIFICITY[a.scopeType] : SCOPE_SPECIFICITY.workspace
  const specB = b.scopeType ? SCOPE_SPECIFICITY[b.scopeType] : SCOPE_SPECIFICITY.workspace
  return chain(
    specB - specA,
    FRESHNESS_RANK[b.freshness] - FRESHNESS_RANK[a.freshness],
    compareNullableNumber(a.confidence, b.confidence),
    compareNullableIso(a.updatedAt, b.updatedAt),
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )
}

/** Goal order: scope specificity → soonest due → creation recency → id. */
export function compareGoals(a: ContextGoal, b: ContextGoal): number {
  return chain(
    GOAL_SCOPE_SPECIFICITY[b.scopeType] - GOAL_SCOPE_SPECIFICITY[a.scopeType],
    // dueAt ascending (soonest first), nulls last
    a.dueAt === null && b.dueAt === null
      ? 0
      : a.dueAt === null
        ? 1
        : b.dueAt === null
          ? -1
          : a.dueAt < b.dueAt
            ? -1
            : a.dueAt > b.dueAt
              ? 1
              : 0,
    compareNullableIso(a.scopeId, b.scopeId),
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )
}
