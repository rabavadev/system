/**
 * X OAuth credential lifecycle operations: conditional token refresh and explicit disconnect.
 *
 * Security invariants:
 * - Plaintext tokens are NEVER stored in D1, audit logs, error messages, or return DTOs.
 * - Authorization headers with token material are NEVER persisted.
 * - Provider revocation (revokeToken) is best-effort: local revocation always proceeds
 *   regardless of provider response or network failure.
 * - Token refresh uses a distributed optimistic lease (refresh_locked_until) to ensure
 *   exactly ONE Cloudflare Worker isolate performs the refresh endpoint call when multiple
 *   isolates detect a near-expiry credential concurrently.
 */

import { execute, newId, nowIso, queryFirst, type SqlDatabase } from '../../../../db/sql.ts'
import {
  resolveOAuthCredential,
  revokeOAuthCredential,
  rotateOAuthCredentialFenced,
  storeOAuthCredential,
} from '../../../credentials/store.ts'
import type { PlatformSecretResolver } from '../../../types.ts'
import { XOAuthClient } from './client.ts'
import type { XDisconnectResult, XOAuthConfiguration, XRefreshResult } from './types.ts'

/** Refresh when access token expires within this many seconds. */
const REFRESH_THRESHOLD_SECONDS = 60

/** Refresh lease duration in seconds. Must be > typical refresh round-trip. */
const REFRESH_LEASE_SECONDS = 30

const X_ADAPTER_KEY = 'x'

type KeySource = string | CryptoKey | PlatformSecretResolver | undefined

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns the number of seconds until the given ISO timestamp.
 * Returns Infinity if the timestamp is null/undefined/unparseable.
 */
function secondsUntilExpiry(isoTimestamp: string | null | undefined): number {
  if (!isoTimestamp || isoTimestamp.trim().length === 0) return Number.POSITIVE_INFINITY
  const expires = new Date(isoTimestamp).getTime()
  if (Number.isNaN(expires)) return Number.POSITIVE_INFINITY
  return (expires - Date.now()) / 1000
}

/**
 * Returns an ISO timestamp that is `seconds` from now.
 */
function isoInFuture(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString()
}

/**
 * Attempts to claim the refresh lease for `accountId` on exact `credentialId` via an optimistic UPDATE.
 * Returns { claimed: true, claimId } if claimed, or { claimed: false } if another isolate holds it.
 */
async function claimRefreshLease(
  db: SqlDatabase,
  accountId: string,
  credentialId: string,
): Promise<{ claimed: true; claimId: string } | { claimed: false }> {
  const now = nowIso()
  const leaseExpiry = isoInFuture(REFRESH_LEASE_SECONDS)
  const claimId = newId()

  // Claim only if: exact credential row is active and has no unexpired lease.
  // "refresh_locked_until IS NULL" → never locked
  // "refresh_locked_until < now" → previous lease has expired
  const result = (await execute(
    db,
    `UPDATE platform_credential
     SET refresh_locked_until = ?, refresh_claim_id = ?
     WHERE id = ? AND account_id = ? AND revoked_at IS NULL
       AND (refresh_locked_until IS NULL OR refresh_locked_until < ?)`,
    [leaseExpiry, claimId, credentialId, accountId, now],
  )) as { meta?: { changes?: number }; changes?: number } | undefined

  // D1 returns { meta: { changes } }; better-sqlite3 returns { changes } directly
  const rowsChanged =
    (result as { meta?: { changes?: number } })?.meta?.changes ??
    (result as { changes?: number })?.changes ??
    0

  if (rowsChanged > 0) {
    return { claimed: true, claimId }
  }
  return { claimed: false }
}

/**
 * Releases the refresh lease for `accountId` and `credentialId` conditionally on the matching `claimId`.
 * If ownership changed or expired meanwhile, this UPDATE affects 0 rows and leaves
 * the new owner's claim untouched.
 */
async function releaseRefreshLease(
  db: SqlDatabase,
  accountId: string,
  credentialId: string,
  claimId: string,
): Promise<void> {
  await execute(
    db,
    `UPDATE platform_credential
     SET refresh_locked_until = NULL, refresh_claim_id = NULL
     WHERE id = ? AND account_id = ? AND revoked_at IS NULL AND refresh_claim_id = ?`,
    [credentialId, accountId, claimId],
  )
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Conditionally refreshes the X OAuth access token for `accountId`.
 *
 * Algorithm:
 * 1. Read raw vault row — check access_token_expires_at.
 * 2. If expiry unknown (NULL): skip (return refresh_skipped). Static/legacy credentials
 *    are not subject to refresh.
 * 3. If > REFRESH_THRESHOLD_SECONDS remaining: skip (not near expiry).
 * 4. If no refresh_token in vault: return reconnect_required.
 * 5. If config missing: return oauth_not_configured.
 * 6. Claim distributed lease with unique claim ID. If lease held by another isolate:
 *    return refresh_lease_held (ok:true — caller can proceed with existing token).
 * 7. Decrypt refresh token. Call XOAuthClient.refreshToken().
 * 8. On provider failure: conditionally release lease with claim ID, return reconnect_required.
 * 9. On success: storeOAuthCredential with expectedRefreshClaimId (fenced atomic rotation).
 *    Return { ok:true, refreshed:true }.
 */
export async function refreshXOAuthCredentialIfNeeded(
  db: SqlDatabase,
  input: { accountId: string; workspaceId: string },
  config: XOAuthConfiguration | null,
  keySource?: KeySource,
  transport?: ((url: string, init?: RequestInit) => Promise<Response>) | undefined,
): Promise<XRefreshResult> {
  // Step 1: read raw vault row for expiry check (no decryption)
  interface ExpiryCheckRow {
    id: string
    access_token_expires_at: string | null
    refresh_token_ciphertext: string | null
  }

  const raw = await queryFirst<ExpiryCheckRow>(
    db,
    `SELECT id, access_token_expires_at, refresh_token_ciphertext
     FROM platform_credential
     WHERE account_id = ? AND revoked_at IS NULL`,
    [input.accountId],
  )

  if (!raw) {
    return { ok: false, code: 'credential_not_found', reason: 'No active credential found.' }
  }

  // Step 2: expiry unknown → skip
  if (!raw.access_token_expires_at) {
    return { ok: true, refreshed: false, code: 'refresh_skipped' }
  }

  // Step 3: not near expiry → skip
  const secsRemaining = secondsUntilExpiry(raw.access_token_expires_at)
  if (secsRemaining > REFRESH_THRESHOLD_SECONDS) {
    return { ok: true, refreshed: false }
  }

  // Step 4: no refresh token → must reconnect
  if (!raw.refresh_token_ciphertext) {
    return {
      ok: false,
      code: 'reconnect_required',
      reason:
        'Access token is expiring and no refresh token is available. Account reconnection required.',
    }
  }

  // Step 5: config required
  if (!config?.clientId || config.clientId.trim().length === 0) {
    return {
      ok: false,
      code: 'oauth_not_configured',
      reason: 'X OAuth configuration (clientId) is not available for token refresh.',
    }
  }

  const credentialId = raw.id

  // Step 6: claim distributed lease with unique claim ID targeting exact active credential
  const claim = await claimRefreshLease(db, input.accountId, credentialId)
  if (!claim.claimed) {
    // Another CF Worker isolate is refreshing. The existing token is still valid
    // for at least the lease window duration — caller can proceed with it.
    return { ok: true, refreshed: false, code: 'refresh_lease_held' }
  }
  const claimId = claim.claimId

  // Step 7: decrypt the current credential to get plaintext refresh token
  const resolveRes = await resolveOAuthCredential(
    db,
    {
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      platformAdapterKey: X_ADAPTER_KEY,
    },
    keySource,
  )

  if (!resolveRes.ok) {
    await releaseRefreshLease(db, input.accountId, credentialId, claimId)
    return {
      ok: false,
      code: 'reconnect_required',
      reason: `Failed to decrypt credential for refresh: ${resolveRes.reason}`,
    }
  }

  const plaintextRefreshToken = resolveRes.credential.refreshToken
  if (!plaintextRefreshToken) {
    await releaseRefreshLease(db, input.accountId, credentialId, claimId)
    return {
      ok: false,
      code: 'reconnect_required',
      reason: 'Decrypted credential is missing refresh token.',
    }
  }

  // Step 8: call X token endpoint
  const client = new XOAuthClient({ transport })
  const refreshRes = await client.refreshToken({
    refreshToken: plaintextRefreshToken,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    clientType: config.clientType,
  })

  if (!refreshRes.ok) {
    await releaseRefreshLease(db, input.accountId, credentialId, claimId)
    return {
      ok: false,
      code: 'reconnect_required',
      reason: `X token refresh failed (${refreshRes.code}): ${refreshRes.message}`,
    }
  }

  const tokenData = refreshRes.data

  // Compute new access token expiry from expires_in
  let accessTokenExpiresAt: string | null = null
  if (typeof tokenData.expires_in === 'number' && tokenData.expires_in > 0) {
    accessTokenExpiresAt = isoInFuture(tokenData.expires_in)
  }

  // Step 9: rotate credential in-place with database-authoritative fencing
  const rotateRes = await rotateOAuthCredentialFenced(
    db,
    {
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      platformAdapterKey: X_ADAPTER_KEY,
      credentialId,
      claimId,
      credential: {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token ?? plaintextRefreshToken,
        tokenType: tokenData.token_type ?? resolveRes.credential.tokenType ?? 'bearer',
        scopes: tokenData.scope ?? resolveRes.credential.scopes ?? null,
        accessTokenExpiresAt,
        refreshTokenExpiresAt: resolveRes.credential.refreshTokenExpiresAt ?? null,
        providerUserId: resolveRes.credential.providerUserId ?? null,
      },
    },
    keySource,
  )

  if (!rotateRes.ok) {
    // Rotation failed (e.g. stale claim superseded, lease expired, or account disconnected)
    await releaseRefreshLease(db, input.accountId, credentialId, claimId)
    return {
      ok: false,
      code: 'reconnect_required',
      reason: `Failed to store rotated credential: ${rotateRes.reason}`,
    }
  }

  return { ok: true, refreshed: true }
}

/**
 * Explicitly disconnects an X account.
 *
 * Order (required by audit):
 * 1. Resolve plaintext tokens from vault (for provider revocation). No mutation yet.
 * 2. Authoritative local revocation: atomically sets platform_credential.revoked_at and
 *    platform_connection.status = 'disconnected' in a single D1 batch.
 *    If this step fails → return error immediately, ZERO provider calls.
 * 3. Best-effort provider revocation (access token, then refresh token).
 *    Provider failure does NOT undo step 2; local state remains authoritative.
 *
 * Plaintext token material is NEVER returned in the result DTO.
 */
export async function disconnectXOAuth(
  db: SqlDatabase,
  input: { accountId: string; workspaceId: string },
  config: XOAuthConfiguration | null,
  keySource?: KeySource,
  transport?: ((url: string, init?: RequestInit) => Promise<Response>) | undefined,
): Promise<XDisconnectResult> {
  // Step 1: Resolve plaintext tokens now — read-only, no mutations yet.
  // We need them for provider-side revocation in step 3.
  // If resolution fails (already revoked, no credential), we proceed to local revoke
  // and skip the provider call (there's nothing to revoke remotely).
  let accessToken: string | null = null
  let refreshToken: string | null = null

  if (config?.clientId && config.clientId.trim().length > 0) {
    const resolveRes = await resolveOAuthCredential(
      db,
      {
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        platformAdapterKey: X_ADAPTER_KEY,
      },
      keySource,
    )

    if (resolveRes.ok) {
      accessToken = resolveRes.credential.accessToken
      refreshToken = resolveRes.credential.refreshToken ?? null
    }
    // If resolution failed (already revoked / no credential), tokens remain null.
    // Local revoke below will still run (no-op if nothing to revoke), and provider
    // call is skipped (no tokens to send).
  }

  // Step 2: Authoritative local revocation — ALWAYS runs and MUST succeed before
  // any provider calls. This is a D1-safe atomic executeBatch operation in
  // revokeOAuthCredential (platform_credential.revoked_at + platform_connection.status).
  const revokeRes = await revokeOAuthCredential(db, {
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    platformAdapterKey: X_ADAPTER_KEY,
  })

  if (!revokeRes.ok) {
    // Local revocation failed. Return error immediately.
    // ZERO provider revoke calls — there is no point revoking at X if local state
    // is inconsistent.
    return {
      ok: false,
      code: 'storage_error',
      reason: `Failed to revoke local credential: ${revokeRes.reason}`,
    }
  }

  // Step 3: Best-effort provider revocation — runs only after local commit.
  // Errors here do NOT affect the local-authoritative disconnect.
  let providerRevoked = false

  if (accessToken && config) {
    const client = new XOAuthClient({ transport })

    // Revoke access token (best-effort — swallow error)
    const revokeAccessRes = await client
      .revokeToken({
        token: accessToken,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        clientType: config.clientType,
      })
      .catch(() => ({ ok: false as const }))

    if (revokeAccessRes.ok) {
      providerRevoked = true
    }

    // Revoke refresh token if present (best-effort — swallow error)
    if (refreshToken) {
      await client
        .revokeToken({
          token: refreshToken,
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          clientType: config.clientType,
        })
        .catch(() => null)
    }
  }

  return { ok: true, localRevoked: true, providerRevoked }
}
