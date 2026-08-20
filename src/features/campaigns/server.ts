import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { type AccountSummary, listAccounts } from '~/server/db/account'
import { listBrands } from '~/server/db/brand'
import {
  activateCampaign,
  archiveCampaign,
  type CampaignDetail,
  type CampaignSummary,
  completeCampaign,
  createCampaign,
  createCampaignInput,
  getCampaignDetail,
  listArchivedCampaigns,
  listCampaigns,
  pauseCampaign,
  restoreCampaign,
  updateCampaign,
  updateCampaignInput,
} from '~/server/db/campaign'
import { getDb } from '~/server/db/client'
import { listProducts, type ProductSummary } from '~/server/db/product'
import { getDefaultWorkspace } from '~/server/db/workspace'
import type { Brand, CampaignStatus } from '~/types/domain'

const idWire = z.object({ id: z.uuid() })
const filterWire = z.object({
  brandId: z.uuid().optional(),
  productId: z.uuid().optional(),
  status: z.enum(['draft', 'active', 'paused', 'completed', 'archived']).optional(),
})

export interface CampaignsPageData {
  campaigns: CampaignSummary[]
  archivedCampaigns: CampaignSummary[]
  brands: Brand[]
  productsByBrand: Record<string, ProductSummary[]>
  allAccounts: AccountSummary[]
}

export const getCampaignsPageData = createServerFn({ method: 'GET' })
  .validator(filterWire)
  .handler(async ({ data }): Promise<CampaignsPageData> => {
    const db = getDb()
    const workspace = await getDefaultWorkspace()
    if (!workspace) {
      return {
        campaigns: [],
        archivedCampaigns: [],
        brands: [],
        productsByBrand: {},
        allAccounts: [],
      }
    }

    const [brands, products, allAccounts, campaigns, archivedCampaigns] = await Promise.all([
      listBrands(workspace.id),
      listProducts(workspace.id),
      listAccounts(workspace.id),
      listCampaigns(db, {
        workspaceId: workspace.id,
        brandId: data.brandId,
        productId: data.productId,
        status: data.status as CampaignStatus | undefined,
      }),
      listArchivedCampaigns(db, workspace.id),
    ])

    const productsByBrand: Record<string, ProductSummary[]> = {}
    for (const brand of brands) {
      productsByBrand[brand.id] = products.filter((p) => p.brandId === brand.id)
    }

    return {
      campaigns,
      archivedCampaigns,
      brands,
      productsByBrand,
      allAccounts,
    }
  })

export const getCampaignDetailData = createServerFn({ method: 'GET' })
  .validator(idWire)
  .handler(
    async ({
      data,
    }): Promise<{
      campaign: CampaignDetail
      brands: Brand[]
      productsByBrand: Record<string, ProductSummary[]>
      allAccounts: AccountSummary[]
    } | null> => {
      const db = getDb()
      const workspace = await getDefaultWorkspace()
      if (!workspace) return null

      const campaign = await getCampaignDetail(db, workspace.id, data.id)
      if (!campaign) return null

      const [brands, products, allAccounts] = await Promise.all([
        listBrands(workspace.id),
        listProducts(workspace.id),
        listAccounts(workspace.id),
      ])

      const productsByBrand: Record<string, ProductSummary[]> = {}
      for (const brand of brands) {
        productsByBrand[brand.id] = products.filter((p) => p.brandId === brand.id)
      }

      return {
        campaign,
        brands,
        productsByBrand,
        allAccounts,
      }
    },
  )

export const createCampaignFn = createServerFn({ method: 'POST' })
  .validator(createCampaignInput)
  .handler(async ({ data }): Promise<CampaignSummary> => {
    const db = getDb()
    return createCampaign(db, data)
  })

export const updateCampaignFn = createServerFn({ method: 'POST' })
  .validator(updateCampaignInput)
  .handler(async ({ data }): Promise<CampaignSummary> => {
    const db = getDb()
    return updateCampaign(db, data)
  })

export const activateCampaignFn = createServerFn({ method: 'POST' })
  .validator(idWire)
  .handler(async ({ data }): Promise<CampaignSummary> => {
    const db = getDb()
    const workspace = await getDefaultWorkspace()
    if (!workspace) throw new Error('Workspace not found')
    return activateCampaign(db, { workspaceId: workspace.id, id: data.id })
  })

export const pauseCampaignFn = createServerFn({ method: 'POST' })
  .validator(idWire)
  .handler(async ({ data }): Promise<CampaignSummary> => {
    const db = getDb()
    const workspace = await getDefaultWorkspace()
    if (!workspace) throw new Error('Workspace not found')
    return pauseCampaign(db, { workspaceId: workspace.id, id: data.id })
  })

export const completeCampaignFn = createServerFn({ method: 'POST' })
  .validator(idWire)
  .handler(async ({ data }): Promise<CampaignSummary> => {
    const db = getDb()
    const workspace = await getDefaultWorkspace()
    if (!workspace) throw new Error('Workspace not found')
    return completeCampaign(db, { workspaceId: workspace.id, id: data.id })
  })

export const archiveCampaignFn = createServerFn({ method: 'POST' })
  .validator(idWire)
  .handler(async ({ data }): Promise<CampaignSummary> => {
    const db = getDb()
    const workspace = await getDefaultWorkspace()
    if (!workspace) throw new Error('Workspace not found')
    return archiveCampaign(db, { workspaceId: workspace.id, id: data.id })
  })

export const restoreCampaignFn = createServerFn({ method: 'POST' })
  .validator(idWire)
  .handler(async ({ data }): Promise<CampaignSummary> => {
    const db = getDb()
    const workspace = await getDefaultWorkspace()
    if (!workspace) throw new Error('Workspace not found')
    return restoreCampaign(db, { workspaceId: workspace.id, id: data.id })
  })
