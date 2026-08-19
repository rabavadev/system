import { z } from 'zod'

import { getBrandById } from '~/server/db/brand'
import { execute, getDb, newId, nowIso, queryAll, queryFirst } from '~/server/db/client'
import { getNicheById } from '~/server/db/niche'
import { requireActiveBrand, requireNicheForBrand } from '~/server/db/relations'
import type { Product, ProductStatus } from '~/types/domain'

interface ProductRow {
  id: string
  brand_id: string
  niche_id: string | null
  name: string
  description: string | null
  url: string | null
  status: ProductStatus
  created_at: string
  updated_at: string
  deleted_at: string | null
}

function toProduct(row: ProductRow): Product {
  return {
    id: row.id,
    brandId: row.brand_id,
    nicheId: row.niche_id,
    name: row.name,
    description: row.description,
    url: row.url,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }
}

/** Product plus display names of its brand/niche, for list screens. */
export interface ProductSummary extends Product {
  brandName: string
  nicheName: string | null
  /** True when the linked niche has been archived since. */
  nicheArchived: boolean
}

export const createProductInput = z.object({
  brandId: z.uuid(),
  nicheId: z.uuid().nullish(),
  name: z.string().trim().min(1, 'Give the product a name.').max(160),
  description: z.string().trim().max(2000).optional(),
  url: z.string().trim().url('Enter a valid URL, including https://').max(500).optional(),
  status: z.enum(['draft', 'active']).default('draft'),
})
export type CreateProductInput = z.input<typeof createProductInput>

export const updateProductInput = z.object({
  id: z.uuid(),
  brandId: z.uuid().optional(),
  nicheId: z.uuid().nullish(),
  name: z.string().trim().min(1, 'Give the product a name.').max(160),
  description: z.string().trim().max(2000).nullable().optional(),
  url: z
    .string()
    .trim()
    .url('Enter a valid URL, including https://')
    .max(500)
    .nullable()
    .optional(),
  status: z.enum(['draft', 'active']).optional(),
})
export type UpdateProductInput = z.input<typeof updateProductInput>

function toSummary(
  row: ProductRow & {
    brand_name: string
    niche_name: string | null
    niche_deleted_at: string | null
  },
): ProductSummary {
  return {
    ...toProduct(row),
    brandName: row.brand_name,
    nicheName: row.niche_name,
    nicheArchived: row.niche_deleted_at !== null,
  }
}

const SUMMARY_SELECT = `
  SELECT p.*, b.name AS brand_name, n.name AS niche_name, n.deleted_at AS niche_deleted_at
  FROM product p
  JOIN brand b ON b.id = p.brand_id
  LEFT JOIN niche n ON n.id = p.niche_id
`

/** Active products of a workspace, optionally limited to one brand. */
export async function listProducts(
  workspaceId: string,
  brandId?: string,
): Promise<ProductSummary[]> {
  const rows = await queryAll<
    ProductRow & { brand_name: string; niche_name: string | null; niche_deleted_at: string | null }
  >(
    getDb(),
    `${SUMMARY_SELECT}
     WHERE b.workspace_id = ? AND p.deleted_at IS NULL AND p.status != 'archived'
     ${brandId ? 'AND p.brand_id = ?' : ''}
     ORDER BY p.created_at DESC`,
    brandId ? [workspaceId, brandId] : [workspaceId],
  )
  return rows.map(toSummary)
}

/** Archived products of a workspace, restorable. */
export async function listArchivedProducts(workspaceId: string): Promise<ProductSummary[]> {
  const rows = await queryAll<
    ProductRow & { brand_name: string; niche_name: string | null; niche_deleted_at: string | null }
  >(
    getDb(),
    `${SUMMARY_SELECT}
     WHERE b.workspace_id = ? AND p.deleted_at IS NULL AND p.status = 'archived'
     ORDER BY p.updated_at DESC`,
    [workspaceId],
  )
  return rows.map(toSummary)
}

/** Active products in one niche (niche detail screen). */
export async function listProductsByNiche(nicheId: string): Promise<Product[]> {
  const rows = await queryAll<ProductRow>(
    getDb(),
    `SELECT * FROM product WHERE niche_id = ? AND deleted_at IS NULL AND status != 'archived'
     ORDER BY created_at DESC`,
    [nicheId],
  )
  return rows.map(toProduct)
}

/** Fetch a product regardless of status, with display names. */
export async function getProductById(id: string): Promise<ProductSummary | null> {
  const row = await queryFirst<
    ProductRow & { brand_name: string; niche_name: string | null; niche_deleted_at: string | null }
  >(getDb(), `${SUMMARY_SELECT} WHERE p.id = ?`, [id])
  return row ? toSummary(row) : null
}

/** The product table has no workspace_id; scope reaches it via brand. */
export async function createProduct(input: CreateProductInput): Promise<ProductSummary> {
  const data = createProductInput.parse(input)
  requireActiveBrand(await getBrandById(data.brandId))
  if (data.nicheId) {
    requireNicheForBrand(await getNicheById(data.nicheId), data.brandId)
  }
  const id = newId()
  const now = nowIso()
  await execute(
    getDb(),
    `INSERT INTO product (id, brand_id, niche_id, name, description, url, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.brandId,
      data.nicheId ?? null,
      data.name,
      data.description ?? null,
      data.url ?? null,
      data.status,
      now,
      now,
    ],
  )
  const created = await getProductById(id)
  if (!created) {
    throw new Error('product insert did not produce a readable row')
  }
  return created
}

export async function updateProduct(input: UpdateProductInput): Promise<ProductSummary> {
  const data = updateProductInput.parse(input)
  const existing = await getProductById(data.id)
  if (!existing) {
    throw new Error('Product not found.')
  }
  const brandId = data.brandId ?? existing.brandId
  requireActiveBrand(await getBrandById(brandId))
  const nicheId = data.nicheId !== undefined ? data.nicheId : existing.nicheId
  if (nicheId) {
    requireNicheForBrand(await getNicheById(nicheId), brandId)
  }
  await execute(
    getDb(),
    `UPDATE product
     SET brand_id = ?, niche_id = ?, name = ?, description = ?, url = ?,
         status = COALESCE(?, status), updated_at = ?
     WHERE id = ?`,
    [
      brandId,
      nicheId ?? null,
      data.name,
      data.description ?? null,
      data.url ?? null,
      data.status ?? null,
      nowIso(),
      data.id,
    ],
  )
  const updated = await getProductById(data.id)
  if (!updated) {
    throw new Error('product update did not produce a readable row')
  }
  return updated
}

/** Archive = status change; the row and its history stay. */
export async function archiveProduct(id: string): Promise<void> {
  const existing = await getProductById(id)
  if (!existing) {
    throw new Error('Product not found.')
  }
  await execute(getDb(), `UPDATE product SET status = 'archived', updated_at = ? WHERE id = ?`, [
    nowIso(),
    id,
  ])
}

export async function restoreProduct(id: string): Promise<void> {
  const existing = await getProductById(id)
  if (!existing) {
    throw new Error('Product not found.')
  }
  requireActiveBrand(await getBrandById(existing.brandId))
  await execute(getDb(), `UPDATE product SET status = 'draft', updated_at = ? WHERE id = ?`, [
    nowIso(),
    id,
  ])
}
