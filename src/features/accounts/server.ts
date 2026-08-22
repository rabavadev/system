import { createServerFn } from '@tanstack/react-start'
import { deleteCookie, getCookie, setCookie } from '@tanstack/react-start/server'
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
import { getDb } from '~/server/db/client'
import { listNiches } from '~/server/db/niche'
import { listPlatforms } from '~/server/db/platform'
import { getDefaultWorkspace } from '~/server/db/workspace'
import {
  completeXOAuthCallback,
  disconnectXOAuth,
  resolveXOAuthConfiguration,
  startXOAuthFlow,
  X_OAUTH_COOKIE_NAME,
  type XDisconnectResult,
  type XOAuthCallbackResult,
  type XOAuthStartResult,
} from '~/server/platforms/adapters/x/oauth/index'
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

const oauthCallbackWire = z.object({
  state: z.string().nullish(),
  code: z.string().nullish(),
  error: z.string().nullish(),
  errorDescription: z.string().nullish(),
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

/**
 * Initiates an X OAuth 2.0 PKCE connection for the specified account.
 * Sets an encrypted HttpOnly transaction cookie and returns the authorization URL.
 */
export const startXOAuthConnectionFn = createServerFn({ method: 'POST' })
  .validator(idWire)
  .handler(async ({ data }): Promise<XOAuthStartResult> => {
    const workspace = await getDefaultWorkspace()
    if (!workspace) {
      return {
        ok: false,
        code: 'account_not_found',
        reason: 'Workspace is not set up.',
      }
    }

    const result = await startXOAuthFlow({
      accountId: data.id,
      workspaceId: workspace.id,
    })

    if (result.ok) {
      // biome-ignore lint/complexity/useLiteralKeys: required by tsconfig noPropertyAccessFromIndexSignature
      const nodeProcess = (globalThis as Record<string, unknown>)['process'] as
        | { env?: Record<string, string | undefined> }
        | undefined
      const isProduction = nodeProcess?.env?.['NODE_ENV'] === 'production'

      setCookie(X_OAUTH_COOKIE_NAME, result.cookieValue, {
        path: '/',
        maxAge: 600, // 10 minutes
        sameSite: 'lax',
        httpOnly: true,
        secure: isProduction,
      })
    }

    return result
  })

/**
 * Completes the X OAuth callback processing and deletes the transaction cookie.
 */
export const completeXOAuthCallbackFn = createServerFn({ method: 'POST' })
  .validator(oauthCallbackWire)
  .handler(async ({ data }): Promise<XOAuthCallbackResult> => {
    const workspace = await getDefaultWorkspace()
    if (!workspace) {
      return {
        ok: false,
        code: 'invalid_request',
        reason: 'Workspace is not set up.',
        clearCookie: true,
      }
    }

    const cookieValue = getCookie(X_OAUTH_COOKIE_NAME)
    const result = await completeXOAuthCallback({
      state: data.state,
      code: data.code,
      error: data.error,
      errorDescription: data.errorDescription,
      cookieValue,
      workspaceId: workspace.id,
    })

    deleteCookie(X_OAUTH_COOKIE_NAME, { path: '/' })
    return result
  })

/**
 * Disconnects an X account by revoking credentials locally and best-effort at the X provider.
 * Never returns plaintext token material in the result DTO.
 */
export const disconnectXAccountFn = createServerFn({ method: 'POST' })
  .validator(idWire)
  .handler(async ({ data }): Promise<XDisconnectResult> => {
    const workspace = await getDefaultWorkspace()
    if (!workspace) {
      return {
        ok: false,
        code: 'account_not_found',
        reason: 'Workspace is not set up.',
      }
    }

    const db = await getDb()

    // Resolve X OAuth config from runtime environment (best-effort — null is safe:
    // disconnectXOAuth will still perform local revocation without provider revocation).
    const config = resolveXOAuthConfiguration(undefined, undefined)

    // Resolve KEK from env for decrypting the credential (needed for provider revocation).
    // biome-ignore lint/complexity/useLiteralKeys: required by tsconfig noPropertyAccessFromIndexSignature
    const nodeProcess = (globalThis as Record<string, unknown>)['process'] as
      | { env?: Record<string, string | undefined> }
      | undefined
    const kek = nodeProcess?.env?.['PLATFORM_CREDENTIAL_KEK_V1'] ?? undefined

    return disconnectXOAuth(db, { accountId: data.id, workspaceId: workspace.id }, config, kek)
  })
