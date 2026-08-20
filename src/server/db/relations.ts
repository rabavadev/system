import type { Brand, Niche, Product } from '~/types/domain'

/**
 * Pure relationship-integrity checks shared by the repositories.
 *
 * Cross-entity rules (a product's niche must belong to its brand, an
 * account's primary niche must be one of its associated niches, archived
 * entities must not be linked) are enforced here, application-side, on top
 * of the schema's foreign keys. This module deliberately has no D1 imports
 * so it can be unit-tested outside the Worker (see scripts/test-relations.ts).
 */

/** Minimal niche shape needed for integrity checks. */
export interface NicheRef {
  id: string
  brandId: string
  workspaceId: string
  deletedAt: string | null
}

/** A business-rule violation. Messages are safe to show to the user. */
export class IntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IntegrityError'
  }
}

/** A brand must exist and not be archived before children change under it. */
export function requireActiveBrand(brand: Brand | null): Brand {
  if (!brand) {
    throw new IntegrityError('Brand not found.')
  }
  if (brand.deletedAt) {
    throw new IntegrityError('This brand is archived. Restore it before making changes.')
  }
  return brand
}

/** A niche must exist and not be archived before children change under it. */
export function requireActiveNiche(niche: Niche | null): Niche {
  if (!niche) {
    throw new IntegrityError('Niche not found.')
  }
  if (niche.deletedAt) {
    throw new IntegrityError('This niche is archived. Restore it before making changes.')
  }
  return niche
}

/** A product's niche must exist, be active, and belong to the product's brand. */
export function requireNicheForBrand(niche: Niche | null, brandId: string): Niche {
  const found = requireActiveNiche(niche)
  if (found.brandId !== brandId) {
    throw new IntegrityError('That niche belongs to a different brand.')
  }
  return found
}

/** A product must exist and not be archived before campaigns or content link to it. */
export function requireActiveProduct(product: Product | null): Product {
  if (!product) {
    throw new IntegrityError('Product not found.')
  }
  if (product.deletedAt || product.status === 'archived') {
    throw new IntegrityError('This product is archived. Restore it before making changes.')
  }
  return product
}

/** A campaign's product must exist, be active, and belong to the campaign's brand. */
export function requireProductForBrand(product: Product | null, brandId: string): Product {
  const found = requireActiveProduct(product)
  if (found.brandId !== brandId) {
    throw new IntegrityError('That product belongs to a different brand.')
  }
  return found
}

/**
 * Validate an account's niche associations plus its primary niche.
 *
 * Rules:
 *   * every niche must belong to the account's workspace and be active
 *   * the primary niche must be one of the associated niches
 *   * duplicate associations are collapsed
 *
 * `niches` must be the rows resolved for the requested ids; the caller
 * checks that every requested id resolved (see account repository).
 */
export function resolveAccountNiches(
  niches: NicheRef[],
  workspaceId: string,
  primaryNicheId: string | null | undefined,
): { nicheIds: string[]; primaryNicheId: string | null } {
  const nicheIds: string[] = []
  for (const niche of niches) {
    if (niche.workspaceId !== workspaceId) {
      throw new IntegrityError('That niche is not part of this workspace.')
    }
    if (niche.deletedAt) {
      throw new IntegrityError('An archived niche cannot be added to an account. Restore it first.')
    }
    if (!nicheIds.includes(niche.id)) {
      nicheIds.push(niche.id)
    }
  }
  if (primaryNicheId && !nicheIds.includes(primaryNicheId)) {
    throw new IntegrityError("The primary niche must be one of the account's niches.")
  }
  return { nicheIds, primaryNicheId: primaryNicheId ?? null }
}
