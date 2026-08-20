import { createServerFn } from '@tanstack/react-start'
import { deleteCookie, getCookie, setCookie } from '@tanstack/react-start/server'
import { z } from 'zod'

import { countPendingApprovals } from '~/server/db/approval'
import { getBrandById, listBrands } from '~/server/db/brand'
import { getDb } from '~/server/db/client'
import { getDefaultWorkspace } from '~/server/db/workspace'

/**
 * Workspace shell + active-selection server functions.
 *
 * The active brand is stored in a cookie: it survives navigation and full
 * reloads, is readable during SSR, and needs no client state store. Later
 * selections (product, account, campaign) follow the same pattern.
 */

export const ACTIVE_BRAND_COOKIE = 'gw_active_brand'
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365

export interface ShellBrand {
  id: string
  name: string
}

export interface ShellData {
  workspaceName: string | null
  /** Active brands, for the switcher. */
  brands: ShellBrand[]
  /** The selected brand, or null when nothing/nothing valid is selected. */
  activeBrand: ShellBrand | null
  /** Real-time pending approvals count. */
  pendingApprovalsCount: number
}

/**
 * Data for the app shell. Returns safe empty values when the database is
 * not migrated/seeded yet so the shell renders static labels instead of
 * crashing.
 */
export const getShellData = createServerFn({ method: 'GET' }).handler(
  async (): Promise<ShellData> => {
    try {
      const workspace = await getDefaultWorkspace()
      if (!workspace) {
        return { workspaceName: null, brands: [], activeBrand: null, pendingApprovalsCount: 0 }
      }
      const db = getDb()
      const [brandsList, pendingApprovalsCount] = await Promise.all([
        listBrands(workspace.id),
        countPendingApprovals(db, workspace.id).catch(() => 0),
      ])
      const brands = brandsList.map((brand) => ({
        id: brand.id,
        name: brand.name,
      }))
      const selectedId = getCookie(ACTIVE_BRAND_COOKIE)
      const activeBrand = brands.find((brand) => brand.id === selectedId) ?? null
      return { workspaceName: workspace.name, brands, activeBrand, pendingApprovalsCount }
    } catch (error) {
      console.warn('shell data unavailable (is D1 migrated?):', error)
      return { workspaceName: null, brands: [], activeBrand: null, pendingApprovalsCount: 0 }
    }
  },
)

const setActiveBrandWire = z.object({ brandId: z.uuid().nullable() })

export const setActiveBrand = createServerFn({ method: 'POST' })
  .validator(setActiveBrandWire)
  .handler(async ({ data }): Promise<void> => {
    if (data.brandId === null) {
      deleteCookie(ACTIVE_BRAND_COOKIE, { path: '/' })
      return
    }
    const brand = await getBrandById(data.brandId)
    if (!brand || brand.deletedAt) {
      throw new Error('That brand is not available.')
    }
    setCookie(ACTIVE_BRAND_COOKIE, data.brandId, {
      path: '/',
      maxAge: COOKIE_MAX_AGE,
      sameSite: 'lax',
      httpOnly: true,
    })
  })
