import { z } from 'zod'

import { getBrandById } from '~/server/db/brand'
import { execute, getDb, newId, nowIso, queryAll, queryFirst } from '~/server/db/client'
import { type NicheRef, requireActiveBrand, requireActiveNiche } from '~/server/db/relations'
import type { Niche } from '~/types/domain'

interface NicheRow {
  id: string
  brand_id: string
  name: string
  description: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

function toNiche(row: NicheRow): Niche {
  return {
    id: row.id,
    brandId: row.brand_id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }
}

/** Niche plus real related counts, for list screens. */
export interface NicheSummary extends Niche {
  productCount: number
  accountCount: number
}

export const createNicheInput = z.object({
  brandId: z.uuid(),
  name: z.string().trim().min(1, 'Give the niche a name.').max(120),
  description: z.string().trim().max(500).optional(),
})
export type CreateNicheInput = z.input<typeof createNicheInput>

export const updateNicheInput = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1, 'Give the niche a name.').max(120),
  description: z.string().trim().max(500).nullable().optional(),
})
export type UpdateNicheInput = z.input<typeof updateNicheInput>

/** Active niches of a brand, with real product/account counts. */
export async function listNiches(brandId: string): Promise<NicheSummary[]> {
  const rows = await queryAll<NicheRow & { product_count: number; account_count: number }>(
    getDb(),
    `SELECT n.*,
       (SELECT COUNT(*) FROM product p WHERE p.niche_id = n.id AND p.deleted_at IS NULL AND p.status != 'archived') AS product_count,
       (SELECT COUNT(*) FROM account_niche an JOIN account a ON a.id = an.account_id
         WHERE an.niche_id = n.id AND a.deleted_at IS NULL AND a.status != 'archived') AS account_count
     FROM niche n
     WHERE n.brand_id = ? AND n.deleted_at IS NULL
     ORDER BY n.created_at ASC`,
    [brandId],
  )
  return rows.map((row) => ({
    ...toNiche(row),
    productCount: row.product_count,
    accountCount: row.account_count,
  }))
}

/** Archived niches of a brand, restorable. */
export async function listArchivedNiches(brandId: string): Promise<Niche[]> {
  const rows = await queryAll<NicheRow>(
    getDb(),
    `SELECT * FROM niche WHERE brand_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC`,
    [brandId],
  )
  return rows.map(toNiche)
}

/** Fetch a niche regardless of archive state. */
export async function getNicheById(id: string): Promise<Niche | null> {
  const row = await queryFirst<NicheRow>(getDb(), `SELECT * FROM niche WHERE id = ?`, [id])
  return row ? toNiche(row) : null
}

/**
 * Resolve niches with their brand's workspace, for account-niche
 * integrity checks. Only returns rows that exist; callers compare counts.
 */
export async function getNicheRefs(ids: string[]): Promise<NicheRef[]> {
  if (ids.length === 0) {
    return []
  }
  const placeholders = ids.map(() => '?').join(', ')
  const rows = await queryAll<{
    id: string
    brand_id: string
    workspace_id: string
    deleted_at: string | null
  }>(
    getDb(),
    `SELECT n.id, n.brand_id, n.deleted_at, b.workspace_id
     FROM niche n JOIN brand b ON b.id = n.brand_id
     WHERE n.id IN (${placeholders})`,
    ids,
  )
  return rows.map((row) => ({
    id: row.id,
    brandId: row.brand_id,
    workspaceId: row.workspace_id,
    deletedAt: row.deleted_at,
  }))
}

export async function createNiche(input: CreateNicheInput): Promise<Niche> {
  const data = createNicheInput.parse(input)
  requireActiveBrand(await getBrandById(data.brandId))
  const id = newId()
  const now = nowIso()
  await execute(
    getDb(),
    `INSERT INTO niche (id, brand_id, name, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, data.brandId, data.name, data.description ?? null, now, now],
  )
  const created = await getNicheById(id)
  if (!created) {
    throw new Error('niche insert did not produce a readable row')
  }
  return created
}

export async function updateNiche(input: UpdateNicheInput): Promise<Niche> {
  const data = updateNicheInput.parse(input)
  requireActiveNiche(await getNicheById(data.id))
  await execute(
    getDb(),
    `UPDATE niche SET name = ?, description = ?, updated_at = ? WHERE id = ?`,
    [data.name, data.description ?? null, nowIso(), data.id],
  )
  const updated = await getNicheById(data.id)
  if (!updated) {
    throw new Error('niche update did not produce a readable row')
  }
  return updated
}

/** Archive = soft delete. Products/accounts keep pointing at the row. */
export async function archiveNiche(id: string): Promise<void> {
  requireActiveNiche(await getNicheById(id))
  await execute(getDb(), `UPDATE niche SET deleted_at = ?, updated_at = ? WHERE id = ?`, [
    nowIso(),
    nowIso(),
    id,
  ])
}

export async function restoreNiche(id: string): Promise<void> {
  const existing = await getNicheById(id)
  if (!existing) {
    throw new Error('Niche not found.')
  }
  if (!existing.deletedAt) {
    return
  }
  requireActiveBrand(await getBrandById(existing.brandId))
  await execute(getDb(), `UPDATE niche SET deleted_at = NULL, updated_at = ? WHERE id = ?`, [
    nowIso(),
    id,
  ])
}
