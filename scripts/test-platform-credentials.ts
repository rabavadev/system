/**
 * STEP 15E.3A: Secure Platform Credential Resolution Test Suite
 *
 * Covers:
 * 1. Platform & Connection DB Helpers:
 *    - listPlatforms, getPlatformById, getPlatformByAdapterKey
 *    - getPlatformConnectionForAccount returns safe DTO (secret_ref only, no secret values)
 *    - upsertPlatformConnection creates and updates connection records
 *
 * 2. Server-Authoritative Platform Credential Resolver:
 *    - Valid active account + connected connection + secret_ref + matching platform returns resolved credential
 *    - secret_ref is string identifier only (not the secret itself); secret value is resolved from runtime resolver
 *    - Missing secret_ref in database returns not_configured
 *    - secret_ref present in DB but missing in runtime environment returns not_configured
 *    - Account not found or belonging to different workspace returns account_not_found (tenant safety)
 *    - Deleted account (deleted_at IS NOT NULL) returns account_ineligible
 *    - Paused / disconnected / archived account returns account_ineligible
 *    - Platform mismatch (account platform Pinterest vs requested provider X) returns platform_mismatch
 *    - Missing platform_connection row returns not_configured
 *    - Connection status 'expired', 'error', 'disconnected' returns connection_inactive
 *    - Metadata JSON parsing (valid object returned, malformed JSON safely handled)
 *    - Scopes string preserved on credential
 *    - Multiple accounts with distinct secret_refs resolve independently
 *    - Zero secrets or tokens stored in D1 database tables
 *    - Recording resolver proves 0 resolver invocations on all validation failure paths
 *    - Secret reference syntax validation (rejects traversal, dots, whitespace, special chars)
 *    - Prototype pollution protection (rejects __proto__, constructor, prototype)
 *    - Provider binding authority (rejects cross-provider prefixed secrets)
 *    - No secret enumeration capability
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import {
  getPlatformByAdapterKey,
  getPlatformById,
  getPlatformConnectionForAccount,
  listPlatforms,
  upsertPlatformConnection,
} from '../src/server/db/platform.ts'
import { execute, newId, nowIso, queryFirst, type SqlDatabase } from '../src/server/db/sql.ts'
import { resolvePlatformCredential } from '../src/server/platforms/resolver.ts'
import { createEnvSecretResolver, isValidSecretRef } from '../src/server/platforms/runtime.ts'
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

async function setupBaseline(db: SqlDatabase) {
  const now = nowIso()
  const workspaceId = newId()
  const foreignWorkspaceId = newId()

  await execute(
    db,
    `INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, 'Test Workspace', 'test', ?, ?)`,
    [workspaceId, now, now],
  )
  await execute(
    db,
    `INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, 'Foreign Workspace', 'foreign', ?, ?)`,
    [foreignWorkspaceId, now, now],
  )

  const xPlatformId = newId()
  const pinterestPlatformId = newId()
  const instagramPlatformId = newId()

  await execute(
    db,
    `INSERT INTO platform (id, adapter_key, name, created_at) VALUES (?, 'x', 'X', ?)`,
    [xPlatformId, now],
  )
  await execute(
    db,
    `INSERT INTO platform (id, adapter_key, name, created_at) VALUES (?, 'pinterest', 'Pinterest', ?)`,
    [pinterestPlatformId, now],
  )
  await execute(
    db,
    `INSERT INTO platform (id, adapter_key, name, created_at) VALUES (?, 'instagram', 'Instagram', ?)`,
    [instagramPlatformId, now],
  )

  const xAccountId = newId()
  await execute(
    db,
    `INSERT INTO account (id, workspace_id, platform_id, handle, display_name, status, created_at, updated_at)
     VALUES (?, ?, ?, 'xuser', 'X User', 'active', ?, ?)`,
    [xAccountId, workspaceId, xPlatformId, now, now],
  )

  const pinterestAccountId = newId()
  await execute(
    db,
    `INSERT INTO account (id, workspace_id, platform_id, handle, display_name, status, created_at, updated_at)
     VALUES (?, ?, ?, 'pinuser', 'Pin User', 'active', ?, ?)`,
    [pinterestAccountId, workspaceId, pinterestPlatformId, now, now],
  )

  return {
    workspaceId,
    foreignWorkspaceId,
    xPlatformId,
    pinterestPlatformId,
    instagramPlatformId,
    xAccountId,
    pinterestAccountId,
  }
}

function createRecordingResolver(secrets: Record<string, string>): {
  resolver: PlatformSecretResolver
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    resolver: {
      resolveSecret(secretRef: string): string | null {
        calls.push(secretRef)
        return secrets[secretRef] ?? null
      },
    },
  }
}

test('STEP 15E.3A Platform Credential Resolution Suite', async (t) => {
  await t.test(
    '1. Database Helpers: listPlatforms, getPlatformById, getPlatformByAdapterKey',
    async () => {
      const db = createTestDb()
      const { xPlatformId } = await setupBaseline(db)

      const platforms = await listPlatforms(db)
      assert.equal(platforms.length >= 3, true)

      const xPlat = await getPlatformById(db, xPlatformId)
      assert.equal(xPlat !== null, true)
      assert.equal(xPlat?.adapterKey, 'x')
      assert.equal(xPlat?.name, 'X')

      const xByKey = await getPlatformByAdapterKey(db, 'x')
      assert.equal(xByKey !== null, true)
      assert.equal(xByKey?.id, xPlatformId)

      const nonExistent = await getPlatformByAdapterKey(db, 'non_existent_key')
      assert.equal(nonExistent, null)
    },
  )

  await t.test(
    '2. Database Helpers: upsertPlatformConnection creates and updates connection safely',
    async () => {
      const db = createTestDb()
      const { xAccountId } = await setupBaseline(db)

      // Initial insert
      const conn1 = await upsertPlatformConnection(db, {
        accountId: xAccountId,
        status: 'connected',
        secretRef: 'X_ACCOUNT_TOKEN_REF',
        scopes: 'tweet.read tweet.write users.read',
        metadata: JSON.stringify({ userId: '12345', handle: 'xuser' }),
      })

      assert.equal(conn1.accountId, xAccountId)
      assert.equal(conn1.status, 'connected')
      assert.equal(conn1.secretRef, 'X_ACCOUNT_TOKEN_REF')
      assert.equal(conn1.scopes, 'tweet.read tweet.write users.read')
      assert.equal(conn1.metadataJson?.includes('12345'), true)

      // Update status and secretRef
      const conn2 = await upsertPlatformConnection(db, {
        accountId: xAccountId,
        status: 'expired',
        secretRef: 'X_NEW_TOKEN_REF',
      })

      assert.equal(conn2.id, conn1.id)
      assert.equal(conn2.status, 'expired')
      assert.equal(conn2.secretRef, 'X_NEW_TOKEN_REF')
      // Preserved scopes and metadata
      assert.equal(conn2.scopes, 'tweet.read tweet.write users.read')
    },
  )

  await t.test(
    '3. Database Helpers: getPlatformConnectionForAccount returns safe PlatformConnection DTO',
    async () => {
      const db = createTestDb()
      const { xAccountId } = await setupBaseline(db)

      await upsertPlatformConnection(db, {
        accountId: xAccountId,
        status: 'connected',
        secretRef: 'X_TOKEN_REF_KEY',
      })

      const conn = await getPlatformConnectionForAccount(db, xAccountId)
      assert.equal(conn !== null, true)
      assert.equal(conn?.accountId, xAccountId)
      assert.equal(conn?.secretRef, 'X_TOKEN_REF_KEY')
      // Ensure no raw secret value property exists on PlatformConnection
      assert.equal('secretValue' in (conn ?? {}), false)
    },
  )

  await t.test(
    '4. Credential Resolver: successful resolution for valid active account + connected connection',
    async () => {
      const db = createTestDb()
      const { workspaceId, xAccountId } = await setupBaseline(db)

      await upsertPlatformConnection(db, {
        accountId: xAccountId,
        status: 'connected',
        secretRef: 'X_AUTH_TOKEN_TEST',
        scopes: 'tweet.read tweet.write',
        metadata: JSON.stringify({ userId: 'u999' }),
      })

      const secretResolver = createEnvSecretResolver({
        X_AUTH_TOKEN_TEST: 'actual-super-secret-oauth-bearer-token',
      })

      const res = await resolvePlatformCredential(
        db,
        {
          workspaceId,
          accountId: xAccountId,
          platformAdapterKey: 'x',
        },
        secretResolver,
      )

      assert.equal(res.ok, true)
      if (res.ok) {
        assert.equal(res.credential.secretRef, 'X_AUTH_TOKEN_TEST')
        assert.equal(res.credential.secretValue, 'actual-super-secret-oauth-bearer-token')
        assert.equal(res.credential.accountId, xAccountId)
        assert.equal(res.credential.platformAdapterKey, 'x')
        assert.equal(res.credential.scopes, 'tweet.read tweet.write')
        assert.deepEqual(res.credential.metadata, { userId: 'u999' })
      }
    },
  )

  await t.test(
    '5. Credential Resolver: secret_ref is string identifier only (not plaintext secret in DB)',
    async () => {
      const db = createTestDb()
      const { xAccountId } = await setupBaseline(db)

      await upsertPlatformConnection(db, {
        accountId: xAccountId,
        status: 'connected',
        secretRef: 'BINDING_SECRET_KEY_NAME',
      })

      // Inspect database row directly
      const row = await queryFirst<{ secret_ref: string }>(
        db,
        `SELECT secret_ref FROM platform_connection WHERE account_id = ?`,
        [xAccountId],
      )

      assert.equal(row?.secret_ref, 'BINDING_SECRET_KEY_NAME')
      assert.equal(row?.secret_ref.includes('bearer'), false)
    },
  )

  await t.test('6. Credential Resolver: missing secret_ref returns not_configured', async () => {
    const db = createTestDb()
    const { workspaceId, xAccountId } = await setupBaseline(db)

    await upsertPlatformConnection(db, {
      accountId: xAccountId,
      status: 'connected',
      secretRef: null,
    })

    const secretResolver = createEnvSecretResolver({ X_TOKEN: 'some-value' })
    const res = await resolvePlatformCredential(
      db,
      {
        workspaceId,
        accountId: xAccountId,
        platformAdapterKey: 'x',
      },
      secretResolver,
    )

    assert.equal(res.ok, false)
    if (!res.ok) {
      assert.equal(res.code, 'not_configured')
    }
  })

  await t.test(
    '7. Credential Resolver: secret_ref present in DB but absent in runtime env returns not_configured',
    async () => {
      const db = createTestDb()
      const { workspaceId, xAccountId } = await setupBaseline(db)

      await upsertPlatformConnection(db, {
        accountId: xAccountId,
        status: 'connected',
        secretRef: 'X_NON_EXISTENT_ENV_BINDING',
      })

      const emptyResolver = createEnvSecretResolver({})
      const res = await resolvePlatformCredential(
        db,
        {
          workspaceId,
          accountId: xAccountId,
          platformAdapterKey: 'x',
        },
        emptyResolver,
      )

      assert.equal(res.ok, false)
      if (!res.ok) {
        assert.equal(res.code, 'not_configured')
      }
    },
  )

  await t.test(
    '8. Credential Resolver: non-existent account returns account_not_found',
    async () => {
      const db = createTestDb()
      const { workspaceId } = await setupBaseline(db)

      const res = await resolvePlatformCredential(
        db,
        {
          workspaceId,
          accountId: 'non-existent-account-id',
          platformAdapterKey: 'x',
        },
        createEnvSecretResolver({}),
      )

      assert.equal(res.ok, false)
      if (!res.ok) {
        assert.equal(res.code, 'account_not_found')
      }
    },
  )

  await t.test(
    '9. Credential Resolver: cross-workspace account access strictly rejected (tenant isolation)',
    async () => {
      const db = createTestDb()
      const { foreignWorkspaceId, xAccountId } = await setupBaseline(db)

      await upsertPlatformConnection(db, {
        accountId: xAccountId,
        status: 'connected',
        secretRef: 'X_TOKEN',
      })

      const resolver = createEnvSecretResolver({ X_TOKEN: 'valid-secret' })

      // Attempt to access xAccountId belonging to workspaceId from foreignWorkspaceId
      const res = await resolvePlatformCredential(
        db,
        {
          workspaceId: foreignWorkspaceId,
          accountId: xAccountId,
          platformAdapterKey: 'x',
        },
        resolver,
      )

      assert.equal(res.ok, false)
      if (!res.ok) {
        assert.equal(res.code, 'account_not_found')
      }
    },
  )

  await t.test('10. Credential Resolver: deleted account returns account_ineligible', async () => {
    const db = createTestDb()
    const { workspaceId, xAccountId } = await setupBaseline(db)
    const now = nowIso()

    await execute(db, `UPDATE account SET deleted_at = ? WHERE id = ?`, [now, xAccountId])

    await upsertPlatformConnection(db, {
      accountId: xAccountId,
      status: 'connected',
      secretRef: 'X_TOKEN',
    })

    const resolver = createEnvSecretResolver({ X_TOKEN: 'valid-secret' })
    const res = await resolvePlatformCredential(
      db,
      {
        workspaceId,
        accountId: xAccountId,
        platformAdapterKey: 'x',
      },
      resolver,
    )

    assert.equal(res.ok, false)
    if (!res.ok) {
      assert.equal(res.code, 'account_ineligible')
    }
  })

  await t.test(
    '11. Credential Resolver: paused / disconnected / archived account returns account_ineligible',
    async () => {
      const db = createTestDb()
      const { workspaceId, xAccountId } = await setupBaseline(db)

      const nonActiveStatuses = ['paused', 'disconnected', 'archived']

      for (const status of nonActiveStatuses) {
        await execute(db, `UPDATE account SET status = ? WHERE id = ?`, [status, xAccountId])
        await upsertPlatformConnection(db, {
          accountId: xAccountId,
          status: 'connected',
          secretRef: 'X_TOKEN',
        })

        const resolver = createEnvSecretResolver({ X_TOKEN: 'valid-secret' })
        const res = await resolvePlatformCredential(
          db,
          {
            workspaceId,
            accountId: xAccountId,
            platformAdapterKey: 'x',
          },
          resolver,
        )

        assert.equal(res.ok, false)
        if (!res.ok) {
          assert.equal(res.code, 'account_ineligible')
        }
      }
    },
  )

  await t.test(
    '12. Credential Resolver: platform mismatch (Pinterest account vs requested X provider) returns platform_mismatch',
    async () => {
      const db = createTestDb()
      const { workspaceId, pinterestAccountId } = await setupBaseline(db)

      await upsertPlatformConnection(db, {
        accountId: pinterestAccountId,
        status: 'connected',
        secretRef: 'PIN_TOKEN',
      })

      const resolver = createEnvSecretResolver({ PIN_TOKEN: 'pin-secret' })

      // Request provider 'x' for a Pinterest account
      const res = await resolvePlatformCredential(
        db,
        {
          workspaceId,
          accountId: pinterestAccountId,
          platformAdapterKey: 'x',
        },
        resolver,
      )

      assert.equal(res.ok, false)
      if (!res.ok) {
        assert.equal(res.code, 'platform_mismatch')
      }
    },
  )

  await t.test(
    '13. Credential Resolver: missing platform_connection row returns not_configured',
    async () => {
      const db = createTestDb()
      const { workspaceId, xAccountId } = await setupBaseline(db)

      const resolver = createEnvSecretResolver({ X_TOKEN: 'val' })
      const res = await resolvePlatformCredential(
        db,
        {
          workspaceId,
          accountId: xAccountId,
          platformAdapterKey: 'x',
        },
        resolver,
      )

      assert.equal(res.ok, false)
      if (!res.ok) {
        assert.equal(res.code, 'not_configured')
      }
    },
  )

  await t.test(
    '14. Credential Resolver: inactive connection status (expired, error, disconnected) returns connection_inactive',
    async () => {
      const db = createTestDb()
      const { workspaceId, xAccountId } = await setupBaseline(db)

      const inactiveStatuses: Array<'expired' | 'error' | 'disconnected'> = [
        'expired',
        'error',
        'disconnected',
      ]

      for (const status of inactiveStatuses) {
        await upsertPlatformConnection(db, {
          accountId: xAccountId,
          status,
          secretRef: 'X_TOKEN',
        })

        const resolver = createEnvSecretResolver({ X_TOKEN: 'secret' })
        const res = await resolvePlatformCredential(
          db,
          {
            workspaceId,
            accountId: xAccountId,
            platformAdapterKey: 'x',
          },
          resolver,
        )

        assert.equal(res.ok, false)
        if (!res.ok) {
          assert.equal(res.code, 'connection_inactive')
        }
      }
    },
  )

  await t.test(
    '15. Credential Resolver: malformed metadata JSON safely handled without crashing',
    async () => {
      const db = createTestDb()
      const { workspaceId, xAccountId } = await setupBaseline(db)

      await upsertPlatformConnection(db, {
        accountId: xAccountId,
        status: 'connected',
        secretRef: 'X_TOKEN',
        metadata: 'invalid-non-json-string',
      })

      const resolver = createEnvSecretResolver({ X_TOKEN: 'secret123' })
      const res = await resolvePlatformCredential(
        db,
        {
          workspaceId,
          accountId: xAccountId,
          platformAdapterKey: 'x',
        },
        resolver,
      )

      assert.equal(res.ok, true)
      if (res.ok) {
        assert.equal(res.credential.metadata, null)
      }
    },
  )

  await t.test(
    '16. Credential Resolver: multiple accounts with independent secret bindings resolve cleanly',
    async () => {
      const db = createTestDb()
      const { workspaceId, xPlatformId } = await setupBaseline(db)
      const now = nowIso()

      const account1 = newId()
      const account2 = newId()

      await execute(
        db,
        `INSERT INTO account (id, workspace_id, platform_id, handle, display_name, status, created_at, updated_at)
       VALUES (?, ?, ?, 'xuser1', 'User 1', 'active', ?, ?)`,
        [account1, workspaceId, xPlatformId, now, now],
      )
      await execute(
        db,
        `INSERT INTO account (id, workspace_id, platform_id, handle, display_name, status, created_at, updated_at)
       VALUES (?, ?, ?, 'xuser2', 'User 2', 'active', ?, ?)`,
        [account2, workspaceId, xPlatformId, now, now],
      )

      await upsertPlatformConnection(db, {
        accountId: account1,
        status: 'connected',
        secretRef: 'X_USER1_SECRET',
      })
      await upsertPlatformConnection(db, {
        accountId: account2,
        status: 'connected',
        secretRef: 'X_USER2_SECRET',
      })

      const resolver = createEnvSecretResolver({
        X_USER1_SECRET: 'token-for-user-1',
        X_USER2_SECRET: 'token-for-user-2',
      })

      const res1 = await resolvePlatformCredential(
        db,
        { workspaceId, accountId: account1, platformAdapterKey: 'x' },
        resolver,
      )
      const res2 = await resolvePlatformCredential(
        db,
        { workspaceId, accountId: account2, platformAdapterKey: 'x' },
        resolver,
      )

      assert.equal(res1.ok, true)
      assert.equal(res2.ok, true)
      if (res1.ok && res2.ok) {
        assert.equal(res1.credential.secretValue, 'token-for-user-1')
        assert.equal(res2.credential.secretValue, 'token-for-user-2')
      }
    },
  )

  await t.test('17. Security: Zero plaintext secrets stored in database tables', async () => {
    const db = createTestDb()
    const { xAccountId } = await setupBaseline(db)

    await upsertPlatformConnection(db, {
      accountId: xAccountId,
      status: 'connected',
      secretRef: 'X_TOKEN_IDENTIFIER',
      metadata: JSON.stringify({ username: 'handle' }),
    })

    const connRows =
      (await db.prepare(`SELECT * FROM platform_connection`).bind().all<Record<string, unknown>>())
        ?.results ?? []

    for (const r of connRows) {
      for (const [col, val] of Object.entries(r)) {
        if (typeof val === 'string') {
          assert.equal(
            val.toLowerCase().includes('bearer') || val.toLowerCase().includes('oauth_token'),
            false,
            `Database column ${col} must not contain plaintext credentials`,
          )
        }
      }
    }
  })

  await t.test(
    '18. Lifecycle Guard: Secret resolver is NEVER called before Account validation passes',
    async () => {
      const db = createTestDb()
      const { workspaceId, foreignWorkspaceId, xAccountId } = await setupBaseline(db)
      const now = nowIso()

      const recording = createRecordingResolver({ X_TOKEN: 'secret' })

      // 1. Missing account
      await resolvePlatformCredential(
        db,
        { workspaceId, accountId: 'missing-id', platformAdapterKey: 'x' },
        recording.resolver,
      )
      assert.equal(recording.calls.length, 0, 'Resolver must not be called for missing account')

      // 2. Foreign workspace
      await resolvePlatformCredential(
        db,
        { workspaceId: foreignWorkspaceId, accountId: xAccountId, platformAdapterKey: 'x' },
        recording.resolver,
      )
      assert.equal(recording.calls.length, 0, 'Resolver must not be called for foreign workspace')

      // 3. Deleted account
      await execute(db, `UPDATE account SET deleted_at = ? WHERE id = ?`, [now, xAccountId])
      await resolvePlatformCredential(
        db,
        { workspaceId, accountId: xAccountId, platformAdapterKey: 'x' },
        recording.resolver,
      )
      assert.equal(recording.calls.length, 0, 'Resolver must not be called for deleted account')

      // 4. Inactive account
      await execute(db, `UPDATE account SET deleted_at = NULL, status = 'paused' WHERE id = ?`, [
        xAccountId,
      ])
      await resolvePlatformCredential(
        db,
        { workspaceId, accountId: xAccountId, platformAdapterKey: 'x' },
        recording.resolver,
      )
      assert.equal(recording.calls.length, 0, 'Resolver must not be called for paused account')
    },
  )

  await t.test(
    '19. Lifecycle Guard: Secret resolver is NEVER called before Platform & Connection validation passes',
    async () => {
      const db = createTestDb()
      const { workspaceId, xAccountId, pinterestAccountId } = await setupBaseline(db)

      const recording = createRecordingResolver({ X_TOKEN: 'secret' })

      // 1. Platform mismatch
      await resolvePlatformCredential(
        db,
        { workspaceId, accountId: pinterestAccountId, platformAdapterKey: 'x' },
        recording.resolver,
      )
      assert.equal(recording.calls.length, 0, 'Resolver must not be called for platform mismatch')

      // 2. Missing connection
      await resolvePlatformCredential(
        db,
        { workspaceId, accountId: xAccountId, platformAdapterKey: 'x' },
        recording.resolver,
      )
      assert.equal(recording.calls.length, 0, 'Resolver must not be called for missing connection')

      // 3. Inactive connection
      await upsertPlatformConnection(db, {
        accountId: xAccountId,
        status: 'disconnected',
        secretRef: 'X_TOKEN',
      })
      await resolvePlatformCredential(
        db,
        { workspaceId, accountId: xAccountId, platformAdapterKey: 'x' },
        recording.resolver,
      )
      assert.equal(
        recording.calls.length,
        0,
        'Resolver must not be called for disconnected connection',
      )
    },
  )

  await t.test(
    '20. Secret Syntax: Malicious and invalid secret_ref identifiers are rejected safely',
    async () => {
      const db = createTestDb()
      const { workspaceId, xAccountId } = await setupBaseline(db)

      const invalidRefs = [
        '../etc/passwd',
        '../../secrets/x.env',
        'X_TOKEN.KEY',
        'X TOKEN WITH SPACES',
        'X_TOKEN$FORGED',
        'X_TOKEN;DROP TABLE platform_connection',
        'X_TOKEN\nNEWLINE',
        'X_TOKEN\0NULL',
        '   ',
        '',
      ]

      for (const invalidRef of invalidRefs) {
        assert.equal(
          isValidSecretRef(invalidRef),
          false,
          `isValidSecretRef must reject: ${JSON.stringify(invalidRef)}`,
        )

        await execute(db, `UPDATE platform_connection SET secret_ref = ? WHERE account_id = ?`, [
          invalidRef,
          xAccountId,
        ])

        const recording = createRecordingResolver({ [invalidRef]: 'evil-val' })
        const res = await resolvePlatformCredential(
          db,
          { workspaceId, accountId: xAccountId, platformAdapterKey: 'x' },
          recording.resolver,
        )

        assert.equal(res.ok, false)
        if (!res.ok) {
          assert.equal(res.code, 'not_configured')
        }
        assert.equal(
          recording.calls.length,
          0,
          `Resolver must not be invoked for invalid secret_ref: ${invalidRef}`,
        )
      }
    },
  )

  await t.test(
    '21. Prototype Safety: Prototype-polluting secret_ref names (__proto__, constructor, prototype) are strictly rejected',
    async () => {
      const db = createTestDb()
      const { workspaceId, xAccountId } = await setupBaseline(db)

      const prototypeKeys = ['__proto__', 'constructor', 'prototype']

      for (const protoKey of prototypeKeys) {
        assert.equal(
          isValidSecretRef(protoKey),
          false,
          `isValidSecretRef must reject prototype key: ${protoKey}`,
        )

        await execute(db, `UPDATE platform_connection SET secret_ref = ? WHERE account_id = ?`, [
          protoKey,
          xAccountId,
        ])

        const resolver = createEnvSecretResolver({ [protoKey]: 'malicious-injected-prototype' })
        const res = await resolvePlatformCredential(
          db,
          { workspaceId, accountId: xAccountId, platformAdapterKey: 'x' },
          resolver,
        )

        assert.equal(res.ok, false)
        if (!res.ok) {
          assert.equal(res.code, 'not_configured')
        }
      }
    },
  )

  await t.test(
    '22. Provider Binding Authority: secret_ref matching another provider prefix is rejected',
    async () => {
      const db = createTestDb()
      const { workspaceId, xAccountId } = await setupBaseline(db)

      // X account configured with a Pinterest secret binding
      await upsertPlatformConnection(db, {
        accountId: xAccountId,
        status: 'connected',
        secretRef: 'PINTEREST_PUBLISH_ACCESS_TOKEN',
      })

      const recording = createRecordingResolver({
        PINTEREST_PUBLISH_ACCESS_TOKEN: 'pin-secret-val',
      })

      const res = await resolvePlatformCredential(
        db,
        { workspaceId, accountId: xAccountId, platformAdapterKey: 'x' },
        recording.resolver,
      )

      assert.equal(res.ok, false)
      if (!res.ok) {
        assert.equal(res.code, 'platform_mismatch')
      }
      assert.equal(
        recording.calls.length,
        0,
        'Resolver must not be invoked for cross-provider secret_ref',
      )
    },
  )

  await t.test(
    '23. Security: No secret enumeration interface and zero secret leakage in error reasons',
    async () => {
      const db = createTestDb()
      const { workspaceId, xAccountId } = await setupBaseline(db)

      await upsertPlatformConnection(db, {
        accountId: xAccountId,
        status: 'connected',
        secretRef: 'X_TOP_SECRET_TOKEN_NAME',
      })

      const secretResolver = createEnvSecretResolver({})

      // Ensure secret resolver has ONLY resolveSecret (no listSecrets/dumpEnv)
      assert.equal(typeof secretResolver.resolveSecret, 'function')
      assert.equal('listSecrets' in secretResolver, false)
      assert.equal('dumpEnv' in secretResolver, false)
      assert.equal('allSecrets' in secretResolver, false)

      const res = await resolvePlatformCredential(
        db,
        { workspaceId, accountId: xAccountId, platformAdapterKey: 'x' },
        secretResolver,
      )

      assert.equal(res.ok, false)
      if (!res.ok) {
        assert.equal(res.code, 'not_configured')
        // Reason must not expose secret values or internal stack traces
        assert.equal(res.reason.includes('bearer'), false)
        assert.equal(res.reason.includes('password'), false)
      }
    },
  )

  await t.test(
    '24. Runtime Resolver: empty runtime secret string returns not_configured',
    async () => {
      const db = createTestDb()
      const { workspaceId, xAccountId } = await setupBaseline(db)

      await upsertPlatformConnection(db, {
        accountId: xAccountId,
        status: 'connected',
        secretRef: 'X_EMPTY_TOKEN',
      })

      const resolver = createEnvSecretResolver({ X_EMPTY_TOKEN: '' })
      const res = await resolvePlatformCredential(
        db,
        { workspaceId, accountId: xAccountId, platformAdapterKey: 'x' },
        resolver,
      )

      assert.equal(res.ok, false)
      if (!res.ok) {
        assert.equal(res.code, 'not_configured')
      }
    },
  )

  await t.test(
    '25. Runtime Resolver: whitespace-only runtime secret returns not_configured',
    async () => {
      const db = createTestDb()
      const { workspaceId, xAccountId } = await setupBaseline(db)

      await upsertPlatformConnection(db, {
        accountId: xAccountId,
        status: 'connected',
        secretRef: 'X_WS_TOKEN',
      })

      const resolver = createEnvSecretResolver({ X_WS_TOKEN: '   \t\n  ' })
      const res = await resolvePlatformCredential(
        db,
        { workspaceId, accountId: xAccountId, platformAdapterKey: 'x' },
        resolver,
      )

      assert.equal(res.ok, false)
      if (!res.ok) {
        assert.equal(res.code, 'not_configured')
      }
    },
  )

  await t.test('26. Runtime Resolver: non-string binding returns not_configured', async () => {
    const db = createTestDb()
    const { workspaceId, xAccountId } = await setupBaseline(db)

    await upsertPlatformConnection(db, {
      accountId: xAccountId,
      status: 'connected',
      secretRef: 'X_OBJECT_TOKEN',
    })

    const resolver = createEnvSecretResolver({
      X_OBJECT_TOKEN: { evil: true } as unknown as string,
    })
    const res = await resolvePlatformCredential(
      db,
      { workspaceId, accountId: xAccountId, platformAdapterKey: 'x' },
      resolver,
    )

    assert.equal(res.ok, false)
    if (!res.ok) {
      assert.equal(res.code, 'not_configured')
    }
  })

  await t.test(
    '27. Security: Reserved runtime bindings (DB, AI, BRAVE_SEARCH_API_KEY, SESSION_SECRET) are unreachable',
    async () => {
      const db = createTestDb()
      const { workspaceId, xAccountId } = await setupBaseline(db)

      const connId = newId()
      const now = nowIso()
      await execute(
        db,
        "INSERT INTO platform_connection (id, account_id, status, secret_ref, created_at, updated_at) VALUES (?, ?, 'connected', 'X_TOKEN', ?, ?)",
        [connId, xAccountId, now, now],
      )

      const reservedKeys = [
        'DB',
        'AI',
        'ASSETS',
        'BRAVE_SEARCH_API_KEY',
        'CLOUDFLARE_API_TOKEN',
        'DATABASE_URL',
        'SESSION_SECRET',
        'NODE_ENV',
      ]

      for (const reservedKey of reservedKeys) {
        const recording = createRecordingResolver({ [reservedKey]: 'top-secret-db-or-key' })

        // Attempt resolving reserved binding directly
        await execute(db, 'UPDATE platform_connection SET secret_ref = ? WHERE account_id = ?', [
          reservedKey,
          xAccountId,
        ])

        const res = await resolvePlatformCredential(
          db,
          { workspaceId, accountId: xAccountId, platformAdapterKey: 'x' },
          recording.resolver,
        )

        assert.equal(res.ok, false, `Reserved binding ${reservedKey} must not resolve`)
        assert.equal(
          recording.calls.length,
          0,
          `Resolver must not be invoked for reserved binding ${reservedKey}`,
        )
      }
    },
  )

  await t.test('28. Security: Arbitrary non-prefixed secret_ref rejected', async () => {
    const db = createTestDb()
    const { workspaceId, xAccountId } = await setupBaseline(db)

    const connId = newId()
    const now = nowIso()
    await execute(
      db,
      "INSERT INTO platform_connection (id, account_id, status, secret_ref, created_at, updated_at) VALUES (?, ?, 'connected', 'X_TOKEN', ?, ?)",
      [connId, xAccountId, now, now],
    )

    const arbitraryKeys = ['MY_CUSTOM_SECRET', 'SECRET_KEY', 'GENERAL_API_KEY']
    for (const key of arbitraryKeys) {
      await execute(db, 'UPDATE platform_connection SET secret_ref = ? WHERE account_id = ?', [
        key,
        xAccountId,
      ])

      const recording = createRecordingResolver({ [key]: 'val' })
      const res = await resolvePlatformCredential(
        db,
        { workspaceId, accountId: xAccountId, platformAdapterKey: 'x' },
        recording.resolver,
      )

      assert.equal(res.ok, false)
      if (!res.ok) {
        assert.equal(res.code, 'platform_mismatch')
      }
      assert.equal(recording.calls.length, 0)
    }
  })

  await t.test('29. Security: X account cannot resolve Threads credential', async () => {
    const db = createTestDb()
    const { workspaceId, xAccountId } = await setupBaseline(db)

    const connId = newId()
    const now = nowIso()
    await execute(
      db,
      "INSERT INTO platform_connection (id, account_id, status, secret_ref, created_at, updated_at) VALUES (?, ?, 'connected', 'X_TOKEN', ?, ?)",
      [connId, xAccountId, now, now],
    )

    await execute(db, 'UPDATE platform_connection SET secret_ref = ? WHERE account_id = ?', [
      'THREADS_ACCESS_TOKEN',
      xAccountId,
    ])

    const recording = createRecordingResolver({ THREADS_ACCESS_TOKEN: 'threads-tok' })
    const res = await resolvePlatformCredential(
      db,
      { workspaceId, accountId: xAccountId, platformAdapterKey: 'x' },
      recording.resolver,
    )

    assert.equal(res.ok, false)
    if (!res.ok) {
      assert.equal(res.code, 'platform_mismatch')
    }
    assert.equal(recording.calls.length, 0)
  })

  await t.test(
    '30. Security: Storing metadata containing raw secrets/tokens is rejected by upsertPlatformConnection',
    async () => {
      const db = createTestDb()
      const { xAccountId } = await setupBaseline(db)

      await assert.rejects(
        () =>
          upsertPlatformConnection(db, {
            accountId: xAccountId,
            status: 'connected',
            secretRef: 'X_TOKEN_1',
            metadata: JSON.stringify({ accessToken: 'secret_token_val_123' }),
          }),
        /Platform connection metadata must not contain secret tokens/,
      )

      await assert.rejects(
        () =>
          upsertPlatformConnection(db, {
            accountId: xAccountId,
            status: 'connected',
            secretRef: 'X_TOKEN_1',
            metadata: JSON.stringify({ headers: { Authorization: 'Bearer secret123' } }),
          }),
        /Platform connection metadata must not contain secret tokens/,
      )
    },
  )

  await t.test(
    '31. Client Safety: SafePlatformConnection DTO contains hasCredential and does not contain raw secrets or secretRef',
    async () => {
      const db = createTestDb()
      const { xAccountId } = await setupBaseline(db)

      await upsertPlatformConnection(db, {
        accountId: xAccountId,
        status: 'connected',
        secretRef: 'X_SECRET_BINDING_123',
        scopes: 'tweet.read tweet.write',
        metadata: JSON.stringify({ userId: 'u1' }),
      })

      const conn = await getPlatformConnectionForAccount(db, xAccountId)
      assert.ok(conn)
      assert.equal(conn.secretRef, 'X_SECRET_BINDING_123')

      const { getSafePlatformConnectionForAccount } = await import('../src/server/db/platform.ts')
      const safeConn = await getSafePlatformConnectionForAccount(db, xAccountId)
      assert.ok(safeConn)
      assert.equal(safeConn.hasCredential, true)
      assert.equal('secretRef' in safeConn, false)
      assert.equal('secretValue' in safeConn, false)
      assert.equal(safeConn.status, 'connected')
    },
  )
})
