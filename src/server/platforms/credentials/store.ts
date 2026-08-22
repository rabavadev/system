import { executeBatch, newId, nowIso, queryFirst, type SqlDatabase } from '../../db/sql.ts'

import { createEnvSecretResolver } from '../runtime.ts'
import type { PlatformSecretResolver } from '../types.ts'
import { DEFAULT_KEY_VERSION, decryptToken, encryptToken, importMasterKey } from './crypto.ts'
import type {
  DecryptedOAuthCredential,
  ResolveOAuthCredentialInput,
  ResolveOAuthCredentialResult,
  RevokeOAuthCredentialInput,
  RevokeOAuthCredentialResult,
  StoredPlatformCredentialRow,
  StoreOAuthCredentialInput,
  StoreOAuthCredentialResult,
} from './types.ts'

export const DEFAULT_KEK_BINDING = 'PLATFORM_CREDENTIAL_KEK_V1'

interface AccountCheckRow {
  id: string
  workspace_id: string
  platform_id: string
  status: string
  deleted_at: string | null
}

interface PlatformCheckRow {
  id: string
  adapter_key: string
}

interface ConnectionCheckRow {
  id: string
  status: string
}

/**
 * Resolves a Web Crypto CryptoKey from explicit key material, a PlatformSecretResolver,
 * or the runtime environment.
 */
export async function resolveCryptoKey(
  keySource?: string | CryptoKey | PlatformSecretResolver,
): Promise<CryptoKey | null> {
  if (keySource && typeof keySource === 'object' && 'algorithm' in keySource) {
    return keySource as CryptoKey
  }

  if (typeof keySource === 'string') {
    try {
      return await importMasterKey(keySource)
    } catch {
      return null
    }
  }

  if (keySource && typeof keySource === 'object' && 'resolveSecret' in keySource) {
    const rawVal = await keySource.resolveSecret(DEFAULT_KEK_BINDING)
    if (rawVal && typeof rawVal === 'string' && rawVal.trim().length > 0) {
      try {
        return await importMasterKey(rawVal.trim())
      } catch {
        return null
      }
    }
    return null
  }

  // Fallback to runtime environment resolver
  const envResolver = createEnvSecretResolver()
  const rawEnvVal = envResolver.resolveSecret(DEFAULT_KEK_BINDING)
  if (rawEnvVal && typeof rawEnvVal === 'string' && rawEnvVal.trim().length > 0) {
    try {
      return await importMasterKey(rawEnvVal.trim())
    } catch {
      return null
    }
  }

  return null
}

/**
 * Checks if an active (non-revoked) OAuth credential exists for an account.
 */
export async function hasActiveOAuthCredential(
  db: SqlDatabase,
  accountId: string,
): Promise<boolean> {
  const row = await queryFirst<{ id: string }>(
    db,
    `SELECT id FROM platform_credential WHERE account_id = ? AND revoked_at IS NULL`,
    [accountId],
  )
  return Boolean(row)
}

/**
 * Stores a normalized OAuth credential set into the encrypted credential vault.
 * Plaintext tokens are immediately encrypted with AES-GCM and never stored in D1.
 * Enforces the one-active-credential-per-account invariant by revoking any prior active credential.
 */
export async function storeOAuthCredential(
  db: SqlDatabase,
  input: StoreOAuthCredentialInput,
  keySource?: string | CryptoKey | PlatformSecretResolver,
): Promise<StoreOAuthCredentialResult> {
  // 1. Validate plaintext access token input
  if (
    !input.credential ||
    typeof input.credential.accessToken !== 'string' ||
    input.credential.accessToken.trim().length === 0
  ) {
    return {
      ok: false,
      code: 'invalid_credential',
      reason: 'Access token must be a non-empty string.',
    }
  }

  // 2. Validate Account existence, tenant ownership, and lifecycle
  const account = await queryFirst<AccountCheckRow>(
    db,
    `SELECT id, workspace_id, platform_id, status, deleted_at FROM account WHERE id = ?`,
    [input.accountId],
  )

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
      reason: `Account is ${account.status}. Must be active to store credentials.`,
    }
  }

  // 3. Validate Platform adapter key matching
  const platform = await queryFirst<PlatformCheckRow>(
    db,
    `SELECT id, adapter_key FROM platform WHERE id = ?`,
    [account.platform_id],
  )

  if (!platform || platform.adapter_key !== input.platformAdapterKey) {
    return {
      ok: false,
      code: 'platform_mismatch',
      reason: `Platform adapter '${platform?.adapter_key ?? 'unknown'}' does not match requested '${input.platformAdapterKey}'.`,
    }
  }

  // 4. Resolve Master Key
  const cryptoKey = await resolveCryptoKey(keySource)
  if (!cryptoKey) {
    return {
      ok: false,
      code: 'credential_vault_not_configured',
      reason: 'Credential vault master encryption key is not configured or is invalid.',
    }
  }

  const keyVersion = input.keyVersion ?? DEFAULT_KEY_VERSION
  if (keyVersion !== DEFAULT_KEY_VERSION) {
    return {
      ok: false,
      code: 'credential_unknown_key_version',
      reason: `Unsupported encryption key version: ${keyVersion}.`,
    }
  }

  // 5. Encrypt access_token and refresh_token immediately
  const aadContext = {
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    platformAdapterKey: input.platformAdapterKey,
    keyVersion,
  }

  const accessEncrypted = await encryptToken(
    input.credential.accessToken.trim(),
    cryptoKey,
    aadContext,
  )

  let refreshEncrypted: { ciphertext: string; iv: string } | null = null
  if (
    input.credential.refreshToken &&
    typeof input.credential.refreshToken === 'string' &&
    input.credential.refreshToken.trim().length > 0
  ) {
    refreshEncrypted = await encryptToken(
      input.credential.refreshToken.trim(),
      cryptoKey,
      aadContext,
    )
  }

  // Normalize scopes
  let normalizedScopes: string | null = null
  if (Array.isArray(input.credential.scopes)) {
    normalizedScopes = input.credential.scopes.join(' ').trim()
  } else if (typeof input.credential.scopes === 'string') {
    normalizedScopes = input.credential.scopes.trim()
  }

  const now = nowIso()
  const credentialId = newId()

  const safeMetadata: Record<string, unknown> = {}
  if (input.credential.providerUserId) {
    // biome-ignore lint/complexity/useLiteralKeys: required by tsconfig noPropertyAccessFromIndexSignature
    safeMetadata['providerUserId'] = input.credential.providerUserId
  }

  const safeMetadataJson =
    Object.keys(safeMetadata).length > 0 ? JSON.stringify(safeMetadata) : null

  // 6, 7, 8: Execute revocation of prior active credential, insertion of new credential,
  // and connection status update atomically via batch execution.
  await executeBatch(db, [
    // 6. Revoke any prior active credential for this account
    {
      sql: `UPDATE platform_credential
            SET revoked_at = ?, updated_at = ?
            WHERE account_id = ? AND revoked_at IS NULL`,
      params: [now, now, input.accountId],
    },
    // 7. Insert new encrypted credential record
    {
      sql: `INSERT INTO platform_credential (
             id, workspace_id, account_id, platform_id, credential_type,
             access_token_ciphertext, access_token_iv,
             refresh_token_ciphertext, refresh_token_iv,
             token_type, scopes,
             access_token_expires_at, refresh_token_expires_at,
             provider_user_id, key_version,
             created_at, updated_at, revoked_at
           ) VALUES (?, ?, ?, ?, 'oauth2', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      params: [
        credentialId,
        input.workspaceId,
        input.accountId,
        account.platform_id,
        accessEncrypted.ciphertext,
        accessEncrypted.iv,
        refreshEncrypted?.ciphertext ?? null,
        refreshEncrypted?.iv ?? null,
        input.credential.tokenType?.trim() ?? 'bearer',
        normalizedScopes,
        input.credential.accessTokenExpiresAt ?? null,
        input.credential.refreshTokenExpiresAt ?? null,
        input.credential.providerUserId ?? null,
        keyVersion,
        now,
        now,
      ],
    },
    // 8. Ensure connection is active and safe metadata updated (deterministic UPSERT)
    {
      sql: `INSERT INTO platform_connection (
             id, account_id, status, secret_ref, scopes, metadata, connected_at, created_at, updated_at
           ) VALUES (?, ?, 'connected', NULL, ?, ?, ?, ?, ?)
           ON CONFLICT(account_id) DO UPDATE SET
             status = 'connected',
             scopes = COALESCE(excluded.scopes, platform_connection.scopes),
             metadata = COALESCE(excluded.metadata, platform_connection.metadata),
             connected_at = COALESCE(platform_connection.connected_at, excluded.connected_at),
             updated_at = excluded.updated_at`,
      params: [newId(), input.accountId, normalizedScopes, safeMetadataJson, now, now, now],
    },
  ])

  return {
    ok: true,
    id: credentialId,
  }
}

/**
 * Resolves and decrypts an active OAuth credential for an account.
 * Strict tenant isolation is enforced: cross-workspace lookups return account_not_found
 * with ZERO decryption attempts.
 */
export async function resolveOAuthCredential(
  db: SqlDatabase,
  input: ResolveOAuthCredentialInput,
  keySource?: string | CryptoKey | PlatformSecretResolver,
): Promise<ResolveOAuthCredentialResult> {
  // 1. Authoritative account lookup and tenant isolation
  const account = await queryFirst<AccountCheckRow>(
    db,
    `SELECT id, workspace_id, platform_id, status, deleted_at FROM account WHERE id = ?`,
    [input.accountId],
  )

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

  // 2. Validate Platform adapter key matching
  const platform = await queryFirst<PlatformCheckRow>(
    db,
    `SELECT id, adapter_key FROM platform WHERE id = ?`,
    [account.platform_id],
  )

  if (!platform || platform.adapter_key !== input.platformAdapterKey) {
    return {
      ok: false,
      code: 'platform_mismatch',
      reason: `Account platform '${platform?.adapter_key ?? 'unknown'}' does not match requested '${input.platformAdapterKey}'.`,
    }
  }

  // 3. Validate Platform Connection status
  const connection = await queryFirst<ConnectionCheckRow>(
    db,
    `SELECT id, status FROM platform_connection WHERE account_id = ?`,
    [input.accountId],
  )

  if (!connection) {
    return {
      ok: false,
      code: 'credential_not_found',
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

  // 4. Load Active Encrypted Credential Record
  const row = await queryFirst<StoredPlatformCredentialRow>(
    db,
    `SELECT * FROM platform_credential WHERE account_id = ? AND revoked_at IS NULL`,
    [input.accountId],
  )

  if (!row) {
    return {
      ok: false,
      code: 'credential_not_found',
      reason: 'No active OAuth credential found for this account.',
    }
  }

  // 5. Verify Key Version
  if (row.key_version !== DEFAULT_KEY_VERSION) {
    return {
      ok: false,
      code: 'credential_unknown_key_version',
      reason: `Unknown encryption key version: ${row.key_version}.`,
    }
  }

  // 6. Resolve Master Key
  const cryptoKey = await resolveCryptoKey(keySource)
  if (!cryptoKey) {
    return {
      ok: false,
      code: 'credential_vault_not_configured',
      reason: 'Credential vault master encryption key is not configured or is invalid.',
    }
  }

  // 7. Decrypt with Authenticated Associated Data (AAD)
  const aadContext = {
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    platformAdapterKey: input.platformAdapterKey,
    keyVersion: row.key_version,
  }

  let accessToken: string
  try {
    accessToken = await decryptToken(
      row.access_token_ciphertext,
      row.access_token_iv,
      cryptoKey,
      aadContext,
    )
  } catch {
    return {
      ok: false,
      code: 'credential_corrupt',
      reason: 'Failed to decrypt access token or credential integrity check failed.',
    }
  }

  let refreshToken: string | null = null
  if (row.refresh_token_ciphertext && row.refresh_token_iv) {
    try {
      refreshToken = await decryptToken(
        row.refresh_token_ciphertext,
        row.refresh_token_iv,
        cryptoKey,
        aadContext,
      )
    } catch {
      return {
        ok: false,
        code: 'credential_corrupt',
        reason: 'Failed to decrypt refresh token or credential integrity check failed.',
      }
    }
  }

  const credential: DecryptedOAuthCredential = {
    id: row.id,
    workspaceId: row.workspace_id,
    accountId: row.account_id,
    platformId: row.platform_id,
    platformAdapterKey: input.platformAdapterKey,
    accessToken,
    refreshToken,
    tokenType: row.token_type,
    scopes: row.scopes,
    accessTokenExpiresAt: row.access_token_expires_at,
    refreshTokenExpiresAt: row.refresh_token_expires_at,
    providerUserId: row.provider_user_id,
    keyVersion: row.key_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }

  return {
    ok: true,
    credential,
  }
}

/**
 * Rotates an existing OAuth credential set.
 */
export async function rotateOAuthCredential(
  db: SqlDatabase,
  input: StoreOAuthCredentialInput,
  keySource?: string | CryptoKey | PlatformSecretResolver,
): Promise<StoreOAuthCredentialResult> {
  return storeOAuthCredential(db, input, keySource)
}

/**
 * Revokes all active OAuth credentials for an account.
 */
export async function revokeOAuthCredential(
  db: SqlDatabase,
  input: RevokeOAuthCredentialInput,
): Promise<RevokeOAuthCredentialResult> {
  // Validate Account existence and tenant ownership
  const account = await queryFirst<AccountCheckRow>(
    db,
    `SELECT id, workspace_id FROM account WHERE id = ?`,
    [input.accountId],
  )

  if (!account || account.workspace_id !== input.workspaceId) {
    return {
      ok: false,
      code: 'account_not_found',
      reason: 'Account not found in this workspace.',
    }
  }

  const now = nowIso()
  await executeBatch(db, [
    {
      sql: `UPDATE platform_credential
            SET revoked_at = ?, updated_at = ?
            WHERE account_id = ? AND revoked_at IS NULL`,
      params: [now, now, input.accountId],
    },
    {
      sql: `UPDATE platform_connection
            SET status = 'disconnected', updated_at = ?
            WHERE account_id = ?`,
      params: [now, input.accountId],
    },
  ])

  return {
    ok: true,
    revokedCount: 1,
  }
}
