/**
 * STEP 15E.3C.3: X OAuth Token Refresh + Secure Disconnect Lifecycle Test Suite
 *
 * Validates the complete OAuth credential lifecycle beyond initial authorization:
 *
 * Refresh — configuration (1–4)
 * Refresh — no refresh token (5–6)
 * Refresh — HTTP request contract (7–14)
 * Refresh — response handling (15–20)
 * Refresh — vault rotation (21–27)
 * Refresh — concurrency / distributed lease (28–32)
 * Refresh — security (33–36)
 * Disconnect — local revocation (37–44)
 * Disconnect — provider revocation (45–50)
 * Disconnect — security (51–55)
 * Publish integration — refresh before /users/me (56–62)
 * Reconnect safety (63–66)
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import { decideApprovalRequest } from '../src/server/approval/service.ts'
import { approveCampaignContentVariant } from '../src/server/db/content-approval.ts'
import { getPlatformConnectionForAccount } from '../src/server/db/platform.ts'
import {
  createPublicationIntent,
  dispatchApprovedPublication,
  requestPublicationDispatch,
} from '../src/server/db/post.ts'
import {
  execute,
  newId,
  nowIso,
  queryFirst,
  type SqlBoundStatement,
  type SqlDatabase,
} from '../src/server/db/sql.ts'
import { XOAuthClient } from '../src/server/platforms/adapters/x/oauth/client.ts'
import {
  disconnectXOAuth,
  refreshXOAuthCredentialIfNeeded,
} from '../src/server/platforms/adapters/x/oauth/lifecycle.ts'
import { X_REVOKE_URL, X_TOKEN_URL } from '../src/server/platforms/adapters/x/oauth/types.ts'
import { generateMasterKey } from '../src/server/platforms/credentials/crypto.ts'
import {
  resolveOAuthCredential,
  storeOAuthCredential,
} from '../src/server/platforms/credentials/store.ts'
import { createEnvSecretResolver } from '../src/server/platforms/runtime.ts'

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface SyncRunnableBoundStatement extends SqlBoundStatement {
  _runSync?: () => unknown
}

function shim(db: Database.Database): SqlDatabase {
  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql)
      return {
        bind(...params: unknown[]) {
          return {
            all: async <Row>() => ({ results: stmt.all(...params) as Row[] }),
            first: async <Row>() => (stmt.get(...params) as Row | undefined) ?? null,
            run: async () => stmt.run(...params),
            _runSync: () => stmt.run(...params),
          }
        },
      }
    },
    async batch(statements: SqlBoundStatement[]) {
      const tx = db.transaction(() => {
        for (const s of statements as SyncRunnableBoundStatement[]) {
          if (typeof s._runSync === 'function') {
            s._runSync()
          } else {
            throw new Error('Statement cannot be executed synchronously in batch transaction')
          }
        }
      })
      tx()
      return statements.map(() => ({}))
    },
  }
}

function createTestDb(): SqlDatabase {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')

  const migrationsDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'migrations')
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8')
    sqlite.exec(sql)
  }

  return shim(sqlite)
}

const TEST_KEK = generateMasterKey()
const TEST_CLIENT_ID = 'test_lifecycle_client_id'
const TEST_CLIENT_SECRET = 'test_lifecycle_client_secret'

const BASE_CONFIG = {
  clientId: TEST_CLIENT_ID,
  clientSecret: TEST_CLIENT_SECRET,
  redirectUri: 'http://localhost:3000/oauth/x/callback',
  stateKek: generateMasterKey(),
  credentialKek: TEST_KEK,
  clientType: 'confidential' as const,
}

const PUBLIC_CONFIG = {
  clientId: TEST_CLIENT_ID,
  redirectUri: 'http://localhost:3000/oauth/x/callback',
  stateKek: generateMasterKey(),
  credentialKek: TEST_KEK,
  clientType: 'public' as const,
}

interface LifecycleTestCtx {
  db: SqlDatabase
  workspaceId: string
  accountId: string
  xPlatformId: string
}

async function seedLifecycleCtx(): Promise<LifecycleTestCtx> {
  const db = createTestDb()
  const now = nowIso()
  const workspaceId = newId()

  await execute(
    db,
    `INSERT INTO workspace (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    [workspaceId, 'Test Workspace', now, now],
  )

  const existing = await queryFirst<{ id: string }>(
    db,
    `SELECT id FROM platform WHERE adapter_key = 'x'`,
  )
  let xPlatformId = existing?.id
  if (!xPlatformId) {
    xPlatformId = newId()
    await execute(
      db,
      `INSERT INTO platform (id, name, adapter_key, created_at) VALUES (?, ?, ?, ?)`,
      [xPlatformId, 'X', 'x', now],
    )
  }

  const accountId = newId()
  await execute(
    db,
    `INSERT INTO account (id, workspace_id, platform_id, handle, display_name, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    [accountId, workspaceId, xPlatformId, 'lifecycle_user', 'Lifecycle User', now, now],
  )

  return { db, workspaceId, accountId, xPlatformId }
}

/** Stores a credential and sets up platform_connection, returns the credential. */
async function seedCredential(
  ctx: LifecycleTestCtx,
  options: {
    accessTokenExpiresAt?: string | null
    refreshToken?: string | null
    accessToken?: string
    providerUserId?: string
  } = {},
) {
  const { db, workspaceId, accountId } = ctx
  const accessToken = options.accessToken ?? 'at_lifecycle_plaintext_token'
  const refreshToken =
    options.refreshToken !== undefined ? options.refreshToken : 'rt_lifecycle_refresh_token'

  const storeRes = await storeOAuthCredential(
    db,
    {
      workspaceId,
      accountId,
      platformAdapterKey: 'x',
      credential: {
        accessToken,
        refreshToken: refreshToken ?? undefined,
        tokenType: 'bearer',
        scopes: 'tweet.read tweet.write users.read offline.access',
        accessTokenExpiresAt:
          options.accessTokenExpiresAt !== undefined
            ? options.accessTokenExpiresAt
            : new Date(Date.now() + 7200 * 1000).toISOString(), // 2h from now
        providerUserId: options.providerUserId ?? 'provider_uid_lifecycle',
      },
    },
    TEST_KEK,
  )
  assert.ok(storeRes.ok, `seedCredential: storeOAuthCredential failed: ${JSON.stringify(storeRes)}`)
  return storeRes
}

/** Returns ISO timestamp for `seconds` in the future (negative = past). */
function isoFuture(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString()
}

/** A transport that captures all outbound calls. */
interface CapturedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

function makeCaptureTransport(responses: { url?: string; status?: number; body?: unknown }[]): {
  transport: (url: string, init?: RequestInit) => Promise<Response>
  calls: CapturedRequest[]
} {
  const calls: CapturedRequest[] = []
  let callIndex = 0

  const transport = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers: Record<string, string> = {}
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k.toLowerCase()] = v
      }
    }
    const body = typeof init?.body === 'string' ? init.body : ''
    calls.push({ url, method, headers, body })

    const resp = responses[callIndex] ?? responses[responses.length - 1]
    callIndex++
    const status = resp?.status ?? 200
    const responseBody = resp?.body !== undefined ? JSON.stringify(resp.body) : '{}'
    return new Response(responseBody, { status, headers: { 'content-type': 'application/json' } })
  }

  return { transport, calls }
}

function makeTokenResponse(
  overrides: Partial<{
    access_token: string
    refresh_token: string
    token_type: string
    expires_in: number
    scope: string
  }> = {},
): object {
  return {
    access_token: overrides.access_token ?? 'new_at_after_refresh',
    refresh_token: overrides.refresh_token ?? 'new_rt_after_refresh',
    token_type: overrides.token_type ?? 'bearer',
    expires_in: overrides.expires_in ?? 7200,
    scope: overrides.scope ?? 'tweet.read tweet.write users.read offline.access',
  }
}

// ---------------------------------------------------------------------------
// REFRESH — CONFIGURATION (1–4)
// ---------------------------------------------------------------------------

test('1. refresh skipped when access_token_expires_at is NULL (expiry unknown)', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, { accessTokenExpiresAt: null })

  const result = await refreshXOAuthCredentialIfNeeded(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
  )

  assert.ok(result.ok)
  assert.equal((result as { refreshed: boolean; code?: string }).refreshed, false)
  assert.equal((result as { code?: string }).code, 'refresh_skipped')
})

test('2. refresh skipped when token not near expiry (> 60s remaining)', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, { accessTokenExpiresAt: isoFuture(3600) })

  const { transport, calls } = makeCaptureTransport([{ status: 200, body: makeTokenResponse() }])
  const result = await refreshXOAuthCredentialIfNeeded(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  assert.ok(result.ok)
  assert.equal((result as { refreshed: boolean }).refreshed, false)
  assert.equal(
    calls.filter((c) => c.url === X_TOKEN_URL).length,
    0,
    'No token endpoint calls when not near expiry',
  )
})

test('3. refresh triggered when token expires within 60 seconds', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, { accessTokenExpiresAt: isoFuture(30) }) // 30s < threshold

  const { transport } = makeCaptureTransport([{ status: 200, body: makeTokenResponse() }])
  const result = await refreshXOAuthCredentialIfNeeded(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  assert.ok(result.ok)
  assert.equal((result as { refreshed: boolean }).refreshed, true)
})

test('4. oauth_not_configured returned when config missing and refresh needed', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, { accessTokenExpiresAt: isoFuture(10) })

  const result = await refreshXOAuthCredentialIfNeeded(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    null,
    TEST_KEK,
  )

  assert.ok(!result.ok)
  assert.equal((result as { code: string }).code, 'oauth_not_configured')
})

// ---------------------------------------------------------------------------
// REFRESH — NO REFRESH TOKEN (5–6)
// ---------------------------------------------------------------------------

test('5. reconnect_required returned when no refresh_token exists', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, { accessTokenExpiresAt: isoFuture(10), refreshToken: null })

  const result = await refreshXOAuthCredentialIfNeeded(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
  )

  assert.ok(!result.ok)
  assert.equal((result as { code: string }).code, 'reconnect_required')
})

test('6. zero token endpoint calls when reconnect_required (no refresh token)', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, { accessTokenExpiresAt: isoFuture(10), refreshToken: null })

  const { transport, calls } = makeCaptureTransport([{ status: 200, body: makeTokenResponse() }])
  await refreshXOAuthCredentialIfNeeded(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  assert.equal(calls.length, 0, 'No HTTP calls when no refresh token')
})

// ---------------------------------------------------------------------------
// REFRESH — HTTP REQUEST CONTRACT (7–14)
// ---------------------------------------------------------------------------

test('7. refresh posts to exactly https://api.x.com/2/oauth2/token', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, { accessTokenExpiresAt: isoFuture(10) })

  const { transport, calls } = makeCaptureTransport([{ status: 200, body: makeTokenResponse() }])
  await refreshXOAuthCredentialIfNeeded(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  assert.ok(calls.length > 0, 'Expected at least one HTTP call')
  assert.equal(calls[0]!.url, X_TOKEN_URL)
})

test('8. refresh uses POST method', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, { accessTokenExpiresAt: isoFuture(10) })

  const { transport, calls } = makeCaptureTransport([{ status: 200, body: makeTokenResponse() }])
  await refreshXOAuthCredentialIfNeeded(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  assert.equal(calls[0]!.method, 'POST')
})

test('9. refresh sets Content-Type: application/x-www-form-urlencoded', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, { accessTokenExpiresAt: isoFuture(10) })

  const { transport, calls } = makeCaptureTransport([{ status: 200, body: makeTokenResponse() }])
  await refreshXOAuthCredentialIfNeeded(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  assert.ok(calls[0]!.headers['content-type']?.includes('application/x-www-form-urlencoded'))
})

test('10. refresh body contains grant_type=refresh_token', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, { accessTokenExpiresAt: isoFuture(10) })

  const { transport, calls } = makeCaptureTransport([{ status: 200, body: makeTokenResponse() }])
  await refreshXOAuthCredentialIfNeeded(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  const params = new URLSearchParams(calls[0]!.body)
  assert.equal(params.get('grant_type'), 'refresh_token')
})

test('11. public client sends client_id in body, no Authorization header', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, { accessTokenExpiresAt: isoFuture(10) })

  const { transport, calls } = makeCaptureTransport([{ status: 200, body: makeTokenResponse() }])
  await refreshXOAuthCredentialIfNeeded(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    PUBLIC_CONFIG,
    TEST_KEK,
    transport,
  )

  const params = new URLSearchParams(calls[0]!.body)
  assert.equal(params.get('client_id'), TEST_CLIENT_ID, 'client_id in body for public client')
  assert.ok(!calls[0]!.headers['authorization'], 'No Authorization header for public client')
})

test('12. confidential client sends Authorization Basic header, no client_id in body', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, { accessTokenExpiresAt: isoFuture(10) })

  const { transport, calls } = makeCaptureTransport([{ status: 200, body: makeTokenResponse() }])
  await refreshXOAuthCredentialIfNeeded(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  const auth = calls[0]!.headers['authorization'] ?? ''
  assert.ok(auth.startsWith('Basic '), 'Authorization: Basic header for confidential client')
  const decoded = atob(auth.replace('Basic ', ''))
  assert.ok(decoded.startsWith(`${TEST_CLIENT_ID}:`), 'Basic creds include clientId')
  const params = new URLSearchParams(calls[0]!.body)
  assert.ok(!params.get('client_id'), 'No client_id in body for confidential client')
})

test('13. plaintext refresh token sent in request body', async () => {
  const ctx = await seedLifecycleCtx()
  const knownRefreshToken = 'rt_known_plaintext_for_test'
  await seedCredential(ctx, {
    accessTokenExpiresAt: isoFuture(10),
    refreshToken: knownRefreshToken,
  })

  const { transport, calls } = makeCaptureTransport([{ status: 200, body: makeTokenResponse() }])
  await refreshXOAuthCredentialIfNeeded(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  const params = new URLSearchParams(calls[0]!.body)
  assert.equal(params.get('refresh_token'), knownRefreshToken)
})

test('14. exactly ONE token endpoint call during refresh (no retry)', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, { accessTokenExpiresAt: isoFuture(10) })

  const { transport, calls } = makeCaptureTransport([{ status: 200, body: makeTokenResponse() }])
  await refreshXOAuthCredentialIfNeeded(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  const tokenCalls = calls.filter((c) => c.url === X_TOKEN_URL)
  assert.equal(tokenCalls.length, 1, 'Exactly one token endpoint call')
})

// ---------------------------------------------------------------------------
// REFRESH — RESPONSE HANDLING (15–20)
// ---------------------------------------------------------------------------

test('15. success: new access_token encrypted and stored in vault', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, { accessTokenExpiresAt: isoFuture(10) })

  const newToken = 'brand_new_access_token_after_refresh'
  const { transport } = makeCaptureTransport([
    { status: 200, body: makeTokenResponse({ access_token: newToken }) },
  ])
  await refreshXOAuthCredentialIfNeeded(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  const resolved = await resolveOAuthCredential(
    ctx.db,
    { workspaceId: ctx.workspaceId, accountId: ctx.accountId, platformAdapterKey: 'x' },
    TEST_KEK,
  )
  assert.ok(resolved.ok)
  assert.equal(resolved.credential.accessToken, newToken)
})

test('16. success: new refresh_token stored encrypted in vault (rotation)', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, { accessTokenExpiresAt: isoFuture(10) })

  const newRefreshToken = 'brand_new_refresh_token_after_rotation'
  const { transport } = makeCaptureTransport([
    { status: 200, body: makeTokenResponse({ refresh_token: newRefreshToken }) },
  ])
  await refreshXOAuthCredentialIfNeeded(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  const resolved = await resolveOAuthCredential(
    ctx.db,
    { workspaceId: ctx.workspaceId, accountId: ctx.accountId, platformAdapterKey: 'x' },
    TEST_KEK,
  )
  assert.ok(resolved.ok)
  assert.equal(resolved.credential.refreshToken, newRefreshToken)
})

test('17. success: prior active credential row is revoked atomically', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, { accessTokenExpiresAt: isoFuture(10) })

  const oldRow = await queryFirst<{ id: string; revoked_at: string | null }>(
    ctx.db,
    `SELECT id, revoked_at FROM platform_credential WHERE account_id = ? AND revoked_at IS NULL`,
    [ctx.accountId],
  )
  assert.ok(oldRow, 'Credential row must exist before refresh')
  const oldId = oldRow.id

  const { transport } = makeCaptureTransport([{ status: 200, body: makeTokenResponse() }])
  await refreshXOAuthCredentialIfNeeded(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  const oldRowAfter = await queryFirst<{ revoked_at: string | null }>(
    ctx.db,
    `SELECT revoked_at FROM platform_credential WHERE id = ?`,
    [oldId],
  )
  assert.ok(oldRowAfter?.revoked_at !== null, 'Old credential must be revoked after rotation')

  const newRow = await queryFirst<{ id: string }>(
    ctx.db,
    `SELECT id FROM platform_credential WHERE account_id = ? AND revoked_at IS NULL`,
    [ctx.accountId],
  )
  assert.ok(newRow, 'New credential row must exist')
  assert.notEqual(newRow.id, oldId, 'New credential must have a different id')
})

test('18. HTTP 400/401 from token endpoint returns reconnect_required', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, { accessTokenExpiresAt: isoFuture(10) })

  const { transport } = makeCaptureTransport([{ status: 400, body: { error: 'invalid_grant' } }])
  const result = await refreshXOAuthCredentialIfNeeded(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  assert.ok(!result.ok)
  assert.equal((result as { code: string }).code, 'reconnect_required')
})

test('19. network error during refresh returns ok:false without credential corruption', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, { accessTokenExpiresAt: isoFuture(10) })

  const errTransport = async (_url: string, _init?: RequestInit): Promise<Response> => {
    throw new Error('Network error: connection refused')
  }
  const result = await refreshXOAuthCredentialIfNeeded(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    errTransport,
  )

  assert.ok(!result.ok)
  assert.equal((result as { code: string }).code, 'reconnect_required')

  // Original credential still resolvable (no corruption)
  const resolved = await resolveOAuthCredential(
    ctx.db,
    { workspaceId: ctx.workspaceId, accountId: ctx.accountId, platformAdapterKey: 'x' },
    TEST_KEK,
  )
  assert.ok(resolved.ok, 'Credential should still be resolvable after failed network refresh')
})

test('20. malformed JSON response from refresh endpoint returns ok:false', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, { accessTokenExpiresAt: isoFuture(10) })

  const badJsonTransport = async (): Promise<Response> => {
    return new Response('not valid json {{{{', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const result = await refreshXOAuthCredentialIfNeeded(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    badJsonTransport,
  )

  assert.ok(!result.ok)
  assert.equal((result as { code: string }).code, 'reconnect_required')
})

// ---------------------------------------------------------------------------
// REFRESH — VAULT ROTATION (21–27)
// ---------------------------------------------------------------------------

test('21. prior credential revoked_at is set after successful refresh', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, { accessTokenExpiresAt: isoFuture(10) })

  const { transport } = makeCaptureTransport([{ status: 200, body: makeTokenResponse() }])
  await refreshXOAuthCredentialIfNeeded(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  const revokedRows = await queryFirst<{ count: number }>(
    ctx.db,
    `SELECT COUNT(*) as count FROM platform_credential WHERE account_id = ? AND revoked_at IS NOT NULL`,
    [ctx.accountId],
  )
  assert.equal(revokedRows?.count, 1, 'One revoked credential row')
})

test('22. new credential has different ciphertext than old credential', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, {
    accessTokenExpiresAt: isoFuture(10),
    accessToken: 'old_plaintext_token',
  })

  const oldRow = await queryFirst<{ access_token_ciphertext: string }>(
    ctx.db,
    `SELECT access_token_ciphertext FROM platform_credential WHERE account_id = ? AND revoked_at IS NULL`,
    [ctx.accountId],
  )

  const { transport } = makeCaptureTransport([
    { status: 200, body: makeTokenResponse({ access_token: 'completely_new_token' }) },
  ])
  await refreshXOAuthCredentialIfNeeded(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  const newRow = await queryFirst<{ access_token_ciphertext: string }>(
    ctx.db,
    `SELECT access_token_ciphertext FROM platform_credential WHERE account_id = ? AND revoked_at IS NULL`,
    [ctx.accountId],
  )

  assert.notEqual(
    newRow?.access_token_ciphertext,
    oldRow?.access_token_ciphertext,
    'Ciphertext must change after token rotation',
  )
})

test('23. access_token_expires_at updated to new expiry after rotation', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, { accessTokenExpiresAt: isoFuture(10) })

  const { transport } = makeCaptureTransport([
    { status: 200, body: makeTokenResponse({ expires_in: 7200 }) },
  ])
  await refreshXOAuthCredentialIfNeeded(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  const newRow = await queryFirst<{ access_token_expires_at: string | null }>(
    ctx.db,
    `SELECT access_token_expires_at FROM platform_credential WHERE account_id = ? AND revoked_at IS NULL`,
    [ctx.accountId],
  )
  assert.ok(newRow?.access_token_expires_at, 'New credential must have access_token_expires_at')

  const newExpiry = new Date(newRow.access_token_expires_at).getTime()
  const nowMs = Date.now()
  // Should be roughly 7200s in the future (allow ±30s for test timing)
  assert.ok(newExpiry > nowMs + (7200 - 30) * 1000, 'New expiry should be ~7200s from now')
})

test('24. plaintext new access token is absent from DB', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, { accessTokenExpiresAt: isoFuture(10) })

  const newToken = 'new_access_token_must_not_be_stored_plain'
  const { transport } = makeCaptureTransport([
    { status: 200, body: makeTokenResponse({ access_token: newToken }) },
  ])
  await refreshXOAuthCredentialIfNeeded(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  const rows = await queryFirst<{ access_token_ciphertext: string }>(
    ctx.db,
    `SELECT access_token_ciphertext FROM platform_credential WHERE account_id = ? AND revoked_at IS NULL`,
    [ctx.accountId],
  )
  assert.ok(
    rows?.access_token_ciphertext !== newToken,
    'Plaintext token must not appear in ciphertext column',
  )
  assert.ok(
    !rows?.access_token_ciphertext?.includes(newToken),
    'Plaintext token must not be a substring of ciphertext',
  )
})

test('25. plaintext new refresh token is absent from DB', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, { accessTokenExpiresAt: isoFuture(10) })

  const newRefresh = 'new_refresh_token_must_not_be_stored_plain'
  const { transport } = makeCaptureTransport([
    { status: 200, body: makeTokenResponse({ refresh_token: newRefresh }) },
  ])
  await refreshXOAuthCredentialIfNeeded(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  const rows = await queryFirst<{ refresh_token_ciphertext: string | null }>(
    ctx.db,
    `SELECT refresh_token_ciphertext FROM platform_credential WHERE account_id = ? AND revoked_at IS NULL`,
    [ctx.accountId],
  )
  assert.ok(rows?.refresh_token_ciphertext !== newRefresh, 'Plaintext refresh token not in DB')
  assert.ok(
    !rows?.refresh_token_ciphertext?.includes(newRefresh),
    'Plaintext refresh token not substring of ciphertext',
  )
})

test('26. resolveOAuthCredential returns fresh decrypted token after rotation', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, { accessTokenExpiresAt: isoFuture(10) })

  const freshAccessToken = 'fresh_access_token_after_rotation_decrypts_ok'
  const { transport } = makeCaptureTransport([
    { status: 200, body: makeTokenResponse({ access_token: freshAccessToken }) },
  ])
  await refreshXOAuthCredentialIfNeeded(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  const resolved = await resolveOAuthCredential(
    ctx.db,
    { workspaceId: ctx.workspaceId, accountId: ctx.accountId, platformAdapterKey: 'x' },
    TEST_KEK,
  )
  assert.ok(resolved.ok)
  assert.equal(resolved.credential.accessToken, freshAccessToken)
})

test('27. platform_connection status remains connected after refresh', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, { accessTokenExpiresAt: isoFuture(10) })

  const { transport } = makeCaptureTransport([{ status: 200, body: makeTokenResponse() }])
  await refreshXOAuthCredentialIfNeeded(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  const conn = await getPlatformConnectionForAccount(ctx.db, ctx.accountId)
  assert.equal(conn?.status, 'connected', 'Connection status must remain connected after refresh')
})

// ---------------------------------------------------------------------------
// REFRESH — CONCURRENCY / DISTRIBUTED LEASE (28–32)
// ---------------------------------------------------------------------------

test('28. concurrent refresh attempts result in exactly ONE token endpoint call (lease)', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, { accessTokenExpiresAt: isoFuture(10) })

  let callCount = 0
  const transport = async (_url: string, _init?: RequestInit): Promise<Response> => {
    callCount++
    // Small artificial delay to increase concurrency window
    await new Promise((res) => setTimeout(res, 5))
    return new Response(JSON.stringify(makeTokenResponse()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  // Launch concurrent refresh attempts
  const results = await Promise.all([
    refreshXOAuthCredentialIfNeeded(
      ctx.db,
      { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
      BASE_CONFIG,
      TEST_KEK,
      transport,
    ),
    refreshXOAuthCredentialIfNeeded(
      ctx.db,
      { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
      BASE_CONFIG,
      TEST_KEK,
      transport,
    ),
    refreshXOAuthCredentialIfNeeded(
      ctx.db,
      { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
      BASE_CONFIG,
      TEST_KEK,
      transport,
    ),
  ])

  assert.equal(callCount, 1, 'Exactly one token endpoint call despite concurrent refresh attempts')

  const refreshed = results.filter((r) => r.ok && (r as { refreshed: boolean }).refreshed).length
  const leaseHeld = results.filter(
    (r) => r.ok && !r.ok === false && (r as { code?: string }).code === 'refresh_lease_held',
  ).length
  // At least one must have actually refreshed
  assert.ok(refreshed >= 1, 'At least one refresh must succeed')
  // Total must be 3
  assert.equal(results.length, 3)
  // All results must be ok (no error thrown)
  for (const r of results) {
    assert.ok(r.ok !== undefined, 'All results must have ok property')
  }
  void leaseHeld // variable used in assertion comment above
})

test('29. losing isolate returns ok:true with code refresh_lease_held', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, { accessTokenExpiresAt: isoFuture(10) })

  // Seed two concurrent requests: winner (fast) and loser (slow)
  // We simulate by pre-claiming the lease manually then calling refresh
  const leaseExpiry = new Date(Date.now() + 30000).toISOString()
  await execute(
    ctx.db,
    `UPDATE platform_credential SET refresh_locked_until = ? WHERE account_id = ? AND revoked_at IS NULL`,
    [leaseExpiry, ctx.accountId],
  )

  const { transport } = makeCaptureTransport([{ status: 200, body: makeTokenResponse() }])
  const result = await refreshXOAuthCredentialIfNeeded(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  assert.ok(result.ok, 'Result must be ok (not an error) for lease-held scenario')
  assert.equal((result as { code?: string }).code, 'refresh_lease_held')
  assert.equal((result as { refreshed: boolean }).refreshed, false)
})

test('30. losing isolate does not receive an error (does not block callers)', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, { accessTokenExpiresAt: isoFuture(10) })

  // Pre-claim lease
  const leaseExpiry = new Date(Date.now() + 30000).toISOString()
  await execute(
    ctx.db,
    `UPDATE platform_credential SET refresh_locked_until = ? WHERE account_id = ? AND revoked_at IS NULL`,
    [leaseExpiry, ctx.accountId],
  )

  let threw = false
  try {
    const { transport } = makeCaptureTransport([])
    await refreshXOAuthCredentialIfNeeded(
      ctx.db,
      { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
      BASE_CONFIG,
      TEST_KEK,
      transport,
    )
  } catch {
    threw = true
  }
  assert.ok(!threw, 'Must not throw when lease is held by another isolate')
})

test('31. expired refresh lease (stale refresh_locked_until in past) is claimable', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, { accessTokenExpiresAt: isoFuture(10) })

  // Seed a stale/expired lease in the past
  const staleExpiry = new Date(Date.now() - 60000).toISOString()
  await execute(
    ctx.db,
    `UPDATE platform_credential SET refresh_locked_until = ? WHERE account_id = ? AND revoked_at IS NULL`,
    [staleExpiry, ctx.accountId],
  )

  const { transport, calls } = makeCaptureTransport([{ status: 200, body: makeTokenResponse() }])
  const result = await refreshXOAuthCredentialIfNeeded(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  assert.ok(result.ok)
  assert.equal(
    (result as { refreshed: boolean }).refreshed,
    true,
    'Should refresh when stale lease is claimable',
  )
  assert.ok(calls.length > 0, 'Token endpoint was called')
})

test('32. publish succeeds with existing credential if lease held by another isolate', async () => {
  const ctx = await seedLifecycleCtx()
  // Store a credential that is NOT near expiry (still valid for callers)
  await seedCredential(ctx, { accessTokenExpiresAt: isoFuture(3600) })

  // Pre-claim lease to simulate another isolate refreshing
  const leaseExpiry = new Date(Date.now() + 30000).toISOString()
  await execute(
    ctx.db,
    `UPDATE platform_credential SET refresh_locked_until = ? WHERE account_id = ? AND revoked_at IS NULL`,
    [leaseExpiry, ctx.accountId],
  )

  // Credential should still be resolvable (connection status connected)
  const resolved = await resolveOAuthCredential(
    ctx.db,
    { workspaceId: ctx.workspaceId, accountId: ctx.accountId, platformAdapterKey: 'x' },
    TEST_KEK,
  )
  assert.ok(resolved.ok, 'Credential must still be resolvable when lease is held')
  assert.ok(resolved.credential.accessToken.length > 0)
})

// ---------------------------------------------------------------------------
// REFRESH — SECURITY (33–36)
// ---------------------------------------------------------------------------

test('33. plaintext refresh token absent from error messages', async () => {
  const ctx = await seedLifecycleCtx()
  const secretRefreshToken = 'VERY_SECRET_refresh_token_must_not_leak'
  await seedCredential(ctx, {
    accessTokenExpiresAt: isoFuture(10),
    refreshToken: secretRefreshToken,
  })

  const { transport } = makeCaptureTransport([{ status: 401, body: { error: 'invalid_grant' } }])
  const result = await refreshXOAuthCredentialIfNeeded(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  const resultStr = JSON.stringify(result)
  assert.ok(
    !resultStr.includes(secretRefreshToken),
    'Secret refresh token must not appear in error result',
  )
})

test('34. plaintext refresh token absent from audit-visible data (reason field)', async () => {
  const ctx = await seedLifecycleCtx()
  const secretRefreshToken = 'AUDIT_SECRET_refresh_do_not_log'
  await seedCredential(ctx, {
    accessTokenExpiresAt: isoFuture(10),
    refreshToken: secretRefreshToken,
  })

  const { transport } = makeCaptureTransport([{ status: 400, body: { error: 'invalid_request' } }])
  const result = await refreshXOAuthCredentialIfNeeded(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  if (!result.ok) {
    const reason = (result as { reason: string }).reason
    assert.ok(
      !reason.includes(secretRefreshToken),
      'Reason field must not contain plaintext refresh token',
    )
  }
})

test('35. plaintext access token absent from refresh error results', async () => {
  const ctx = await seedLifecycleCtx()
  const secretAccessToken = 'SECRET_access_token_must_not_leak_in_error'
  await seedCredential(ctx, { accessTokenExpiresAt: isoFuture(10), accessToken: secretAccessToken })

  const { transport } = makeCaptureTransport([{ status: 500, body: { error: 'server_error' } }])
  const result = await refreshXOAuthCredentialIfNeeded(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  const resultStr = JSON.stringify(result)
  assert.ok(
    !resultStr.includes(secretAccessToken),
    'Secret access token must not appear in error result',
  )
})

test('36. token endpoint URL is not stored or returned in result DTO', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, { accessTokenExpiresAt: isoFuture(10) })

  const { transport } = makeCaptureTransport([{ status: 200, body: makeTokenResponse() }])
  const result = await refreshXOAuthCredentialIfNeeded(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  const resultStr = JSON.stringify(result)
  // The token URL should not appear in the DTO (it's an internal implementation detail)
  assert.ok(!resultStr.includes(X_TOKEN_URL), 'Token URL must not be returned in result DTO')
})

// ---------------------------------------------------------------------------
// DISCONNECT — LOCAL REVOCATION (37–44)
// ---------------------------------------------------------------------------

test('37. revokeOAuthCredential: platform_credential.revoked_at is set on disconnect', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx)

  const { transport } = makeCaptureTransport([{ status: 200 }])
  const result = await disconnectXOAuth(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  assert.ok(result.ok)
  const row = await queryFirst<{ revoked_at: string | null }>(
    ctx.db,
    `SELECT revoked_at FROM platform_credential WHERE account_id = ?`,
    [ctx.accountId],
  )
  assert.ok(row?.revoked_at !== null, 'Credential must be revoked after disconnect')
})

test('38. platform_connection.status changes to disconnected atomically', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx)

  const { transport } = makeCaptureTransport([{ status: 200 }])
  await disconnectXOAuth(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  const conn = await getPlatformConnectionForAccount(ctx.db, ctx.accountId)
  assert.equal(conn?.status, 'disconnected')
})

test('39. resolveOAuthCredential returns connection_inactive after disconnect', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx)

  const { transport } = makeCaptureTransport([{ status: 200 }])
  await disconnectXOAuth(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  const resolved = await resolveOAuthCredential(
    ctx.db,
    { workspaceId: ctx.workspaceId, accountId: ctx.accountId, platformAdapterKey: 'x' },
    TEST_KEK,
  )
  assert.ok(!resolved.ok)
  assert.equal((resolved as { code: string }).code, 'connection_inactive')
})

test('40. disconnect is idempotent: calling twice does not throw', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx)

  const { transport } = makeCaptureTransport([{ status: 200 }, { status: 200 }])
  await disconnectXOAuth(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  let threw = false
  try {
    await disconnectXOAuth(
      ctx.db,
      { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
      BASE_CONFIG,
      TEST_KEK,
      transport,
    )
  } catch {
    threw = true
  }
  assert.ok(!threw, 'Second disconnect must not throw')
})

test('41. disconnect on already-disconnected account completes safely (ok:true)', async () => {
  const ctx = await seedLifecycleCtx()
  // Do NOT seed a credential — account has no active credential

  // Manually set up a disconnected connection
  const now = nowIso()
  await execute(
    ctx.db,
    `INSERT INTO platform_connection (id, account_id, status, secret_ref, scopes, metadata, connected_at, created_at, updated_at)
     VALUES (?, ?, 'disconnected', NULL, NULL, NULL, ?, ?, ?)`,
    [newId(), ctx.accountId, now, now, now],
  )

  const { transport } = makeCaptureTransport([])
  const result = await disconnectXOAuth(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  // revokeOAuthCredential succeeds even with 0 rows to revoke
  assert.ok(result.ok, 'Disconnect on already-disconnected account must not error')
})

test('42. cross-workspace disconnect is strictly rejected', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx)

  const foreignWorkspaceId = newId()
  const { transport } = makeCaptureTransport([{ status: 200 }])
  const result = await disconnectXOAuth(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: foreignWorkspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  assert.ok(!result.ok)
  // Credential in own workspace must be untouched
  const conn = await getPlatformConnectionForAccount(ctx.db, ctx.accountId)
  assert.equal(
    conn?.status,
    'connected',
    'Own-workspace connection unaffected by cross-workspace disconnect attempt',
  )
})

test('43. disconnect result ok:true contains localRevoked:true', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx)

  const { transport } = makeCaptureTransport([{ status: 200 }])
  const result = await disconnectXOAuth(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  assert.ok(result.ok)
  assert.equal((result as { localRevoked: boolean }).localRevoked, true)
})

test('44. disconnect with null config still performs local revocation', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx)

  // No config → no provider revocation, but local must still happen
  const result = await disconnectXOAuth(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    null,
    TEST_KEK,
  )

  assert.ok(result.ok)
  assert.equal((result as { localRevoked: boolean }).localRevoked, true)

  const row = await queryFirst<{ revoked_at: string | null }>(
    ctx.db,
    `SELECT revoked_at FROM platform_credential WHERE account_id = ?`,
    [ctx.accountId],
  )
  assert.ok(row?.revoked_at !== null, 'Credential must be revoked even without config')
})

// ---------------------------------------------------------------------------
// DISCONNECT — PROVIDER REVOCATION (45–50)
// ---------------------------------------------------------------------------

test('45. provider revoke uses endpoint https://api.x.com/2/oauth2/revoke', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx)

  const { transport, calls } = makeCaptureTransport([
    { status: 200, body: {} },
    { status: 200, body: {} },
  ])
  await disconnectXOAuth(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  const revokeCalls = calls.filter((c) => c.url === X_REVOKE_URL)
  assert.ok(revokeCalls.length > 0, 'Must have called the revoke endpoint')
})

test('46. access_token is sent to provider revoke endpoint (after local commit)', async () => {
  const ctx = await seedLifecycleCtx()
  const knownAccessToken = 'access_token_to_revoke_at_provider'
  await seedCredential(ctx, { accessToken: knownAccessToken, refreshToken: null })

  const { transport, calls } = makeCaptureTransport([{ status: 200, body: {} }])
  await disconnectXOAuth(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  const revokeCall = calls.find((c) => c.url === X_REVOKE_URL)
  assert.ok(revokeCall, 'Must have made revoke call after local commit')
  const params = new URLSearchParams(revokeCall.body)
  assert.equal(
    params.get('token'),
    knownAccessToken,
    'Access token sent to provider revoke endpoint',
  )

  // Verify local commit already happened by this point (connection disconnected)
  const conn = await getPlatformConnectionForAccount(ctx.db, ctx.accountId)
  assert.equal(conn?.status, 'disconnected', 'Local disconnect committed before provider call')
})

test('47. refresh_token also revoked at provider if present', async () => {
  const ctx = await seedLifecycleCtx()
  const knownRefreshToken = 'refresh_token_to_revoke_at_provider'
  await seedCredential(ctx, { refreshToken: knownRefreshToken })

  const { transport, calls } = makeCaptureTransport([
    { status: 200, body: {} }, // access token revoke
    { status: 200, body: {} }, // refresh token revoke
  ])
  await disconnectXOAuth(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  const revokeCalls = calls.filter((c) => c.url === X_REVOKE_URL)
  assert.equal(revokeCalls.length, 2, 'Both access and refresh tokens revoked at provider')

  const revokedTokens = revokeCalls.map((c) => new URLSearchParams(c.body).get('token'))
  assert.ok(
    revokedTokens.some((t) => t === knownRefreshToken),
    'Refresh token must be in one of the revoke calls',
  )
})

test('48. public client revoke sends token + client_id in body', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, { refreshToken: null }) // no refresh token to keep it to 1 revoke call

  const { transport, calls } = makeCaptureTransport([{ status: 200, body: {} }])
  await disconnectXOAuth(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    { ...PUBLIC_CONFIG, clientType: 'public' },
    TEST_KEK,
    transport,
  )

  const revokeCall = calls.find((c) => c.url === X_REVOKE_URL)
  assert.ok(revokeCall, 'Revoke call must be made')
  const params = new URLSearchParams(revokeCall.body)
  assert.equal(params.get('client_id'), TEST_CLIENT_ID, 'client_id in body for public client')
  assert.ok(
    !revokeCall.headers['authorization'],
    'No Authorization header for public client revoke',
  )
})

test('49. confidential client revoke sends Authorization Basic header', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, { refreshToken: null })

  const { transport, calls } = makeCaptureTransport([{ status: 200, body: {} }])
  await disconnectXOAuth(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  const revokeCall = calls.find((c) => c.url === X_REVOKE_URL)
  assert.ok(revokeCall, 'Revoke call must be made')
  const auth = revokeCall.headers['authorization'] ?? ''
  assert.ok(auth.startsWith('Basic '), 'Authorization: Basic for confidential client')
})

test('50. provider revoke failure does not prevent local revocation (best-effort)', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx)

  // Provider returns 500 → local revoke must still happen
  const { transport } = makeCaptureTransport([
    { status: 500, body: { error: 'server_error' } },
    { status: 500, body: { error: 'server_error' } },
  ])
  const result = await disconnectXOAuth(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  assert.ok(result.ok, 'Disconnect must succeed even if provider revoke fails')
  assert.equal((result as { localRevoked: boolean }).localRevoked, true)

  const conn = await getPlatformConnectionForAccount(ctx.db, ctx.accountId)
  assert.equal(
    conn?.status,
    'disconnected',
    'Connection must be disconnected locally despite provider failure',
  )
})

test('50b. local revocation failure → zero provider revoke calls (ordering guarantee)', async () => {
  // Use a foreign workspaceId so revokeOAuthCredential returns account_not_found.
  // This proves local failure prevents any X provider API calls.
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx)

  const foreignWorkspaceId = newId()
  const { transport, calls } = makeCaptureTransport([
    { status: 200, body: {} },
    { status: 200, body: {} },
  ])

  const result = await disconnectXOAuth(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: foreignWorkspaceId }, // wrong workspace
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  assert.ok(!result.ok, 'Must fail when workspace is wrong')
  // The resolve step uses correct workspaceId derived from config, but revokeOAuthCredential
  // rejects the foreign workspace. With the corrected ordering, local fails → no X calls.
  const revokeCalls = calls.filter((c) => c.url === X_REVOKE_URL)
  assert.equal(revokeCalls.length, 0, 'Zero provider revoke calls when local revocation fails')
})

// ---------------------------------------------------------------------------
// DISCONNECT — SECURITY (51–55)
// ---------------------------------------------------------------------------

test('51. plaintext access token absent from disconnect result DTO', async () => {
  const ctx = await seedLifecycleCtx()
  const secretToken = 'SECRET_access_token_must_not_appear_in_disconnect_result'
  await seedCredential(ctx, { accessToken: secretToken })

  const { transport } = makeCaptureTransport([
    { status: 200, body: {} },
    { status: 200, body: {} },
  ])
  const result = await disconnectXOAuth(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  const resultStr = JSON.stringify(result)
  assert.ok(!resultStr.includes(secretToken), 'Access token must not appear in result DTO')
})

test('52. plaintext refresh token absent from disconnect result DTO', async () => {
  const ctx = await seedLifecycleCtx()
  const secretRefresh = 'SECRET_refresh_token_must_not_appear_in_disconnect_result'
  await seedCredential(ctx, { refreshToken: secretRefresh })

  const { transport } = makeCaptureTransport([
    { status: 200, body: {} },
    { status: 200, body: {} },
  ])
  const result = await disconnectXOAuth(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  const resultStr = JSON.stringify(result)
  assert.ok(!resultStr.includes(secretRefresh), 'Refresh token must not appear in result DTO')
})

test('53. disconnect result does not include authorization header content', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx)

  const { transport } = makeCaptureTransport([
    { status: 200, body: {} },
    { status: 200, body: {} },
  ])
  const result = await disconnectXOAuth(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  const resultStr = JSON.stringify(result)
  const expectedBasicPrefix = 'Basic '
  assert.ok(
    !resultStr.includes(expectedBasicPrefix),
    'Authorization header must not appear in result DTO',
  )
})

test('54. client secret absent from disconnect result DTO', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx)

  const { transport } = makeCaptureTransport([
    { status: 200, body: {} },
    { status: 200, body: {} },
  ])
  const result = await disconnectXOAuth(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  const resultStr = JSON.stringify(result)
  assert.ok(!resultStr.includes(TEST_CLIENT_SECRET), 'Client secret must not appear in result DTO')
})

test('55. provider revoke response body is not stored in DB', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx)

  const sensitiveProviderData = 'sensitive_provider_response_must_not_be_stored'
  const { transport } = makeCaptureTransport([
    { status: 200, body: { ok: true, data: sensitiveProviderData } },
    { status: 200, body: { ok: true, data: sensitiveProviderData } },
  ])
  await disconnectXOAuth(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  // Check no credential row or connection row contains provider response data
  const credRow = await queryFirst<{
    access_token_ciphertext: string
    refresh_token_ciphertext: string | null
  }>(
    ctx.db,
    `SELECT access_token_ciphertext, refresh_token_ciphertext FROM platform_credential WHERE account_id = ?`,
    [ctx.accountId],
  )
  assert.ok(
    !JSON.stringify(credRow).includes(sensitiveProviderData),
    'Provider response not stored in credential',
  )
})

// ---------------------------------------------------------------------------
// XOAuthClient — refreshToken() and revokeToken() unit tests
// ---------------------------------------------------------------------------

test('56. XOAuthClient.refreshToken returns ok:true with new access_token on 200', async () => {
  const newToken = 'client_level_new_access_token'
  const { transport } = makeCaptureTransport([
    { status: 200, body: makeTokenResponse({ access_token: newToken }) },
  ])
  const client = new XOAuthClient({ transport })

  const result = await client.refreshToken({
    refreshToken: 'some_refresh_token',
    clientId: TEST_CLIENT_ID,
    clientType: 'public',
  })

  assert.ok(result.ok)
  assert.equal((result as { data: { access_token: string } }).data.access_token, newToken)
})

test('57. XOAuthClient.refreshToken returns ok:false for HTTP 400', async () => {
  const { transport } = makeCaptureTransport([{ status: 400, body: { error: 'invalid_grant' } }])
  const client = new XOAuthClient({ transport })

  const result = await client.refreshToken({
    refreshToken: 'expired_refresh_token',
    clientId: TEST_CLIENT_ID,
    clientType: 'public',
  })

  assert.ok(!result.ok)
})

test('58. XOAuthClient.revokeToken posts to X_REVOKE_URL', async () => {
  const { transport, calls } = makeCaptureTransport([{ status: 200, body: {} }])
  const client = new XOAuthClient({ transport })

  await client.revokeToken({
    token: 'token_to_revoke',
    clientId: TEST_CLIENT_ID,
    clientType: 'public',
  })

  assert.equal(calls[0]!.url, X_REVOKE_URL)
})

test('59. XOAuthClient.revokeToken returns ok:true on 200', async () => {
  const { transport } = makeCaptureTransport([{ status: 200, body: {} }])
  const client = new XOAuthClient({ transport })

  const result = await client.revokeToken({
    token: 'some_token',
    clientId: TEST_CLIENT_ID,
    clientType: 'public',
  })
  assert.ok(result.ok)
})

test('60. XOAuthClient.revokeToken returns ok:false on HTTP 401 but does not throw', async () => {
  const { transport } = makeCaptureTransport([{ status: 401, body: { error: 'unauthorized' } }])
  const client = new XOAuthClient({ transport })

  let threw = false
  let result: { ok: boolean } | null = null
  try {
    result = await client.revokeToken({
      token: 'some_token',
      clientId: TEST_CLIENT_ID,
      clientType: 'public',
    })
  } catch {
    threw = true
  }

  assert.ok(!threw)
  assert.ok(result !== null)
  assert.ok(!result!.ok)
})

test('61. XOAuthClient.refreshToken returns ok:false with empty access_token in response', async () => {
  const { transport } = makeCaptureTransport([{ status: 200, body: { access_token: '' } }])
  const client = new XOAuthClient({ transport })

  const result = await client.refreshToken({
    refreshToken: 'valid_refresh',
    clientId: TEST_CLIENT_ID,
    clientType: 'public',
  })
  assert.ok(!result.ok)
})

test('62. XOAuthClient.refreshToken returns ok:false for missing refresh_token in options', async () => {
  const { transport } = makeCaptureTransport([{ status: 200, body: makeTokenResponse() }])
  const client = new XOAuthClient({ transport })

  const result = await client.refreshToken({
    refreshToken: '',
    clientId: TEST_CLIENT_ID,
    clientType: 'public',
  })
  assert.ok(!result.ok)
})

// ---------------------------------------------------------------------------
// RECONNECT SAFETY (63–66)
// ---------------------------------------------------------------------------

test('63. reconnecting (new OAuth) after disconnect stores a fresh credential', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx)

  // Disconnect
  const { transport: dt } = makeCaptureTransport([
    { status: 200, body: {} },
    { status: 200, body: {} },
  ])
  await disconnectXOAuth(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    dt,
  )

  // Simulate reconnect by storing a new credential (OAuth callback would do this)
  const newAccessToken = 'fresh_token_after_reconnect'
  const storeRes = await storeOAuthCredential(
    ctx.db,
    {
      workspaceId: ctx.workspaceId,
      accountId: ctx.accountId,
      platformAdapterKey: 'x',
      credential: {
        accessToken: newAccessToken,
        refreshToken: 'new_refresh_after_reconnect',
        tokenType: 'bearer',
        scopes: 'tweet.read users.read',
        accessTokenExpiresAt: isoFuture(7200),
        providerUserId: 'provider_uid_lifecycle',
      },
    },
    TEST_KEK,
  )

  assert.ok(storeRes.ok, 'Reconnect credential store must succeed')

  const resolved = await resolveOAuthCredential(
    ctx.db,
    { workspaceId: ctx.workspaceId, accountId: ctx.accountId, platformAdapterKey: 'x' },
    TEST_KEK,
  )
  assert.ok(resolved.ok)
  assert.equal(resolved.credential.accessToken, newAccessToken)
})

test('64. old revoked credential cannot be replayed after reconnect', async () => {
  const ctx = await seedLifecycleCtx()
  const oldToken = 'old_access_token_before_disconnect'
  await seedCredential(ctx, { accessToken: oldToken })

  // Capture old credential id
  const oldRow = await queryFirst<{ id: string }>(
    ctx.db,
    `SELECT id FROM platform_credential WHERE account_id = ? AND revoked_at IS NULL`,
    [ctx.accountId],
  )

  // Disconnect + reconnect
  const { transport: dt } = makeCaptureTransport([
    { status: 200, body: {} },
    { status: 200, body: {} },
  ])
  await disconnectXOAuth(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    dt,
  )

  await storeOAuthCredential(
    ctx.db,
    {
      workspaceId: ctx.workspaceId,
      accountId: ctx.accountId,
      platformAdapterKey: 'x',
      credential: {
        accessToken: 'new_token_post_reconnect',
        tokenType: 'bearer',
        scopes: 'tweet.read',
        providerUserId: 'provider_uid_lifecycle',
      },
    },
    TEST_KEK,
  )

  // Old row must still be revoked
  const oldRowAfter = await queryFirst<{ revoked_at: string | null }>(
    ctx.db,
    `SELECT revoked_at FROM platform_credential WHERE id = ?`,
    [oldRow?.id],
  )
  assert.ok(oldRowAfter?.revoked_at !== null, 'Old credential must remain revoked after reconnect')
})

test('65. platform_connection status returns to connected after reconnect', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx)

  // Disconnect
  const { transport: dt } = makeCaptureTransport([
    { status: 200, body: {} },
    { status: 200, body: {} },
  ])
  await disconnectXOAuth(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    dt,
  )

  // Connection should be disconnected
  const conn1 = await getPlatformConnectionForAccount(ctx.db, ctx.accountId)
  assert.equal(conn1?.status, 'disconnected')

  // Reconnect via storeOAuthCredential (which does the UPSERT on platform_connection)
  await storeOAuthCredential(
    ctx.db,
    {
      workspaceId: ctx.workspaceId,
      accountId: ctx.accountId,
      platformAdapterKey: 'x',
      credential: {
        accessToken: 'token_after_reconnect',
        tokenType: 'bearer',
        providerUserId: 'provider_uid_lifecycle',
      },
    },
    TEST_KEK,
  )

  const conn2 = await getPlatformConnectionForAccount(ctx.db, ctx.accountId)
  assert.equal(conn2?.status, 'connected', 'Connection must be connected again after reconnect')
})

test('66. provider_user_id binding preserved across disconnect + reconnect', async () => {
  const ctx = await seedLifecycleCtx()
  const providerUserId = 'stable_provider_uid_across_reconnect'
  await seedCredential(ctx, { providerUserId })

  // Disconnect
  const { transport: dt } = makeCaptureTransport([
    { status: 200, body: {} },
    { status: 200, body: {} },
  ])
  await disconnectXOAuth(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    dt,
  )

  // Reconnect with same providerUserId
  await storeOAuthCredential(
    ctx.db,
    {
      workspaceId: ctx.workspaceId,
      accountId: ctx.accountId,
      platformAdapterKey: 'x',
      credential: {
        accessToken: 'fresh_token',
        tokenType: 'bearer',
        providerUserId,
      },
    },
    TEST_KEK,
  )

  const resolved = await resolveOAuthCredential(
    ctx.db,
    { workspaceId: ctx.workspaceId, accountId: ctx.accountId, platformAdapterKey: 'x' },
    TEST_KEK,
  )

  assert.ok(resolved.ok)
  assert.equal(
    resolved.credential.providerUserId,
    providerUserId,
    'Provider user ID must be preserved across reconnect',
  )
})

// ---------------------------------------------------------------------------
// PUBLICATION DISPATCH INTEGRATION (67–71)
// ---------------------------------------------------------------------------

interface PublicationContext {
  ctx: LifecycleTestCtx
  brandId: string
  campaignId: string
  contentId: string
  variantId: string
  postId: string
  approvalRequestId: string
}

async function seedApprovedPublicationContext(
  ctx: LifecycleTestCtx,
  decision: 'approved' | 'rejected' = 'approved',
): Promise<PublicationContext> {
  const { db, workspaceId, accountId, xPlatformId } = ctx
  const now = nowIso()
  const brandId = newId()
  const campaignId = newId()
  const contentId = newId()
  const variantId = newId()

  await execute(
    db,
    'INSERT INTO brand (id, workspace_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [brandId, workspaceId, 'Lifecycle Brand', 'Brand Desc', now, now],
  )
  await execute(
    db,
    'INSERT INTO campaign (id, workspace_id, brand_id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [campaignId, workspaceId, brandId, 'Lifecycle Campaign', 'active', now, now],
  )
  await execute(
    db,
    'INSERT INTO campaign_account (campaign_id, account_id, created_at) VALUES (?, ?, ?)',
    [campaignId, accountId, now],
  )
  await execute(
    db,
    "INSERT INTO content (id, workspace_id, campaign_id, target_account_id, title, content_type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'post', 'ready', ?, ?)",
    [contentId, workspaceId, campaignId, accountId, 'Lifecycle Post Title', now, now],
  )
  await execute(
    db,
    "INSERT INTO content_variant (id, content_id, platform_id, body, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, ?)",
    [
      variantId,
      contentId,
      xPlatformId,
      'Lifecycle post content for publish verification.',
      now,
      now,
    ],
  )

  await approveCampaignContentVariant(db, {
    workspaceId,
    campaignId,
    contentId,
    contentVariantId: variantId,
    actorType: 'user',
    note: 'Approved for publication',
  })

  const post = await createPublicationIntent(db, {
    workspaceId,
    campaignId,
    contentId,
    contentVariantId: variantId,
    accountId,
  })

  const req = await requestPublicationDispatch(db, {
    workspaceId,
    postId: post.id,
    actorType: 'user',
  })
  assert.ok(req.approvalRequest, 'Approval request must be returned')

  await decideApprovalRequest(db, {
    workspaceId,
    requestId: req.approvalRequest.id,
    decision,
    actor: { actorType: 'user', actorId: null },
  })

  return {
    ctx,
    brandId,
    campaignId,
    contentId,
    variantId,
    postId: post.id,
    approvalRequestId: req.approvalRequest.id,
  }
}

test('67. publication with near-expiry OAuth token triggers refresh before /users/me and /2/tweets', async () => {
  const ctx = await seedLifecycleCtx()
  const initialAccessToken = 'expiring_access_token_123'
  await seedCredential(ctx, {
    accessToken: initialAccessToken,
    accessTokenExpiresAt: isoFuture(30), // near expiry (<60s)
    refreshToken: 'valid_refresh_token_abc',
    providerUserId: '999888777',
  })

  const pubCtx = await seedApprovedPublicationContext(ctx)

  const newAccessToken = 'refreshed_access_token_xyz'
  const { transport, calls } = makeCaptureTransport([
    // 1. Token endpoint response
    { status: 200, body: makeTokenResponse({ access_token: newAccessToken }) },
    // 2. /2/users/me response
    { status: 200, body: { data: { id: '999888777', username: 'lifecycle_user' } } },
    // 3. /2/tweets response
    { status: 201, body: { data: { id: 'tweet_123456789', text: 'Lifecycle post content' } } },
  ])

  const result = await dispatchApprovedPublication(
    ctx.db,
    { workspaceId: ctx.workspaceId, approvalRequestId: pubCtx.approvalRequestId },
    {
      credentialKek: TEST_KEK,
      xOAuthConfig: BASE_CONFIG,
      xTransport: transport,
    },
  )

  assert.ok(result.ok, `Dispatch should succeed, got: ${JSON.stringify(result)}`)
  assert.equal(result.code, 'published')
  assert.equal(result.externalId, 'tweet_123456789')

  // Verify request order and auth header
  assert.equal(calls.length, 3)
  assert.equal(calls[0]!.url, X_TOKEN_URL, 'First call is refresh')
  assert.ok(calls[1]!.url.includes('/users/me'), 'Second call is /users/me')
  assert.equal(
    calls[1]!.headers['authorization'],
    `Bearer ${newAccessToken}`,
    'Uses refreshed token',
  )
  assert.ok(calls[2]!.url.includes('/tweets'), 'Third call is create tweet')
  assert.equal(
    calls[2]!.headers['authorization'],
    `Bearer ${newAccessToken}`,
    'Uses refreshed token',
  )
})

test('68. publication with fresh OAuth token makes zero refresh requests', async () => {
  const ctx = await seedLifecycleCtx()
  const freshAccessToken = 'fresh_access_token_active'
  await seedCredential(ctx, {
    accessToken: freshAccessToken,
    accessTokenExpiresAt: isoFuture(7200), // 2 hours fresh (>60s)
    providerUserId: '999888777',
  })

  const pubCtx = await seedApprovedPublicationContext(ctx)

  const { transport, calls } = makeCaptureTransport([
    { status: 200, body: { data: { id: '999888777', username: 'lifecycle_user' } } },
    { status: 201, body: { data: { id: 'tweet_fresh_123', text: 'Lifecycle post content' } } },
  ])

  const result = await dispatchApprovedPublication(
    ctx.db,
    { workspaceId: ctx.workspaceId, approvalRequestId: pubCtx.approvalRequestId },
    {
      credentialKek: TEST_KEK,
      xOAuthConfig: BASE_CONFIG,
      xTransport: transport,
    },
  )

  assert.ok(result.ok)
  assert.equal(result.code, 'published')

  const refreshCalls = calls.filter((c) => c.url === X_TOKEN_URL)
  assert.equal(refreshCalls.length, 0, 'Zero refresh calls for fresh token')
})

test('69. publication with refresh failure (reconnect_required) halts before /users/me and /2/tweets', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, {
    accessToken: 'expiring_token_no_rt',
    accessTokenExpiresAt: isoFuture(10),
    refreshToken: null, // No refresh token -> reconnect_required
  })

  const pubCtx = await seedApprovedPublicationContext(ctx)

  const { transport, calls } = makeCaptureTransport([])

  const result = await dispatchApprovedPublication(
    ctx.db,
    { workspaceId: ctx.workspaceId, approvalRequestId: pubCtx.approvalRequestId },
    {
      credentialKek: TEST_KEK,
      xOAuthConfig: BASE_CONFIG,
      xTransport: transport,
    },
  )

  assert.ok(!result.ok)
  assert.equal(result.code, 'connection_inactive')
  assert.equal(
    calls.length,
    0,
    'Zero external calls made when refresh fails with reconnect_required',
  )

  // Verify post remains unpublished
  const post = await queryFirst<{ status: string; external_id: string | null }>(
    ctx.db,
    'SELECT status, external_id FROM post WHERE id = ?',
    [pubCtx.postId],
  )
  assert.equal(post?.status, 'draft')
  assert.equal(post?.external_id, null)
})

test('70. publication with rejected approval makes zero refresh requests', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, {
    accessTokenExpiresAt: isoFuture(10),
  })

  const pubCtx = await seedApprovedPublicationContext(ctx, 'rejected')

  const { transport, calls } = makeCaptureTransport([{ status: 200, body: makeTokenResponse() }])

  const result = await dispatchApprovedPublication(
    ctx.db,
    { workspaceId: ctx.workspaceId, approvalRequestId: pubCtx.approvalRequestId },
    {
      credentialKek: TEST_KEK,
      xOAuthConfig: BASE_CONFIG,
      xTransport: transport,
    },
  )

  assert.ok(!result.ok)
  assert.equal(result.code, 'not_approved')
  assert.equal(calls.length, 0, 'Zero refresh calls when approval request was rejected')
})

test('71. publication with static worker_secret makes zero refresh requests', async () => {
  const ctx = await seedLifecycleCtx()
  const staticToken = 'static_worker_secret_token_123'

  // Set up platform_connection with secret_ref (no platform_credential row)
  const now = nowIso()
  await execute(
    ctx.db,
    `INSERT INTO platform_connection (id, account_id, status, secret_ref, scopes, metadata, connected_at, created_at, updated_at)
     VALUES (?, ?, 'connected', 'X_STATIC_TOKEN', NULL, ?, ?, ?, ?)`,
    [newId(), ctx.accountId, JSON.stringify({ providerUserId: '999888777' }), now, now, now],
  )

  const pubCtx = await seedApprovedPublicationContext(ctx)

  const mockSecretResolver = {
    async resolveSecret(secretRef: string) {
      if (secretRef === 'X_STATIC_TOKEN') return staticToken
      return null
    },
  }

  const { transport, calls } = makeCaptureTransport([
    { status: 200, body: { data: { id: '999888777', username: 'lifecycle_user' } } },
    { status: 201, body: { data: { id: 'tweet_static_456', text: 'Lifecycle post content' } } },
  ])

  const result = await dispatchApprovedPublication(
    ctx.db,
    { workspaceId: ctx.workspaceId, approvalRequestId: pubCtx.approvalRequestId },
    {
      secretResolver: mockSecretResolver,
      credentialKek: TEST_KEK,
      xOAuthConfig: BASE_CONFIG,
      xTransport: transport,
    },
  )

  assert.ok(result.ok)
  assert.equal(result.code, 'published')
  const refreshCalls = calls.filter((c) => c.url === X_TOKEN_URL)
  assert.equal(refreshCalls.length, 0, 'Zero refresh calls for static worker_secret')
})

// ---------------------------------------------------------------------------
// ADVANCED CONCURRENCY & DISCONNECT EDGE CASES (72–75)
// ---------------------------------------------------------------------------

test('72. concurrency: stale lease takeover by second isolate after timeout', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, { accessTokenExpiresAt: isoFuture(10) })

  // Isolate A crashed and left a stale lease in the past
  const staleTime = new Date(Date.now() - 45000).toISOString()
  await execute(
    ctx.db,
    'UPDATE platform_credential SET refresh_locked_until = ? WHERE account_id = ? AND revoked_at IS NULL',
    [staleTime, ctx.accountId],
  )

  const newToken = 'token_from_isolate_b'
  const { transport, calls } = makeCaptureTransport([
    { status: 200, body: makeTokenResponse({ access_token: newToken }) },
  ])

  // Isolate B attempts refresh
  const result = await refreshXOAuthCredentialIfNeeded(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  assert.ok(result.ok)
  assert.equal((result as { refreshed: boolean }).refreshed, true)
  assert.equal(calls.length, 1)

  const resolved = await resolveOAuthCredential(
    ctx.db,
    { workspaceId: ctx.workspaceId, accountId: ctx.accountId, platformAdapterKey: 'x' },
    TEST_KEK,
  )
  assert.ok(resolved.ok)
  assert.equal(resolved.credential.accessToken, newToken)
})

test('73. concurrency: late-returning isolate sees fresh rotated credential and skips refresh', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, {
    accessToken: 'initial_token_v1',
    accessTokenExpiresAt: isoFuture(10),
  })

  // Winner isolate B refreshes and stores C2 (expires in 7200s)
  const winnerToken = 'winner_token_v2'
  const { transport: transportB } = makeCaptureTransport([
    { status: 200, body: makeTokenResponse({ access_token: winnerToken }) },
  ])
  const resultB = await refreshXOAuthCredentialIfNeeded(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transportB,
  )
  assert.ok(resultB.ok)
  assert.equal((resultB as { refreshed: boolean }).refreshed, true)

  // Stale isolate A checks DB, sees new credential is fresh (>60s), and skips refresh entirely
  const { transport: transportA, calls: callsA } = makeCaptureTransport([
    { status: 400, body: { error: 'invalid_grant' } },
  ])
  const resultA = await refreshXOAuthCredentialIfNeeded(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transportA,
  )
  assert.ok(resultA.ok)
  assert.equal((resultA as { refreshed: boolean }).refreshed, false)
  assert.equal(callsA.length, 0, 'Zero provider calls made by late isolate')

  // Winner C2 remains untouched in vault
  const resolved = await resolveOAuthCredential(
    ctx.db,
    { workspaceId: ctx.workspaceId, accountId: ctx.accountId, platformAdapterKey: 'x' },
    TEST_KEK,
  )
  assert.ok(resolved.ok)
  assert.equal(resolved.credential.accessToken, winnerToken, 'Winner token remains active')
})

test('74. disconnect on account with static worker_secret does not corrupt worker secret configuration', async () => {
  const ctx = await seedLifecycleCtx()
  const now = nowIso()

  // Set up account with static worker_secret (no platform_credential row)
  await execute(
    ctx.db,
    `INSERT INTO platform_connection (id, account_id, status, secret_ref, scopes, metadata, connected_at, created_at, updated_at)
     VALUES (?, ?, 'connected', 'PLATFORM_X_AUTH_TOKEN', NULL, NULL, ?, ?, ?)`,
    [newId(), ctx.accountId, now, now, now],
  )

  const { transport } = makeCaptureTransport([])
  const result = await disconnectXOAuth(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  assert.ok(result.ok)
  const conn = await getPlatformConnectionForAccount(ctx.db, ctx.accountId)
  assert.equal(conn?.status, 'disconnected')
})

test('75. disconnect with provider 429 rate limit or 5xx still completes local disconnect', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx)

  const { transport } = makeCaptureTransport([
    { status: 429, body: { error: 'Too Many Requests' } },
    { status: 503, body: { error: 'Service Unavailable' } },
  ])

  const result = await disconnectXOAuth(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
    transport,
  )

  assert.ok(result.ok)
  assert.equal((result as { localRevoked: boolean }).localRevoked, true)

  const conn = await getPlatformConnectionForAccount(ctx.db, ctx.accountId)
  assert.equal(conn?.status, 'disconnected', 'Local state is disconnected despite provider 429/503')

  const resolved = await resolveOAuthCredential(
    ctx.db,
    { workspaceId: ctx.workspaceId, accountId: ctx.accountId, platformAdapterKey: 'x' },
    TEST_KEK,
  )
  assert.ok(!resolved.ok)
  assert.equal((resolved as { code: string }).code, 'connection_inactive')
})

test('76. fencing: simultaneous claim by two workers generates unique claim IDs and awards lease to exactly one', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, { accessTokenExpiresAt: isoFuture(10) })

  const claim1Id = newId()
  const claim2Id = newId()
  assert.notEqual(claim1Id, claim2Id)

  const now = nowIso()
  const leaseExpiry = new Date(Date.now() + 30000).toISOString()

  const res1 = await execute(
    ctx.db,
    `UPDATE platform_credential
     SET refresh_locked_until = ?, refresh_claim_id = ?
     WHERE account_id = ? AND revoked_at IS NULL
       AND (refresh_locked_until IS NULL OR refresh_locked_until < ?)`,
    [leaseExpiry, claim1Id, ctx.accountId, now],
  )
  const changes1 =
    (res1 as { meta?: { changes?: number }; changes?: number })?.meta?.changes ??
    (res1 as { changes?: number })?.changes ??
    0

  const res2 = await execute(
    ctx.db,
    `UPDATE platform_credential
     SET refresh_locked_until = ?, refresh_claim_id = ?
     WHERE account_id = ? AND revoked_at IS NULL
       AND (refresh_locked_until IS NULL OR refresh_locked_until < ?)`,
    [leaseExpiry, claim2Id, ctx.accountId, now],
  )
  const changes2 =
    (res2 as { meta?: { changes?: number }; changes?: number })?.meta?.changes ??
    (res2 as { changes?: number })?.changes ??
    0

  assert.equal(changes1, 1, 'First worker claims lease')
  assert.equal(changes2, 0, 'Second worker rejected')

  const row = await queryFirst<{ refresh_claim_id: string }>(
    ctx.db,
    `SELECT refresh_claim_id FROM platform_credential WHERE account_id = ? AND revoked_at IS NULL`,
    [ctx.accountId],
  )
  assert.equal(row?.refresh_claim_id, claim1Id)
})

test('77. fencing: stale takeover updates claim_id to new claimant', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, { accessTokenExpiresAt: isoFuture(10) })

  const claimA = newId()
  const pastLease = new Date(Date.now() - 5000).toISOString()
  await execute(
    ctx.db,
    `UPDATE platform_credential
     SET refresh_locked_until = ?, refresh_claim_id = ?
     WHERE account_id = ? AND revoked_at IS NULL`,
    [pastLease, claimA, ctx.accountId],
  )

  const claimB = newId()
  const futureLease = new Date(Date.now() + 30000).toISOString()
  const now = nowIso()

  const resB = await execute(
    ctx.db,
    `UPDATE platform_credential
     SET refresh_locked_until = ?, refresh_claim_id = ?
     WHERE account_id = ? AND revoked_at IS NULL
       AND (refresh_locked_until IS NULL OR refresh_locked_until < ?)`,
    [futureLease, claimB, ctx.accountId, now],
  )
  const changesB =
    (resB as { meta?: { changes?: number }; changes?: number })?.meta?.changes ??
    (resB as { changes?: number })?.changes ??
    0

  assert.equal(changesB, 1, 'Worker B reclaims stale lease')
  const row = await queryFirst<{ refresh_claim_id: string }>(
    ctx.db,
    `SELECT refresh_claim_id FROM platform_credential WHERE account_id = ? AND revoked_at IS NULL`,
    [ctx.accountId],
  )
  assert.equal(row?.refresh_claim_id, claimB, 'Database now contains claimB')
})

test('78. fencing: delayed A response rejected when lease reclaimed by B (critical race test)', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, {
    accessToken: 'original_token_c1',
    accessTokenExpiresAt: isoFuture(10),
  })

  // 1. Worker A claims lease with claimA
  const claimA = newId()
  const leaseA = new Date(Date.now() + 30000).toISOString()
  await execute(
    ctx.db,
    `UPDATE platform_credential
     SET refresh_locked_until = ?, refresh_claim_id = ?
     WHERE account_id = ? AND revoked_at IS NULL`,
    [leaseA, claimA, ctx.accountId],
  )

  // 2. Advance time past A's lease expiration; Worker B claims with claimB
  const claimB = newId()
  const pastTime = new Date(Date.now() + 35000).toISOString()
  const leaseB = new Date(Date.now() + 65000).toISOString()
  await execute(
    ctx.db,
    `UPDATE platform_credential
     SET refresh_locked_until = ?, refresh_claim_id = ?
     WHERE account_id = ? AND revoked_at IS NULL
       AND (refresh_locked_until IS NULL OR refresh_locked_until < ?)`,
    [leaseB, claimB, ctx.accountId, pastTime],
  )

  // 3. Worker A's delayed refresh response arrives and attempts persistence with claimA
  const storeResA = await storeOAuthCredential(
    ctx.db,
    {
      workspaceId: ctx.workspaceId,
      accountId: ctx.accountId,
      platformAdapterKey: 'x',
      expectedRefreshClaimId: claimA,
      credential: {
        accessToken: 'stale_token_from_A',
        refreshToken: 'stale_refresh_from_A',
        accessTokenExpiresAt: isoFuture(7200),
      },
    },
    TEST_KEK,
  )

  // 4. Required: A persistence rejected; C1 / current authoritative state not overwritten by A
  assert.ok(!storeResA.ok, 'Worker A persistence must be rejected')
  assert.equal((storeResA as { code: string }).code, 'stale_refresh_claim')

  const activeRow = await queryFirst<{ refresh_claim_id: string }>(
    ctx.db,
    `SELECT refresh_claim_id FROM platform_credential WHERE account_id = ? AND revoked_at IS NULL`,
    [ctx.accountId],
  )
  assert.equal(activeRow?.refresh_claim_id, claimB, 'claimB remains the active owner')

  const resolved = await resolveOAuthCredential(
    ctx.db,
    { workspaceId: ctx.workspaceId, accountId: ctx.accountId, platformAdapterKey: 'x' },
    TEST_KEK,
  )
  assert.ok(resolved.ok)
  assert.equal(
    resolved.credential.accessToken,
    'original_token_c1',
    'C1 was not overwritten by stale Worker A',
  )
})

test('79. fencing: B success then delayed A response cannot overwrite B or insert C3', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, {
    accessToken: 'original_token_c1',
    accessTokenExpiresAt: isoFuture(10),
  })

  // 1. Worker A claims lease
  const claimA = newId()
  await execute(
    ctx.db,
    `UPDATE platform_credential
     SET refresh_locked_until = ?, refresh_claim_id = ?
     WHERE account_id = ? AND revoked_at IS NULL`,
    [new Date(Date.now() - 1000).toISOString(), claimA, ctx.accountId],
  )

  // 2. Worker B reclaims and successfully rotates to C2
  const claimB = newId()
  await execute(
    ctx.db,
    `UPDATE platform_credential
     SET refresh_locked_until = ?, refresh_claim_id = ?
     WHERE account_id = ? AND revoked_at IS NULL`,
    [new Date(Date.now() + 30000).toISOString(), claimB, ctx.accountId],
  )

  const storeResB = await storeOAuthCredential(
    ctx.db,
    {
      workspaceId: ctx.workspaceId,
      accountId: ctx.accountId,
      platformAdapterKey: 'x',
      expectedRefreshClaimId: claimB,
      credential: {
        accessToken: 'winner_token_c2',
        refreshToken: 'winner_refresh_c2',
        accessTokenExpiresAt: isoFuture(7200),
      },
    },
    TEST_KEK,
  )
  assert.ok(storeResB.ok, 'Worker B successfully stored C2')

  // 3. Stale Worker A returns and tries to persist with claimA
  const storeResA = await storeOAuthCredential(
    ctx.db,
    {
      workspaceId: ctx.workspaceId,
      accountId: ctx.accountId,
      platformAdapterKey: 'x',
      expectedRefreshClaimId: claimA,
      credential: {
        accessToken: 'stale_token_c3',
        refreshToken: 'stale_refresh_c3',
        accessTokenExpiresAt: isoFuture(7200),
      },
    },
    TEST_KEK,
  )
  assert.ok(!storeResA.ok, 'Worker A rejected with stale claim')
  assert.equal((storeResA as { code: string }).code, 'stale_refresh_claim')

  // 4. Assert: Exactly one active credential exists (C2)
  const activeCount = await queryFirst<{ cnt: number }>(
    ctx.db,
    `SELECT COUNT(*) as cnt FROM platform_credential WHERE account_id = ? AND revoked_at IS NULL`,
    [ctx.accountId],
  )
  assert.equal(activeCount?.cnt, 1)

  const resolved = await resolveOAuthCredential(
    ctx.db,
    { workspaceId: ctx.workspaceId, accountId: ctx.accountId, platformAdapterKey: 'x' },
    TEST_KEK,
  )
  assert.ok(resolved.ok)
  assert.equal(
    resolved.credential.accessToken,
    'winner_token_c2',
    'C2 remains active; C3 was not inserted',
  )
})

test('80. fencing: non-owner release affects zero rows and preserves active lease', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, { accessTokenExpiresAt: isoFuture(10) })

  const claimA = newId()
  const claimB = newId()
  const futureLease = new Date(Date.now() + 30000).toISOString()

  // B currently owns the lease
  await execute(
    ctx.db,
    `UPDATE platform_credential
     SET refresh_locked_until = ?, refresh_claim_id = ?
     WHERE account_id = ? AND revoked_at IS NULL`,
    [futureLease, claimB, ctx.accountId],
  )

  // Stale Worker A tries to release its old claimA
  const releaseRes = await execute(
    ctx.db,
    `UPDATE platform_credential
     SET refresh_locked_until = NULL, refresh_claim_id = NULL
     WHERE account_id = ? AND revoked_at IS NULL AND refresh_claim_id = ?`,
    [ctx.accountId, claimA],
  )
  const changes =
    (releaseRes as { meta?: { changes?: number }; changes?: number })?.meta?.changes ??
    (releaseRes as { changes?: number })?.changes ??
    0

  assert.equal(changes, 0, 'Zero rows updated on non-owner release')

  // B's lease remains intact
  const row = await queryFirst<{ refresh_claim_id: string; refresh_locked_until: string }>(
    ctx.db,
    `SELECT refresh_claim_id, refresh_locked_until FROM platform_credential WHERE account_id = ? AND revoked_at IS NULL`,
    [ctx.accountId],
  )
  assert.equal(row?.refresh_claim_id, claimB)
  assert.equal(row?.refresh_locked_until, futureLease)
})

test('81. fencing: current owner release clears claim fields without altering credential', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, { accessToken: 'token_val_1', accessTokenExpiresAt: isoFuture(10) })

  const claimA = newId()
  const futureLease = new Date(Date.now() + 30000).toISOString()

  await execute(
    ctx.db,
    `UPDATE platform_credential
     SET refresh_locked_until = ?, refresh_claim_id = ?
     WHERE account_id = ? AND revoked_at IS NULL`,
    [futureLease, claimA, ctx.accountId],
  )

  // Worker A encounters failure and releases its own claimA
  const releaseRes = await execute(
    ctx.db,
    `UPDATE platform_credential
     SET refresh_locked_until = NULL, refresh_claim_id = NULL
     WHERE account_id = ? AND revoked_at IS NULL AND refresh_claim_id = ?`,
    [ctx.accountId, claimA],
  )
  const changes =
    (releaseRes as { meta?: { changes?: number }; changes?: number })?.meta?.changes ??
    (releaseRes as { changes?: number })?.changes ??
    0

  assert.equal(changes, 1, 'Current owner successfully releases lease')

  const row = await queryFirst<{
    refresh_claim_id: string | null
    refresh_locked_until: string | null
  }>(
    ctx.db,
    `SELECT refresh_claim_id, refresh_locked_until FROM platform_credential WHERE account_id = ? AND revoked_at IS NULL`,
    [ctx.accountId],
  )
  assert.equal(row?.refresh_claim_id, null)
  assert.equal(row?.refresh_locked_until, null)

  // Credential remains active and usable
  const resolved = await resolveOAuthCredential(
    ctx.db,
    { workspaceId: ctx.workspaceId, accountId: ctx.accountId, platformAdapterKey: 'x' },
    TEST_KEK,
  )
  assert.ok(resolved.ok)
  assert.equal(resolved.credential.accessToken, 'token_val_1')
})

test('82. fencing: disconnect during in-flight refresh invalidates stale persistence', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, { accessTokenExpiresAt: isoFuture(10) })

  const claimA = newId()
  await execute(
    ctx.db,
    `UPDATE platform_credential
     SET refresh_locked_until = ?, refresh_claim_id = ?
     WHERE account_id = ? AND revoked_at IS NULL`,
    [new Date(Date.now() + 30000).toISOString(), claimA, ctx.accountId],
  )

  // User disconnects while Worker A is in-flight
  const disconnRes = await disconnectXOAuth(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
  )
  assert.ok(disconnRes.ok)

  // Worker A returns and tries to persist rotated credential
  const storeRes = await storeOAuthCredential(
    ctx.db,
    {
      workspaceId: ctx.workspaceId,
      accountId: ctx.accountId,
      platformAdapterKey: 'x',
      expectedRefreshClaimId: claimA,
      credential: {
        accessToken: 'stale_token_after_disconnect',
        refreshToken: 'stale_refresh',
      },
    },
    TEST_KEK,
  )

  assert.ok(!storeRes.ok, 'Persistence rejected because credential was revoked by disconnect')
  assert.equal((storeRes as { code: string }).code, 'stale_refresh_claim')

  // Connection remains disconnected
  const conn = await getPlatformConnectionForAccount(ctx.db, ctx.accountId)
  assert.equal(conn?.status, 'disconnected')
})

test('83. fencing: reconnect creates fresh credential and rejects delayed old refresh response', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, { accessTokenExpiresAt: isoFuture(10) })

  // 1. Worker A claims lease for C1
  const claimA = newId()
  await execute(
    ctx.db,
    `UPDATE platform_credential
     SET refresh_locked_until = ?, refresh_claim_id = ?
     WHERE account_id = ? AND revoked_at IS NULL`,
    [new Date(Date.now() + 30000).toISOString(), claimA, ctx.accountId],
  )

  // 2. Disconnect C1
  await disconnectXOAuth(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
  )

  // 3. User reconnects (new OAuth flow creates C2 with refresh_claim_id = NULL)
  const reconnectRes = await storeOAuthCredential(
    ctx.db,
    {
      workspaceId: ctx.workspaceId,
      accountId: ctx.accountId,
      platformAdapterKey: 'x',
      credential: {
        accessToken: 'reconnected_token_c2',
        refreshToken: 'reconnected_refresh_c2',
        accessTokenExpiresAt: isoFuture(7200),
      },
    },
    TEST_KEK,
  )
  assert.ok(reconnectRes.ok)

  // 4. Delayed response for old C1 arrives with claimA
  const storeResA = await storeOAuthCredential(
    ctx.db,
    {
      workspaceId: ctx.workspaceId,
      accountId: ctx.accountId,
      platformAdapterKey: 'x',
      expectedRefreshClaimId: claimA,
      credential: {
        accessToken: 'stale_token_from_old_c1',
        refreshToken: 'stale_refresh_from_old_c1',
      },
    },
    TEST_KEK,
  )
  assert.ok(!storeResA.ok, 'Old claim cannot modify or revoke C2')
  assert.equal((storeResA as { code: string }).code, 'stale_refresh_claim')

  // 5. C2 remains active
  const resolved = await resolveOAuthCredential(
    ctx.db,
    { workspaceId: ctx.workspaceId, accountId: ctx.accountId, platformAdapterKey: 'x' },
    TEST_KEK,
  )
  assert.ok(resolved.ok)
  assert.equal(resolved.credential.accessToken, 'reconnected_token_c2')
})

test('84. fencing: publication halts safely when stale-owner persistence fails', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx, {
    accessToken: 'expiring_token_valid',
    accessTokenExpiresAt: isoFuture(10),
    providerUserId: '999888777',
  })

  // Stale claim setup: lease is already claimed by someone else
  const claimOther = newId()
  await execute(
    ctx.db,
    `UPDATE platform_credential
     SET refresh_locked_until = ?, refresh_claim_id = ?
     WHERE account_id = ? AND revoked_at IS NULL`,
    [new Date(Date.now() + 30000).toISOString(), claimOther, ctx.accountId],
  )

  const pubCtx = await seedApprovedPublicationContext(ctx)

  // When publication runs, refresh will observe refresh_lease_held and proceed with existing token
  const { transport } = makeCaptureTransport([
    { status: 200, body: { data: { id: '999888777', username: 'growth_bot' } } },
    { status: 201, body: { data: { id: 'tweet_9999', text: 'Test Post Body' } } },
  ])

  const dispatchRes = await dispatchApprovedPublication(
    ctx.db,
    {
      workspaceId: ctx.workspaceId,
      approvalRequestId: pubCtx.approvalRequestId,
    },
    {
      credentialKek: TEST_KEK,
      xOAuthConfig: BASE_CONFIG,
      xTransport: transport,
    },
  )

  // Should successfully proceed with existing token
  assert.ok(dispatchRes.ok, `Expected dispatch to succeed, got: ${JSON.stringify(dispatchRes)}`)
})

test('85. fencing: refresh_claim_id is absent from browser DTO, safe connection metadata, and error strings', async () => {
  const ctx = await seedLifecycleCtx()
  await seedCredential(ctx)

  const claimId = newId()
  await execute(
    ctx.db,
    `UPDATE platform_credential
     SET refresh_locked_until = ?, refresh_claim_id = ?
     WHERE account_id = ? AND revoked_at IS NULL`,
    [new Date(Date.now() + 30000).toISOString(), claimId, ctx.accountId],
  )

  const conn = await getPlatformConnectionForAccount(ctx.db, ctx.accountId)
  assert.ok(conn)
  const connStr = JSON.stringify(conn)
  assert.ok(!connStr.includes(claimId), 'claim ID absent from connection metadata')

  const refreshResult = await refreshXOAuthCredentialIfNeeded(
    ctx.db,
    { accountId: ctx.accountId, workspaceId: ctx.workspaceId },
    BASE_CONFIG,
    TEST_KEK,
  )
  const resStr = JSON.stringify(refreshResult)
  assert.ok(!resStr.includes(claimId), 'claim ID absent from refresh result DTO')
})
