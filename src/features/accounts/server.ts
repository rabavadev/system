import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import {
  type AccountDetail,
  type AccountSummary,
  archiveAccount,
  createAccount,
  getAccountDetail,
  listAccounts,
  listArchivedAccounts,
  restoreAccount,
  updateAccount,
} from '~/server/db/account'
import { listBrands } from '~/server/db/brand'
import { listNiches } from '~/server/db/niche'
import { listPlatforms } from '~/server/db/platform'
import { getDefaultWorkspace } from '~/server/db/workspace'
import type { Account, Brand, Niche, Platform } from '~/types/domain'

// Wire schemas are declared locally (not derived from repository schemas at
// module level) so the client build can strip every server/db import.
const idWire = z.object({ id: z.uuid() })
const handleWire = z
  .string()
  .trim()
  .min(1, 'Enter the account handle.')
  .max(100)
  .regex(
    /^@?[A-Za-z0-9._-]+$/,
    'Handles may contain letters, numbers, dots, dashes and underscores.',
  )
const createAccountWire = z.object({
  platformId: z.uuid(),
  handle: handleWire,
  displayName: z.string().trim().max(120).optional(),
  nicheIds: z.array(z.uuid()).max(50).default([]),
  primaryNicheId: z.uuid().nullish(),
})
const updateAccountWire = z.object({
  id: z.uuid(),
  handle: handleWire,
  displayName: z.string().trim().max(120).nullable().optional(),
  status: z.enum(['active', 'paused']).optional(),
  nicheIds: z.array(z.uuid()).max(50).optional(),
  primaryNicheId: z.uuid().nullish(),
})

export interface AccountsPageData {
  accounts: AccountSummary[]
  archivedAccounts: AccountSummary[]
  platforms: Platform[]
  brands: Brand[]
  /** Active niches grouped by brand, for the account form. */
  nichesByBrand: Record<string, Niche[]>
}

export const getAccountsPageData = createServerFn({ method: 'GET' }).handler(
  async (): Promise<AccountsPageData> => {
    const workspace = await getDefaultWorkspace()
    const platforms = await listPlatforms()
    if (!workspace) {
      return { accounts: [], archivedAccounts: [], platforms, brands: [], nichesByBrand: {} }
    }
    const brands = await listBrands(workspace.id)
    const nichesByBrand: Record<string, Niche[]> = {}
    for (const brand of brands) {
      nichesByBrand[brand.id] = await listNiches(brand.id)
    }
    const [accounts, archivedAccounts] = await Promise.all([
      listAccounts(workspace.id),
      listArchivedAccounts(workspace.id),
    ])
    return { accounts, archivedAccounts, platforms, brands, nichesByBrand }
  },
)

export const getAccount = createServerFn({ method: 'GET' })
  .validator(idWire)
  .handler(async ({ data }): Promise<AccountDetail | null> => {
    return getAccountDetail(data.id)
  })

export const createAccountFn = createServerFn({ method: 'POST' })
  .validator(createAccountWire)
  .handler(async ({ data }): Promise<Account> => {
    const workspace = await getDefaultWorkspace()
    if (!workspace) {
      throw new Error('Workspace is not set up yet.')
    }
    return createAccount({ ...data, workspaceId: workspace.id })
  })

export const updateAccountFn = createServerFn({ method: 'POST' })
  .validator(updateAccountWire)
  .handler(async ({ data }): Promise<void> => {
    await updateAccount(data)
  })

export const archiveAccountFn = createServerFn({ method: 'POST' })
  .validator(idWire)
  .handler(async ({ data }): Promise<void> => {
    return archiveAccount(data.id)
  })

export const restoreAccountFn = createServerFn({ method: 'POST' })
  .validator(idWire)
  .handler(async ({ data }): Promise<void> => {
    return restoreAccount(data.id)
  })
