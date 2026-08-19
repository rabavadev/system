import { ContextError } from './errors.ts'
import type { ContextScopeSource } from './types.ts'

/**
 * Pure scope rules: archived-state detection, relationship validation and
 * precedence. No database imports — the engine loads rows, these functions
 * judge them. Unit-testable without any Worker dependency.
 *
 * Archive semantics differ per entity (see docs/database.md):
 *   brand / niche / conversation — `deletedAt` set
 *   product / account / campaign — status 'archived' (or `deletedAt`)
 */

export interface ScopedBrand {
  id: string
  workspaceId: string
  name: string
  description: string | null
  deletedAt: string | null
}

export interface ScopedNiche {
  id: string
  brandId: string
  name: string
  description: string | null
  deletedAt: string | null
}

export interface ScopedProduct {
  id: string
  brandId: string
  nicheId: string | null
  name: string
  description: string | null
  url: string | null
  status: string
  deletedAt: string | null
}

export interface ScopedAccount {
  id: string
  workspaceId: string
  handle: string
  displayName: string | null
  status: string
  deletedAt: string | null
  primaryNicheId: string | null
  /** All associated niches, including archived ones (the engine decides). */
  niches: { id: string; brandId: string; deletedAt: string | null }[]
}

export interface ScopedCampaign {
  id: string
  workspaceId: string
  brandId: string | null
  productId: string | null
  name: string
  status: string
  startsAt: string | null
  endsAt: string | null
  deletedAt: string | null
}

export function isBrandArchived(brand: ScopedBrand): boolean {
  return brand.deletedAt !== null
}

export function isNicheArchived(niche: ScopedNiche): boolean {
  return niche.deletedAt !== null
}

export function isProductArchived(product: ScopedProduct): boolean {
  return product.status === 'archived' || product.deletedAt !== null
}

export function isAccountArchived(account: ScopedAccount): boolean {
  return account.status === 'archived' || account.deletedAt !== null
}

export function isCampaignArchived(campaign: ScopedCampaign): boolean {
  return campaign.status === 'archived' || campaign.deletedAt !== null
}

/** Two entities must live in the same workspace. */
export function assertEntityWorkspace(
  entityWorkspaceId: string,
  workspaceId: string,
  entityType: string,
  entityId: string,
): void {
  if (entityWorkspaceId !== workspaceId) {
    throw new ContextError('workspace_mismatch', 'That item belongs to a different workspace.', {
      type: entityType,
      id: entityId,
    })
  }
}

/** A niche only makes sense under its own brand. */
export function checkNicheBrand(niche: ScopedNiche, brand: ScopedBrand): void {
  if (niche.brandId !== brand.id) {
    throw new ContextError(
      'scope_conflict',
      'That niche belongs to a different brand than requested.',
      { type: 'niche', id: niche.id },
    )
  }
}

/**
 * A product is owned by exactly one brand and optionally sits in one niche
 * of that same brand. Both must agree with any explicit brand/niche.
 */
export function checkProductAlignment(
  product: ScopedProduct,
  brand: ScopedBrand | null,
  niche: ScopedNiche | null,
): void {
  if (brand && product.brandId !== brand.id) {
    throw new ContextError(
      'scope_conflict',
      'That product belongs to a different brand than requested.',
      { type: 'product', id: product.id },
    )
  }
  if (niche) {
    if (niche.brandId !== product.brandId) {
      throw new ContextError(
        'scope_conflict',
        'That niche and that product belong to different brands.',
        { type: 'niche', id: niche.id },
      )
    }
    if (product.nicheId !== null && product.nicheId !== niche.id) {
      throw new ContextError(
        'scope_conflict',
        'That product belongs to a different niche than requested.',
        { type: 'product', id: product.id },
      )
    }
  }
}

/**
 * Account ↔ brand. An account is not owned by a brand; it is associated
 * with niches. So an explicit brand is compatible iff the account has no
 * active niches yet, or at least one active niche inside that brand. An
 * account whose active niches all live in other brands contradicts the
 * requested brand and is rejected (no silent cross-brand context).
 */
export function checkAccountBrand(account: ScopedAccount, brandId: string): void {
  const activeBrands = new Set(
    account.niches.filter((n) => n.deletedAt === null).map((n) => n.brandId),
  )
  if (activeBrands.size > 0 && !activeBrands.has(brandId)) {
    throw new ContextError(
      'scope_conflict',
      'That account is not associated with the requested brand.',
      { type: 'account', id: account.id },
    )
  }
}

/**
 * The brand an account implies on its own: the primary niche's brand when
 * available, else the single shared brand of its active niches, else null
 * (account spans multiple brands — do not guess).
 */
export function deriveAccountBrandId(account: ScopedAccount): string | null {
  const active = account.niches.filter((n) => n.deletedAt === null)
  if (account.primaryNicheId) {
    const primary = active.find((n) => n.id === account.primaryNicheId)
    if (primary) {
      return primary.brandId
    }
  }
  const brands = new Set(active.map((n) => n.brandId))
  return brands.size === 1 ? (active[0]?.brandId ?? null) : null
}

/** A campaign's optional brand/product links must agree with the request. */
export function checkCampaignAlignment(
  campaign: ScopedCampaign,
  brand: ScopedBrand | null,
  product: ScopedProduct | null,
): void {
  if (brand && campaign.brandId !== null && campaign.brandId !== brand.id) {
    throw new ContextError(
      'scope_conflict',
      'That campaign belongs to a different brand than requested.',
      { type: 'campaign', id: campaign.id },
    )
  }
  if (product && campaign.productId !== null && campaign.productId !== product.id) {
    throw new ContextError(
      'scope_conflict',
      'That campaign belongs to a different product than requested.',
      { type: 'campaign', id: campaign.id },
    )
  }
}

/**
 * Deterministic source precedence:
 *   explicit request > persisted conversation scope > UI selection >
 *   workspace default.
 */
export function decideScopeSource(input: {
  hasExplicit: boolean
  hasConversationScope: boolean
  hasUiBrand: boolean
}): ContextScopeSource {
  if (input.hasExplicit) return 'explicit'
  if (input.hasConversationScope) return 'conversation'
  if (input.hasUiBrand) return 'ui'
  return 'workspace'
}

/** The most specific resolved scope wins the activeScope slot. */
export function mostSpecificScope(resolved: {
  campaignId: string | null
  productId: string | null
  accountId: string | null
  nicheId: string | null
  brandId: string | null
}): {
  type: 'workspace' | 'brand' | 'niche' | 'product' | 'account' | 'campaign'
  id: string | null
} {
  if (resolved.campaignId) return { type: 'campaign', id: resolved.campaignId }
  if (resolved.productId) return { type: 'product', id: resolved.productId }
  if (resolved.accountId) return { type: 'account', id: resolved.accountId }
  if (resolved.nicheId) return { type: 'niche', id: resolved.nicheId }
  if (resolved.brandId) return { type: 'brand', id: resolved.brandId }
  return { type: 'workspace', id: null }
}
