import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import {
  archiveBrand,
  type BrandSummary,
  createBrand,
  getBrandById,
  listArchivedBrands,
  listBrands,
  restoreBrand,
  updateBrand,
} from '~/server/db/brand'
import { getDefaultWorkspace } from '~/server/db/workspace'
import type { Brand } from '~/types/domain'

/**
 * Server functions for the brands feature. The client never passes a
 * workspace id; the default workspace is resolved server-side.
 */

// Wire schemas are declared locally (not derived from repository schemas at
// module level) so the client build can strip every server/db import.
const createBrandWire = z.object({
  name: z.string().trim().min(1, 'Give the brand a name.').max(120),
  description: z.string().trim().max(500).optional(),
})
const updateBrandWire = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1, 'Give the brand a name.').max(120),
  description: z.string().trim().max(500).nullable().optional(),
})
const idWire = z.object({ id: z.uuid() })

export interface BrandsPageData {
  brands: BrandSummary[]
  archivedBrands: Brand[]
}

export const getBrandsPageData = createServerFn({ method: 'GET' }).handler(
  async (): Promise<BrandsPageData> => {
    const workspace = await getDefaultWorkspace()
    if (!workspace) {
      return { brands: [], archivedBrands: [] }
    }
    const [brands, archivedBrands] = await Promise.all([
      listBrands(workspace.id),
      listArchivedBrands(workspace.id),
    ])
    return { brands, archivedBrands }
  },
)

export const getBrand = createServerFn({ method: 'GET' })
  .validator(idWire)
  .handler(async ({ data }): Promise<Brand | null> => {
    return getBrandById(data.id)
  })

export const createBrandFn = createServerFn({ method: 'POST' })
  .validator(createBrandWire)
  .handler(async ({ data }): Promise<Brand> => {
    const workspace = await getDefaultWorkspace()
    if (!workspace) {
      throw new Error('Workspace is not set up yet.')
    }
    return createBrand({ ...data, workspaceId: workspace.id })
  })

export const updateBrandFn = createServerFn({ method: 'POST' })
  .validator(updateBrandWire)
  .handler(async ({ data }): Promise<Brand> => {
    return updateBrand(data)
  })

export const archiveBrandFn = createServerFn({ method: 'POST' })
  .validator(idWire)
  .handler(async ({ data }): Promise<void> => {
    return archiveBrand(data.id)
  })

export const restoreBrandFn = createServerFn({ method: 'POST' })
  .validator(idWire)
  .handler(async ({ data }): Promise<void> => {
    return restoreBrand(data.id)
  })
