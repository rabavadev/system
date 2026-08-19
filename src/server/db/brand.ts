import { z } from 'zod'

import { execute, getDb, newId, nowIso, queryAll, queryFirst } from '~/server/db/client'
import type { Brand } from '~/types/domain'

interface BrandRow {
  id: string
  workspace_id: string
  name: string
  description: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

function toBrand(row: BrandRow): Brand {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }
}

/** Brand plus real child counts, for list screens. */
export interface BrandSummary extends Brand {
  nicheCount: number
  productCount: number
}

export const createBrandInput = z.object({
  workspaceId: z.uuid(),
  name: z.string().trim().min(1, 'Give the brand a name.').max(120),
  description: z.string().trim().max(500).optional(),
})
export type CreateBrandInput = z.input<typeof createBrandInput>

export const updateBrandInput = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1, 'Give the brand a name.').max(120),
  description: z.string().trim().max(500).nullable().optional(),
})
export type UpdateBrandInput = z.input<typeof updateBrandInput>

/** Active (non-archived) brands of a workspace, with child counts. */
export async function listBrands(workspaceId: string): Promise<BrandSummary[]> {
  const rows = await queryAll<BrandRow & { niche_count: number; product_count: number }>(
    getDb(),
    `SELECT b.*,
       (SELECT COUNT(*) FROM niche n WHERE n.brand_id = b.id AND n.deleted_at IS NULL) AS niche_count,
       (SELECT COUNT(*) FROM product p WHERE p.brand_id = b.id AND p.deleted_at IS NULL AND p.status != 'archived') AS product_count
     FROM brand b
     WHERE b.workspace_id = ? AND b.deleted_at IS NULL
     ORDER BY b.created_at ASC`,
    [workspaceId],
  )
  return rows.map((row) => ({
    ...toBrand(row),
    nicheCount: row.niche_count,
    productCount: row.product_count,
  }))
}

/** Archived brands, restorable. */
export async function listArchivedBrands(workspaceId: string): Promise<Brand[]> {
  const rows = await queryAll<BrandRow>(
    getDb(),
    `SELECT * FROM brand WHERE workspace_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC`,
    [workspaceId],
  )
  return rows.map(toBrand)
}

/** Fetch a brand regardless of archive state (detail screens need both). */
export async function getBrandById(id: string): Promise<Brand | null> {
  const row = await queryFirst<BrandRow>(getDb(), `SELECT * FROM brand WHERE id = ?`, [id])
  return row ? toBrand(row) : null
}

export async function createBrand(input: CreateBrandInput): Promise<Brand> {
  const data = createBrandInput.parse(input)
  const id = newId()
  const now = nowIso()
  await execute(
    getDb(),
    `INSERT INTO brand (id, workspace_id, name, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, data.workspaceId, data.name, data.description ?? null, now, now],
  )
  const created = await getBrandById(id)
  if (!created) {
    throw new Error('brand insert did not produce a readable row')
  }
  return created
}

export async function updateBrand(input: UpdateBrandInput): Promise<Brand> {
  const data = updateBrandInput.parse(input)
  const existing = await getBrandById(data.id)
  if (!existing) {
    throw new Error('Brand not found.')
  }
  await execute(
    getDb(),
    `UPDATE brand SET name = ?, description = ?, updated_at = ? WHERE id = ?`,
    [data.name, data.description ?? null, nowIso(), data.id],
  )
  const updated = await getBrandById(data.id)
  if (!updated) {
    throw new Error('brand update did not produce a readable row')
  }
  return updated
}

/** Archive = soft delete. Children keep their rows and history. */
export async function archiveBrand(id: string): Promise<void> {
  const existing = await getBrandById(id)
  if (!existing) {
    throw new Error('Brand not found.')
  }
  if (existing.deletedAt) {
    return
  }
  await execute(getDb(), `UPDATE brand SET deleted_at = ?, updated_at = ? WHERE id = ?`, [
    nowIso(),
    nowIso(),
    id,
  ])
}

export async function restoreBrand(id: string): Promise<void> {
  const existing = await getBrandById(id)
  if (!existing) {
    throw new Error('Brand not found.')
  }
  if (!existing.deletedAt) {
    return
  }
  await execute(getDb(), `UPDATE brand SET deleted_at = NULL, updated_at = ? WHERE id = ?`, [
    nowIso(),
    id,
  ])
}
