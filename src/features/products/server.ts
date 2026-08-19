import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { listBrands } from '~/server/db/brand'
import { listNiches } from '~/server/db/niche'
import {
  archiveProduct,
  createProduct,
  createProductInput,
  getProductById,
  listArchivedProducts,
  listProducts,
  type ProductSummary,
  restoreProduct,
  updateProduct,
  updateProductInput,
} from '~/server/db/product'
import { getDefaultWorkspace } from '~/server/db/workspace'
import type { Brand, Niche } from '~/types/domain'

const idWire = z.object({ id: z.uuid() })
const listWire = z.object({ brandId: z.uuid().optional() })

export interface ProductsPageData {
  products: ProductSummary[]
  archivedProducts: ProductSummary[]
  brands: Brand[]
  /** Active niches grouped by brand, for the product form. */
  nichesByBrand: Record<string, Niche[]>
}

export const getProductsPageData = createServerFn({ method: 'GET' })
  .validator(listWire)
  .handler(async ({ data }): Promise<ProductsPageData> => {
    const workspace = await getDefaultWorkspace()
    if (!workspace) {
      return { products: [], archivedProducts: [], brands: [], nichesByBrand: {} }
    }
    const brands = await listBrands(workspace.id)
    const nichesByBrand: Record<string, Niche[]> = {}
    for (const brand of brands) {
      nichesByBrand[brand.id] = await listNiches(brand.id)
    }
    const [products, archivedProducts] = await Promise.all([
      listProducts(workspace.id, data.brandId),
      listArchivedProducts(workspace.id),
    ])
    return { products, archivedProducts, brands, nichesByBrand }
  })

export const getProduct = createServerFn({ method: 'GET' })
  .validator(idWire)
  .handler(async ({ data }): Promise<ProductSummary | null> => {
    return getProductById(data.id)
  })

export const createProductFn = createServerFn({ method: 'POST' })
  .validator(createProductInput)
  .handler(async ({ data }): Promise<ProductSummary> => {
    return createProduct(data)
  })

export const updateProductFn = createServerFn({ method: 'POST' })
  .validator(updateProductInput)
  .handler(async ({ data }): Promise<ProductSummary> => {
    return updateProduct(data)
  })

export const archiveProductFn = createServerFn({ method: 'POST' })
  .validator(idWire)
  .handler(async ({ data }): Promise<void> => {
    return archiveProduct(data.id)
  })

export const restoreProductFn = createServerFn({ method: 'POST' })
  .validator(idWire)
  .handler(async ({ data }): Promise<void> => {
    return restoreProduct(data.id)
  })
