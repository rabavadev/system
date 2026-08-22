/**
 * STEP 15E.3C.1: Secure OAuth Credential Vault Test Suite
 *
 * Validates the encrypted OAuth credential storage foundation:
 * - Web Crypto AES-GCM 256-bit symmetric encryption
 * - Dynamic CSPRNG IVs & Authenticated Associated Data (AAD) binding
 * - Strict tenant isolation & lifecycle eligibility guards
 * - Zero plaintext token persistence in D1 database rows
 * - SafePlatformConnection DTO protection
 * - Deterministic error codes and fail-closed behavior
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import {
  getSafePlatformConnectionForAccount,
  upsertPlatformConnection,
} from '../src/server/db/platform.ts'
import {
  execute,
  newId,
  nowIso,
  queryAll,
  queryFirst,
  type SqlDatabase,
} from '../src/server/db/sql.ts'
import {
  decryptToken,
  encryptToken,
  generateMasterKey,
  importMasterKey,
  parseMasterKey,
} from '../src/server/platforms/credentials/crypto.ts'
import {
  hasActiveOAuthCredential,
  resolveOAuthCredential,
  revokeOAuthCredential,
  rotateOAuthCredential,
  storeOAuthCredential,
} from '../src/server/platforms/credentials/store.ts'
import { resolvePlatformCredential } from '../src/server/platforms/resolver.ts'
import { createEnvSecretResolver } from '../src/server/platforms/runtime.ts'
import type { PlatformSecretResolver } from '../src/server/platforms/types.ts'

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
          }
        },
      }
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

async function setupTestEnvironment(db: SqlDatabase) {
  const now = nowIso()
  const workspaceId = newId()
  const foreignWorkspaceId = newId()

  await execute(
    db,
    `INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, 'Primary WS', 'primary-ws', ?, ?)`,
    [workspaceId, now, now],
  )
  await execute(
    db,
    `INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, 'Foreign WS', 'foreign-ws', ?, ?)`,
    [foreignWorkspaceId, now, now],
  )

  const xPlatformId = newId()
  const pinterestPlatformId = newId()

  await execute(
    db,
    `INSERT INTO platform (id, adapter_key, name, created_at) VALUES (?, 'x', 'X / Twitter', ?)`,
    [xPlatformId, now],
  )
  await execute(
    db,
    `INSERT INTO platform (id, adapter_key, name, created_at) VALUES (?, 'pinterest', 'Pinterest', ?)`,
    [pinterestPlatformId, now],
  )

  const accountId = newId()
  await execute(
    db,
    `INSERT INTO account (id, workspace_id, platform_id, handle, display_name, status, created_at, updated_at)
     VALUES (?, ?, ?, 'test_x_user', 'Test User', 'active', ?, ?)`,
    [accountId, workspaceId, xPlatformId, now, now],
  )

  const account2Id = newId()
  await execute(
    db,
    `INSERT INTO account (id, workspace_id, platform_id, handle, display_name, status, created_at, updated_at)
     VALUES (?, ?, ?, 'test_x_user_2', 'Test User 2', 'active', ?, ?)`,
    [account2Id, workspaceId, xPlatformId, now, now],
  )

  const foreignAccountId = newId()
  await execute(
    db,
    `INSERT INTO account (id, workspace_id, platform_id, handle, display_name, status, created_at, updated_at)
     VALUES (?, ?, ?, 'foreign_x_user', 'Foreign User', 'active', ?, ?)`,
    [foreignAccountId, foreignWorkspaceId, xPlatformId, now, now],
  )

  // Seed connection for primary account
  await upsertPlatformConnection(db, {
    accountId,
    status: 'connected',
  })

  await upsertPlatformConnection(db, {
    accountId: account2Id,
    status: 'connected',
  })

  await upsertPlatformConnection(db, {
    accountId: foreignAccountId,
    status: 'connected',
  })

  const masterKey = generateMasterKey()

  return {
    workspaceId,
    foreignWorkspaceId,
    xPlatformId,
    pinterestPlatformId,
    accountId,
    account2Id,
    foreignAccountId,
    masterKey,
  }
}

test('STEP 15E.3C.1: Secure OAuth Credential Vault Test Suite', async (t) => {
  // 1. valid key imports successfully
  await t.test('1. Valid 256-bit symmetric key imports successfully', async () => {
    const rawBase64Key = generateMasterKey()
    const cryptoKey = await importMasterKey(rawBase64Key)
    assert.ok(cryptoKey)
    assert.equal(cryptoKey.algorithm.name, 'AES-GCM')
    assert.equal(cryptoKey.extractable, false)
  })

  // 2. missing key fails closed
  await t.test(
    '2. Missing master key fails closed with credential_vault_not_configured',
    async () => {
      assert.throws(() => parseMasterKey(''), /credential_vault_not_configured/)
    },
  )

  // 3. malformed key fails closed
  await t.test('3. Malformed / wrong length key fails closed', async () => {
    // 16 bytes base64 (too short for 256-bit AES-GCM)
    const shortKey = btoa('1234567890123456')
    assert.throws(() => parseMasterKey(shortKey), /credential_vault_not_configured/)
    assert.throws(
      () => parseMasterKey('not-valid-base64-!@#$%^&*()'),
      /credential_vault_not_configured/,
    )
  })

  // 4. plaintext access token encrypts
  await t.test('4. Plaintext access token encrypts into ciphertext and IV', async () => {
    const masterKey = generateMasterKey()
    const cryptoKey = await importMasterKey(masterKey)
    const aadCtx = {
      workspaceId: 'ws-1',
      accountId: 'acc-1',
      platformAdapterKey: 'x',
      keyVersion: 1,
    }

    const encrypted = await encryptToken('my-secret-access-token-12345', cryptoKey, aadCtx)
    assert.ok(encrypted.ciphertext)
    assert.ok(encrypted.iv)
    assert.notEqual(encrypted.ciphertext, 'my-secret-access-token-12345')
  })

  // 5. persisted representation does not contain plaintext access token
  await t.test(
    '5. Persisted database row does not contain plaintext access token sentinel',
    async () => {
      const db = createTestDb()
      const env = await setupTestEnvironment(db)
      const sentinel = 'ACCESS_TOKEN_SENTINEL_ALPHA_998877'

      const storeRes = await storeOAuthCredential(
        db,
        {
          workspaceId: env.workspaceId,
          accountId: env.accountId,
          platformAdapterKey: 'x',
          credential: {
            accessToken: sentinel,
          },
        },
        env.masterKey,
      )
      assert.equal(storeRes.ok, true)

      const rawRow = await queryFirst<Record<string, unknown>>(
        db,
        `SELECT * FROM platform_credential WHERE account_id = ? AND revoked_at IS NULL`,
        [env.accountId],
      )
      assert.ok(rawRow)

      const rowSerialized = JSON.stringify(rawRow)
      assert.equal(
        rowSerialized.includes(sentinel),
        false,
        'Raw database row must NEVER contain plaintext access token sentinel',
      )
    },
  )

  // 6. plaintext refresh token encrypts
  await t.test('6. Plaintext refresh token encrypts into separate ciphertext and IV', async () => {
    const masterKey = generateMasterKey()
    const cryptoKey = await importMasterKey(masterKey)
    const aadCtx = {
      workspaceId: 'ws-1',
      accountId: 'acc-1',
      platformAdapterKey: 'x',
      keyVersion: 1,
    }

    const encAccess = await encryptToken('access-token', cryptoKey, aadCtx)
    const encRefresh = await encryptToken('refresh-token-val', cryptoKey, aadCtx)

    assert.ok(encRefresh.ciphertext)
    assert.ok(encRefresh.iv)
    assert.notEqual(encRefresh.ciphertext, 'refresh-token-val')
    assert.notEqual(encAccess.ciphertext, encRefresh.ciphertext)
    assert.notEqual(encAccess.iv, encRefresh.iv)
  })

  // 7. persisted representation does not contain plaintext refresh token
  await t.test(
    '7. Persisted database row does not contain plaintext refresh token sentinel',
    async () => {
      const db = createTestDb()
      const env = await setupTestEnvironment(db)
      const accessSentinel = 'ACCESS_TOKEN_SENTINEL_A'
      const refreshSentinel = 'REFRESH_TOKEN_SENTINEL_Z_554433'

      const storeRes = await storeOAuthCredential(
        db,
        {
          workspaceId: env.workspaceId,
          accountId: env.accountId,
          platformAdapterKey: 'x',
          credential: {
            accessToken: accessSentinel,
            refreshToken: refreshSentinel,
          },
        },
        env.masterKey,
      )
      assert.equal(storeRes.ok, true)

      const rawRow = await queryFirst<Record<string, unknown>>(
        db,
        `SELECT * FROM platform_credential WHERE account_id = ? AND revoked_at IS NULL`,
        [env.accountId],
      )
      assert.ok(rawRow)

      const rowSerialized = JSON.stringify(rawRow)
      assert.equal(
        rowSerialized.includes(refreshSentinel),
        false,
        'Raw database row must NEVER contain plaintext refresh token sentinel',
      )
      assert.equal(
        rowSerialized.includes(accessSentinel),
        false,
        'Raw database row must NEVER contain plaintext access token sentinel',
      )
    },
  )

  // 8. decrypt returns exact access token
  await t.test('8. Decrypt returns exact original access token', async () => {
    const db = createTestDb()
    const env = await setupTestEnvironment(db)
    const expectedToken = 'exact_secret_access_token_12345_!@#$%^&*'

    await storeOAuthCredential(
      db,
      {
        workspaceId: env.workspaceId,
        accountId: env.accountId,
        platformAdapterKey: 'x',
        credential: {
          accessToken: expectedToken,
        },
      },
      env.masterKey,
    )

    const resolveRes = await resolveOAuthCredential(
      db,
      {
        workspaceId: env.workspaceId,
        accountId: env.accountId,
        platformAdapterKey: 'x',
      },
      env.masterKey,
    )

    assert.equal(resolveRes.ok, true)
    if (resolveRes.ok) {
      assert.equal(resolveRes.credential.accessToken, expectedToken)
    }
  })

  // 9. decrypt returns exact refresh token
  await t.test('9. Decrypt returns exact original refresh token', async () => {
    const db = createTestDb()
    const env = await setupTestEnvironment(db)
    const expectedAccess = 'exact_access_token'
    const expectedRefresh = 'exact_refresh_token_778899_secret'

    await storeOAuthCredential(
      db,
      {
        workspaceId: env.workspaceId,
        accountId: env.accountId,
        platformAdapterKey: 'x',
        credential: {
          accessToken: expectedAccess,
          refreshToken: expectedRefresh,
        },
      },
      env.masterKey,
    )

    const resolveRes = await resolveOAuthCredential(
      db,
      {
        workspaceId: env.workspaceId,
        accountId: env.accountId,
        platformAdapterKey: 'x',
      },
      env.masterKey,
    )

    assert.equal(resolveRes.ok, true)
    if (resolveRes.ok) {
      assert.equal(resolveRes.credential.accessToken, expectedAccess)
      assert.equal(resolveRes.credential.refreshToken, expectedRefresh)
    }
  })

  // 10. unique random IV used across encryptions
  await t.test('10. Unique random IV generated on every encryption call', async () => {
    const masterKey = generateMasterKey()
    const cryptoKey = await importMasterKey(masterKey)
    const aadCtx = {
      workspaceId: 'ws-1',
      accountId: 'acc-1',
      platformAdapterKey: 'x',
      keyVersion: 1,
    }

    const ivs = new Set<string>()
    for (let i = 0; i < 20; i++) {
      const enc = await encryptToken('constant-token-string', cryptoKey, aadCtx)
      assert.equal(ivs.has(enc.iv), false, 'IV collision detected')
      ivs.add(enc.iv)
    }
    assert.equal(ivs.size, 20)
  })

  // 11. same token encrypted twice produces different ciphertext
  await t.test(
    '11. Same token encrypted twice produces distinct ciphertexts (probabilistic encryption)',
    async () => {
      const masterKey = generateMasterKey()
      const cryptoKey = await importMasterKey(masterKey)
      const aadCtx = {
        workspaceId: 'ws-1',
        accountId: 'acc-1',
        platformAdapterKey: 'x',
        keyVersion: 1,
      }

      const enc1 = await encryptToken('identical-token', cryptoKey, aadCtx)
      const enc2 = await encryptToken('identical-token', cryptoKey, aadCtx)

      assert.notEqual(enc1.ciphertext, enc2.ciphertext)
      assert.notEqual(enc1.iv, enc2.iv)

      // Both decrypt to identical plaintext
      const dec1 = await decryptToken(enc1.ciphertext, enc1.iv, cryptoKey, aadCtx)
      const dec2 = await decryptToken(enc2.ciphertext, enc2.iv, cryptoKey, aadCtx)
      assert.equal(dec1, 'identical-token')
      assert.equal(dec2, 'identical-token')
    },
  )

  // 12. tampered ciphertext rejected
  await t.test('12. Tampered ciphertext rejected with credential_corrupt', async () => {
    const db = createTestDb()
    const env = await setupTestEnvironment(db)

    await storeOAuthCredential(
      db,
      {
        workspaceId: env.workspaceId,
        accountId: env.accountId,
        platformAdapterKey: 'x',
        credential: { accessToken: 'valid-token' },
      },
      env.masterKey,
    )

    // Tamper with ciphertext in DB
    await execute(
      db,
      `UPDATE platform_credential SET access_token_ciphertext = 'dGFtcGVyZWQtY2lwaGVydGV4dAo=' WHERE account_id = ?`,
      [env.accountId],
    )

    const resolveRes = await resolveOAuthCredential(
      db,
      {
        workspaceId: env.workspaceId,
        accountId: env.accountId,
        platformAdapterKey: 'x',
      },
      env.masterKey,
    )

    assert.equal(resolveRes.ok, false)
    if (!resolveRes.ok) {
      assert.equal(resolveRes.code, 'credential_corrupt')
    }
  })

  // 13. tampered IV rejected
  await t.test('13. Tampered IV rejected with credential_corrupt', async () => {
    const db = createTestDb()
    const env = await setupTestEnvironment(db)

    await storeOAuthCredential(
      db,
      {
        workspaceId: env.workspaceId,
        accountId: env.accountId,
        platformAdapterKey: 'x',
        credential: { accessToken: 'valid-token' },
      },
      env.masterKey,
    )

    // Tamper with IV in DB
    await execute(
      db,
      `UPDATE platform_credential SET access_token_iv = 'dGFtcGVyZWQtaXYxMgo=' WHERE account_id = ?`,
      [env.accountId],
    )

    const resolveRes = await resolveOAuthCredential(
      db,
      {
        workspaceId: env.workspaceId,
        accountId: env.accountId,
        platformAdapterKey: 'x',
      },
      env.masterKey,
    )

    assert.equal(resolveRes.ok, false)
    if (!resolveRes.ok) {
      assert.equal(resolveRes.code, 'credential_corrupt')
    }
  })

  // 14. wrong master key rejected
  await t.test('14. Wrong master key rejected with credential_corrupt', async () => {
    const db = createTestDb()
    const env = await setupTestEnvironment(db)
    const wrongKey = generateMasterKey()

    await storeOAuthCredential(
      db,
      {
        workspaceId: env.workspaceId,
        accountId: env.accountId,
        platformAdapterKey: 'x',
        credential: { accessToken: 'valid-token' },
      },
      env.masterKey,
    )

    const resolveRes = await resolveOAuthCredential(
      db,
      {
        workspaceId: env.workspaceId,
        accountId: env.accountId,
        platformAdapterKey: 'x',
      },
      wrongKey,
    )

    assert.equal(resolveRes.ok, false)
    if (!resolveRes.ok) {
      assert.equal(resolveRes.code, 'credential_corrupt')
    }
  })

  // 15. wrong workspace AAD rejected
  await t.test(
    '15. Wrong workspace AAD context rejected (ciphertext copy prevention)',
    async () => {
      const masterKey = generateMasterKey()
      const cryptoKey = await importMasterKey(masterKey)

      const enc = await encryptToken('token-ws1', cryptoKey, {
        workspaceId: 'ws-1',
        accountId: 'acc-1',
        platformAdapterKey: 'x',
        keyVersion: 1,
      })

      // Attempt to decrypt with different workspaceId in AAD
      await assert.rejects(
        () =>
          decryptToken(enc.ciphertext, enc.iv, cryptoKey, {
            workspaceId: 'ws-2',
            accountId: 'acc-1',
            platformAdapterKey: 'x',
            keyVersion: 1,
          }),
        /OperationError|decrypt/,
      )
    },
  )

  // 16. wrong account AAD rejected
  await t.test('16. Wrong account AAD context rejected (AAD swap protection)', async () => {
    const masterKey = generateMasterKey()
    const cryptoKey = await importMasterKey(masterKey)

    const enc = await encryptToken('token-acc1', cryptoKey, {
      workspaceId: 'ws-1',
      accountId: 'acc-1',
      platformAdapterKey: 'x',
      keyVersion: 1,
    })

    // Attempt to decrypt with different accountId in AAD
    await assert.rejects(
      () =>
        decryptToken(enc.ciphertext, enc.iv, cryptoKey, {
          workspaceId: 'ws-1',
          accountId: 'acc-2',
          platformAdapterKey: 'x',
          keyVersion: 1,
        }),
      /OperationError|decrypt/,
    )
  })

  // 17. wrong platform AAD rejected
  await t.test(
    '17. Wrong platform AAD context rejected (cross-platform copy prevention)',
    async () => {
      const masterKey = generateMasterKey()
      const cryptoKey = await importMasterKey(masterKey)

      const enc = await encryptToken('token-x', cryptoKey, {
        workspaceId: 'ws-1',
        accountId: 'acc-1',
        platformAdapterKey: 'x',
        keyVersion: 1,
      })

      // Attempt to decrypt with platform 'pinterest'
      await assert.rejects(
        () =>
          decryptToken(enc.ciphertext, enc.iv, cryptoKey, {
            workspaceId: 'ws-1',
            accountId: 'acc-1',
            platformAdapterKey: 'pinterest',
            keyVersion: 1,
          }),
        /OperationError|decrypt/,
      )
    },
  )

  // 18. unknown key version rejected
  await t.test('18. Unknown key version rejected fail-closed', async () => {
    const db = createTestDb()
    const env = await setupTestEnvironment(db)

    await storeOAuthCredential(
      db,
      {
        workspaceId: env.workspaceId,
        accountId: env.accountId,
        platformAdapterKey: 'x',
        credential: { accessToken: 'valid-token' },
      },
      env.masterKey,
    )

    // Set key_version to 999 in DB
    await execute(db, `UPDATE platform_credential SET key_version = 999 WHERE account_id = ?`, [
      env.accountId,
    ])

    const resolveRes = await resolveOAuthCredential(
      db,
      {
        workspaceId: env.workspaceId,
        accountId: env.accountId,
        platformAdapterKey: 'x',
      },
      env.masterKey,
    )

    assert.equal(resolveRes.ok, false)
    if (!resolveRes.ok) {
      assert.equal(resolveRes.code, 'credential_unknown_key_version')
    }
  })

  // 19. cross-workspace credential lookup rejected
  await t.test('19. Cross-workspace credential lookup rejected (tenant isolation)', async () => {
    const db = createTestDb()
    const env = await setupTestEnvironment(db)

    await storeOAuthCredential(
      db,
      {
        workspaceId: env.workspaceId,
        accountId: env.accountId,
        platformAdapterKey: 'x',
        credential: { accessToken: 'valid-token' },
      },
      env.masterKey,
    )

    // Attempt to resolve env.accountId (belongs to primary workspace) from foreign workspace
    const resolveRes = await resolveOAuthCredential(
      db,
      {
        workspaceId: env.foreignWorkspaceId,
        accountId: env.accountId,
        platformAdapterKey: 'x',
      },
      env.masterKey,
    )

    assert.equal(resolveRes.ok, false)
    if (!resolveRes.ok) {
      assert.equal(resolveRes.code, 'account_not_found')
    }
  })

  // 20. foreign Account causes zero decrypt attempt
  await t.test('20. Foreign account causes zero decrypt attempt', async () => {
    const db = createTestDb()
    const env = await setupTestEnvironment(db)

    let decryptAttempted = false
    const recordingKeySource: PlatformSecretResolver = {
      resolveSecret() {
        decryptAttempted = true
        return env.masterKey
      },
    }

    const resolveRes = await resolveOAuthCredential(
      db,
      {
        workspaceId: env.foreignWorkspaceId,
        accountId: env.accountId,
        platformAdapterKey: 'x',
      },
      recordingKeySource,
    )

    assert.equal(resolveRes.ok, false)
    assert.equal(
      decryptAttempted,
      false,
      'Master key resolution / decrypt must NEVER occur for foreign accounts',
    )
  })

  // 21. deleted Account rejected
  await t.test('21. Deleted Account rejected with account_ineligible', async () => {
    const db = createTestDb()
    const env = await setupTestEnvironment(db)

    await storeOAuthCredential(
      db,
      {
        workspaceId: env.workspaceId,
        accountId: env.accountId,
        platformAdapterKey: 'x',
        credential: { accessToken: 'valid-token' },
      },
      env.masterKey,
    )

    // Soft-delete account
    await execute(db, `UPDATE account SET deleted_at = ? WHERE id = ?`, [nowIso(), env.accountId])

    const resolveRes = await resolveOAuthCredential(
      db,
      {
        workspaceId: env.workspaceId,
        accountId: env.accountId,
        platformAdapterKey: 'x',
      },
      env.masterKey,
    )

    assert.equal(resolveRes.ok, false)
    if (!resolveRes.ok) {
      assert.equal(resolveRes.code, 'account_ineligible')
    }
  })

  // 22. inactive Account rejected
  await t.test(
    '22. Paused / disconnected / archived Account rejected with account_ineligible',
    async () => {
      const db = createTestDb()
      const env = await setupTestEnvironment(db)

      await storeOAuthCredential(
        db,
        {
          workspaceId: env.workspaceId,
          accountId: env.accountId,
          platformAdapterKey: 'x',
          credential: { accessToken: 'valid-token' },
        },
        env.masterKey,
      )

      for (const status of ['paused', 'disconnected', 'archived']) {
        await execute(db, `UPDATE account SET status = ? WHERE id = ?`, [status, env.accountId])
        const resolveRes = await resolveOAuthCredential(
          db,
          {
            workspaceId: env.workspaceId,
            accountId: env.accountId,
            platformAdapterKey: 'x',
          },
          env.masterKey,
        )

        assert.equal(resolveRes.ok, false)
        if (!resolveRes.ok) {
          assert.equal(resolveRes.code, 'account_ineligible')
        }
      }
    },
  )

  // 23. disconnected connection rejected
  await t.test(
    '23. Disconnected / expired / error connection rejected with connection_inactive',
    async () => {
      const db = createTestDb()
      const env = await setupTestEnvironment(db)

      await storeOAuthCredential(
        db,
        {
          workspaceId: env.workspaceId,
          accountId: env.accountId,
          platformAdapterKey: 'x',
          credential: { accessToken: 'valid-token' },
        },
        env.masterKey,
      )

      for (const status of ['disconnected', 'expired', 'error']) {
        await execute(db, `UPDATE platform_connection SET status = ? WHERE account_id = ?`, [
          status,
          env.accountId,
        ])
        const resolveRes = await resolveOAuthCredential(
          db,
          {
            workspaceId: env.workspaceId,
            accountId: env.accountId,
            platformAdapterKey: 'x',
          },
          env.masterKey,
        )

        assert.equal(resolveRes.ok, false)
        if (!resolveRes.ok) {
          assert.equal(resolveRes.code, 'connection_inactive')
        }
      }
    },
  )

  // 24. revoked credential cannot resolve
  await t.test('24. Revoked credential cannot resolve (returns credential_not_found)', async () => {
    const db = createTestDb()
    const env = await setupTestEnvironment(db)

    await storeOAuthCredential(
      db,
      {
        workspaceId: env.workspaceId,
        accountId: env.accountId,
        platformAdapterKey: 'x',
        credential: { accessToken: 'token-to-revoke' },
      },
      env.masterKey,
    )

    // Verify active
    const before = await hasActiveOAuthCredential(db, env.accountId)
    assert.equal(before, true)

    // Revoke
    const revokeRes = await revokeOAuthCredential(db, {
      workspaceId: env.workspaceId,
      accountId: env.accountId,
      platformAdapterKey: 'x',
    })
    assert.equal(revokeRes.ok, true)

    // Verify inactive
    const after = await hasActiveOAuthCredential(db, env.accountId)
    assert.equal(after, false)

    const resolveRes = await resolveOAuthCredential(
      db,
      {
        workspaceId: env.workspaceId,
        accountId: env.accountId,
        platformAdapterKey: 'x',
      },
      env.masterKey,
    )

    assert.equal(resolveRes.ok, false)
    if (!resolveRes.ok) {
      assert.equal(resolveRes.code, 'credential_not_found')
    }
  })

  // 25. safe DTO exposes hasCredential
  await t.test(
    '25. SafePlatformConnection DTO exposes hasCredential: true and credentialSource: oauth_vault',
    async () => {
      const db = createTestDb()
      const env = await setupTestEnvironment(db)

      await storeOAuthCredential(
        db,
        {
          workspaceId: env.workspaceId,
          accountId: env.accountId,
          platformAdapterKey: 'x',
          credential: { accessToken: 'valid-token', scopes: 'tweet.read tweet.write' },
        },
        env.masterKey,
      )

      const safeConn = await getSafePlatformConnectionForAccount(db, env.accountId)
      assert.ok(safeConn)
      assert.equal(safeConn.hasCredential, true)
      assert.equal(safeConn.credentialSource, 'oauth_vault')
      assert.equal(safeConn.scopes, 'tweet.read tweet.write')
    },
  )

  // 26. safe DTO does not expose accessToken
  await t.test('26. SafePlatformConnection DTO never exposes raw accessToken', async () => {
    const db = createTestDb()
    const env = await setupTestEnvironment(db)

    await storeOAuthCredential(
      db,
      {
        workspaceId: env.workspaceId,
        accountId: env.accountId,
        platformAdapterKey: 'x',
        credential: { accessToken: 'token-secret-alpha', refreshToken: 'refresh-secret-beta' },
      },
      env.masterKey,
    )

    const safeConn = await getSafePlatformConnectionForAccount(db, env.accountId)
    assert.ok(safeConn)
    assert.equal('accessToken' in safeConn, false)
    assert.equal(JSON.stringify(safeConn).includes('token-secret-alpha'), false)
  })

  // 27. safe DTO does not expose refreshToken
  await t.test('27. SafePlatformConnection DTO never exposes raw refreshToken', async () => {
    const db = createTestDb()
    const env = await setupTestEnvironment(db)

    await storeOAuthCredential(
      db,
      {
        workspaceId: env.workspaceId,
        accountId: env.accountId,
        platformAdapterKey: 'x',
        credential: { accessToken: 'token-secret-alpha', refreshToken: 'refresh-secret-beta' },
      },
      env.masterKey,
    )

    const safeConn = await getSafePlatformConnectionForAccount(db, env.accountId)
    assert.ok(safeConn)
    assert.equal('refreshToken' in safeConn, false)
    assert.equal(JSON.stringify(safeConn).includes('refresh-secret-beta'), false)
  })

  // 28. safe DTO does not expose secretRef or secretValue
  await t.test(
    '28. SafePlatformConnection DTO never exposes secretRef or secretValue',
    async () => {
      const db = createTestDb()
      const env = await setupTestEnvironment(db)

      await storeOAuthCredential(
        db,
        {
          workspaceId: env.workspaceId,
          accountId: env.accountId,
          platformAdapterKey: 'x',
          credential: { accessToken: 'token-secret-alpha' },
        },
        env.masterKey,
      )

      const safeConn = await getSafePlatformConnectionForAccount(db, env.accountId)
      assert.ok(safeConn)
      assert.equal('secretRef' in safeConn, false)
      assert.equal('secretValue' in safeConn, false)
    },
  )

  // 29. safe DTO does not expose ciphertext, iv, or aad
  await t.test('29. SafePlatformConnection DTO never exposes ciphertext, iv, or aad', async () => {
    const db = createTestDb()
    const env = await setupTestEnvironment(db)

    await storeOAuthCredential(
      db,
      {
        workspaceId: env.workspaceId,
        accountId: env.accountId,
        platformAdapterKey: 'x',
        credential: { accessToken: 'token-secret-alpha' },
      },
      env.masterKey,
    )

    const safeConn = await getSafePlatformConnectionForAccount(db, env.accountId)
    assert.ok(safeConn)
    assert.equal('ciphertext' in safeConn, false)
    assert.equal('iv' in safeConn, false)
    assert.equal('aad' in safeConn, false)
  })

  // 30. safe DTO does not expose master key material
  await t.test('30. SafePlatformConnection DTO never exposes master key material', async () => {
    const db = createTestDb()
    const env = await setupTestEnvironment(db)

    await storeOAuthCredential(
      db,
      {
        workspaceId: env.workspaceId,
        accountId: env.accountId,
        platformAdapterKey: 'x',
        credential: { accessToken: 'token-secret-alpha' },
      },
      env.masterKey,
    )

    const safeConn = await getSafePlatformConnectionForAccount(db, env.accountId)
    assert.ok(safeConn)
    assert.equal('masterKey' in safeConn, false)
    assert.equal('kek' in safeConn, false)
  })

  // 31. error reasons contain no plaintext token leaks
  await t.test(
    '31. Error reasons on corrupt resolution contain zero plaintext token leaks',
    async () => {
      const db = createTestDb()
      const env = await setupTestEnvironment(db)
      const badTokenSentinel = 'LEAK_CHECK_SENTINEL_TOKEN_SECRET_99'

      await storeOAuthCredential(
        db,
        {
          workspaceId: env.workspaceId,
          accountId: env.accountId,
          platformAdapterKey: 'x',
          credential: { accessToken: badTokenSentinel },
        },
        env.masterKey,
      )

      const resolveRes = await resolveOAuthCredential(
        db,
        {
          workspaceId: env.workspaceId,
          accountId: env.accountId,
          platformAdapterKey: 'x',
        },
        'invalid-key-that-causes-failure-12345678901234567890123456789012',
      )

      assert.equal(resolveRes.ok, false)
      if (!resolveRes.ok) {
        assert.equal(resolveRes.reason.includes(badTokenSentinel), false)
        assert.equal(JSON.stringify(resolveRes).includes(badTokenSentinel), false)
      }
    },
  )

  // 32. audit logs contain no plaintext token leaks
  await t.test(
    '32. Audit log records on credential store contain zero plaintext token leaks',
    async () => {
      const db = createTestDb()
      const env = await setupTestEnvironment(db)
      const auditSentinel = 'AUDIT_LOG_SECRET_TOKEN_SENTINEL_4455'

      await storeOAuthCredential(
        db,
        {
          workspaceId: env.workspaceId,
          accountId: env.accountId,
          platformAdapterKey: 'x',
          credential: { accessToken: auditSentinel, refreshToken: `${auditSentinel}_REF` },
        },
        env.masterKey,
      )

      const auditLogs = await queryAll<{
        action: string
        entity_type: string
        new_value: string | null
      }>(db, `SELECT action, entity_type, new_value FROM audit_log WHERE workspace_id = ?`, [
        env.workspaceId,
      ])

      for (const log of auditLogs) {
        const json = JSON.stringify(log)
        assert.equal(json.includes(auditSentinel), false)
      }
    },
  )

  // 33. domain events contain no plaintext token leaks
  await t.test(
    '33. Domain events on credential store contain zero plaintext token leaks',
    async () => {
      const db = createTestDb()
      const env = await setupTestEnvironment(db)
      const eventSentinel = 'EVENT_SECRET_TOKEN_SENTINEL_7788'

      await storeOAuthCredential(
        db,
        {
          workspaceId: env.workspaceId,
          accountId: env.accountId,
          platformAdapterKey: 'x',
          credential: { accessToken: eventSentinel },
        },
        env.masterKey,
      )

      const events = await queryAll<{ event_type: string; payload: string | null }>(
        db,
        `SELECT event_type, payload FROM event WHERE workspace_id = ?`,
        [env.workspaceId],
      )

      for (const ev of events) {
        const json = JSON.stringify(ev)
        assert.equal(json.includes(eventSentinel), false)
      }
    },
  )

  // 34. token-like metadata remains rejected by upsertPlatformConnection
  await t.test(
    '34. Token-shaped strings remain strictly rejected in platform_connection.metadata',
    async () => {
      const db = createTestDb()
      const env = await setupTestEnvironment(db)

      await assert.rejects(
        () =>
          upsertPlatformConnection(db, {
            accountId: env.accountId,
            metadata: '{"accessToken": "plain-secret-token"}',
          }),
        /Platform connection metadata must not contain secret tokens/,
      )

      await assert.rejects(
        () =>
          upsertPlatformConnection(db, {
            accountId: env.accountId,
            metadata: '{"authorization": "Bearer secret"}',
          }),
        /Platform connection metadata must not contain secret tokens/,
      )
    },
  )

  // 35. static secret_ref credentials still resolve via resolvePlatformCredential
  await t.test(
    '35. Static secret_ref operator credentials still resolve cleanly via resolvePlatformCredential',
    async () => {
      const db = createTestDb()
      const env = await setupTestEnvironment(db)

      // Configure static secret_ref connection (no row in platform_credential)
      await upsertPlatformConnection(db, {
        accountId: env.accountId,
        status: 'connected',
        secretRef: 'X_OPERATOR_STATIC_SECRET',
      })

      const secretResolver = createEnvSecretResolver({
        X_OPERATOR_STATIC_SECRET: 'static-operator-token-value',
      })

      const res = await resolvePlatformCredential(
        db,
        {
          workspaceId: env.workspaceId,
          accountId: env.accountId,
          platformAdapterKey: 'x',
        },
        secretResolver,
      )

      assert.equal(res.ok, true)
      if (res.ok) {
        assert.equal(res.credential.secretRef, 'X_OPERATOR_STATIC_SECRET')
        assert.equal(res.credential.secretValue, 'static-operator-token-value')
        assert.equal(res.credential.platformAdapterKey, 'x')
      }
    },
  )

  // 36. existing X publishing tests remain compatible (vault credentials resolve with X-authorized prefix)
  await t.test(
    '36. Vault credentials resolved through resolvePlatformCredential carry provider-bound prefix for X adapter',
    async () => {
      const db = createTestDb()
      const env = await setupTestEnvironment(db)

      await storeOAuthCredential(
        db,
        {
          workspaceId: env.workspaceId,
          accountId: env.accountId,
          platformAdapterKey: 'x',
          credential: {
            accessToken: 'oauth-token-for-x-publishing',
            providerUserId: 'x-uid-1001',
          },
        },
        env.masterKey,
      )

      const res = await resolvePlatformCredential(
        db,
        {
          workspaceId: env.workspaceId,
          accountId: env.accountId,
          platformAdapterKey: 'x',
        },
        { kek: env.masterKey },
      )

      assert.equal(res.ok, true)
      if (res.ok) {
        assert.equal(res.credential.secretRef, 'X_OAUTH_VAULT')
        assert.equal(res.credential.secretValue, 'oauth-token-for-x-publishing')
        assert.equal(res.credential.platformAdapterKey, 'x')
        // biome-ignore lint/complexity/useLiteralKeys: required by tsconfig noPropertyAccessFromIndexSignature
        assert.equal(res.credential.metadata?.['providerUserId'], 'x-uid-1001')
        // biome-ignore lint/complexity/useLiteralKeys: required by tsconfig noPropertyAccessFromIndexSignature
        assert.equal(res.credential.metadata?.['credentialSource'], 'oauth_vault')
      }
    },
  )

  // 37. one active credential invariant enforced
  await t.test(
    '37. One active credential invariant enforced: storing new credential revokes prior',
    async () => {
      const db = createTestDb()
      const env = await setupTestEnvironment(db)

      const res1 = await storeOAuthCredential(
        db,
        {
          workspaceId: env.workspaceId,
          accountId: env.accountId,
          platformAdapterKey: 'x',
          credential: { accessToken: 'token-v1' },
        },
        env.masterKey,
      )
      assert.equal(res1.ok, true)

      const res2 = await storeOAuthCredential(
        db,
        {
          workspaceId: env.workspaceId,
          accountId: env.accountId,
          platformAdapterKey: 'x',
          credential: { accessToken: 'token-v2' },
        },
        env.masterKey,
      )
      assert.equal(res2.ok, true)

      // Check database rows
      const rows = await queryAll<{ id: string; revoked_at: string | null }>(
        db,
        `SELECT id, revoked_at FROM platform_credential WHERE account_id = ? ORDER BY created_at ASC`,
        [env.accountId],
      )

      assert.equal(rows.length, 2)
      assert.notEqual(rows[0]?.revoked_at, null, 'First credential must be marked revoked')
      assert.equal(rows[1]?.revoked_at, null, 'Second credential must be active')

      // Resolving returns v2
      const resolveRes = await resolveOAuthCredential(
        db,
        {
          workspaceId: env.workspaceId,
          accountId: env.accountId,
          platformAdapterKey: 'x',
        },
        env.masterKey,
      )
      assert.equal(resolveRes.ok, true)
      if (resolveRes.ok) {
        assert.equal(resolveRes.credential.accessToken, 'token-v2')
      }
    },
  )

  // 38. Credential replacement atomicity
  await t.test(
    '38. Credential replacement atomicity: failure during replacement rolls back and preserves prior active credential',
    async () => {
      const db = createTestDb()
      const env = await setupTestEnvironment(db)

      // Store initial valid credential
      const initialStore = await storeOAuthCredential(
        db,
        {
          workspaceId: env.workspaceId,
          accountId: env.accountId,
          platformAdapterKey: 'x',
          credential: { accessToken: 'initial-surviving-token' },
        },
        env.masterKey,
      )
      assert.equal(initialStore.ok, true)

      // Verify active
      const beforeActive = await queryFirst<{ id: string; revoked_at: string | null }>(
        db,
        `SELECT id, revoked_at FROM platform_credential WHERE account_id = ? AND revoked_at IS NULL`,
        [env.accountId],
      )
      assert.ok(beforeActive)
      assert.equal(beforeActive.revoked_at, null)

      // Create a faulty db proxy that throws on INSERT into platform_credential
      const faultyDb: SqlDatabase = {
        prepare(sql: string) {
          if (sql.includes('INSERT INTO platform_credential')) {
            return {
              bind() {
                return {
                  all: async () => {
                    throw new Error('Simulated disk/constraint failure on credential INSERT')
                  },
                  first: async () => {
                    throw new Error('Simulated disk/constraint failure on credential INSERT')
                  },
                  run: async () => {
                    throw new Error('Simulated disk/constraint failure on credential INSERT')
                  },
                }
              },
            }
          }
          return db.prepare(sql)
        },
      }

      // Attempt replacement that will fail during insert
      await assert.rejects(
        () =>
          storeOAuthCredential(
            faultyDb,
            {
              workspaceId: env.workspaceId,
              accountId: env.accountId,
              platformAdapterKey: 'x',
              credential: { accessToken: 'failing-new-token' },
            },
            env.masterKey,
          ),
        /Simulated disk\/constraint failure on credential INSERT/,
      )

      // Verify transaction rollback: prior credential must STILL be active and unrevoked!
      const afterActive = await queryFirst<{ id: string; revoked_at: string | null }>(
        db,
        `SELECT id, revoked_at FROM platform_credential WHERE account_id = ? AND revoked_at IS NULL`,
        [env.accountId],
      )
      assert.ok(afterActive, 'Prior credential must still exist as active row after rollback')
      assert.equal(afterActive.id, beforeActive.id)
      assert.equal(afterActive.revoked_at, null)

      // Resolving still returns original valid token
      const resolveRes = await resolveOAuthCredential(
        db,
        {
          workspaceId: env.workspaceId,
          accountId: env.accountId,
          platformAdapterKey: 'x',
        },
        env.masterKey,
      )
      assert.equal(resolveRes.ok, true)
      if (resolveRes.ok) {
        assert.equal(resolveRes.credential.accessToken, 'initial-surviving-token')
      }
    },
  )

  // 39. refresh token nullable
  await t.test('39. Refresh token is nullable: stores null and resolves null cleanly', async () => {
    const db = createTestDb()
    const env = await setupTestEnvironment(db)

    await storeOAuthCredential(
      db,
      {
        workspaceId: env.workspaceId,
        accountId: env.accountId,
        platformAdapterKey: 'x',
        credential: {
          accessToken: 'bearer-only-token',
          refreshToken: null,
        },
      },
      env.masterKey,
    )

    const resolveRes = await resolveOAuthCredential(
      db,
      {
        workspaceId: env.workspaceId,
        accountId: env.accountId,
        platformAdapterKey: 'x',
      },
      env.masterKey,
    )

    assert.equal(resolveRes.ok, true)
    if (resolveRes.ok) {
      assert.equal(resolveRes.credential.accessToken, 'bearer-only-token')
      assert.equal(resolveRes.credential.refreshToken, null)
    }
  })

  // 40. scopes/expiry metadata preserved safely
  await t.test('40. Scopes and expiry metadata are preserved and returned safely', async () => {
    const db = createTestDb()
    const env = await setupTestEnvironment(db)

    const expiresAt = '2026-12-31T23:59:59.000Z'
    const refreshExpiresAt = '2027-06-30T23:59:59.000Z'

    await storeOAuthCredential(
      db,
      {
        workspaceId: env.workspaceId,
        accountId: env.accountId,
        platformAdapterKey: 'x',
        credential: {
          accessToken: 'scoped-token',
          refreshToken: 'scoped-refresh',
          scopes: ['tweet.read', 'tweet.write', 'users.read'],
          accessTokenExpiresAt: expiresAt,
          refreshTokenExpiresAt: refreshExpiresAt,
          providerUserId: 'prov-user-999',
        },
      },
      env.masterKey,
    )

    const resolveRes = await resolveOAuthCredential(
      db,
      {
        workspaceId: env.workspaceId,
        accountId: env.accountId,
        platformAdapterKey: 'x',
      },
      env.masterKey,
    )

    assert.equal(resolveRes.ok, true)
    if (resolveRes.ok) {
      assert.equal(resolveRes.credential.scopes, 'tweet.read tweet.write users.read')
      assert.equal(resolveRes.credential.accessTokenExpiresAt, expiresAt)
      assert.equal(resolveRes.credential.refreshTokenExpiresAt, refreshExpiresAt)
      assert.equal(resolveRes.credential.providerUserId, 'prov-user-999')
    }
  })

  // 41. no plaintext token exists anywhere in persisted DB rows
  await t.test(
    '41. Global DB scan: Zero plaintext sentinel tokens anywhere in sqlite rows',
    async () => {
      const db = createTestDb()
      const env = await setupTestEnvironment(db)
      const globalSentinel = 'GLOBAL_SCAN_SENTINEL_TOKEN_SECRET_XYZ'

      await storeOAuthCredential(
        db,
        {
          workspaceId: env.workspaceId,
          accountId: env.accountId,
          platformAdapterKey: 'x',
          credential: {
            accessToken: globalSentinel,
            refreshToken: `${globalSentinel}_REFRESH`,
          },
        },
        env.masterKey,
      )

      const allTables =
        (
          await db
            .prepare(
              `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
            )
            .bind()
            .all<{ name: string }>()
        )?.results ?? []

      for (const { name } of allTables) {
        const rows =
          (await db.prepare(`SELECT * FROM "${name}"`).bind().all<Record<string, unknown>>())
            ?.results ?? []

        for (const row of rows) {
          const json = JSON.stringify(row)
          assert.equal(
            json.includes(globalSentinel),
            false,
            `Table "${name}" must NOT contain plaintext token sentinel`,
          )
        }
      }
    },
  )

  // 42. AAD swap test (Account A ciphertext attempted to decrypt as Account B -> fails)
  await t.test(
    '42. AAD Swap Test: Ciphertext from Account A cannot be decrypted as Account B',
    async () => {
      const db = createTestDb()
      const env = await setupTestEnvironment(db)

      // Store credential for Account 1
      await storeOAuthCredential(
        db,
        {
          workspaceId: env.workspaceId,
          accountId: env.accountId,
          platformAdapterKey: 'x',
          credential: { accessToken: 'account-1-secret-token' },
        },
        env.masterKey,
      )

      const rowA = await queryFirst<{ access_token_ciphertext: string; access_token_iv: string }>(
        db,
        `SELECT access_token_ciphertext, access_token_iv FROM platform_credential WHERE account_id = ? AND revoked_at IS NULL`,
        [env.accountId],
      )
      assert.ok(rowA)

      // Copy Account 1 ciphertext directly into Account 2's row in DB
      await execute(
        db,
        `INSERT INTO platform_credential (
         id, workspace_id, account_id, platform_id, credential_type,
         access_token_ciphertext, access_token_iv,
         token_type, scopes, key_version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'oauth2', ?, ?, 'bearer', NULL, 1, ?, ?)`,
        [
          newId(),
          env.workspaceId,
          env.account2Id,
          env.xPlatformId,
          rowA.access_token_ciphertext,
          rowA.access_token_iv,
          nowIso(),
          nowIso(),
        ],
      )

      // Attempt to resolve Account 2
      const resolveRes = await resolveOAuthCredential(
        db,
        {
          workspaceId: env.workspaceId,
          accountId: env.account2Id,
          platformAdapterKey: 'x',
        },
        env.masterKey,
      )

      assert.equal(resolveRes.ok, false)
      if (!resolveRes.ok) {
        assert.equal(resolveRes.code, 'credential_corrupt')
      }
    },
  )

  // 43. Roundtrip assertion with sentinels & rotation
  await t.test(
    '43. Full Lifecycle Roundtrip: store -> raw row check -> rotate -> resolve -> revoke -> check',
    async () => {
      const db = createTestDb()
      const env = await setupTestEnvironment(db)

      const initialToken = 'INITIAL_TOKEN_LIFECYCLE_1'
      const rotatedToken = 'ROTATED_TOKEN_LIFECYCLE_2'

      // Store initial
      const storeRes = await storeOAuthCredential(
        db,
        {
          workspaceId: env.workspaceId,
          accountId: env.accountId,
          platformAdapterKey: 'x',
          credential: { accessToken: initialToken },
        },
        env.masterKey,
      )
      assert.equal(storeRes.ok, true)

      // Resolve initial
      const res1 = await resolveOAuthCredential(
        db,
        {
          workspaceId: env.workspaceId,
          accountId: env.accountId,
          platformAdapterKey: 'x',
        },
        env.masterKey,
      )
      assert.equal(res1.ok, true)
      if (res1.ok) {
        assert.equal(res1.credential.accessToken, initialToken)
      }

      // Rotate
      const rotRes = await rotateOAuthCredential(
        db,
        {
          workspaceId: env.workspaceId,
          accountId: env.accountId,
          platformAdapterKey: 'x',
          credential: { accessToken: rotatedToken },
        },
        env.masterKey,
      )
      assert.equal(rotRes.ok, true)

      // Resolve rotated
      const res2 = await resolveOAuthCredential(
        db,
        {
          workspaceId: env.workspaceId,
          accountId: env.accountId,
          platformAdapterKey: 'x',
        },
        env.masterKey,
      )
      assert.equal(res2.ok, true)
      if (res2.ok) {
        assert.equal(res2.credential.accessToken, rotatedToken)
      }

      // Revoke
      const revRes = await revokeOAuthCredential(db, {
        workspaceId: env.workspaceId,
        accountId: env.accountId,
        platformAdapterKey: 'x',
      })
      assert.equal(revRes.ok, true)

      // Resolve after revoke fails
      const res3 = await resolveOAuthCredential(
        db,
        {
          workspaceId: env.workspaceId,
          accountId: env.accountId,
          platformAdapterKey: 'x',
        },
        env.masterKey,
      )
      assert.equal(res3.ok, false)
      if (!res3.ok) {
        assert.equal(res3.code, 'credential_not_found')
      }
    },
  )
})
