import {
  getPlatformById,
  getPlatformConnectionForAccount,
  getSafePlatformConnectionForAccount,
  upsertPlatformConnection,
} from '../../../../db/platform.ts'
import { nowIso, queryFirst, type SqlDatabase } from '../../../../db/sql.ts'
import { storeOAuthCredential } from '../../../credentials/store.ts'
import { XOAuthClient } from './client.ts'
import {
  constantTimeCompare,
  decryptOAuthTransaction,
  encryptOAuthTransaction,
  generateOAuthState,
  generatePkcePair,
  OAUTH_STATE_TTL_MS,
} from './crypto.ts'
import {
  type OAuthTransactionState,
  X_AUTHORIZE_URL,
  X_OAUTH_DEFAULT_SCOPES,
  type XOAuthCallbackOptions,
  type XOAuthCallbackResult,
  type XOAuthConfiguration,
  type XOAuthStartOptions,
  type XOAuthStartResult,
} from './types.ts'

interface AccountLookupRow {
  id: string
  workspace_id: string
  platform_id: string
  handle: string
  status: string
  deleted_at: string | null
}

/**
 * Resolves authoritative X OAuth configuration from explicit options, Cloudflare Worker runtime bindings,
 * or process.env fallbacks.
 */
export function resolveXOAuthConfiguration(
  runtimeEnv?: Record<string, unknown>,
  overrides?: Partial<XOAuthConfiguration>,
): XOAuthConfiguration | null {
  const findValue = (keys: string[]): string | undefined => {
    // 1. Injected overrides
    for (const key of keys) {
      if (overrides && Object.hasOwn(overrides, key)) {
        const val = (overrides as Record<string, unknown>)[key]
        if (typeof val === 'string' && val.trim().length > 0) {
          return val.trim()
        }
      }
    }

    // 2. Injected server runtime environment / Cloudflare bindings
    if (runtimeEnv && typeof runtimeEnv === 'object') {
      for (const key of keys) {
        if (Object.hasOwn(runtimeEnv, key)) {
          const val = runtimeEnv[key]
          if (typeof val === 'string' && val.trim().length > 0) {
            return val.trim()
          }
        }
      }
    }

    // 3. Node process environment fallback (for CLI tests)
    // biome-ignore lint/complexity/useLiteralKeys: required by tsconfig noPropertyAccessFromIndexSignature
    const nodeProcess = (globalThis as Record<string, unknown>)['process'] as
      | { env?: Record<string, string | undefined> }
      | undefined
    if (nodeProcess?.env && typeof nodeProcess.env === 'object') {
      for (const key of keys) {
        if (Object.hasOwn(nodeProcess.env, key)) {
          const val = nodeProcess.env[key]
          if (typeof val === 'string' && val.trim().length > 0) {
            return val.trim()
          }
        }
      }
    }

    return undefined
  }

  const clientId = findValue(['clientId', 'X_OAUTH_CLIENT_ID', 'PLATFORM_X_OAUTH_CLIENT_ID'])
  const redirectUri = findValue([
    'redirectUri',
    'X_OAUTH_REDIRECT_URI',
    'PLATFORM_X_OAUTH_REDIRECT_URI',
  ])
  const stateKek = findValue(['stateKek', 'PLATFORM_OAUTH_STATE_KEK_V1', 'OAUTH_STATE_KEK_V1'])
  const credentialKek = findValue([
    'credentialKek',
    'PLATFORM_CREDENTIAL_KEK_V1',
    'CREDENTIAL_KEK_V1',
  ])
  const clientSecret = findValue([
    'clientSecret',
    'X_OAUTH_CLIENT_SECRET',
    'PLATFORM_X_OAUTH_CLIENT_SECRET',
  ])
  const clientTypeRaw = findValue([
    'clientType',
    'X_OAUTH_CLIENT_TYPE',
    'PLATFORM_X_OAUTH_CLIENT_TYPE',
  ])?.toLowerCase()

  if (!clientId || !redirectUri || !stateKek) {
    return null
  }

  let clientType: 'public' | 'confidential'
  if (clientTypeRaw === 'confidential') {
    if (!clientSecret) {
      // Configured as confidential client, but missing required client secret -> fail closed
      return null
    }
    clientType = 'confidential'
  } else if (clientTypeRaw === 'public') {
    clientType = 'public'
  } else {
    clientType = clientSecret ? 'confidential' : 'public'
  }

  const result: XOAuthConfiguration = {
    clientId,
    redirectUri,
    stateKek,
    clientType,
  }
  if (credentialKek) {
    result.credentialKek = credentialKek
  }
  if (clientType === 'confidential' && clientSecret) {
    result.clientSecret = clientSecret
  }

  return result
}

/**
 * Initiates an X OAuth 2.0 PKCE connection attempt for an internal account.
 * Generates random state and PKCE verifier, stores encrypted state in HttpOnly cookie payload,
 * and constructs the server-authoritative X authorization URL.
 */
export async function startXOAuthFlow(options: XOAuthStartOptions): Promise<XOAuthStartResult> {
  const { accountId, workspaceId } = options

  if (
    !accountId ||
    typeof accountId !== 'string' ||
    !workspaceId ||
    typeof workspaceId !== 'string'
  ) {
    return {
      ok: false,
      code: 'account_not_found',
      reason: 'Valid account ID and workspace ID are required.',
    }
  }

  let db = options.db
  if (!db) {
    const { getDb } = await import('../../../../db/client.ts')
    db = getDb()
  }

  // 1. Resolve and validate account
  const accountRow = await queryFirst<AccountLookupRow>(
    db,
    `SELECT id, workspace_id, platform_id, handle, status, deleted_at
     FROM account
     WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [accountId, workspaceId],
  )

  if (!accountRow) {
    return {
      ok: false,
      code: 'account_not_found',
      reason: 'Account not found or belongs to a different workspace.',
    }
  }

  if (accountRow.status !== 'active') {
    return {
      ok: false,
      code: 'account_ineligible',
      reason: `Account is ${accountRow.status}. Only active accounts can connect to X.`,
    }
  }

  // 2. Validate platform is X
  const platform = await getPlatformById(db, accountRow.platform_id)
  if (platform?.adapterKey.toLowerCase().trim() !== 'x') {
    return {
      ok: false,
      code: 'platform_mismatch',
      reason: 'Account is not configured for the X platform adapter.',
    }
  }

  // 3. Resolve OAuth configuration
  const config = resolveXOAuthConfiguration(options.env, options.config)
  if (!config) {
    return {
      ok: false,
      code: 'oauth_not_configured',
      reason:
        'X OAuth client ID, redirect URI, or state encryption key is missing from server configuration.',
    }
  }

  // 4. Generate PKCE pair and state
  const { codeVerifier, codeChallenge } = await generatePkcePair()
  const state = generateOAuthState()

  const issuedAt = nowIso()
  const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString()

  // 5. Encrypt transaction state
  const transactionState: OAuthTransactionState = {
    state,
    codeVerifier,
    workspaceId,
    accountId,
    platformAdapterKey: 'x',
    issuedAt,
    expiresAt,
  }

  let cookieValue: string
  try {
    cookieValue = await encryptOAuthTransaction(transactionState, config.stateKek)
  } catch (error) {
    return {
      ok: false,
      code: 'oauth_not_configured',
      reason: error instanceof Error ? error.message : 'Failed to encrypt OAuth transaction state.',
    }
  }

  // 6. Build exact X authorization URL
  const authUrl = new URL(X_AUTHORIZE_URL)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('client_id', config.clientId)
  authUrl.searchParams.set('redirect_uri', config.redirectUri)
  authUrl.searchParams.set('scope', X_OAUTH_DEFAULT_SCOPES.join(' '))
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('code_challenge', codeChallenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')

  return {
    ok: true,
    url: authUrl.toString(),
    cookieValue,
    state,
    expiresAt,
  }
}

/**
 * Completes the X OAuth 2.0 PKCE callback.
 * Decrypts and verifies transaction state, exchanges code for access token via PKCE,
 * fetches authenticated X identity, validates identity match, stores encrypted tokens into vault,
 * and updates platform connection to connected status.
 */
export async function completeXOAuthCallback(
  options: XOAuthCallbackOptions,
): Promise<XOAuthCallbackResult> {
  const { workspaceId, cookieValue } = options

  if (!workspaceId || typeof workspaceId !== 'string') {
    return {
      ok: false,
      code: 'invalid_request',
      reason: 'Valid workspace ID is required.',
      clearCookie: true,
    }
  }

  let db = options.db
  if (!db) {
    const { getDb } = await import('../../../../db/client.ts')
    db = getDb()
  }

  // 1. Resolve configuration
  const config = resolveXOAuthConfiguration(options.env, options.config)
  if (!config) {
    return {
      ok: false,
      code: 'oauth_not_configured',
      reason: 'X OAuth configuration or state encryption key is missing.',
      clearCookie: true,
    }
  }

  // 2. Validate cookie presence
  if (!cookieValue || typeof cookieValue !== 'string' || cookieValue.trim().length === 0) {
    return {
      ok: false,
      code: 'invalid_oauth_state',
      reason: 'Missing OAuth transaction cookie or session state.',
      clearCookie: true,
    }
  }

  // 3. Decrypt and verify transaction state
  const transaction = await decryptOAuthTransaction(cookieValue, config.stateKek, {
    workspaceId,
    platformAdapterKey: 'x',
  })

  if (!transaction) {
    return {
      ok: false,
      code: 'invalid_oauth_state',
      reason:
        'OAuth transaction state is invalid, tampered, expired, or belongs to another workspace.',
      clearCookie: true,
    }
  }

  // 4. Handle provider denial / cancellation (zero token requests)
  if (options.error) {
    return {
      ok: false,
      code: 'connection_cancelled',
      reason:
        options.errorDescription ?? `User cancelled or denied authorization (${options.error}).`,
      clearCookie: true,
    }
  }

  // 5. Compare state parameter using constant-time comparison
  if (!options.state || !constantTimeCompare(options.state, transaction.state)) {
    return {
      ok: false,
      code: 'invalid_oauth_state',
      reason: 'OAuth state parameter is missing or does not match transaction state.',
      clearCookie: true,
    }
  }

  // 6. Verify authorization code is present
  if (!options.code || typeof options.code !== 'string' || options.code.trim().length === 0) {
    return {
      ok: false,
      code: 'invalid_request',
      reason: 'Authorization code is missing from callback.',
      clearCookie: true,
    }
  }

  // 7. Verify account still exists and is eligible
  const accountRow = await queryFirst<AccountLookupRow>(
    db,
    `SELECT id, workspace_id, platform_id, handle, status, deleted_at
     FROM account
     WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [transaction.accountId, workspaceId],
  )

  if (!accountRow) {
    return {
      ok: false,
      code: 'account_not_found',
      reason: 'Target account was deleted or moved to another workspace.',
      clearCookie: true,
    }
  }

  if (accountRow.status !== 'active') {
    return {
      ok: false,
      code: 'account_ineligible',
      reason: `Target account is ${accountRow.status}. Cannot connect an inactive account.`,
      clearCookie: true,
    }
  }

  // 8. Exchange authorization code for tokens via PKCE
  const oauthClient = new XOAuthClient({
    transport: options.transport,
  })

  const tokenResult = await oauthClient.exchangeAuthorizationCode({
    code: options.code,
    codeVerifier: transaction.codeVerifier,
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    clientSecret: config.clientSecret,
    clientType: config.clientType,
  })

  if (!tokenResult.ok) {
    return {
      ok: false,
      code: tokenResult.code,
      reason: tokenResult.message,
      clearCookie: true,
    }
  }

  const tokenData = tokenResult.data

  // 9. Fetch authenticated X identity via GET /2/users/me BEFORE storing credential
  const userResult = await oauthClient.getAuthenticatedUser(tokenData.access_token)
  if (!userResult.ok) {
    return {
      ok: false,
      code: userResult.code,
      reason: userResult.message,
      clearCookie: true,
    }
  }

  const userData = userResult.data

  // 10. Verify account identity safety
  const existingConn = await getPlatformConnectionForAccount(db, accountRow.id)
  let existingProviderUserId: string | null = null
  if (existingConn?.metadataJson) {
    try {
      const parsedMeta = JSON.parse(existingConn.metadataJson) as { providerUserId?: string }
      if (
        typeof parsedMeta.providerUserId === 'string' &&
        parsedMeta.providerUserId.trim().length > 0
      ) {
        existingProviderUserId = parsedMeta.providerUserId.trim()
      }
    } catch {
      // ignore malformed existing metadata
    }
  }

  if (existingProviderUserId && existingProviderUserId !== userData.id) {
    return {
      ok: false,
      code: 'account_identity_mismatch',
      reason: `Authenticated X user ID (${userData.id}) does not match existing account provider ID (${existingProviderUserId}).`,
      clearCookie: true,
    }
  }

  // 11. Store tokens into encrypted credential vault
  const now = nowIso()
  let accessTokenExpiresAt: string | null = null
  if (typeof tokenData.expires_in === 'number' && tokenData.expires_in > 0) {
    accessTokenExpiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
  }

  const vaultResult = await storeOAuthCredential(
    db,
    {
      workspaceId,
      accountId: accountRow.id,
      platformAdapterKey: 'x',
      credential: {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token ?? null,
        tokenType: tokenData.token_type ?? 'bearer',
        scopes: tokenData.scope ?? X_OAUTH_DEFAULT_SCOPES.join(' '),
        accessTokenExpiresAt,
        providerUserId: userData.id,
      },
      keyVersion: 1,
    },
    config.credentialKek,
  )

  if (!vaultResult.ok) {
    return {
      ok: false,
      code: vaultResult.code,
      reason: vaultResult.reason,
      clearCookie: true,
    }
  }

  // 12. Upsert platform connection record with safe metadata
  const safeMetadata = JSON.stringify({
    providerUserId: userData.id,
    username: userData.username,
    connectedAt: now,
  })

  await upsertPlatformConnection(db, {
    accountId: accountRow.id,
    status: 'connected',
    scopes: tokenData.scope ?? X_OAUTH_DEFAULT_SCOPES.join(' '),
    metadata: safeMetadata,
  })

  const safeConn = await getSafePlatformConnectionForAccount(db, accountRow.id)
  if (!safeConn) {
    return {
      ok: false,
      code: 'vault_storage_failed',
      reason: 'Failed to load platform connection after updating.',
      clearCookie: true,
    }
  }

  return {
    ok: true,
    accountId: accountRow.id,
    providerUserId: userData.id,
    username: userData.username,
    connection: safeConn,
    clearCookie: true,
  }
}
