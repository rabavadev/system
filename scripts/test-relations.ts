/**
 * Relationship-integrity tests (npm run test:relations).
 *
 * Unit-tests the pure validation rules the repositories enforce on top of
 * the schema: cross-brand rejection, archived-entity rejection, and
 * primary-niche compatibility. Runs with node --experimental-strip-types;
 * the module under test has no D1 imports on purpose.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  IntegrityError,
  type NicheRef,
  requireActiveBrand,
  requireNicheForBrand,
  resolveAccountNiches,
} from '../src/server/db/relations.ts'

const WS = 'ws-1'
const BRAND = 'brand-1'

function niche(overrides: Partial<NicheRef> = {}): NicheRef {
  return { id: 'n-1', brandId: BRAND, workspaceId: WS, deletedAt: null, ...overrides }
}

function brand(deletedAt: string | null = null) {
  return {
    id: BRAND,
    workspaceId: WS,
    name: 'B',
    description: null,
    createdAt: 't',
    updatedAt: 't',
    deletedAt,
  }
}

test('requireActiveBrand rejects missing and archived brands', () => {
  assert.throws(() => requireActiveBrand(null), IntegrityError)
  assert.throws(() => requireActiveBrand(brand('2026-01-01T00:00:00Z')), /archived/)
  assert.equal(requireActiveBrand(brand()).id, BRAND)
})

test('requireNicheForBrand rejects cross-brand and archived niches', () => {
  const ok = {
    id: 'n-1',
    brandId: BRAND,
    name: 'N',
    description: null,
    createdAt: 't',
    updatedAt: 't',
    deletedAt: null,
  }
  assert.equal(requireNicheForBrand(ok, BRAND).id, 'n-1')
  assert.throws(() => requireNicheForBrand(null, BRAND), IntegrityError)
  assert.throws(
    () => requireNicheForBrand({ ...ok, brandId: 'other-brand' }, BRAND),
    /different brand/,
  )
  assert.throws(
    () => requireNicheForBrand({ ...ok, deletedAt: '2026-01-01T00:00:00Z' }, BRAND),
    /archived/,
  )
})

test('resolveAccountNiches accepts niches from multiple brands of one workspace', () => {
  const result = resolveAccountNiches(
    [niche({ id: 'n-1' }), niche({ id: 'n-2', brandId: 'brand-2' })],
    WS,
    'n-2',
  )
  assert.deepEqual(result, { nicheIds: ['n-1', 'n-2'], primaryNicheId: 'n-2' })
})

test('resolveAccountNiches rejects niches from another workspace', () => {
  assert.throws(
    () => resolveAccountNiches([niche({ workspaceId: 'ws-2' })], WS, null),
    /not part of this workspace/,
  )
})

test('resolveAccountNiches rejects archived niches', () => {
  assert.throws(
    () => resolveAccountNiches([niche({ deletedAt: '2026-01-01T00:00:00Z' })], WS, null),
    /archived niche/,
  )
})

test('resolveAccountNiches rejects a primary niche outside the associations', () => {
  assert.throws(
    () => resolveAccountNiches([niche({ id: 'n-1' })], WS, 'n-elsewhere'),
    /primary niche/,
  )
})

test('resolveAccountNiches collapses duplicates and allows no primary', () => {
  const result = resolveAccountNiches([niche({ id: 'n-1' }), niche({ id: 'n-1' })], WS, null)
  assert.deepEqual(result, { nicheIds: ['n-1'], primaryNicheId: null })
})
