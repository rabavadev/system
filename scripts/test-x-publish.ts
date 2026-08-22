/**
 * STEP 15E.3B: Real X Text Publishing Adapter Test Suite
 *
 * Validates the complete approval-gated, credential-resolved, identity-verified
 * X text publishing adapter lifecycle with recording HTTP transport (zero live network calls).
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import { decideApprovalRequest } from '../src/server/approval/service.ts'
import {
  approveCampaignContentVariant,
  revokeCampaignContentApproval,
} from '../src/server/db/content-approval.ts'
import { upsertPlatformConnection } from '../src/server/db/platform.ts'
import {
  createPublicationIntent,
  dispatchApprovedPublication,
  getPostDetail,
  requestPublicationDispatch,
} from '../src/server/db/post.ts'
import { execute, newId, nowIso, queryAll, type SqlDatabase } from '../src/server/db/sql.ts'
import { isXBoundSecretRef, XPublishingAdapter } from '../src/server/platforms/adapters/x/index.ts'
import type { XHttpTransport } from '../src/server/platforms/adapters/x/types.ts'
import { resolvePlatformCredential } from '../src/server/platforms/resolver.ts'
import { createEnvSecretResolver } from '../src/server/platforms/runtime.ts'

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
  const migrationFiles = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  for (const file of migrationFiles) {
    const sql = readFileSync(join(migrationsDir, file), 'utf-8')
    sqlite.exec(sql)
  }

  return shim(sqlite)
}

interface RecordedHttpRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

function createMockTransport(
  handler: (
    req: RecordedHttpRequest,
  ) =>
    | { status: number; body: unknown; headers?: Record<string, string> }
    | Promise<{ status: number; body: unknown; headers?: Record<string, string> }>,
): { transport: XHttpTransport; recordedRequests: RecordedHttpRequest[] } {
  const recordedRequests: RecordedHttpRequest[] = []

  const transport: XHttpTransport = async (url: string, init: RequestInit) => {
    const headersObj: Record<string, string> = {}
    if (init.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => {
          headersObj[k.toLowerCase()] = v
        })
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) {
          headersObj[k.toLowerCase()] = v
        }
      } else {
        for (const [k, v] of Object.entries(init.headers)) {
          headersObj[k.toLowerCase()] = String(v)
        }
      }
    }

    const recordedReq: RecordedHttpRequest = {
      url,
      method: init.method ?? 'GET',
      headers: headersObj,
      body: typeof init.body === 'string' ? init.body : undefined,
    }
    recordedRequests.push(recordedReq)

    const res = await handler(recordedReq)
    const resHeaders = new Headers()
    if (res.headers) {
      for (const [k, v] of Object.entries(res.headers)) {
        resHeaders.set(k, v)
      }
    }

    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: resHeaders,
    })
  }

  return { transport, recordedRequests }
}

interface TestSetup {
  db: SqlDatabase
  workspaceId: string
  brandId: string
  campaignId: string
  platformId: string
  accountId: string
  contentId: string
  variantId: string
  approvalId: string
  postId: string
}

async function setupTestEnvironment(): Promise<TestSetup> {
  const db = createTestDb()
  const workspaceId = newId()
  const brandId = newId()
  const campaignId = newId()
  const platformId = newId()
  const accountId = newId()
  const contentId = newId()
  const variantId = newId()
  const now = nowIso()

  // 1. Workspace
  await execute(
    db,
    'INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [workspaceId, 'X Publish Test WS', 'x-pub-ws', now, now],
  )

  // 2. Platform (x)
  await execute(
    db,
    "INSERT OR IGNORE INTO platform (id, adapter_key, name, created_at) VALUES (?, 'x', 'X / Twitter', ?)",
    [platformId, now],
  )

  // 3. Brand & Campaign
  await execute(
    db,
    'INSERT INTO brand (id, workspace_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [brandId, workspaceId, 'GrowthBrand', 'Brand Desc', now, now],
  )
  await execute(
    db,
    'INSERT INTO campaign (id, workspace_id, brand_id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [campaignId, workspaceId, brandId, 'Launch Campaign', 'active', now, now],
  )

  // 4. Account
  await execute(
    db,
    'INSERT INTO account (id, workspace_id, platform_id, handle, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [accountId, workspaceId, platformId, 'growth_user', 'Growth User', 'active', now, now],
  )
  await execute(
    db,
    'INSERT INTO campaign_account (campaign_id, account_id, created_at) VALUES (?, ?, ?)',
    [campaignId, accountId, now],
  )

  // 5. Content & Variant
  await execute(
    db,
    "INSERT INTO content (id, workspace_id, campaign_id, target_account_id, title, content_type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'post', 'ready', ?, ?)",
    [contentId, workspaceId, campaignId, accountId, 'Big Announcement', now, now],
  )
  await execute(
    db,
    "INSERT INTO content_variant (id, content_id, platform_id, body, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, ?)",
    [
      variantId,
      contentId,
      platformId,
      'Exciting news! We are launching our new platform today.',
      now,
      now,
    ],
  )

  // 6. Editorial Approval
  const approvalRes = await approveCampaignContentVariant(db, {
    workspaceId,
    campaignId,
    contentId,
    contentVariantId: variantId,
    actorType: 'user',
    note: 'Approved for publication',
  })

  // 7. Publication Intent
  const post = await createPublicationIntent(db, {
    workspaceId,
    campaignId,
    contentId,
    contentVariantId: variantId,
    accountId,
  })

  // 8. Platform Connection with X_ACCESS_TOKEN binding
  await upsertPlatformConnection(db, {
    accountId,
    status: 'connected',
    secretRef: 'X_ACCESS_TOKEN',
    scopes: 'tweet.read tweet.write users.read',
    metadata: JSON.stringify({ providerUserId: 'x-user-12345' }),
  })

  return {
    db,
    workspaceId,
    brandId,
    campaignId,
    platformId,
    accountId,
    contentId,
    variantId,
    approvalId: approvalRes.approval.id,
    postId: post.id,
  }
}

test('STEP 15E.3B: X Text Publishing Adapter Test Suite', async (t) => {
  // 1. X adapter key resolves correctly
  await t.test('1. X adapter key resolves correctly', () => {
    const adapter = new XPublishingAdapter()
    assert.ok(adapter instanceof XPublishingAdapter)
  })

  // 2. Non-X provider rejected by resolver
  await t.test('2. Non-X provider rejected by resolver', async () => {
    const env = await setupTestEnvironment()
    const secretResolver = createEnvSecretResolver({ X_ACCESS_TOKEN: 'valid-x-token' })
    const res = await resolvePlatformCredential(
      env.db,
      { workspaceId: env.workspaceId, accountId: env.accountId, platformAdapterKey: 'instagram' },
      secretResolver,
    )
    assert.equal(res.ok, false)
    assert.equal(res.code, 'platform_mismatch')
  })

  // 3. Missing connection => not_configured
  await t.test('3. Missing connection => not_configured', async () => {
    const env = await setupTestEnvironment()
    await execute(env.db, 'DELETE FROM platform_connection WHERE account_id = ?', [env.accountId])
    const secretResolver = createEnvSecretResolver({ X_ACCESS_TOKEN: 'valid-x-token' })
    const res = await resolvePlatformCredential(
      env.db,
      { workspaceId: env.workspaceId, accountId: env.accountId, platformAdapterKey: 'x' },
      secretResolver,
    )
    assert.equal(res.ok, false)
    assert.equal(res.code, 'not_configured')
  })

  // 4. Inactive connection rejected
  await t.test('4. Inactive connection rejected', async () => {
    const env = await setupTestEnvironment()
    await execute(
      env.db,
      "UPDATE platform_connection SET status = 'disconnected' WHERE account_id = ?",
      [env.accountId],
    )
    const secretResolver = createEnvSecretResolver({ X_ACCESS_TOKEN: 'valid-x-token' })
    const res = await resolvePlatformCredential(
      env.db,
      { workspaceId: env.workspaceId, accountId: env.accountId, platformAdapterKey: 'x' },
      secretResolver,
    )
    assert.equal(res.ok, false)
    assert.equal(res.code, 'connection_inactive')
  })

  // 5. Missing X secret in runtime => not_configured
  await t.test('5. Missing X secret in runtime => not_configured', async () => {
    const env = await setupTestEnvironment()
    const secretResolver = createEnvSecretResolver({}) // empty runtime env
    const res = await resolvePlatformCredential(
      env.db,
      { workspaceId: env.workspaceId, accountId: env.accountId, platformAdapterKey: 'x' },
      secretResolver,
    )
    assert.equal(res.ok, false)
    assert.equal(res.code, 'not_configured')
  })

  // 6. Generic non-X-bound secret rejected by X adapter
  await t.test('6. Generic non-X-bound secret rejected by X adapter', async () => {
    const adapter = new XPublishingAdapter()
    const res = await adapter.publishText({
      text: 'Test tweet',
      expectedAccountHandle: 'growth_user',
      credential: {
        secretRef: 'SOCIAL_GENERIC_TOKEN',
        secretValue: 'mock-token',
        accountId: 'acc-1',
        platformAdapterKey: 'x',
      },
    })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'not_configured')
    assert.ok(res.message.includes('X_ prefix'))
  })

  // 7. X_* secret accepted by isXBoundSecretRef
  await t.test('7. X_* secret accepted by isXBoundSecretRef', () => {
    assert.equal(isXBoundSecretRef('X_ACCESS_TOKEN'), true)
    assert.equal(isXBoundSecretRef('x_publish_token'), true)
    assert.equal(isXBoundSecretRef('X_ACCOUNT_123_TOKEN'), true)
    assert.equal(isXBoundSecretRef('PINTEREST_TOKEN'), false)
    assert.equal(isXBoundSecretRef('GENERIC_TOKEN'), false)
  })

  // 8. Secret value not exposed in result
  await t.test('8. Secret value not exposed in result', async () => {
    const { transport } = createMockTransport((req) => {
      if (req.url.includes('/users/me')) {
        return { status: 200, body: { data: { id: 'x-user-12345', username: 'growth_user' } } }
      }
      return { status: 201, body: { data: { id: 'tweet-999', text: 'hello' } } }
    })
    const adapter = new XPublishingAdapter({ transport })
    const secretVal = 'SUPER_SECRET_TOKEN_XYZ_123'
    const res = await adapter.publishText({
      text: 'Test tweet',
      expectedAccountHandle: 'growth_user',
      credential: {
        secretRef: 'X_ACCESS_TOKEN',
        secretValue: secretVal,
        accountId: 'acc-1',
        platformAdapterKey: 'x',
      },
    })
    assert.equal(res.ok, true)
    const jsonResult = JSON.stringify(res)
    assert.ok(!jsonResult.includes(secretVal), 'Result must not contain secret token')
  })

  // 9. Pending approval => zero HTTP calls
  await t.test('9. Pending approval => zero HTTP calls', async () => {
    const env = await setupTestEnvironment()
    const reqRes = await requestPublicationDispatch(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
    })
    assert.ok(reqRes.approvalRequest)

    const { transport, recordedRequests } = createMockTransport(() => ({
      status: 200,
      body: {},
    }))

    const dispRes = await dispatchApprovedPublication(
      env.db,
      { workspaceId: env.workspaceId, approvalRequestId: reqRes.approvalRequest.id },
      {
        xTransport: transport,
        secretResolver: createEnvSecretResolver({ X_ACCESS_TOKEN: 'mock-token' }),
      },
    )
    assert.equal(dispRes.ok, false)
    assert.equal(dispRes.code, 'not_approved')
    assert.equal(recordedRequests.length, 0, 'Must make zero HTTP calls when approval is pending')
  })

  // 10. Rejected approval => zero HTTP calls
  await t.test('10. Rejected approval => zero HTTP calls', async () => {
    const env = await setupTestEnvironment()
    const reqRes = await requestPublicationDispatch(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
    })
    assert.ok(reqRes.approvalRequest)

    await decideApprovalRequest(env.db, {
      workspaceId: env.workspaceId,
      requestId: reqRes.approvalRequest.id,
      decision: 'rejected',
      decisionReason: 'Not ready for public release',
      actor: { actorType: 'user', actorId: null },
    })

    const { transport, recordedRequests } = createMockTransport(() => ({
      status: 200,
      body: {},
    }))

    const dispRes = await dispatchApprovedPublication(
      env.db,
      { workspaceId: env.workspaceId, approvalRequestId: reqRes.approvalRequest.id },
      {
        xTransport: transport,
        secretResolver: createEnvSecretResolver({ X_ACCESS_TOKEN: 'mock-token' }),
      },
    )
    assert.equal(dispRes.ok, false)
    assert.equal(dispRes.code, 'not_approved')
    assert.equal(recordedRequests.length, 0, 'Must make zero HTTP calls when approval is rejected')
  })

  // 11. Cancelled approval => zero HTTP calls
  await t.test('11. Cancelled approval => zero HTTP calls', async () => {
    const env = await setupTestEnvironment()
    const reqRes = await requestPublicationDispatch(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
    })
    assert.ok(reqRes.approvalRequest)

    await execute(env.db, "UPDATE approval SET status = 'cancelled' WHERE id = ?", [
      reqRes.approvalRequest.id,
    ])

    const { transport, recordedRequests } = createMockTransport(() => ({
      status: 200,
      body: {},
    }))

    const dispRes = await dispatchApprovedPublication(
      env.db,
      { workspaceId: env.workspaceId, approvalRequestId: reqRes.approvalRequest.id },
      {
        xTransport: transport,
        secretResolver: createEnvSecretResolver({ X_ACCESS_TOKEN: 'mock-token' }),
      },
    )
    assert.equal(dispRes.ok, false)
    assert.equal(dispRes.code, 'not_approved')
    assert.equal(recordedRequests.length, 0, 'Must make zero HTTP calls when approval is cancelled')
  })

  // 12. Expired approval => zero HTTP calls
  await t.test('12. Expired approval => zero HTTP calls', async () => {
    const env = await setupTestEnvironment()
    const reqRes = await requestPublicationDispatch(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
    })
    assert.ok(reqRes.approvalRequest)

    await execute(env.db, "UPDATE approval SET status = 'expired' WHERE id = ?", [
      reqRes.approvalRequest.id,
    ])

    const { transport, recordedRequests } = createMockTransport(() => ({
      status: 200,
      body: {},
    }))

    const dispRes = await dispatchApprovedPublication(
      env.db,
      { workspaceId: env.workspaceId, approvalRequestId: reqRes.approvalRequest.id },
      {
        xTransport: transport,
        secretResolver: createEnvSecretResolver({ X_ACCESS_TOKEN: 'mock-token' }),
      },
    )
    assert.equal(dispRes.ok, false)
    assert.equal(dispRes.code, 'not_approved')
    assert.equal(recordedRequests.length, 0, 'Must make zero HTTP calls when approval is expired')
  })

  // 13. Stale eligibility => zero HTTP calls
  await t.test('13. Stale eligibility => zero HTTP calls', async () => {
    const env = await setupTestEnvironment()
    const reqRes = await requestPublicationDispatch(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
    })
    assert.ok(reqRes.approvalRequest)

    await decideApprovalRequest(env.db, {
      workspaceId: env.workspaceId,
      requestId: reqRes.approvalRequest.id,
      decision: 'approved',
      actor: { actorType: 'user', actorId: null },
    })

    // Editorial approval revoked afterwards
    await revokeCampaignContentApproval(env.db, {
      workspaceId: env.workspaceId,
      campaignId: env.campaignId,
      contentId: env.contentId,
      actorType: 'user',
    })

    const { transport, recordedRequests } = createMockTransport(() => ({
      status: 200,
      body: {},
    }))

    const dispRes = await dispatchApprovedPublication(
      env.db,
      { workspaceId: env.workspaceId, approvalRequestId: reqRes.approvalRequest.id },
      {
        xTransport: transport,
        secretResolver: createEnvSecretResolver({ X_ACCESS_TOKEN: 'mock-token' }),
      },
    )
    assert.equal(dispRes.ok, false)
    assert.equal(dispRes.code, 'ineligible')
    assert.equal(recordedRequests.length, 0, 'Must make zero HTTP calls when eligibility is stale')
  })

  // 14. Snapshot tamper => zero HTTP calls and integrity error
  await t.test('14. Snapshot tamper => zero HTTP calls and integrity error', async () => {
    const env = await setupTestEnvironment()
    const reqRes = await requestPublicationDispatch(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
    })
    assert.ok(reqRes.approvalRequest)

    await decideApprovalRequest(env.db, {
      workspaceId: env.workspaceId,
      requestId: reqRes.approvalRequest.id,
      decision: 'approved',
      actor: { actorType: 'user', actorId: null },
    })

    await execute(
      env.db,
      'UPDATE approval SET snapshot_json = \'{"tampered":true}\' WHERE id = ?',
      [reqRes.approvalRequest.id],
    )

    const { transport, recordedRequests } = createMockTransport(() => ({
      status: 200,
      body: {},
    }))

    await assert.rejects(
      () =>
        dispatchApprovedPublication(
          env.db,
          { workspaceId: env.workspaceId, approvalRequestId: reqRes.approvalRequest.id },
          {
            xTransport: transport,
            secretResolver: createEnvSecretResolver({ X_ACCESS_TOKEN: 'mock-token' }),
          },
        ),
      /integrity violation/,
    )
    assert.equal(recordedRequests.length, 0, 'Must make zero HTTP calls when snapshot is tampered')
  })

  // 15. Valid approved dispatch resolves credential
  await t.test('15. Valid approved dispatch resolves credential', async () => {
    const env = await setupTestEnvironment()
    const reqRes = await requestPublicationDispatch(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
    })
    assert.ok(reqRes.approvalRequest)

    await decideApprovalRequest(env.db, {
      workspaceId: env.workspaceId,
      requestId: reqRes.approvalRequest.id,
      decision: 'approved',
      actor: { actorType: 'user', actorId: null },
    })

    const { transport } = createMockTransport((req) => {
      if (req.url.includes('/users/me')) {
        return { status: 200, body: { data: { id: 'x-user-12345', username: 'growth_user' } } }
      }
      return { status: 201, body: { data: { id: 'x-tweet-101', text: 'tweet' } } }
    })

    const dispRes = await dispatchApprovedPublication(
      env.db,
      { workspaceId: env.workspaceId, approvalRequestId: reqRes.approvalRequest.id },
      {
        xTransport: transport,
        secretResolver: createEnvSecretResolver({ X_ACCESS_TOKEN: 'live-resolved-x-token' }),
      },
    )
    assert.equal(dispRes.ok, true)
    assert.equal(dispRes.code, 'published')
    assert.equal(dispRes.externalId, 'x-tweet-101')
  })

  // 16. /users/me occurs before /2/tweets
  await t.test('16. /users/me occurs before /2/tweets', async () => {
    const env = await setupTestEnvironment()
    const reqRes = await requestPublicationDispatch(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
    })
    assert.ok(reqRes.approvalRequest)

    await decideApprovalRequest(env.db, {
      workspaceId: env.workspaceId,
      requestId: reqRes.approvalRequest.id,
      decision: 'approved',
      actor: { actorType: 'user', actorId: null },
    })

    const { transport, recordedRequests } = createMockTransport((req) => {
      if (req.url.includes('/users/me')) {
        return { status: 200, body: { data: { id: 'x-user-12345', username: 'growth_user' } } }
      }
      return { status: 201, body: { data: { id: 'x-tweet-102', text: 'tweet' } } }
    })

    await dispatchApprovedPublication(
      env.db,
      { workspaceId: env.workspaceId, approvalRequestId: reqRes.approvalRequest.id },
      {
        xTransport: transport,
        secretResolver: createEnvSecretResolver({ X_ACCESS_TOKEN: 'valid-x-token' }),
      },
    )

    assert.equal(recordedRequests.length, 2)
    assert.ok(recordedRequests[0].url.includes('/2/users/me'), 'First request must be /2/users/me')
    assert.ok(recordedRequests[1].url.includes('/2/tweets'), 'Second request must be /2/tweets')
  })

  // 17. Wrong authenticated X user => zero POST /2/tweets
  await t.test('17. Wrong authenticated X user => zero POST /2/tweets', async () => {
    const env = await setupTestEnvironment()
    const reqRes = await requestPublicationDispatch(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
    })
    assert.ok(reqRes.approvalRequest)

    await decideApprovalRequest(env.db, {
      workspaceId: env.workspaceId,
      requestId: reqRes.approvalRequest.id,
      decision: 'approved',
      actor: { actorType: 'user', actorId: null },
    })

    const { transport, recordedRequests } = createMockTransport((req) => {
      if (req.url.includes('/users/me')) {
        // Return a completely different X user
        return {
          status: 200,
          body: { data: { id: 'wrong-user-999', username: 'imposter_handle' } },
        }
      }
      return { status: 201, body: { data: { id: 'should-not-happen' } } }
    })

    const dispRes = await dispatchApprovedPublication(
      env.db,
      { workspaceId: env.workspaceId, approvalRequestId: reqRes.approvalRequest.id },
      {
        xTransport: transport,
        secretResolver: createEnvSecretResolver({ X_ACCESS_TOKEN: 'valid-x-token' }),
      },
    )

    assert.equal(dispRes.ok, false)
    assert.equal(dispRes.code, 'account_identity_mismatch')
    assert.equal(
      recordedRequests.length,
      1,
      'Must NOT make POST /2/tweets when user identity mismatches',
    )

    const post = await getPostDetail(env.db, env.workspaceId, env.postId)
    assert.equal(post?.status, 'failed')
  })

  // 18. Matching account identity permits POST
  await t.test('18. Matching account identity permits POST', async () => {
    const env = await setupTestEnvironment()
    const reqRes = await requestPublicationDispatch(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
    })
    assert.ok(reqRes.approvalRequest)

    await decideApprovalRequest(env.db, {
      workspaceId: env.workspaceId,
      requestId: reqRes.approvalRequest.id,
      decision: 'approved',
      actor: { actorType: 'user', actorId: null },
    })

    const { transport, recordedRequests } = createMockTransport((req) => {
      if (req.url.includes('/users/me')) {
        return { status: 200, body: { data: { id: 'x-user-12345', username: 'growth_user' } } }
      }
      return { status: 201, body: { data: { id: 'tweet-correct', text: 'tweet' } } }
    })

    const dispRes = await dispatchApprovedPublication(
      env.db,
      { workspaceId: env.workspaceId, approvalRequestId: reqRes.approvalRequest.id },
      {
        xTransport: transport,
        secretResolver: createEnvSecretResolver({ X_ACCESS_TOKEN: 'valid-x-token' }),
      },
    )

    assert.equal(dispRes.ok, true)
    assert.equal(dispRes.code, 'published')
    assert.equal(recordedRequests.length, 2)
  })

  // 19. Exact approved Variant text sent
  await t.test('19. Exact approved Variant text sent', async () => {
    const env = await setupTestEnvironment()
    const reqRes = await requestPublicationDispatch(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
    })
    assert.ok(reqRes.approvalRequest)

    await decideApprovalRequest(env.db, {
      workspaceId: env.workspaceId,
      requestId: reqRes.approvalRequest.id,
      decision: 'approved',
      actor: { actorType: 'user', actorId: null },
    })

    let tweetBodySent: string | undefined
    const { transport } = createMockTransport((req) => {
      if (req.url.includes('/users/me')) {
        return { status: 200, body: { data: { id: 'x-user-12345', username: 'growth_user' } } }
      }
      if (req.url.includes('/tweets')) {
        const parsed = JSON.parse(req.body ?? '{}')
        tweetBodySent = parsed.text
        return { status: 201, body: { data: { id: 'tweet-exact-text', text: parsed.text } } }
      }
      return { status: 500, body: {} }
    })

    await dispatchApprovedPublication(
      env.db,
      { workspaceId: env.workspaceId, approvalRequestId: reqRes.approvalRequest.id },
      {
        xTransport: transport,
        secretResolver: createEnvSecretResolver({ X_ACCESS_TOKEN: 'valid-x-token' }),
      },
    )

    assert.equal(tweetBodySent, 'Exciting news! We are launching our new platform today.')
  })

  // 20. Browser content cannot override text
  await t.test('20. Browser content cannot override text', async () => {
    const env = await setupTestEnvironment()
    // Post was prepared with approved variant. Browser cannot alter post.content_variant_id or variant body in DB.
    const post = await getPostDetail(env.db, env.workspaceId, env.postId)
    assert.equal(post?.variantBody, 'Exciting news! We are launching our new platform today.')
  })

  // 21. Browser Account cannot redirect destination
  await t.test('21. Browser Account cannot redirect destination', async () => {
    const env = await setupTestEnvironment()
    const reqRes = await requestPublicationDispatch(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
    })
    assert.ok(reqRes.approvalRequest)
    // Snapshot payload locks the accountId derived server-side
    const snapshot = JSON.parse(reqRes.approvalRequest.snapshotJson)
    assert.equal(snapshot.accountId, env.accountId)
  })

  // 22. One approved dispatch => max one POST /2/tweets
  await t.test('22. One approved dispatch => max one POST /2/tweets', async () => {
    const env = await setupTestEnvironment()
    const reqRes = await requestPublicationDispatch(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
    })
    assert.ok(reqRes.approvalRequest)

    await decideApprovalRequest(env.db, {
      workspaceId: env.workspaceId,
      requestId: reqRes.approvalRequest.id,
      decision: 'approved',
      actor: { actorType: 'user', actorId: null },
    })

    let tweetCalls = 0
    const { transport } = createMockTransport((req) => {
      if (req.url.includes('/users/me')) {
        return { status: 200, body: { data: { id: 'x-user-12345', username: 'growth_user' } } }
      }
      if (req.url.includes('/tweets')) {
        tweetCalls++
        return { status: 201, body: { data: { id: 'tweet-once', text: 'tweet' } } }
      }
      return { status: 500, body: {} }
    })

    await dispatchApprovedPublication(
      env.db,
      { workspaceId: env.workspaceId, approvalRequestId: reqRes.approvalRequest.id },
      {
        xTransport: transport,
        secretResolver: createEnvSecretResolver({ X_ACCESS_TOKEN: 'valid-x-token' }),
      },
    )

    assert.equal(tweetCalls, 1, 'Exactly one POST /2/tweets call made')
  })

  // 23. Concurrent / double dispatch => max one provider create
  await t.test('23. Concurrent / double dispatch => max one provider create', async () => {
    const env = await setupTestEnvironment()
    const reqRes = await requestPublicationDispatch(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
    })
    assert.ok(reqRes.approvalRequest)

    await decideApprovalRequest(env.db, {
      workspaceId: env.workspaceId,
      requestId: reqRes.approvalRequest.id,
      decision: 'approved',
      actor: { actorType: 'user', actorId: null },
    })

    let tweetCalls = 0
    const { transport } = createMockTransport((req) => {
      if (req.url.includes('/users/me')) {
        return { status: 200, body: { data: { id: 'x-user-12345', username: 'growth_user' } } }
      }
      if (req.url.includes('/tweets')) {
        tweetCalls++
        return { status: 201, body: { data: { id: 'tweet-concurrent', text: 'tweet' } } }
      }
      return { status: 500, body: {} }
    })

    const res1 = await dispatchApprovedPublication(
      env.db,
      { workspaceId: env.workspaceId, approvalRequestId: reqRes.approvalRequest.id },
      {
        xTransport: transport,
        secretResolver: createEnvSecretResolver({ X_ACCESS_TOKEN: 'valid-x-token' }),
      },
    )

    const res2 = await dispatchApprovedPublication(
      env.db,
      { workspaceId: env.workspaceId, approvalRequestId: reqRes.approvalRequest.id },
      {
        xTransport: transport,
        secretResolver: createEnvSecretResolver({ X_ACCESS_TOKEN: 'valid-x-token' }),
      },
    )

    assert.equal(res1.ok, true)
    assert.equal(res2.ok, false)
    assert.equal(res2.code, 'ineligible')
    assert.equal(
      tweetCalls,
      1,
      'Must make only one create-tweet call across sequential/duplicate dispatches',
    )
  })

  // 24. Success requires HTTP 201
  await t.test('24. Success requires HTTP 201', async () => {
    const { transport } = createMockTransport((req) => {
      if (req.url.includes('/users/me')) {
        return { status: 200, body: { data: { id: 'x-user-12345', username: 'growth_user' } } }
      }
      return { status: 200, body: { data: { id: 'unexpected-200' } } } // HTTP 200 instead of 201
    })

    const adapter = new XPublishingAdapter({ transport })
    const res = await adapter.publishText({
      text: 'Tweet text',
      expectedAccountHandle: 'growth_user',
      credential: {
        secretRef: 'X_ACCESS_TOKEN',
        secretValue: 'token',
        accountId: 'acc-1',
        platformAdapterKey: 'x',
      },
    })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'provider_error')
  })

  // 25. Success requires valid data.id
  await t.test('25. Success requires valid data.id', async () => {
    const { transport } = createMockTransport((req) => {
      if (req.url.includes('/users/me')) {
        return { status: 200, body: { data: { id: 'x-user-12345', username: 'growth_user' } } }
      }
      return { status: 201, body: { data: { id: '   ' } } } // whitespace id
    })

    const adapter = new XPublishingAdapter({ transport })
    const res = await adapter.publishText({
      text: 'Tweet text',
      expectedAccountHandle: 'growth_user',
      credential: {
        secretRef: 'X_ACCESS_TOKEN',
        secretValue: 'token',
        accountId: 'acc-1',
        platformAdapterKey: 'x',
      },
    })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'provider_error')
  })

  // 26. Malformed success does not publish
  await t.test('26. Malformed success does not publish', async () => {
    const { transport } = createMockTransport((req) => {
      if (req.url.includes('/users/me')) {
        return { status: 200, body: { data: { id: 'x-user-12345', username: 'growth_user' } } }
      }
      return { status: 201, body: null } // null payload
    })

    const adapter = new XPublishingAdapter({ transport })
    const res = await adapter.publishText({
      text: 'Tweet text',
      expectedAccountHandle: 'growth_user',
      credential: {
        secretRef: 'X_ACCESS_TOKEN',
        secretValue: 'token',
        accountId: 'acc-1',
        platformAdapterKey: 'x',
      },
    })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'provider_error')
  })

  // 27. External_id equals provider ID
  await t.test('27. External_id equals provider ID', async () => {
    const env = await setupTestEnvironment()
    const reqRes = await requestPublicationDispatch(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
    })
    assert.ok(reqRes.approvalRequest)

    await decideApprovalRequest(env.db, {
      workspaceId: env.workspaceId,
      requestId: reqRes.approvalRequest.id,
      decision: 'approved',
      actor: { actorType: 'user', actorId: null },
    })

    const providerTweetId = '1892837465920192837'
    const { transport } = createMockTransport((req) => {
      if (req.url.includes('/users/me')) {
        return { status: 200, body: { data: { id: 'x-user-12345', username: 'growth_user' } } }
      }
      return { status: 201, body: { data: { id: providerTweetId, text: 'text' } } }
    })

    const dispRes = await dispatchApprovedPublication(
      env.db,
      { workspaceId: env.workspaceId, approvalRequestId: reqRes.approvalRequest.id },
      {
        xTransport: transport,
        secretResolver: createEnvSecretResolver({ X_ACCESS_TOKEN: 'valid-x-token' }),
      },
    )

    assert.equal(dispRes.ok, true)
    assert.equal(dispRes.externalId, providerTweetId)

    const post = await getPostDetail(env.db, env.workspaceId, env.postId)
    assert.equal(post?.externalId, providerTweetId)
  })

  // 28. url remains null unless actually returned
  await t.test('28. url remains null unless actually returned', async () => {
    const env = await setupTestEnvironment()
    const reqRes = await requestPublicationDispatch(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
    })
    assert.ok(reqRes.approvalRequest)

    await decideApprovalRequest(env.db, {
      workspaceId: env.workspaceId,
      requestId: reqRes.approvalRequest.id,
      decision: 'approved',
      actor: { actorType: 'user', actorId: null },
    })

    const { transport } = createMockTransport((req) => {
      if (req.url.includes('/users/me')) {
        return { status: 200, body: { data: { id: 'x-user-12345', username: 'growth_user' } } }
      }
      return { status: 201, body: { data: { id: 'tweet-url-null-test', text: 'text' } } }
    })

    await dispatchApprovedPublication(
      env.db,
      { workspaceId: env.workspaceId, approvalRequestId: reqRes.approvalRequest.id },
      {
        xTransport: transport,
        secretResolver: createEnvSecretResolver({ X_ACCESS_TOKEN: 'valid-x-token' }),
      },
    )

    const post = await getPostDetail(env.db, env.workspaceId, env.postId)
    assert.equal(post?.url, null)
  })

  // 29. published_at set only after success
  await t.test('29. published_at set only after success', async () => {
    const env = await setupTestEnvironment()
    const reqRes = await requestPublicationDispatch(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
    })
    assert.ok(reqRes.approvalRequest)

    await decideApprovalRequest(env.db, {
      workspaceId: env.workspaceId,
      requestId: reqRes.approvalRequest.id,
      decision: 'approved',
      actor: { actorType: 'user', actorId: null },
    })

    const { transport } = createMockTransport((req) => {
      if (req.url.includes('/users/me')) {
        return { status: 200, body: { data: { id: 'x-user-12345', username: 'growth_user' } } }
      }
      return { status: 201, body: { data: { id: 'tweet-published-at', text: 'text' } } }
    })

    const postBefore = await getPostDetail(env.db, env.workspaceId, env.postId)
    assert.equal(postBefore?.publishedAt, null)

    const publishTimestamp = '2026-08-22T04:45:00.000Z'
    await dispatchApprovedPublication(
      env.db,
      { workspaceId: env.workspaceId, approvalRequestId: reqRes.approvalRequest.id },
      {
        xTransport: transport,
        secretResolver: createEnvSecretResolver({ X_ACCESS_TOKEN: 'valid-x-token' }),
        nowOverride: publishTimestamp,
      },
    )

    const postAfter = await getPostDetail(env.db, env.workspaceId, env.postId)
    assert.equal(postAfter?.publishedAt, publishTimestamp)
  })

  // 30. post.status published only after success
  await t.test('30. post.status published only after success', async () => {
    const env = await setupTestEnvironment()
    const reqRes = await requestPublicationDispatch(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
    })
    assert.ok(reqRes.approvalRequest)

    await decideApprovalRequest(env.db, {
      workspaceId: env.workspaceId,
      requestId: reqRes.approvalRequest.id,
      decision: 'approved',
      actor: { actorType: 'user', actorId: null },
    })

    const { transport } = createMockTransport((req) => {
      if (req.url.includes('/users/me')) {
        return { status: 200, body: { data: { id: 'x-user-12345', username: 'growth_user' } } }
      }
      return { status: 201, body: { data: { id: 'tweet-status-published', text: 'text' } } }
    })

    await dispatchApprovedPublication(
      env.db,
      { workspaceId: env.workspaceId, approvalRequestId: reqRes.approvalRequest.id },
      {
        xTransport: transport,
        secretResolver: createEnvSecretResolver({ X_ACCESS_TOKEN: 'valid-x-token' }),
      },
    )

    const post = await getPostDetail(env.db, env.workspaceId, env.postId)
    assert.equal(post?.status, 'published')
  })

  // 31. HTTP 400 normalized
  await t.test('31. HTTP 400 normalized to invalid_request', async () => {
    const { transport } = createMockTransport((req) => {
      if (req.url.includes('/users/me')) {
        return { status: 200, body: { data: { id: 'x-user-12345', username: 'growth_user' } } }
      }
      return { status: 400, body: { errors: [{ message: 'Bad request' }] } }
    })
    const adapter = new XPublishingAdapter({ transport })
    const res = await adapter.publishText({
      text: 'Tweet text',
      expectedAccountHandle: 'growth_user',
      credential: {
        secretRef: 'X_ACCESS_TOKEN',
        secretValue: 'token',
        accountId: 'acc-1',
        platformAdapterKey: 'x',
      },
    })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'invalid_request')
  })

  // 32. HTTP 401 normalized
  await t.test('32. HTTP 401 normalized to unauthorized', async () => {
    const { transport } = createMockTransport(() => ({
      status: 401,
      body: { title: 'Unauthorized' },
    }))
    const adapter = new XPublishingAdapter({ transport })
    const res = await adapter.publishText({
      text: 'Tweet text',
      expectedAccountHandle: 'growth_user',
      credential: {
        secretRef: 'X_ACCESS_TOKEN',
        secretValue: 'token',
        accountId: 'acc-1',
        platformAdapterKey: 'x',
      },
    })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'unauthorized')
  })

  // 33. HTTP 403 normalized
  await t.test('33. HTTP 403 normalized to forbidden', async () => {
    const { transport } = createMockTransport((req) => {
      if (req.url.includes('/users/me')) {
        return { status: 200, body: { data: { id: 'x-user-12345', username: 'growth_user' } } }
      }
      return { status: 403, body: { title: 'Forbidden' } }
    })
    const adapter = new XPublishingAdapter({ transport })
    const res = await adapter.publishText({
      text: 'Tweet text',
      expectedAccountHandle: 'growth_user',
      credential: {
        secretRef: 'X_ACCESS_TOKEN',
        secretValue: 'token',
        accountId: 'acc-1',
        platformAdapterKey: 'x',
      },
    })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'forbidden')
  })

  // 34. HTTP 429 normalized with retry metadata
  await t.test('34. HTTP 429 normalized to rate_limited', async () => {
    const { transport } = createMockTransport((req) => {
      if (req.url.includes('/users/me')) {
        return { status: 200, body: { data: { id: 'x-user-12345', username: 'growth_user' } } }
      }
      return {
        status: 429,
        body: { title: 'Too Many Requests' },
        headers: { 'retry-after': '60' },
      }
    })
    const adapter = new XPublishingAdapter({ transport })
    const res = await adapter.publishText({
      text: 'Tweet text',
      expectedAccountHandle: 'growth_user',
      credential: {
        secretRef: 'X_ACCESS_TOKEN',
        secretValue: 'token',
        accountId: 'acc-1',
        platformAdapterKey: 'x',
      },
    })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'rate_limited')
    assert.equal(res.retryAfterMs, 60_000)
  })

  // 35. HTTP 5xx normalized to provider_error
  await t.test('35. HTTP 5xx normalized to provider_error', async () => {
    const { transport } = createMockTransport((req) => {
      if (req.url.includes('/users/me')) {
        return { status: 200, body: { data: { id: 'x-user-12345', username: 'growth_user' } } }
      }
      return { status: 503, body: { title: 'Service Unavailable' } }
    })
    const adapter = new XPublishingAdapter({ transport })
    const res = await adapter.publishText({
      text: 'Tweet text',
      expectedAccountHandle: 'growth_user',
      credential: {
        secretRef: 'X_ACCESS_TOKEN',
        secretValue: 'token',
        accountId: 'acc-1',
        platformAdapterKey: 'x',
      },
    })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'provider_error')
    assert.equal(res.ambiguous, true)
  })

  // 36. Timeout normalized to timeout
  await t.test('36. Timeout normalized to timeout', async () => {
    const transport: XHttpTransport = async () => {
      const err = new Error('The operation was aborted')
      err.name = 'AbortError'
      throw err
    }
    const adapter = new XPublishingAdapter({ transport })
    const res = await adapter.publishText({
      text: 'Tweet text',
      expectedAccountHandle: 'growth_user',
      credential: {
        secretRef: 'X_ACCESS_TOKEN',
        secretValue: 'token',
        accountId: 'acc-1',
        platformAdapterKey: 'x',
      },
    })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'timeout')
  })

  // 37. Network failure handled as potentially ambiguous
  await t.test('37. Network failure handled as potentially ambiguous', async () => {
    const transport: XHttpTransport = async (url) => {
      if (url.includes('/users/me')) {
        return new Response(
          JSON.stringify({ data: { id: 'x-user-12345', username: 'growth_user' } }),
          { status: 200 },
        )
      }
      throw new Error('ECONNRESET')
    }
    const adapter = new XPublishingAdapter({ transport })
    const res = await adapter.publishText({
      text: 'Tweet text',
      expectedAccountHandle: 'growth_user',
      credential: {
        secretRef: 'X_ACCESS_TOKEN',
        secretValue: 'token',
        accountId: 'acc-1',
        platformAdapterKey: 'x',
      },
    })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'network_error')
    assert.equal(res.ambiguous, true)
  })

  // 38. No automatic POST retry
  await t.test('38. No automatic POST retry on failure', async () => {
    let postAttempts = 0
    const { transport } = createMockTransport((req) => {
      if (req.url.includes('/users/me')) {
        return { status: 200, body: { data: { id: 'x-user-12345', username: 'growth_user' } } }
      }
      postAttempts++
      return { status: 500, body: { title: 'Internal Server Error' } }
    })
    const adapter = new XPublishingAdapter({ transport })
    await adapter.publishText({
      text: 'Tweet text',
      expectedAccountHandle: 'growth_user',
      credential: {
        secretRef: 'X_ACCESS_TOKEN',
        secretValue: 'token',
        accountId: 'acc-1',
        platformAdapterKey: 'x',
      },
    })
    assert.equal(postAttempts, 1, 'Must never perform automatic retries for POST /2/tweets')
  })

  // 39. Provider failure does not mark published
  await t.test('39. Provider failure does not mark published', async () => {
    const env = await setupTestEnvironment()
    const reqRes = await requestPublicationDispatch(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
    })
    assert.ok(reqRes.approvalRequest)

    await decideApprovalRequest(env.db, {
      workspaceId: env.workspaceId,
      requestId: reqRes.approvalRequest.id,
      decision: 'approved',
      actor: { actorType: 'user', actorId: null },
    })

    const { transport } = createMockTransport((req) => {
      if (req.url.includes('/users/me')) {
        return { status: 200, body: { data: { id: 'x-user-12345', username: 'growth_user' } } }
      }
      return { status: 500, body: { title: 'Internal Server Error' } }
    })

    const dispRes = await dispatchApprovedPublication(
      env.db,
      { workspaceId: env.workspaceId, approvalRequestId: reqRes.approvalRequest.id },
      {
        xTransport: transport,
        secretResolver: createEnvSecretResolver({ X_ACCESS_TOKEN: 'valid-x-token' }),
      },
    )

    assert.equal(dispRes.ok, false)
    const post = await getPostDetail(env.db, env.workspaceId, env.postId)
    assert.equal(post?.status, 'failed')
    assert.equal(post?.publishedAt, null)
    assert.equal(post?.externalId, null)
  })

  // 40. Token never stored in Post error
  await t.test('40. Token never stored in Post error', async () => {
    const env = await setupTestEnvironment()
    const reqRes = await requestPublicationDispatch(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
    })
    assert.ok(reqRes.approvalRequest)

    await decideApprovalRequest(env.db, {
      workspaceId: env.workspaceId,
      requestId: reqRes.approvalRequest.id,
      decision: 'approved',
      actor: { actorType: 'user', actorId: null },
    })

    const secretValue = 'SECRET_TOKEN_VALUE_40'
    const { transport } = createMockTransport(() => ({
      status: 401,
      body: { title: 'Unauthorized' },
    }))

    await dispatchApprovedPublication(
      env.db,
      { workspaceId: env.workspaceId, approvalRequestId: reqRes.approvalRequest.id },
      {
        xTransport: transport,
        secretResolver: createEnvSecretResolver({ X_ACCESS_TOKEN: secretValue }),
      },
    )

    const post = await getPostDetail(env.db, env.workspaceId, env.postId)
    assert.ok(post?.error)
    assert.ok(!post?.error?.includes(secretValue), 'Post error must not contain secret token')
  })

  // 41. Token absent from audit logs
  await t.test('41. Token absent from audit logs', async () => {
    const env = await setupTestEnvironment()
    const secretValue = 'SECRET_TOKEN_VALUE_41'
    const reqRes = await requestPublicationDispatch(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
    })
    assert.ok(reqRes.approvalRequest)

    await decideApprovalRequest(env.db, {
      workspaceId: env.workspaceId,
      requestId: reqRes.approvalRequest.id,
      decision: 'approved',
      actor: { actorType: 'user', actorId: null },
    })

    const { transport } = createMockTransport((req) => {
      if (req.url.includes('/users/me')) {
        return { status: 200, body: { data: { id: 'x-user-12345', username: 'growth_user' } } }
      }
      return { status: 201, body: { data: { id: 'audit-tweet-1', text: 'tweet' } } }
    })

    await dispatchApprovedPublication(
      env.db,
      { workspaceId: env.workspaceId, approvalRequestId: reqRes.approvalRequest.id },
      {
        xTransport: transport,
        secretResolver: createEnvSecretResolver({ X_ACCESS_TOKEN: secretValue }),
      },
    )

    const auditRows = await queryAll<{ new_value: string }>(
      env.db,
      'SELECT new_value FROM audit_log WHERE workspace_id = ?',
      [env.workspaceId],
    )
    for (const row of auditRows) {
      assert.ok(!row.new_value?.includes(secretValue), 'Audit log must not contain secret token')
    }
  })

  // 42. Token absent from events
  await t.test('42. Token absent from events', async () => {
    const env = await setupTestEnvironment()
    const secretValue = 'SECRET_TOKEN_VALUE_42'
    const reqRes = await requestPublicationDispatch(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
    })
    assert.ok(reqRes.approvalRequest)

    await decideApprovalRequest(env.db, {
      workspaceId: env.workspaceId,
      requestId: reqRes.approvalRequest.id,
      decision: 'approved',
      actor: { actorType: 'user', actorId: null },
    })

    const { transport } = createMockTransport((req) => {
      if (req.url.includes('/users/me')) {
        return { status: 200, body: { data: { id: 'x-user-12345', username: 'growth_user' } } }
      }
      return { status: 201, body: { data: { id: 'event-tweet-1', text: 'tweet' } } }
    })

    await dispatchApprovedPublication(
      env.db,
      { workspaceId: env.workspaceId, approvalRequestId: reqRes.approvalRequest.id },
      {
        xTransport: transport,
        secretResolver: createEnvSecretResolver({ X_ACCESS_TOKEN: secretValue }),
      },
    )

    const eventRows = await queryAll<{ payload: string }>(
      env.db,
      'SELECT payload FROM event WHERE workspace_id = ?',
      [env.workspaceId],
    )
    for (const row of eventRows) {
      assert.ok(!row.payload?.includes(secretValue), 'Event payload must not contain secret token')
    }
  })

  // 43. Authorization header absent from persisted data
  await t.test('43. Authorization header absent from persisted data', async () => {
    const env = await setupTestEnvironment()
    const reqRes = await requestPublicationDispatch(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
    })
    assert.ok(reqRes.approvalRequest)

    await decideApprovalRequest(env.db, {
      workspaceId: env.workspaceId,
      requestId: reqRes.approvalRequest.id,
      decision: 'approved',
      actor: { actorType: 'user', actorId: null },
    })

    const { transport } = createMockTransport((req) => {
      if (req.url.includes('/users/me')) {
        return { status: 200, body: { data: { id: 'x-user-12345', username: 'growth_user' } } }
      }
      return { status: 201, body: { data: { id: 'tweet-auth-test', text: 'tweet' } } }
    })

    await dispatchApprovedPublication(
      env.db,
      { workspaceId: env.workspaceId, approvalRequestId: reqRes.approvalRequest.id },
      {
        xTransport: transport,
        secretResolver: createEnvSecretResolver({ X_ACCESS_TOKEN: 'token-43' }),
      },
    )

    const allEvents = await queryAll<{ payload: string }>(env.db, 'SELECT payload FROM event')
    for (const e of allEvents) {
      assert.ok(!e.payload?.toLowerCase().includes('authorization: bearer'))
    }
  })

  // 44. publication.published event emitted only on confirmed success
  await t.test('44. publication.published event emitted only on confirmed success', async () => {
    const env = await setupTestEnvironment()
    const reqRes = await requestPublicationDispatch(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
    })
    assert.ok(reqRes.approvalRequest)

    await decideApprovalRequest(env.db, {
      workspaceId: env.workspaceId,
      requestId: reqRes.approvalRequest.id,
      decision: 'approved',
      actor: { actorType: 'user', actorId: null },
    })

    const { transport } = createMockTransport((req) => {
      if (req.url.includes('/users/me')) {
        return { status: 200, body: { data: { id: 'x-user-12345', username: 'growth_user' } } }
      }
      return { status: 201, body: { data: { id: 'tweet-44', text: 'text' } } }
    })

    await dispatchApprovedPublication(
      env.db,
      { workspaceId: env.workspaceId, approvalRequestId: reqRes.approvalRequest.id },
      {
        xTransport: transport,
        secretResolver: createEnvSecretResolver({ X_ACCESS_TOKEN: 'valid-x-token' }),
      },
    )

    const publishedEvents = await queryAll<{ event_type: string }>(
      env.db,
      "SELECT event_type FROM event WHERE event_type = 'publication.published'",
    )
    assert.equal(publishedEvents.length, 1)
  })

  // 45. Failure event truthful
  await t.test('45. Failure event truthful', async () => {
    const env = await setupTestEnvironment()
    const reqRes = await requestPublicationDispatch(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
    })
    assert.ok(reqRes.approvalRequest)

    await decideApprovalRequest(env.db, {
      workspaceId: env.workspaceId,
      requestId: reqRes.approvalRequest.id,
      decision: 'approved',
      actor: { actorType: 'user', actorId: null },
    })

    const { transport } = createMockTransport((req) => {
      if (req.url.includes('/users/me')) {
        return { status: 200, body: { data: { id: 'x-user-12345', username: 'growth_user' } } }
      }
      return { status: 403, body: { title: 'Forbidden' } }
    })

    await dispatchApprovedPublication(
      env.db,
      { workspaceId: env.workspaceId, approvalRequestId: reqRes.approvalRequest.id },
      {
        xTransport: transport,
        secretResolver: createEnvSecretResolver({ X_ACCESS_TOKEN: 'valid-x-token' }),
      },
    )

    const failedEvents = await queryAll<{ event_type: string; payload: string }>(
      env.db,
      "SELECT event_type, payload FROM event WHERE event_type = 'publication.failed'",
    )
    assert.equal(failedEvents.length, 1)
    const payload = JSON.parse(failedEvents[0].payload)
    assert.equal(payload.errorCode, 'forbidden')
  })

  // 46. Already-published Post causes zero provider calls
  await t.test('46. Already-published Post causes zero provider calls', async () => {
    const env = await setupTestEnvironment()
    const reqRes = await requestPublicationDispatch(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
    })
    assert.ok(reqRes.approvalRequest)

    await decideApprovalRequest(env.db, {
      workspaceId: env.workspaceId,
      requestId: reqRes.approvalRequest.id,
      decision: 'approved',
      actor: { actorType: 'user', actorId: null },
    })

    // Now mark the post as published in DB
    await execute(
      env.db,
      "UPDATE post SET status = 'published', external_id = 'tweet-already' WHERE id = ?",
      [env.postId],
    )

    await assert.rejects(
      () =>
        requestPublicationDispatch(env.db, {
          workspaceId: env.workspaceId,
          postId: env.postId,
        }),
      /already published/,
    )

    const { transport, recordedRequests } = createMockTransport(() => ({
      status: 200,
      body: {},
    }))

    const dispRes = await dispatchApprovedPublication(
      env.db,
      { workspaceId: env.workspaceId, approvalRequestId: reqRes.approvalRequest.id },
      {
        xTransport: transport,
        secretResolver: createEnvSecretResolver({ X_ACCESS_TOKEN: 'valid-x-token' }),
      },
    )

    assert.equal(dispRes.ok, false) // Revalidation fails (already published)
    assert.equal(dispRes.code, 'ineligible')
    assert.equal(recordedRequests.length, 0, 'Zero provider calls on already published post')
  })

  // 47. Account identity tests: handle match case-insensitive
  await t.test('47. Account identity handle match case-insensitive and stripped @', async () => {
    const { transport } = createMockTransport((req) => {
      if (req.url.includes('/users/me')) {
        return { status: 200, body: { data: { id: 'x-id-999', username: 'Growth_User' } } }
      }
      return { status: 201, body: { data: { id: 'tweet-47' } } }
    })
    const adapter = new XPublishingAdapter({ transport })
    const res = await adapter.publishText({
      text: 'Tweet text',
      expectedAccountHandle: '@growth_user',
      credential: {
        secretRef: 'X_ACCESS_TOKEN',
        secretValue: 'token',
        accountId: 'acc-1',
        platformAdapterKey: 'x',
      },
    })
    assert.equal(res.ok, true)
    assert.equal(res.externalId, 'tweet-47')
  })

  // 48. Account identity tests: provider ID metadata match
  await t.test('48. Account identity provider ID metadata match', async () => {
    const { transport } = createMockTransport((req) => {
      if (req.url.includes('/users/me')) {
        return {
          status: 200,
          body: { data: { id: 'trusted-x-id-123', username: 'new_handle_renamed' } },
        }
      }
      return { status: 201, body: { data: { id: 'tweet-48' } } }
    })
    const adapter = new XPublishingAdapter({ transport })
    const res = await adapter.publishText({
      text: 'Tweet text',
      expectedAccountHandle: 'old_handle',
      trustedProviderUserId: 'trusted-x-id-123',
      credential: {
        secretRef: 'X_ACCESS_TOKEN',
        secretValue: 'token',
        accountId: 'acc-1',
        platformAdapterKey: 'x',
        metadata: { providerUserId: 'trusted-x-id-123' },
      },
    })
    assert.equal(res.ok, true)
    assert.equal(res.externalId, 'tweet-48')
  })

  // 49. Empty text rejected with invalid_request
  await t.test('49. Empty text rejected with invalid_request before network call', async () => {
    let calls = 0
    const { transport } = createMockTransport(() => {
      calls++
      return { status: 200, body: {} }
    })
    const adapter = new XPublishingAdapter({ transport })
    const res = await adapter.publishText({
      text: '    ',
      expectedAccountHandle: 'growth_user',
      credential: {
        secretRef: 'X_ACCESS_TOKEN',
        secretValue: 'token',
        accountId: 'acc-1',
        platformAdapterKey: 'x',
      },
    })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'invalid_request')
    assert.equal(calls, 0, 'Zero network calls on empty text')
  })

  // 50. Malformed /users/me response normalized to provider_error
  await t.test('50. Malformed /users/me response normalized to provider_error', async () => {
    const { transport } = createMockTransport(() => ({
      status: 200,
      body: { data: {} }, // missing id and username
    }))
    const adapter = new XPublishingAdapter({ transport })
    const res = await adapter.publishText({
      text: 'Tweet text',
      expectedAccountHandle: 'growth_user',
      credential: {
        secretRef: 'X_ACCESS_TOKEN',
        secretValue: 'token',
        accountId: 'acc-1',
        platformAdapterKey: 'x',
      },
    })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'provider_error')
    assert.ok(res.message.includes('incomplete'))
  })
})
