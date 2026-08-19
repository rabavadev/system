import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { getBrandById } from '~/server/db/brand'
import { getDb, queryAll } from '~/server/db/client'
import {
  archiveNiche,
  createNiche,
  createNicheInput,
  getNicheById,
  listArchivedNiches,
  listNiches,
  type NicheSummary,
  restoreNiche,
  updateNiche,
  updateNicheInput,
} from '~/server/db/niche'
import { listProductsByNiche } from '~/server/db/product'
import type { Brand, Niche, Product } from '~/types/domain'

const idWire = z.object({ id: z.uuid() })
const brandWire = z.object({ brandId: z.uuid() })

export interface BrandNichesData {
  niches: NicheSummary[]
  archivedNiches: Niche[]
}

export const getBrandNiches = createServerFn({ method: 'GET' })
  .validator(brandWire)
  .handler(async ({ data }): Promise<BrandNichesData> => {
    const [niches, archivedNiches] = await Promise.all([
      listNiches(data.brandId),
      listArchivedNiches(data.brandId),
    ])
    return { niches, archivedNiches }
  })

export interface NicheDetailData {
  niche: Niche
  brand: Brand | null
  products: Product[]
  accounts: Array<{
    id: string
    handle: string
    displayName: string | null
    platformName: string
    isPrimary: boolean
  }>
}

export const getNicheDetail = createServerFn({ method: 'GET' })
  .validator(idWire)
  .handler(async ({ data }): Promise<NicheDetailData | null> => {
    const niche = await getNicheById(data.id)
    if (!niche) {
      return null
    }
    const [brand, products, accounts] = await Promise.all([
      getBrandById(niche.brandId),
      listProductsByNiche(niche.id),
      queryAll<{
        id: string
        handle: string
        display_name: string | null
        platform_name: string
        is_primary: number
      }>(
        getDb(),
        `SELECT a.id, a.handle, a.display_name, p.name AS platform_name,
           CASE WHEN a.primary_niche_id = ? THEN 1 ELSE 0 END AS is_primary
         FROM account_niche an
         JOIN account a ON a.id = an.account_id
         JOIN platform p ON p.id = a.platform_id
         WHERE an.niche_id = ? AND a.deleted_at IS NULL AND a.status != 'archived'
         ORDER BY a.handle ASC`,
        [niche.id, niche.id],
      ),
    ])
    return {
      niche,
      brand,
      products,
      accounts: accounts.map((row) => ({
        id: row.id,
        handle: row.handle,
        displayName: row.display_name,
        platformName: row.platform_name,
        isPrimary: row.is_primary === 1,
      })),
    }
  })

export const createNicheFn = createServerFn({ method: 'POST' })
  .validator(createNicheInput)
  .handler(async ({ data }): Promise<Niche> => {
    return createNiche(data)
  })

export const updateNicheFn = createServerFn({ method: 'POST' })
  .validator(updateNicheInput)
  .handler(async ({ data }): Promise<Niche> => {
    return updateNiche(data)
  })

export const archiveNicheFn = createServerFn({ method: 'POST' })
  .validator(idWire)
  .handler(async ({ data }): Promise<void> => {
    return archiveNiche(data.id)
  })

export const restoreNicheFn = createServerFn({ method: 'POST' })
  .validator(idWire)
  .handler(async ({ data }): Promise<void> => {
    return restoreNiche(data.id)
  })
