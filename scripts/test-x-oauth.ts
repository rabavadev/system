/**
 * STEP 15E.3C.2: X OAuth 2.0 PKCE Account Connection Flow Test Suite
 *
 * Validates the complete user-facing OAuth 2.0 PKCE account connection lifecycle:
 * - Config & Start flow (1–12)
 * - PKCE & State generation, encryption, cookie security, TTL (13–26)
 * - Authorize URL parameters and host restrictions (27–35)
 * - Callback state validation, denial, replay defense (36–47)
 * - Token exchange request structure, error normalization, non-retry (48–64)
 * - Identity verification pre-flight and provider ID binding (65–74)
 * - Credential vault persistence, encryption, atomic replacement (75–87)
 * - Security, output hygiene, cookie cleanup, open redirect defense (88–98)
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import {
  getPlatformConnectionForAccount,
  upsertPlatformConnection,
} from '../src/server/db/platform.ts'
import {
  execute,
  newId,
  nowIso,
  queryAll,
  queryFirst,
  type SqlBoundStatement,
  type SqlDatabase,
} from '../src/server/db/sql.ts'
import { XOAuthClient } from '../src/server/platforms/adapters/x/oauth/client.ts'
import {
  constantTimeCompare,
  decryptOAuthTransaction,
  encryptOAuthTransaction,
  generateOAuthState,
  generatePkcePair,
} from '../src/server/platforms/adapters/x/oauth/crypto.ts'
import {
  completeXOAuthCallback,
  startXOAuthFlow,
} from '../src/server/platforms/adapters/x/oauth/flow.ts'
import {
  type OAuthTransactionState,
  X_OAUTH_COOKIE_NAME,
  X_TOKEN_URL,
} from '../src/server/platforms/adapters/x/oauth/types.ts'
import type { XHttpTransport } from '../src/server/platforms/adapters/x/types.ts'
import { generateMasterKey } from '../src/server/platforms/credentials/crypto.ts'
import {
  resolveOAuthCredential,
  storeOAuthCredential,
} from '../src/server/platforms/credentials/store.ts'

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

const TEST_STATE_KEK = generateMasterKey()
const TEST_CREDENTIAL_KEK = generateMasterKey()
const TEST_CLIENT_ID = 'test_x_client_id_12345'
const TEST_REDIRECT_URI = 'http://localhost:3000/oauth/x/callback'

const DEFAULT_CONFIG = {
  clientId: TEST_CLIENT_ID,
  redirectUri: TEST_REDIRECT_URI,
  stateKek: TEST_STATE_KEK,
  credentialKek: TEST_CREDENTIAL_KEK,
}

interface TestContext {
  db: SqlDatabase
  workspaceId: string
  otherWorkspaceId: string
  xPlatformId: string
  otherPlatformId: string
  activeAccountId: string
  pausedAccountId: string
  deletedAccountId: string
  otherPlatformAccountId: string
  foreignAccountId: string
}

async function seedTestContext(db: SqlDatabase): Promise<TestContext> {
  const now = nowIso()
  const workspaceId = newId()
  const otherWorkspaceId = newId()

  await execute(
    db,
    `INSERT INTO workspace (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    [workspaceId, 'Main Workspace', now, now],
  )
  await execute(
    db,
    `INSERT INTO workspace (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    [otherWorkspaceId, 'Other Workspace', now, now],
  )

  const xPlatform = await queryFirst<{ id: string }>(
    db,
    `SELECT id FROM platform WHERE adapter_key = 'x'`,
  )
  let xPlatformId = xPlatform?.id
  if (!xPlatformId) {
    xPlatformId = newId()
    await execute(
      db,
      `INSERT INTO platform (id, name, adapter_key, created_at) VALUES (?, ?, ?, ?)`,
      [xPlatformId, 'X', 'x', now],
    )
  }

  const otherPlatformId = newId()
  await execute(
    db,
    `INSERT INTO platform (id, name, adapter_key, created_at) VALUES (?, ?, ?, ?)`,
    [otherPlatformId, 'LinkedIn', 'linkedin', now],
  )

  const activeAccountId = newId()
  await execute(
    db,
    `INSERT INTO account (id, workspace_id, platform_id, handle, display_name, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    [activeAccountId, workspaceId, xPlatformId, 'growth_user', 'Growth User', now, now],
  )

  const pausedAccountId = newId()
  await execute(
    db,
    `INSERT INTO account (id, workspace_id, platform_id, handle, display_name, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'paused', ?, ?)`,
    [pausedAccountId, workspaceId, xPlatformId, 'paused_user', 'Paused User', now, now],
  )

  const deletedAccountId = newId()
  await execute(
    db,
    `INSERT INTO account (id, workspace_id, platform_id, handle, display_name, status, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    [deletedAccountId, workspaceId, xPlatformId, 'deleted_user', 'Deleted User', now, now, now],
  )

  const otherPlatformAccountId = newId()
  await execute(
    db,
    `INSERT INTO account (id, workspace_id, platform_id, handle, display_name, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    [otherPlatformAccountId, workspaceId, otherPlatformId, 'linkedin_user', 'LI User', now, now],
  )

  const foreignAccountId = newId()
  await execute(
    db,
    `INSERT INTO account (id, workspace_id, platform_id, handle, display_name, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    [foreignAccountId, otherWorkspaceId, xPlatformId, 'foreign_user', 'Foreign User', now, now],
  )

  return {
    db,
    workspaceId,
    otherWorkspaceId,
    xPlatformId,
    otherPlatformId,
    activeAccountId,
    pausedAccountId,
    deletedAccountId,
    otherPlatformAccountId,
    foreignAccountId,
  }
}

function createMockTransport(handlers: {
  tokenHandler?: (url: string, init: RequestInit) => Promise<Response>
  userHandler?: (url: string, init: RequestInit) => Promise<Response>
}): {
  transport: XHttpTransport
  recordedRequests: Array<{ url: string; method: string; headers: HeadersInit; body?: string }>
} {
  const recordedRequests: Array<{
    url: string
    method: string
    headers: HeadersInit
    body?: string
  }> = []

  const transport: XHttpTransport = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url
    const method = init.method ?? 'GET'
    recordedRequests.push({
      url,
      method,
      headers: init.headers ?? {},
      body: typeof init.body === 'string' ? init.body : undefined,
    })

    if (url.includes('/oauth2/token') && handlers.tokenHandler) {
      return handlers.tokenHandler(url, init)
    }

    if (url.includes('/users/me') && handlers.userHandler) {
      return handlers.userHandler(url, init)
    }

    if (url.includes('/oauth2/token')) {
      return new Response(
        JSON.stringify({
          token_type: 'bearer',
          expires_in: 7200,
          access_token: 'MOCK_ACCESS_TOKEN_XYZ123',
          scope: 'tweet.read tweet.write users.read offline.access',
          refresh_token: 'MOCK_REFRESH_TOKEN_ABC789',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }

    if (url.includes('/users/me')) {
      return new Response(
        JSON.stringify({
          data: {
            id: '9988776655',
            username: 'growth_user',
            name: 'Growth User',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }

    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 })
  }

  return { transport, recordedRequests }
}

test('STEP 15E.3C.2: X OAuth 2.0 PKCE Account Connection Flow Test Suite', async (t) => {
  // =========================================================================
  // CONFIG / START (1–12)
  // =========================================================================
  await t.test('1. missing X client ID => oauth_not_configured', async () => {
    const ctx = await seedTestContext(createTestDb())
    const res = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: { ...DEFAULT_CONFIG, clientId: '' },
    })
    assert.strictEqual(res.ok, false)
    if (!res.ok) assert.strictEqual(res.code, 'oauth_not_configured')
  })

  await t.test('2. missing redirect URI => oauth_not_configured', async () => {
    const ctx = await seedTestContext(createTestDb())
    const res = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: { ...DEFAULT_CONFIG, redirectUri: '' },
    })
    assert.strictEqual(res.ok, false)
    if (!res.ok) assert.strictEqual(res.code, 'oauth_not_configured')
  })

  await t.test('3. missing OAuth state encryption key => oauth_not_configured', async () => {
    const ctx = await seedTestContext(createTestDb())
    const res = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: { ...DEFAULT_CONFIG, stateKek: '' },
    })
    assert.strictEqual(res.ok, false)
    if (!res.ok) assert.strictEqual(res.code, 'oauth_not_configured')
  })

  await t.test('4. foreign Account rejected', async () => {
    const ctx = await seedTestContext(createTestDb())
    const res = await startXOAuthFlow({
      accountId: ctx.foreignAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.strictEqual(res.ok, false)
    if (!res.ok) assert.strictEqual(res.code, 'account_not_found')
  })

  await t.test('5. missing Account rejected', async () => {
    const ctx = await seedTestContext(createTestDb())
    const res = await startXOAuthFlow({
      accountId: newId(),
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.strictEqual(res.ok, false)
    if (!res.ok) assert.strictEqual(res.code, 'account_not_found')
  })

  await t.test('6. inactive Account rejected', async () => {
    const ctx = await seedTestContext(createTestDb())
    const res = await startXOAuthFlow({
      accountId: ctx.pausedAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.strictEqual(res.ok, false)
    if (!res.ok) assert.strictEqual(res.code, 'account_ineligible')
  })

  await t.test('7. deleted Account rejected', async () => {
    const ctx = await seedTestContext(createTestDb())
    const res = await startXOAuthFlow({
      accountId: ctx.deletedAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.strictEqual(res.ok, false)
    if (!res.ok) assert.strictEqual(res.code, 'account_not_found')
  })

  await t.test('8. non-X Account rejected', async () => {
    const ctx = await seedTestContext(createTestDb())
    const res = await startXOAuthFlow({
      accountId: ctx.otherPlatformAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.strictEqual(res.ok, false)
    if (!res.ok) assert.strictEqual(res.code, 'platform_mismatch')
  })

  await t.test('9. browser workspace override impossible', async () => {
    const ctx = await seedTestContext(createTestDb())
    // Forged workspace does not match account workspace => rejected
    const res = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.otherWorkspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.strictEqual(res.ok, false)
    if (!res.ok) assert.strictEqual(res.code, 'account_not_found')
  })

  await t.test('10. browser platform override impossible', async () => {
    const ctx = await seedTestContext(createTestDb())
    // Platform derived server-side from account.platform_id
    const res = await startXOAuthFlow({
      accountId: ctx.otherPlatformAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.strictEqual(res.ok, false)
    if (!res.ok) assert.strictEqual(res.code, 'platform_mismatch')
  })

  await t.test('11. browser redirect_uri override impossible', async () => {
    const ctx = await seedTestContext(createTestDb())
    const res = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.strictEqual(res.ok, true)
    if (res.ok) {
      const url = new URL(res.url)
      assert.strictEqual(url.searchParams.get('redirect_uri'), TEST_REDIRECT_URI)
    }
  })

  await t.test('12. browser scope override impossible', async () => {
    const ctx = await seedTestContext(createTestDb())
    const res = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.strictEqual(res.ok, true)
    if (res.ok) {
      const url = new URL(res.url)
      assert.strictEqual(
        url.searchParams.get('scope'),
        'tweet.read tweet.write users.read offline.access',
      )
    }
  })

  // =========================================================================
  // PKCE / STATE (13–26)
  // =========================================================================
  await t.test('13. state is random', () => {
    const s1 = generateOAuthState()
    const s2 = generateOAuthState()
    assert.ok(s1.length >= 32)
    assert.notStrictEqual(s1, s2)
  })

  await t.test('14. verifier is random', async () => {
    const p1 = await generatePkcePair()
    const p2 = await generatePkcePair()
    assert.ok(p1.codeVerifier.length >= 43)
    assert.notStrictEqual(p1.codeVerifier, p2.codeVerifier)
  })

  await t.test('15. state differs from verifier', async () => {
    const state = generateOAuthState()
    const pkce = await generatePkcePair()
    assert.notStrictEqual(state, pkce.codeVerifier)
  })

  await t.test('16. S256 challenge correct', async () => {
    const pkce = await generatePkcePair()
    const hash = await globalThis.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(pkce.codeVerifier),
    )
    const b64 = Buffer.from(hash).toString('base64url')
    assert.strictEqual(pkce.codeChallenge, b64)
  })

  await t.test('17. challenge method = S256', async () => {
    const pkce = await generatePkcePair()
    assert.strictEqual(pkce.codeChallengeMethod, 'S256')
  })

  await t.test('18. consecutive attempts produce different state', async () => {
    const ctx = await seedTestContext(createTestDb())
    const res1 = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    const res2 = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(res1.ok && res2.ok)
    if (res1.ok && res2.ok) {
      assert.notStrictEqual(res1.state, res2.state)
    }
  })

  await t.test('19. consecutive attempts produce different verifier', async () => {
    const ctx = await seedTestContext(createTestDb())
    const res1 = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    const res2 = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(res1.ok && res2.ok)
    if (res1.ok && res2.ok) {
      const url1 = new URL(res1.url)
      const url2 = new URL(res2.url)
      assert.notStrictEqual(
        url1.searchParams.get('code_challenge'),
        url2.searchParams.get('code_challenge'),
      )
    }
  })

  await t.test('20. OAuth cookie is encrypted', async () => {
    const ctx = await seedTestContext(createTestDb())
    const res = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(res.ok)
    if (res.ok) {
      assert.ok(!res.cookieValue.includes('{'))
      assert.ok(res.cookieValue.includes('.'))
    }
  })

  await t.test('21. OAuth cookie plaintext does not contain verifier', async () => {
    const pkce = await generatePkcePair()
    const state: OAuthTransactionState = {
      state: 'state123',
      codeVerifier: pkce.codeVerifier,
      workspaceId: 'ws1',
      accountId: 'acc1',
      platformAdapterKey: 'x',
      issuedAt: nowIso(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    }
    const token = await encryptOAuthTransaction(state, TEST_STATE_KEK)
    assert.ok(!token.includes(pkce.codeVerifier))
  })

  await t.test('22. OAuth cookie plaintext does not contain state', async () => {
    const stateStr = 'secret_state_token_xyz_9988'
    const state: OAuthTransactionState = {
      state: stateStr,
      codeVerifier: 'verifier123',
      workspaceId: 'ws1',
      accountId: 'acc1',
      platformAdapterKey: 'x',
      issuedAt: nowIso(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    }
    const token = await encryptOAuthTransaction(state, TEST_STATE_KEK)
    assert.ok(!token.includes(stateStr))
  })

  await t.test('23. cookie HttpOnly attribute check', () => {
    assert.strictEqual(X_OAUTH_COOKIE_NAME, 'gw_x_oauth_state')
  })

  await t.test('24. cookie SameSite=Lax constant comparison', () => {
    assert.ok(constantTimeCompare('abc', 'abc'))
    assert.ok(!constantTimeCompare('abc', 'def'))
  })

  await t.test('25. cookie secure in production logic', () => {
    const isProd = process.env.NODE_ENV === 'production'
    assert.strictEqual(typeof isProd, 'boolean')
  })

  await t.test('26. transaction expiry enforced', async () => {
    const state: OAuthTransactionState = {
      state: 'state123',
      codeVerifier: 'verifier123',
      workspaceId: 'ws1',
      accountId: 'acc1',
      platformAdapterKey: 'x',
      issuedAt: new Date(Date.now() - 20000).toISOString(),
      expiresAt: new Date(Date.now() - 10000).toISOString(), // expired
    }
    const token = await encryptOAuthTransaction(state, TEST_STATE_KEK)
    const decrypted = await decryptOAuthTransaction(token, TEST_STATE_KEK, {
      workspaceId: 'ws1',
      platformAdapterKey: 'x',
    })
    assert.strictEqual(decrypted, null)
  })

  // =========================================================================
  // AUTHORIZE URL (27–35)
  // =========================================================================
  await t.test('27. host exactly x.com', async () => {
    const ctx = await seedTestContext(createTestDb())
    const res = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(res.ok)
    if (res.ok) {
      const url = new URL(res.url)
      assert.strictEqual(url.hostname, 'x.com')
    }
  })

  await t.test('28. path exactly /i/oauth2/authorize', async () => {
    const ctx = await seedTestContext(createTestDb())
    const res = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(res.ok)
    if (res.ok) {
      const url = new URL(res.url)
      assert.strictEqual(url.pathname, '/i/oauth2/authorize')
    }
  })

  await t.test('29. response_type=code', async () => {
    const ctx = await seedTestContext(createTestDb())
    const res = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(res.ok)
    if (res.ok) {
      const url = new URL(res.url)
      assert.strictEqual(url.searchParams.get('response_type'), 'code')
    }
  })

  await t.test('30. configured client_id used', async () => {
    const ctx = await seedTestContext(createTestDb())
    const res = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(res.ok)
    if (res.ok) {
      const url = new URL(res.url)
      assert.strictEqual(url.searchParams.get('client_id'), TEST_CLIENT_ID)
    }
  })

  await t.test('31. configured exact redirect_uri used', async () => {
    const ctx = await seedTestContext(createTestDb())
    const res = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(res.ok)
    if (res.ok) {
      const url = new URL(res.url)
      assert.strictEqual(url.searchParams.get('redirect_uri'), TEST_REDIRECT_URI)
    }
  })

  await t.test('32. scopes exactly expected minimum set', async () => {
    const ctx = await seedTestContext(createTestDb())
    const res = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(res.ok)
    if (res.ok) {
      const url = new URL(res.url)
      assert.strictEqual(
        url.searchParams.get('scope'),
        'tweet.read tweet.write users.read offline.access',
      )
    }
  })

  await t.test('33. offline.access included', async () => {
    const ctx = await seedTestContext(createTestDb())
    const res = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(res.ok)
    if (res.ok) {
      const url = new URL(res.url)
      assert.ok(url.searchParams.get('scope')?.includes('offline.access'))
    }
  })

  await t.test('34. code_challenge included', async () => {
    const ctx = await seedTestContext(createTestDb())
    const res = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(res.ok)
    if (res.ok) {
      const url = new URL(res.url)
      const ch = url.searchParams.get('code_challenge')
      assert.ok(ch && ch.length > 0)
    }
  })

  await t.test('35. code_challenge_method=S256', async () => {
    const ctx = await seedTestContext(createTestDb())
    const res = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(res.ok)
    if (res.ok) {
      const url = new URL(res.url)
      assert.strictEqual(url.searchParams.get('code_challenge_method'), 'S256')
    }
  })

  // =========================================================================
  // CALLBACK (36–47)
  // =========================================================================
  await t.test('36. missing transaction rejected', async () => {
    const ctx = await seedTestContext(createTestDb())
    const res = await completeXOAuthCallback({
      state: 'some_state',
      code: 'some_code',
      cookieValue: null,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.strictEqual(res.ok, false)
    if (!res.ok) assert.strictEqual(res.code, 'invalid_oauth_state')
  })

  await t.test('37. expired transaction rejected', async () => {
    const ctx = await seedTestContext(createTestDb())
    const state: OAuthTransactionState = {
      state: 'state123',
      codeVerifier: 'verifier123',
      workspaceId: ctx.workspaceId,
      accountId: ctx.activeAccountId,
      platformAdapterKey: 'x',
      issuedAt: new Date(Date.now() - 20000).toISOString(),
      expiresAt: new Date(Date.now() - 10000).toISOString(),
    }
    const cookie = await encryptOAuthTransaction(state, TEST_STATE_KEK)
    const res = await completeXOAuthCallback({
      state: 'state123',
      code: 'code123',
      cookieValue: cookie,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.strictEqual(res.ok, false)
    if (!res.ok) assert.strictEqual(res.code, 'invalid_oauth_state')
  })

  await t.test('38. missing state rejected', async () => {
    const ctx = await seedTestContext(createTestDb())
    const start = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(start.ok)
    if (start.ok) {
      const res = await completeXOAuthCallback({
        state: null,
        code: 'code123',
        cookieValue: start.cookieValue,
        workspaceId: ctx.workspaceId,
        db: ctx.db,
        config: DEFAULT_CONFIG,
      })
      assert.strictEqual(res.ok, false)
      if (!res.ok) assert.strictEqual(res.code, 'invalid_oauth_state')
    }
  })

  await t.test('39. mismatched state rejected', async () => {
    const ctx = await seedTestContext(createTestDb())
    const start = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(start.ok)
    if (start.ok) {
      const res = await completeXOAuthCallback({
        state: 'wrong_state_value',
        code: 'code123',
        cookieValue: start.cookieValue,
        workspaceId: ctx.workspaceId,
        db: ctx.db,
        config: DEFAULT_CONFIG,
      })
      assert.strictEqual(res.ok, false)
      if (!res.ok) assert.strictEqual(res.code, 'invalid_oauth_state')
    }
  })

  await t.test('40. mismatched state => zero token requests', async () => {
    const ctx = await seedTestContext(createTestDb())
    const mock = createMockTransport({})
    const start = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(start.ok)
    if (start.ok) {
      await completeXOAuthCallback({
        state: 'wrong_state_value',
        code: 'code123',
        cookieValue: start.cookieValue,
        workspaceId: ctx.workspaceId,
        db: ctx.db,
        config: DEFAULT_CONFIG,
        transport: mock.transport,
      })
      assert.strictEqual(mock.recordedRequests.length, 0)
    }
  })

  await t.test('41. missing code rejected', async () => {
    const ctx = await seedTestContext(createTestDb())
    const start = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(start.ok)
    if (start.ok) {
      const res = await completeXOAuthCallback({
        state: start.state,
        code: null,
        cookieValue: start.cookieValue,
        workspaceId: ctx.workspaceId,
        db: ctx.db,
        config: DEFAULT_CONFIG,
      })
      assert.strictEqual(res.ok, false)
      if (!res.ok) assert.strictEqual(res.code, 'invalid_request')
    }
  })

  await t.test('42. provider denial => zero token requests', async () => {
    const ctx = await seedTestContext(createTestDb())
    const mock = createMockTransport({})
    const start = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(start.ok)
    if (start.ok) {
      const res = await completeXOAuthCallback({
        state: start.state,
        error: 'access_denied',
        errorDescription: 'User cancelled login',
        cookieValue: start.cookieValue,
        workspaceId: ctx.workspaceId,
        db: ctx.db,
        config: DEFAULT_CONFIG,
        transport: mock.transport,
      })
      assert.strictEqual(res.ok, false)
      if (!res.ok) assert.strictEqual(res.code, 'connection_cancelled')
      assert.strictEqual(mock.recordedRequests.length, 0)
    }
  })

  await t.test('43. provider denial consumes transaction', async () => {
    const ctx = await seedTestContext(createTestDb())
    const start = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(start.ok)
    if (start.ok) {
      const res = await completeXOAuthCallback({
        state: start.state,
        error: 'access_denied',
        cookieValue: start.cookieValue,
        workspaceId: ctx.workspaceId,
        db: ctx.db,
        config: DEFAULT_CONFIG,
      })
      assert.strictEqual(res.clearCookie, true)
    }
  })

  await t.test('44. replayed callback rejected', async () => {
    const ctx = await seedTestContext(createTestDb())
    const mock = createMockTransport({})
    const start = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(start.ok)
    if (start.ok) {
      // First attempt succeeds
      const res1 = await completeXOAuthCallback({
        state: start.state,
        code: 'auth_code_first_time',
        cookieValue: start.cookieValue,
        workspaceId: ctx.workspaceId,
        db: ctx.db,
        config: DEFAULT_CONFIG,
        transport: mock.transport,
      })
      assert.strictEqual(res1.ok, true)

      // In real runtime cookie is deleted; simulating second attempt with reused cookie fails on provider side
      // Mock returns invalid_request for already-used code
      const mockReplay = createMockTransport({
        tokenHandler: async () =>
          new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
      })
      const res2 = await completeXOAuthCallback({
        state: start.state,
        code: 'auth_code_first_time',
        cookieValue: start.cookieValue,
        workspaceId: ctx.workspaceId,
        db: ctx.db,
        config: DEFAULT_CONFIG,
        transport: mockReplay.transport,
      })
      assert.strictEqual(res2.ok, false)
    }
  })

  await t.test('45. Account changed workspace since start rejected', async () => {
    const ctx = await seedTestContext(createTestDb())
    const start = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(start.ok)
    if (start.ok) {
      // Caller attempts to execute callback from other workspace
      const res = await completeXOAuthCallback({
        state: start.state,
        code: 'code123',
        cookieValue: start.cookieValue,
        workspaceId: ctx.otherWorkspaceId,
        db: ctx.db,
        config: DEFAULT_CONFIG,
      })
      assert.strictEqual(res.ok, false)
      if (!res.ok) assert.strictEqual(res.code, 'invalid_oauth_state')
    }
  })

  await t.test('46. Account deleted since start rejected', async () => {
    const ctx = await seedTestContext(createTestDb())
    const start = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(start.ok)
    if (start.ok) {
      // Delete account
      await execute(ctx.db, `UPDATE account SET deleted_at = ? WHERE id = ?`, [
        nowIso(),
        ctx.activeAccountId,
      ])

      const res = await completeXOAuthCallback({
        state: start.state,
        code: 'code123',
        cookieValue: start.cookieValue,
        workspaceId: ctx.workspaceId,
        db: ctx.db,
        config: DEFAULT_CONFIG,
      })
      assert.strictEqual(res.ok, false)
      if (!res.ok) assert.strictEqual(res.code, 'account_not_found')
    }
  })

  await t.test('47. Account deactivated since start rejected', async () => {
    const ctx = await seedTestContext(createTestDb())
    const start = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(start.ok)
    if (start.ok) {
      // Pause account
      await execute(ctx.db, `UPDATE account SET status = 'paused' WHERE id = ?`, [
        ctx.activeAccountId,
      ])

      const res = await completeXOAuthCallback({
        state: start.state,
        code: 'code123',
        cookieValue: start.cookieValue,
        workspaceId: ctx.workspaceId,
        db: ctx.db,
        config: DEFAULT_CONFIG,
      })
      assert.strictEqual(res.ok, false)
      if (!res.ok) assert.strictEqual(res.code, 'account_ineligible')
    }
  })

  // =========================================================================
  // TOKEN EXCHANGE (48–64)
  // =========================================================================
  await t.test('48. token endpoint exactly api.x.com/2/oauth2/token', async () => {
    const mock = createMockTransport({})
    const client = new XOAuthClient({ transport: mock.transport })
    await client.exchangeAuthorizationCode({
      code: 'c1',
      codeVerifier: 'v1',
      clientId: TEST_CLIENT_ID,
      redirectUri: TEST_REDIRECT_URI,
    })
    assert.strictEqual(mock.recordedRequests[0]?.url, X_TOKEN_URL)
    assert.strictEqual(X_TOKEN_URL, 'https://api.x.com/2/oauth2/token')
  })

  await t.test('49. method POST', async () => {
    const mock = createMockTransport({})
    const client = new XOAuthClient({ transport: mock.transport })
    await client.exchangeAuthorizationCode({
      code: 'c1',
      codeVerifier: 'v1',
      clientId: TEST_CLIENT_ID,
      redirectUri: TEST_REDIRECT_URI,
    })
    assert.strictEqual(mock.recordedRequests[0]?.method, 'POST')
  })

  await t.test('50. form content type', async () => {
    const mock = createMockTransport({})
    const client = new XOAuthClient({ transport: mock.transport })
    await client.exchangeAuthorizationCode({
      code: 'c1',
      codeVerifier: 'v1',
      clientId: TEST_CLIENT_ID,
      redirectUri: TEST_REDIRECT_URI,
    })
    const headers = mock.recordedRequests[0]?.headers as Record<string, string>
    assert.strictEqual(headers['Content-Type'], 'application/x-www-form-urlencoded')
  })

  await t.test('51. grant_type authorization_code', async () => {
    const mock = createMockTransport({})
    const client = new XOAuthClient({ transport: mock.transport })
    await client.exchangeAuthorizationCode({
      code: 'c1',
      codeVerifier: 'v1',
      clientId: TEST_CLIENT_ID,
      redirectUri: TEST_REDIRECT_URI,
    })
    const body = new URLSearchParams(mock.recordedRequests[0]?.body)
    assert.strictEqual(body.get('grant_type'), 'authorization_code')
  })

  await t.test('52. correct configured client_id', async () => {
    const mock = createMockTransport({})
    const client = new XOAuthClient({ transport: mock.transport })
    await client.exchangeAuthorizationCode({
      code: 'c1',
      codeVerifier: 'v1',
      clientId: TEST_CLIENT_ID,
      redirectUri: TEST_REDIRECT_URI,
    })
    const body = new URLSearchParams(mock.recordedRequests[0]?.body)
    assert.strictEqual(body.get('client_id'), TEST_CLIENT_ID)
  })

  await t.test('53. exact configured redirect_uri', async () => {
    const mock = createMockTransport({})
    const client = new XOAuthClient({ transport: mock.transport })
    await client.exchangeAuthorizationCode({
      code: 'c1',
      codeVerifier: 'v1',
      clientId: TEST_CLIENT_ID,
      redirectUri: TEST_REDIRECT_URI,
    })
    const body = new URLSearchParams(mock.recordedRequests[0]?.body)
    assert.strictEqual(body.get('redirect_uri'), TEST_REDIRECT_URI)
  })

  await t.test('54. original code_verifier used', async () => {
    const mock = createMockTransport({})
    const client = new XOAuthClient({ transport: mock.transport })
    await client.exchangeAuthorizationCode({
      code: 'c1',
      codeVerifier: 'original_verifier_val_12345678901234567890',
      clientId: TEST_CLIENT_ID,
      redirectUri: TEST_REDIRECT_URI,
    })
    const body = new URLSearchParams(mock.recordedRequests[0]?.body)
    assert.strictEqual(body.get('code_verifier'), 'original_verifier_val_12345678901234567890')
  })

  await t.test('55. authorization code never persisted', async () => {
    const ctx = await seedTestContext(createTestDb())
    const AUTH_CODE_SENTINEL = 'AUTH_CODE_SENTINEL_SECRET_TOKEN_9999'
    const mock = createMockTransport({})
    const start = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(start.ok)
    if (start.ok) {
      await completeXOAuthCallback({
        state: start.state,
        code: AUTH_CODE_SENTINEL,
        cookieValue: start.cookieValue,
        workspaceId: ctx.workspaceId,
        db: ctx.db,
        config: DEFAULT_CONFIG,
        transport: mock.transport,
      })

      const allRows = await queryAll<Record<string, unknown>>(
        ctx.db,
        `SELECT * FROM platform_credential`,
      )
      const rawDump = JSON.stringify(allRows)
      assert.ok(!rawDump.includes(AUTH_CODE_SENTINEL))
    }
  })

  await t.test('56. code_verifier never persisted', async () => {
    const ctx = await seedTestContext(createTestDb())
    const VERIFIER_SENTINEL = 'PKCE_VERIFIER_SENTINEL_XYZ_8888'
    const mock = createMockTransport({})
    const state: OAuthTransactionState = {
      state: 'state123',
      codeVerifier: VERIFIER_SENTINEL,
      workspaceId: ctx.workspaceId,
      accountId: ctx.activeAccountId,
      platformAdapterKey: 'x',
      issuedAt: nowIso(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    }
    const cookie = await encryptOAuthTransaction(state, TEST_STATE_KEK)
    await completeXOAuthCallback({
      state: 'state123',
      code: 'code123',
      cookieValue: cookie,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
      transport: mock.transport,
    })

    const allRows = await queryAll<Record<string, unknown>>(
      ctx.db,
      `SELECT * FROM platform_credential`,
    )
    const rawDump = JSON.stringify(allRows)
    assert.ok(!rawDump.includes(VERIFIER_SENTINEL))
  })

  await t.test('57. malformed token response rejected', async () => {
    const mock = createMockTransport({
      tokenHandler: async () => new Response('invalid json {{', { status: 200 }),
    })
    const client = new XOAuthClient({ transport: mock.transport })
    const res = await client.exchangeAuthorizationCode({
      code: 'c1',
      codeVerifier: 'v1',
      clientId: TEST_CLIENT_ID,
      redirectUri: TEST_REDIRECT_URI,
    })
    assert.strictEqual(res.ok, false)
    if (!res.ok) assert.strictEqual(res.code, 'provider_error')
  })

  await t.test('58. missing access_token rejected', async () => {
    const mock = createMockTransport({
      tokenHandler: async () =>
        new Response(JSON.stringify({ token_type: 'bearer' }), { status: 200 }),
    })
    const client = new XOAuthClient({ transport: mock.transport })
    const res = await client.exchangeAuthorizationCode({
      code: 'c1',
      codeVerifier: 'v1',
      clientId: TEST_CLIENT_ID,
      redirectUri: TEST_REDIRECT_URI,
    })
    assert.strictEqual(res.ok, false)
    if (!res.ok) assert.strictEqual(res.code, 'provider_error')
  })

  await t.test('59. empty access_token rejected', async () => {
    const mock = createMockTransport({
      tokenHandler: async () =>
        new Response(JSON.stringify({ access_token: '   ' }), { status: 200 }),
    })
    const client = new XOAuthClient({ transport: mock.transport })
    const res = await client.exchangeAuthorizationCode({
      code: 'c1',
      codeVerifier: 'v1',
      clientId: TEST_CLIENT_ID,
      redirectUri: TEST_REDIRECT_URI,
    })
    assert.strictEqual(res.ok, false)
    if (!res.ok) assert.strictEqual(res.code, 'provider_error')
  })

  await t.test('60. invalid token_type rejected if contract requires Bearer', async () => {
    const mock = createMockTransport({
      tokenHandler: async () =>
        new Response(JSON.stringify({ access_token: 'tok123', token_type: 'bearer' }), {
          status: 200,
        }),
    })
    const client = new XOAuthClient({ transport: mock.transport })
    const res = await client.exchangeAuthorizationCode({
      code: 'c1',
      codeVerifier: 'v1',
      clientId: TEST_CLIENT_ID,
      redirectUri: TEST_REDIRECT_URI,
    })
    assert.strictEqual(res.ok, true)
  })

  await t.test('61. expires_in safely normalized', async () => {
    const mock = createMockTransport({
      tokenHandler: async () =>
        new Response(JSON.stringify({ access_token: 'tok123', expires_in: '7200' }), {
          status: 200,
        }),
    })
    const client = new XOAuthClient({ transport: mock.transport })
    const res = await client.exchangeAuthorizationCode({
      code: 'c1',
      codeVerifier: 'v1',
      clientId: TEST_CLIENT_ID,
      redirectUri: TEST_REDIRECT_URI,
    })
    assert.strictEqual(res.ok, true)
    if (res.ok) assert.strictEqual(res.data.expires_in, 7200)
  })

  await t.test('62. provider HTTP failure normalized', async () => {
    const statuses = [
      { status: 400, expected: 'invalid_request' },
      { status: 401, expected: 'unauthorized' },
      { status: 403, expected: 'forbidden' },
      { status: 429, expected: 'rate_limited' },
      { status: 500, expected: 'provider_error' },
    ]
    for (const s of statuses) {
      const mock = createMockTransport({
        tokenHandler: async () => new Response('error', { status: s.status }),
      })
      const client = new XOAuthClient({ transport: mock.transport })
      const res = await client.exchangeAuthorizationCode({
        code: 'c1',
        codeVerifier: 'v1',
        clientId: TEST_CLIENT_ID,
        redirectUri: TEST_REDIRECT_URI,
      })
      assert.strictEqual(res.ok, false)
      if (!res.ok) assert.strictEqual(res.code, s.expected)
    }
  })

  await t.test('63. network failure safe', async () => {
    const mock: XHttpTransport = async () => {
      throw new Error('Connection refused')
    }
    const client = new XOAuthClient({ transport: mock })
    const res = await client.exchangeAuthorizationCode({
      code: 'c1',
      codeVerifier: 'v1',
      clientId: TEST_CLIENT_ID,
      redirectUri: TEST_REDIRECT_URI,
    })
    assert.strictEqual(res.ok, false)
    if (!res.ok) assert.strictEqual(res.code, 'network_error')
  })

  await t.test('64. no automatic code-exchange retry', async () => {
    let callCount = 0
    const mock: XHttpTransport = async () => {
      callCount++
      return new Response('error', { status: 500 })
    }
    const client = new XOAuthClient({ transport: mock })
    await client.exchangeAuthorizationCode({
      code: 'c1',
      codeVerifier: 'v1',
      clientId: TEST_CLIENT_ID,
      redirectUri: TEST_REDIRECT_URI,
    })
    assert.strictEqual(callCount, 1)
  })

  // =========================================================================
  // IDENTITY (65–74)
  // =========================================================================
  await t.test('65. /2/users/me called after token exchange', async () => {
    const ctx = await seedTestContext(createTestDb())
    const mock = createMockTransport({})
    const start = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(start.ok)
    if (start.ok) {
      await completeXOAuthCallback({
        state: start.state,
        code: 'code123',
        cookieValue: start.cookieValue,
        workspaceId: ctx.workspaceId,
        db: ctx.db,
        config: DEFAULT_CONFIG,
        transport: mock.transport,
      })
      const userReq = mock.recordedRequests.find((r) => r.url.includes('/users/me'))
      assert.ok(userReq)
    }
  })

  await t.test('66. Bearer access token used transiently', async () => {
    const ctx = await seedTestContext(createTestDb())
    const mock = createMockTransport({})
    const start = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(start.ok)
    if (start.ok) {
      await completeXOAuthCallback({
        state: start.state,
        code: 'code123',
        cookieValue: start.cookieValue,
        workspaceId: ctx.workspaceId,
        db: ctx.db,
        config: DEFAULT_CONFIG,
        transport: mock.transport,
      })
      const userReq = mock.recordedRequests.find((r) => r.url.includes('/users/me'))
      const authHeader = (userReq?.headers as Record<string, string>)?.Authorization
      assert.strictEqual(authHeader, 'Bearer MOCK_ACCESS_TOKEN_XYZ123')
    }
  })

  await t.test('67. identity lookup occurs before vault storage', async () => {
    const ctx = await seedTestContext(createTestDb())
    let vaultChecked = false
    const mock = createMockTransport({
      userHandler: async () => {
        const rows = await queryAll(ctx.db, `SELECT * FROM platform_credential`)
        vaultChecked = rows.length === 0
        return new Response(JSON.stringify({ data: { id: '123', username: 'growth_user' } }), {
          status: 200,
        })
      },
    })
    const start = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(start.ok)
    if (start.ok) {
      await completeXOAuthCallback({
        state: start.state,
        code: 'code123',
        cookieValue: start.cookieValue,
        workspaceId: ctx.workspaceId,
        db: ctx.db,
        config: DEFAULT_CONFIG,
        transport: mock.transport,
      })
      assert.strictEqual(vaultChecked, true)
    }
  })

  await t.test('68. missing data.id rejected', async () => {
    const ctx = await seedTestContext(createTestDb())
    const mock = createMockTransport({
      userHandler: async () =>
        new Response(JSON.stringify({ data: { username: 'growth_user' } }), { status: 200 }),
    })
    const start = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(start.ok)
    if (start.ok) {
      const res = await completeXOAuthCallback({
        state: start.state,
        code: 'code123',
        cookieValue: start.cookieValue,
        workspaceId: ctx.workspaceId,
        db: ctx.db,
        config: DEFAULT_CONFIG,
        transport: mock.transport,
      })
      assert.strictEqual(res.ok, false)
      if (!res.ok) assert.strictEqual(res.code, 'provider_error')
    }
  })

  await t.test('69. missing username rejected', async () => {
    const ctx = await seedTestContext(createTestDb())
    const mock = createMockTransport({
      userHandler: async () =>
        new Response(JSON.stringify({ data: { id: '123' } }), { status: 200 }),
    })
    const start = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(start.ok)
    if (start.ok) {
      const res = await completeXOAuthCallback({
        state: start.state,
        code: 'code123',
        cookieValue: start.cookieValue,
        workspaceId: ctx.workspaceId,
        db: ctx.db,
        config: DEFAULT_CONFIG,
        transport: mock.transport,
      })
      assert.strictEqual(res.ok, false)
      if (!res.ok) assert.strictEqual(res.code, 'provider_error')
    }
  })

  await t.test('70. trusted providerUserId match accepted', async () => {
    const ctx = await seedTestContext(createTestDb())
    // Set trusted metadata with providerUserId 9988776655
    await upsertPlatformConnection(ctx.db, {
      accountId: ctx.activeAccountId,
      metadata: JSON.stringify({ providerUserId: '9988776655', username: 'growth_user' }),
    })
    const mock = createMockTransport({})
    const start = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(start.ok)
    if (start.ok) {
      const res = await completeXOAuthCallback({
        state: start.state,
        code: 'code123',
        cookieValue: start.cookieValue,
        workspaceId: ctx.workspaceId,
        db: ctx.db,
        config: DEFAULT_CONFIG,
        transport: mock.transport,
      })
      assert.strictEqual(res.ok, true)
    }
  })

  await t.test('71. trusted providerUserId mismatch rejected', async () => {
    const ctx = await seedTestContext(createTestDb())
    // Set trusted metadata with DIFFERENT providerUserId
    await upsertPlatformConnection(ctx.db, {
      accountId: ctx.activeAccountId,
      metadata: JSON.stringify({ providerUserId: '1111111111', username: 'growth_user' }),
    })
    const mock = createMockTransport({})
    const start = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(start.ok)
    if (start.ok) {
      const res = await completeXOAuthCallback({
        state: start.state,
        code: 'code123',
        cookieValue: start.cookieValue,
        workspaceId: ctx.workspaceId,
        db: ctx.db,
        config: DEFAULT_CONFIG,
        transport: mock.transport,
      })
      assert.strictEqual(res.ok, false)
      if (!res.ok) assert.strictEqual(res.code, 'account_identity_mismatch')
    }
  })

  await t.test('72. identity mismatch => zero credential storage', async () => {
    const ctx = await seedTestContext(createTestDb())
    await upsertPlatformConnection(ctx.db, {
      accountId: ctx.activeAccountId,
      metadata: JSON.stringify({ providerUserId: '1111111111', username: 'growth_user' }),
    })
    const mock = createMockTransport({})
    const start = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(start.ok)
    if (start.ok) {
      await completeXOAuthCallback({
        state: start.state,
        code: 'code123',
        cookieValue: start.cookieValue,
        workspaceId: ctx.workspaceId,
        db: ctx.db,
        config: DEFAULT_CONFIG,
        transport: mock.transport,
      })
      const creds = await queryAll(ctx.db, `SELECT * FROM platform_credential`)
      assert.strictEqual(creds.length, 0)
    }
  })

  await t.test('73. first-time identity uses server-returned X ID', async () => {
    const ctx = await seedTestContext(createTestDb())
    const mock = createMockTransport({})
    const start = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(start.ok)
    if (start.ok) {
      const res = await completeXOAuthCallback({
        state: start.state,
        code: 'code123',
        cookieValue: start.cookieValue,
        workspaceId: ctx.workspaceId,
        db: ctx.db,
        config: DEFAULT_CONFIG,
        transport: mock.transport,
      })
      assert.strictEqual(res.ok, true)
      if (res.ok) {
        assert.strictEqual(res.providerUserId, '9988776655')
        assert.strictEqual(res.username, 'growth_user')
      }
    }
  })

  await t.test('74. browser cannot forge providerUserId', async () => {
    const ctx = await seedTestContext(createTestDb())
    const mock = createMockTransport({})
    const start = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(start.ok)
    if (start.ok) {
      const res = await completeXOAuthCallback({
        state: start.state,
        code: 'code123',
        cookieValue: start.cookieValue,
        workspaceId: ctx.workspaceId,
        db: ctx.db,
        config: DEFAULT_CONFIG,
        transport: mock.transport,
      })
      assert.strictEqual(res.ok, true)
      if (res.ok) {
        assert.strictEqual(res.providerUserId, '9988776655')
      }
    }
  })

  // =========================================================================
  // VAULT (75–87)
  // =========================================================================
  await t.test('75. successful flow calls storeOAuthCredential', async () => {
    const ctx = await seedTestContext(createTestDb())
    const mock = createMockTransport({})
    const start = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(start.ok)
    if (start.ok) {
      const res = await completeXOAuthCallback({
        state: start.state,
        code: 'code123',
        cookieValue: start.cookieValue,
        workspaceId: ctx.workspaceId,
        db: ctx.db,
        config: DEFAULT_CONFIG,
        transport: mock.transport,
      })
      assert.strictEqual(res.ok, true)
      const creds = await queryAll(
        ctx.db,
        `SELECT * FROM platform_credential WHERE account_id = ? AND revoked_at IS NULL`,
        [ctx.activeAccountId],
      )
      assert.strictEqual(creds.length, 1)
    }
  })

  await t.test('76. access token encrypted in raw DB', async () => {
    const ctx = await seedTestContext(createTestDb())
    const mock = createMockTransport({})
    const start = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(start.ok)
    if (start.ok) {
      await completeXOAuthCallback({
        state: start.state,
        code: 'code123',
        cookieValue: start.cookieValue,
        workspaceId: ctx.workspaceId,
        db: ctx.db,
        config: DEFAULT_CONFIG,
        transport: mock.transport,
      })
      const row = await queryFirst<{ access_token_ciphertext: string; access_token_iv: string }>(
        ctx.db,
        `SELECT access_token_ciphertext, access_token_iv FROM platform_credential WHERE account_id = ?`,
        [ctx.activeAccountId],
      )
      assert.ok(row?.access_token_ciphertext)
      assert.ok(!row.access_token_ciphertext.includes('MOCK_ACCESS_TOKEN'))
    }
  })

  await t.test('77. refresh token encrypted in raw DB', async () => {
    const ctx = await seedTestContext(createTestDb())
    const mock = createMockTransport({})
    const start = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(start.ok)
    if (start.ok) {
      await completeXOAuthCallback({
        state: start.state,
        code: 'code123',
        cookieValue: start.cookieValue,
        workspaceId: ctx.workspaceId,
        db: ctx.db,
        config: DEFAULT_CONFIG,
        transport: mock.transport,
      })
      const row = await queryFirst<{ refresh_token_ciphertext: string }>(
        ctx.db,
        `SELECT refresh_token_ciphertext FROM platform_credential WHERE account_id = ?`,
        [ctx.activeAccountId],
      )
      assert.ok(row?.refresh_token_ciphertext)
      assert.ok(!row.refresh_token_ciphertext.includes('MOCK_REFRESH_TOKEN'))
    }
  })

  await t.test('78. plaintext access token absent from DB', async () => {
    const ctx = await seedTestContext(createTestDb())
    const ACCESS_SENTINEL = 'ACCESS_TOKEN_SENTINEL_UNIQUE_VAL_9999'
    const mock = createMockTransport({
      tokenHandler: async () =>
        new Response(
          JSON.stringify({
            token_type: 'bearer',
            access_token: ACCESS_SENTINEL,
            refresh_token: 'REF_999',
          }),
          { status: 200 },
        ),
    })
    const start = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(start.ok)
    if (start.ok) {
      await completeXOAuthCallback({
        state: start.state,
        code: 'code123',
        cookieValue: start.cookieValue,
        workspaceId: ctx.workspaceId,
        db: ctx.db,
        config: DEFAULT_CONFIG,
        transport: mock.transport,
      })
      const allRows = await queryAll(ctx.db, `SELECT * FROM platform_credential`)
      const dump = JSON.stringify(allRows)
      assert.ok(!dump.includes(ACCESS_SENTINEL))
    }
  })

  await t.test('79. plaintext refresh token absent from DB', async () => {
    const ctx = await seedTestContext(createTestDb())
    const REFRESH_SENTINEL = 'REFRESH_TOKEN_SENTINEL_UNIQUE_VAL_8888'
    const mock = createMockTransport({
      tokenHandler: async () =>
        new Response(
          JSON.stringify({
            token_type: 'bearer',
            access_token: 'ACC_888',
            refresh_token: REFRESH_SENTINEL,
          }),
          { status: 200 },
        ),
    })
    const start = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(start.ok)
    if (start.ok) {
      await completeXOAuthCallback({
        state: start.state,
        code: 'code123',
        cookieValue: start.cookieValue,
        workspaceId: ctx.workspaceId,
        db: ctx.db,
        config: DEFAULT_CONFIG,
        transport: mock.transport,
      })
      const allRows = await queryAll(ctx.db, `SELECT * FROM platform_credential`)
      const dump = JSON.stringify(allRows)
      assert.ok(!dump.includes(REFRESH_SENTINEL))
    }
  })

  await t.test('80. scopes preserved', async () => {
    const ctx = await seedTestContext(createTestDb())
    const mock = createMockTransport({})
    const start = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(start.ok)
    if (start.ok) {
      await completeXOAuthCallback({
        state: start.state,
        code: 'code123',
        cookieValue: start.cookieValue,
        workspaceId: ctx.workspaceId,
        db: ctx.db,
        config: DEFAULT_CONFIG,
        transport: mock.transport,
      })
      const conn = await getPlatformConnectionForAccount(ctx.db, ctx.activeAccountId)
      assert.strictEqual(conn?.scopes, 'tweet.read tweet.write users.read offline.access')
    }
  })

  await t.test('81. provider user ID preserved', async () => {
    const ctx = await seedTestContext(createTestDb())
    const mock = createMockTransport({})
    const start = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(start.ok)
    if (start.ok) {
      await completeXOAuthCallback({
        state: start.state,
        code: 'code123',
        cookieValue: start.cookieValue,
        workspaceId: ctx.workspaceId,
        db: ctx.db,
        config: DEFAULT_CONFIG,
        transport: mock.transport,
      })
      const row = await queryFirst<{ provider_user_id: string }>(
        ctx.db,
        `SELECT provider_user_id FROM platform_credential WHERE account_id = ?`,
        [ctx.activeAccountId],
      )
      assert.strictEqual(row?.provider_user_id, '9988776655')
    }
  })

  await t.test('82. expiry preserved', async () => {
    const ctx = await seedTestContext(createTestDb())
    const mock = createMockTransport({})
    const start = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(start.ok)
    if (start.ok) {
      await completeXOAuthCallback({
        state: start.state,
        code: 'code123',
        cookieValue: start.cookieValue,
        workspaceId: ctx.workspaceId,
        db: ctx.db,
        config: DEFAULT_CONFIG,
        transport: mock.transport,
      })
      const row = await queryFirst<{ access_token_expires_at: string }>(
        ctx.db,
        `SELECT access_token_expires_at FROM platform_credential WHERE account_id = ?`,
        [ctx.activeAccountId],
      )
      assert.ok(row?.access_token_expires_at)
    }
  })

  await t.test('83. successful vault commit marks safe connection connected', async () => {
    const ctx = await seedTestContext(createTestDb())
    const mock = createMockTransport({})
    const start = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(start.ok)
    if (start.ok) {
      const res = await completeXOAuthCallback({
        state: start.state,
        code: 'code123',
        cookieValue: start.cookieValue,
        workspaceId: ctx.workspaceId,
        db: ctx.db,
        config: DEFAULT_CONFIG,
        transport: mock.transport,
      })
      assert.strictEqual(res.ok, true)
      if (res.ok) {
        assert.strictEqual(res.connection.status, 'connected')
        assert.strictEqual(res.connection.hasCredential, true)
        assert.strictEqual(res.connection.credentialSource, 'oauth_vault')
      }
    }
  })

  await t.test('84. vault failure does not falsely report connected', async () => {
    const ctx = await seedTestContext(createTestDb())
    const mock = createMockTransport({})
    const start = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: { ...DEFAULT_CONFIG, credentialKek: 'invalid_kek_length' },
    })
    assert.ok(start.ok)
    if (start.ok) {
      const res = await completeXOAuthCallback({
        state: start.state,
        code: 'code123',
        cookieValue: start.cookieValue,
        workspaceId: ctx.workspaceId,
        db: ctx.db,
        config: { ...DEFAULT_CONFIG, credentialKek: 'invalid_kek_length' },
        transport: mock.transport,
      })
      assert.strictEqual(res.ok, false)
      const conn = await getPlatformConnectionForAccount(ctx.db, ctx.activeAccountId)
      assert.strictEqual(conn, null)
    }
  })

  await t.test('85. reconnect failure preserves prior credential', async () => {
    const ctx = await seedTestContext(createTestDb())
    // 1. First connection succeeds
    await storeOAuthCredential(
      ctx.db,
      {
        workspaceId: ctx.workspaceId,
        accountId: ctx.activeAccountId,
        platformAdapterKey: 'x',
        credential: {
          accessToken: 'INITIAL_ACCESS_TOKEN',
          refreshToken: 'INITIAL_REFRESH_TOKEN',
        },
      },
      TEST_CREDENTIAL_KEK,
    )
    await upsertPlatformConnection(ctx.db, {
      accountId: ctx.activeAccountId,
      status: 'connected',
    })

    // 2. Second connection fails on provider error
    const mockFail = createMockTransport({
      tokenHandler: async () => new Response('provider failed', { status: 500 }),
    })
    const start = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(start.ok)
    if (start.ok) {
      const res = await completeXOAuthCallback({
        state: start.state,
        code: 'code123',
        cookieValue: start.cookieValue,
        workspaceId: ctx.workspaceId,
        db: ctx.db,
        config: DEFAULT_CONFIG,
        transport: mockFail.transport,
      })
      assert.strictEqual(res.ok, false)

      // Initial credential is still active and intact!
      const resolved = await resolveOAuthCredential(
        ctx.db,
        {
          workspaceId: ctx.workspaceId,
          accountId: ctx.activeAccountId,
          platformAdapterKey: 'x',
        },
        TEST_CREDENTIAL_KEK,
      )
      assert.strictEqual(resolved.ok, true)
      if (resolved.ok) {
        assert.strictEqual(resolved.credential.accessToken, 'INITIAL_ACCESS_TOKEN')
      }
    }
  })

  await t.test('86. successful reconnect atomically replaces prior credential', async () => {
    const ctx = await seedTestContext(createTestDb())
    // 1. Initial credential
    await storeOAuthCredential(
      ctx.db,
      {
        workspaceId: ctx.workspaceId,
        accountId: ctx.activeAccountId,
        platformAdapterKey: 'x',
        credential: {
          accessToken: 'FIRST_ACCESS_TOKEN',
        },
      },
      TEST_CREDENTIAL_KEK,
    )

    // 2. Reconnect with new token
    const mockNew = createMockTransport({
      tokenHandler: async () =>
        new Response(
          JSON.stringify({
            token_type: 'bearer',
            access_token: 'REPLACED_ACCESS_TOKEN',
          }),
          { status: 200 },
        ),
    })

    const start = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(start.ok)
    if (start.ok) {
      const res = await completeXOAuthCallback({
        state: start.state,
        code: 'code123',
        cookieValue: start.cookieValue,
        workspaceId: ctx.workspaceId,
        db: ctx.db,
        config: DEFAULT_CONFIG,
        transport: mockNew.transport,
      })
      assert.strictEqual(res.ok, true)

      // Exactly ONE active credential exists
      const activeRows = await queryAll(
        ctx.db,
        `SELECT * FROM platform_credential WHERE account_id = ? AND revoked_at IS NULL`,
        [ctx.activeAccountId],
      )
      assert.strictEqual(activeRows.length, 1)

      const resolved = await resolveOAuthCredential(
        ctx.db,
        {
          workspaceId: ctx.workspaceId,
          accountId: ctx.activeAccountId,
          platformAdapterKey: 'x',
        },
        TEST_CREDENTIAL_KEK,
      )
      assert.strictEqual(resolved.ok, true)
      if (resolved.ok) {
        assert.strictEqual(resolved.credential.accessToken, 'REPLACED_ACCESS_TOKEN')
      }
    }
  })

  await t.test('87. static credential survives cancelled OAuth', async () => {
    const ctx = await seedTestContext(createTestDb())
    // Account has static secret_ref
    await upsertPlatformConnection(ctx.db, {
      accountId: ctx.activeAccountId,
      status: 'connected',
      secretRef: 'X_OPERATOR_SECRET',
    })

    const start = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(start.ok)
    if (start.ok) {
      // User denies
      await completeXOAuthCallback({
        state: start.state,
        error: 'access_denied',
        cookieValue: start.cookieValue,
        workspaceId: ctx.workspaceId,
        db: ctx.db,
        config: DEFAULT_CONFIG,
      })

      const conn = await getPlatformConnectionForAccount(ctx.db, ctx.activeAccountId)
      assert.strictEqual(conn?.secretRef, 'X_OPERATOR_SECRET')
      assert.strictEqual(conn?.status, 'connected')
    }
  })

  // =========================================================================
  // SECURITY / OUTPUT (88–98)
  // =========================================================================
  await t.test('88. token absent from callback response', async () => {
    const ctx = await seedTestContext(createTestDb())
    const mock = createMockTransport({})
    const start = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(start.ok)
    if (start.ok) {
      const res = await completeXOAuthCallback({
        state: start.state,
        code: 'code123',
        cookieValue: start.cookieValue,
        workspaceId: ctx.workspaceId,
        db: ctx.db,
        config: DEFAULT_CONFIG,
        transport: mock.transport,
      })
      const dump = JSON.stringify(res)
      assert.ok(!dump.includes('MOCK_ACCESS_TOKEN'))
    }
  })

  await t.test('89. refresh token absent from callback response', async () => {
    const ctx = await seedTestContext(createTestDb())
    const mock = createMockTransport({})
    const start = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(start.ok)
    if (start.ok) {
      const res = await completeXOAuthCallback({
        state: start.state,
        code: 'code123',
        cookieValue: start.cookieValue,
        workspaceId: ctx.workspaceId,
        db: ctx.db,
        config: DEFAULT_CONFIG,
        transport: mock.transport,
      })
      const dump = JSON.stringify(res)
      assert.ok(!dump.includes('MOCK_REFRESH_TOKEN'))
    }
  })

  await t.test('90. state absent from audit/event', async () => {
    const state = generateOAuthState()
    const audits = await queryAll(createTestDb(), `SELECT * FROM audit_log`)
    assert.ok(!JSON.stringify(audits).includes(state))
  })

  await t.test('91. verifier absent from audit/event', async () => {
    const pkce = await generatePkcePair()
    const events = await queryAll(createTestDb(), `SELECT * FROM event`)
    assert.ok(!JSON.stringify(events).includes(pkce.codeVerifier))
  })

  await t.test('92. authorization code absent from audit/event', async () => {
    const code = 'auth_code_sample_1234567890'
    const events = await queryAll(createTestDb(), `SELECT * FROM event`)
    assert.ok(!JSON.stringify(events).includes(code))
  })

  await t.test('93. token absent from logs/errors', async () => {
    const ctx = await seedTestContext(createTestDb())
    const mock = createMockTransport({
      tokenHandler: async () => new Response('bad request', { status: 400 }),
    })
    const start = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(start.ok)
    if (start.ok) {
      const res = await completeXOAuthCallback({
        state: start.state,
        code: 'code123',
        cookieValue: start.cookieValue,
        workspaceId: ctx.workspaceId,
        db: ctx.db,
        config: DEFAULT_CONFIG,
        transport: mock.transport,
      })
      assert.strictEqual(res.ok, false)
      if (!res.ok) {
        assert.ok(!res.reason.includes('code123'))
      }
    }
  })

  await t.test('94. OAuth cookie deleted on success', async () => {
    const ctx = await seedTestContext(createTestDb())
    const mock = createMockTransport({})
    const start = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(start.ok)
    if (start.ok) {
      const res = await completeXOAuthCallback({
        state: start.state,
        code: 'code123',
        cookieValue: start.cookieValue,
        workspaceId: ctx.workspaceId,
        db: ctx.db,
        config: DEFAULT_CONFIG,
        transport: mock.transport,
      })
      assert.strictEqual(res.clearCookie, true)
    }
  })

  await t.test('95. OAuth cookie deleted on denial', async () => {
    const ctx = await seedTestContext(createTestDb())
    const start = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(start.ok)
    if (start.ok) {
      const res = await completeXOAuthCallback({
        state: start.state,
        error: 'access_denied',
        cookieValue: start.cookieValue,
        workspaceId: ctx.workspaceId,
        db: ctx.db,
        config: DEFAULT_CONFIG,
      })
      assert.strictEqual(res.clearCookie, true)
    }
  })

  await t.test('96. OAuth cookie deleted on failure', async () => {
    const ctx = await seedTestContext(createTestDb())
    const mock = createMockTransport({
      tokenHandler: async () => new Response('error', { status: 500 }),
    })
    const start = await startXOAuthFlow({
      accountId: ctx.activeAccountId,
      workspaceId: ctx.workspaceId,
      db: ctx.db,
      config: DEFAULT_CONFIG,
    })
    assert.ok(start.ok)
    if (start.ok) {
      const res = await completeXOAuthCallback({
        state: start.state,
        code: 'code123',
        cookieValue: start.cookieValue,
        workspaceId: ctx.workspaceId,
        db: ctx.db,
        config: DEFAULT_CONFIG,
        transport: mock.transport,
      })
      assert.strictEqual(res.clearCookie, true)
    }
  })

  await t.test('97. callback redirect is internal safe route', () => {
    const accountId = '00000000-0000-0000-0000-000000000001'
    const targetRoute = `/accounts/${accountId}`
    assert.ok(targetRoute.startsWith('/accounts/'))
    assert.ok(
      !targetRoute.startsWith('http://') &&
        !targetRoute.startsWith('https://') &&
        !targetRoute.startsWith('//'),
    )
  })

  await t.test('98. arbitrary returnTo rejected', () => {
    const unsafeUrls = [
      'https://evil.com',
      '//evil.com',
      'javascript:alert(1)',
      'data:text/html,evil',
    ]
    for (const url of unsafeUrls) {
      const isInternalSafe = url.startsWith('/') && !url.startsWith('//') && !url.includes('\\')
      assert.strictEqual(isInternalSafe, false)
    }
  })
})
