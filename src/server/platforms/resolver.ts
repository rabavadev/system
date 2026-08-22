import { getPlatformById, getPlatformConnectionForAccount } from '../db/platform.ts'
import { queryFirst, type SqlDatabase } from '../db/sql.ts'
import { decryptToken, importMasterKey } from './credentials/crypto.ts'
import type { StoredPlatformCredentialRow } from './credentials/types.ts'
import { isAdapterAuthorizedSecretRef, isValidSecretRef } from './runtime.ts'
import type {
  PlatformCredential,
  PlatformSecretResolver,
  ResolvePlatformCredentialInput,
  ResolvePlatformCredentialResult,
} from './types.ts'

interface AccountLookupRow {
  id: string
  workspace_id: string
  platform_id: string
  handle: string
  display_name: string | null
  status: string
  deleted_at: string | null
}

export type ResolvePlatformCredentialOptions =
  | PlatformSecretResolver
  | {
      secretResolver?: PlatformSecretResolver
      kek?: string | CryptoKey
    }

/**
 * Server-authoritative platform credential resolver.
 *
 * Enforces in order:
 * 1. Workspace tenant isolation
 * 2. Active account lifecycle checks (not deleted, status active)
 * 3. Platform adapter key matching
 * 4. Active connected connection state
 * 5. Primary credential source resolution:
 *    A. Active encrypted OAuth vault credential in D1 (decrypted with AES-GCM + server AAD)
 *    B. Static runtime secret binding from secret_ref (validated against provider allowlist)
 *
 * Secrets and master keys are never stored in D1 in plaintext and never returned through public domain DTOs.
 */
export async function resolvePlatformCredential(
  db: SqlDatabase,
  input: ResolvePlatformCredentialInput,
  secretResolverOrOptions?: ResolvePlatformCredentialOptions,
  explicitKek?: string | CryptoKey,
): Promise<ResolvePlatformCredentialResult> {
  let secretResolver: PlatformSecretResolver | undefined
  let kek: string | CryptoKey | undefined = explicitKek

  if (secretResolverOrOptions) {
    if ('resolveSecret' in secretResolverOrOptions) {
      secretResolver = secretResolverOrOptions
    } else {
      secretResolver = secretResolverOrOptions.secretResolver
      if (!kek) {
        kek = secretResolverOrOptions.kek
      }
    }
  }

  // 1. Load Account server-side
  const accountRows = (
    await db
      .prepare(
        `SELECT id, workspace_id, platform_id, handle, display_name, status, deleted_at
       FROM account
       WHERE id = ?`,
      )
      .bind(input.accountId)
      .all<AccountLookupRow>()
  )?.results

  const account = accountRows && accountRows.length > 0 ? accountRows[0] : null

  if (!account || account.workspace_id !== input.workspaceId) {
    return {
      ok: false,
      code: 'account_not_found',
      reason: 'Account not found in this workspace.',
    }
  }

  if (account.deleted_at !== null) {
    return {
      ok: false,
      code: 'account_ineligible',
      reason: 'Account has been deleted.',
    }
  }

  if (account.status !== 'active') {
    return {
      ok: false,
      code: 'account_ineligible',
      reason: `Account is ${account.status}. Must be active to resolve credentials.`,
    }
  }

  // 2. Load and verify Platform
  const platform = await getPlatformById(db, account.platform_id)
  if (!platform) {
    return {
      ok: false,
      code: 'platform_mismatch',
      reason: 'Account platform record not found.',
    }
  }

  if (platform.adapterKey !== input.platformAdapterKey) {
    return {
      ok: false,
      code: 'platform_mismatch',
      reason: `Account platform '${platform.adapterKey}' does not match requested platform '${input.platformAdapterKey}'.`,
    }
  }

  // 3. Load active Platform Connection
  const connection = await getPlatformConnectionForAccount(db, account.id)
  if (!connection) {
    return {
      ok: false,
      code: 'not_configured',
      reason: 'No platform connection configured for this account.',
    }
  }

  if (connection.status !== 'connected') {
    return {
      ok: false,
      code: 'connection_inactive',
      reason: `Platform connection is ${connection.status}. Must be connected to resolve credentials.`,
    }
  }

  // Parse safe connection metadata JSON if present
  let parsedMetadata: Record<string, unknown> = {}
  if (connection.metadataJson && connection.metadataJson.trim().length > 0) {
    try {
      const parsed = JSON.parse(connection.metadataJson)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        parsedMetadata = parsed as Record<string, unknown>
      }
    } catch {
      parsedMetadata = {}
    }
  }

  // 4. Check for active encrypted OAuth credential in vault
  const oauthRow = await queryFirst<StoredPlatformCredentialRow>(
    db,
    `SELECT * FROM platform_credential WHERE account_id = ? AND revoked_at IS NULL`,
    [account.id],
  )

  if (oauthRow) {
    if (oauthRow.key_version !== 1) {
      return {
        ok: false,
        code: 'not_configured',
        reason: `Unknown encryption key version ${oauthRow.key_version} in credential vault.`,
      }
    }

    // Resolve KEK
    let cryptoKey: CryptoKey | null = null
    if (kek) {
      if (typeof kek === 'object' && 'algorithm' in kek) {
        cryptoKey = kek as CryptoKey
      } else if (typeof kek === 'string') {
        try {
          cryptoKey = await importMasterKey(kek)
        } catch {
          cryptoKey = null
        }
      }
    }

    if (!cryptoKey && secretResolver) {
      const rawKek = await secretResolver.resolveSecret('PLATFORM_CREDENTIAL_KEK_V1')
      if (rawKek && typeof rawKek === 'string' && rawKek.trim().length > 0) {
        try {
          cryptoKey = await importMasterKey(rawKek.trim())
        } catch {
          cryptoKey = null
        }
      }
    }

    if (!cryptoKey) {
      return {
        ok: false,
        code: 'not_configured',
        reason: 'Master encryption key is not configured in runtime environment.',
      }
    }

    const aadContext = {
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      platformAdapterKey: input.platformAdapterKey,
      keyVersion: oauthRow.key_version,
    }

    let accessToken: string
    try {
      accessToken = await decryptToken(
        oauthRow.access_token_ciphertext,
        oauthRow.access_token_iv,
        cryptoKey,
        aadContext,
      )
    } catch {
      return {
        ok: false,
        code: 'not_configured',
        reason: 'Failed to decrypt OAuth credential or credential integrity check failed.',
      }
    }

    const mergedMetadata: Record<string, unknown> = {
      ...parsedMetadata,
      // biome-ignore lint/complexity/useLiteralKeys: required by tsconfig noPropertyAccessFromIndexSignature
      providerUserId: oauthRow.provider_user_id ?? parsedMetadata['providerUserId'] ?? null,
      tokenType: oauthRow.token_type ?? 'bearer',

      accessTokenExpiresAt: oauthRow.access_token_expires_at ?? null,
      refreshTokenExpiresAt: oauthRow.refresh_token_expires_at ?? null,
      credentialSource: 'oauth_vault',
    }

    const platformPrefix = platform.adapterKey.toUpperCase()
    const vaultRef = `${platformPrefix}_OAUTH_VAULT`

    const credential: PlatformCredential = {
      secretRef: vaultRef,
      secretValue: accessToken,
      accountId: account.id,
      platformAdapterKey: platform.adapterKey,
      scopes: oauthRow.scopes ?? connection.scopes ?? null,
      metadata: mergedMetadata,
    }

    return {
      ok: true,
      credential,
    }
  }

  // 5. Fallback to static runtime secret binding if no OAuth credential exists
  if (!connection.secretRef || connection.secretRef.trim().length === 0) {
    return {
      ok: false,
      code: 'not_configured',
      reason: 'Platform connection has no secret_ref or active OAuth credential configured.',
    }
  }

  const trimmedSecretRef = connection.secretRef.trim()

  // Validate secret_ref syntax and prototype safety
  if (!isValidSecretRef(trimmedSecretRef)) {
    return {
      ok: false,
      code: 'not_configured',
      reason: 'Invalid secret_ref identifier format.',
    }
  }

  // Provider binding check
  if (!isAdapterAuthorizedSecretRef(platform.adapterKey, trimmedSecretRef)) {
    return {
      ok: false,
      code: 'platform_mismatch',
      reason: `Secret reference '${trimmedSecretRef}' is not authorized for platform '${platform.adapterKey}'.`,
    }
  }

  // Resolve external secret binding
  if (!secretResolver) {
    return {
      ok: false,
      code: 'not_configured',
      reason: `No secret resolver provided and runtime secret binding '${trimmedSecretRef}' cannot be resolved.`,
    }
  }

  const secretValue = await secretResolver.resolveSecret(trimmedSecretRef)
  if (!secretValue || typeof secretValue !== 'string' || secretValue.trim().length === 0) {
    return {
      ok: false,
      code: 'not_configured',
      reason: `Secret binding '${trimmedSecretRef}' is not configured in runtime environment.`,
    }
  }

  const credential: PlatformCredential = {
    secretRef: trimmedSecretRef,
    secretValue: secretValue.trim(),
    accountId: account.id,
    platformAdapterKey: platform.adapterKey,
    scopes: connection.scopes ?? null,
    metadata: Object.keys(parsedMetadata).length > 0 ? parsedMetadata : null,
  }

  return {
    ok: true,
    credential,
  }
}
