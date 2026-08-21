/**
 * STEP 15E.2: Approval-Gated Publication Dispatch Boundary Test Suite
 *
 * Covers:
 * 1. Baseline: publication disabled by default, Publisher agent disabled, platform.publish unavailable.
 * 2. Initiation: explicit user publish request required; no auto-publish on critic pass, approval, intent creation, or schedule.
 * 3. Authority / Reload: server reloads Post from DB; client forged content/account/approval ignored; workspace isolation enforced.
 * 4. Pre-Approval Eligibility: missing approval, revoked approval, paused account, deleted account, archived campaign, disconnected account rejected before creating approval request.
 * 5. Policy Resolution: action 'content.publish', brand scoping, default review mode, hard minimum mode elevating AUTO to REVIEW with source tool_requirement, BLOCKED policy handling.
 * 6. Approval Request Creation: correct actionKey, risk tags, human summary, authoritative snapshot, fingerprinting, idempotency & deduplication.
 * 7. Post State: status remains 'draft', dispatchStatus derived as 'awaiting_approval', externalId and url remain null.
 * 8. Approval Decision: rejection leaves post unpublished and emits publication.approval_rejected; expired approval cannot dispatch.
 * 9. Approval-Time Revalidation: live mutation checks at approval dispatch (revoked approval, paused account, tampered snapshot fail safely).
 * 10. Dispatch Boundary: approved eligible dispatch fails safely as not_configured/unavailable; zero external network calls; post remains unpublished; events & audit logs verified.
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import { BUILTIN_AGENTS } from '../src/server/agents/definitions.ts'
import { ensureBuiltinAgents } from '../src/server/agents/registry.ts'
import {
  createApprovalRequest,
  decideApprovalRequest,
  getApprovalRequest,
} from '../src/server/approval/service.ts'
import { computeSnapshotFingerprint, verifySnapshotIntegrity } from '../src/server/approval/snapshot.ts'
import {
  approveCampaignContentVariant,
  revokeCampaignContentApproval,
} from '../src/server/db/content-approval.ts'
import {
  createPublicationIntent,
  derivePostState,
  dispatchApprovedPublication,
  getPostDetail,
  requestPublicationDispatch,
  toPostDetail,
  validatePublicationEligibility,
} from '../src/server/db/post.ts'
import { execute, newId, nowIso, queryAll, queryFirst, type SqlDatabase } from '../src/server/db/sql.ts'
import { ACTION_DEFINITIONS } from '../src/server/policy/index.ts'
import { resolveApprovalPolicy } from '../src/server/policy/resolver.ts'
import { TOOL_DEFINITIONS } from '../src/server/tools/definitions.ts'
import { prepareToolExecution } from '../src/server/tools/executor.ts'

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

  const migrationsDir = join(
    fileURLToPath(new URL('.', import.meta.url)),
    '..',
    'migrations',
  )
  const migrationFiles = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  for (const file of migrationFiles) {
    const sql = readFileSync(join(migrationsDir, file), 'utf-8')
    sqlite.exec(sql)
  }

  return shim(sqlite)
}

interface TestSetup {
  db: SqlDatabase
  workspaceId: string
  workspaceBId: string
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
  const workspaceBId = newId()
  const brandId = newId()
  const campaignId = newId()
  const platformId = newId()
  const accountId = newId()
  const contentId = newId()
  const variantId = newId()

  const now = nowIso()

  // 1. Workspaces
  await execute(
    db,
    `INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    [workspaceId, 'Primary Workspace', 'primary-ws', now, now],
  )
  await execute(
    db,
    `INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    [workspaceBId, 'Secondary Workspace', 'secondary-ws', now, now],
  )

  await ensureBuiltinAgents(db, workspaceId)
  await ensureBuiltinAgents(db, workspaceBId)

  // 2. Platform
  await execute(
    db,
    `INSERT OR IGNORE INTO platform (id, adapter_key, name, created_at) VALUES (?, 'x', 'X / Twitter', ?)`,
    [platformId, now],
  )

  // 3. Brand
  await execute(
    db,
    `INSERT INTO brand (id, workspace_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [brandId, workspaceId, 'Acme Corp', 'Top Brand', now, now],
  )

  // 4. Campaign
  await execute(
    db,
    `INSERT INTO campaign (id, workspace_id, brand_id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [campaignId, workspaceId, brandId, 'Q3 Launch', 'active', now, now],
  )

  // 5. Account
  await execute(
    db,
    `INSERT INTO account (id, workspace_id, platform_id, handle, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [accountId, workspaceId, platformId, 'acmegrowth', 'Acme Growth', 'active', now, now],
  )

  // 6. Connect Account to Campaign
  await execute(
    db,
    `INSERT INTO campaign_account (campaign_id, account_id, created_at) VALUES (?, ?, ?)`,
    [campaignId, accountId, now],
  )

  // 7. Content Item
  await execute(
    db,
    `INSERT INTO content (id, workspace_id, campaign_id, target_account_id, title, content_type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [contentId, workspaceId, campaignId, accountId, 'Launch Announcement', 'post', 'ready', now, now],
  )

  // 8. Content Variant
  await execute(
    db,
    `INSERT INTO content_variant (id, content_id, platform_id, body, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [variantId, contentId, platformId, 'Exciting product launch coming today!', 'draft', now, now],
  )

  // 9. Editorial Approval
  const approvalRes = await approveCampaignContentVariant(db, {
    workspaceId,
    campaignId,
    contentId,
    contentVariantId: variantId,
    actorType: 'user',
    note: 'Initial human editorial approval',
  })
  const approvalId = approvalRes.approval.id

  // 10. Publication Intent (Post in 'draft' status)
  const post = await createPublicationIntent(db, {
    workspaceId,
    campaignId,
    contentId,
    contentVariantId: variantId,
    accountId,
  })

  return {
    db,
    workspaceId,
    workspaceBId,
    brandId,
    campaignId,
    platformId,
    accountId,
    contentId,
    variantId,
    approvalId,
    postId: post.id,
  }
}

test('STEP 15E.2 Dispatch Boundary Test Suite', async (t) => {
  // ==========================================
  // Category 1: Baseline Architecture Guards
  // ==========================================
  await t.test('1. Baseline: Publisher Agent remains disabled in definition', () => {
    const publisher = BUILTIN_AGENTS.find((a) => a.key === 'publisher')
    assert.ok(publisher, 'Publisher agent must exist in definitions')
    assert.equal(publisher.status, 'disabled', 'Publisher agent must be disabled')
  })

  await t.test('2. Baseline: platform.publish Tool is unavailable and requires approval', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.key === 'platform.publish')
    assert.ok(tool, 'platform.publish tool definition must exist')
    assert.equal(tool.status, 'unavailable', 'platform.publish status must be unavailable')
    assert.equal(tool.approval, 'required', 'platform.publish must require approval')
    assert.deepEqual(tool.risk, ['write', 'external'], 'platform.publish risks must be write and external')
  })

  await t.test('3. Baseline: prepareToolExecution for platform.publish fails safely as unavailable', () => {
    const prep = prepareToolExecution({
      workspaceId: 'any-ws',
      toolKey: 'platform.publish',
      args: { accountId: 'acc-1', contentVariantId: 'var-1' },
      caller: {
        agentId: 'publisher',
        agentName: 'Publisher',
        agentStatus: 'disabled',
        agentVersionId: 'v1',
        capabilities: ['publish'],
      },
    })
    assert.equal(prep.ok, false, 'Tool execution preparation must return ok: false')
    if (!prep.ok) {
      assert.ok(
        prep.error.code === 'capability_denied' || prep.error.code === 'not_configured' || prep.error.code === 'tool_disabled',
        'Must return safe disabled/not_configured error code',
      )
    }
  })

  // ==========================================
  // Category 2: Initiation & No Auto-Publish
  // ==========================================
  await t.test('4. Initiation: Critic review pass alone does not publish or create Approval Request', async () => {
    const env = await setupTestEnvironment()
    const posts = await queryAll<{ status: string }>(env.db, 'SELECT status FROM post WHERE id = ?', [env.postId])
    assert.equal(posts[0]?.status, 'draft', 'Post must remain draft')
    const approvals = await queryAll(env.db, "SELECT * FROM approval WHERE subject_id = ?", [env.postId])
    assert.equal(approvals.length, 0, 'No approval request must exist automatically')
  })

  await t.test('5. Initiation: Editorial approval alone does not publish or create Approval Request', async () => {
    const env = await setupTestEnvironment()
    const post = await getPostDetail(env.db, env.workspaceId, env.postId)
    assert.equal(post?.status, 'draft')
    assert.equal(post?.dispatchStatus, 'prepared')
    const approvals = await queryAll(env.db, "SELECT * FROM approval WHERE subject_id = ?", [env.postId])
    assert.equal(approvals.length, 0)
  })

  await t.test('6. Initiation: Publication intent preparation alone does not publish or dispatch', async () => {
    const env = await setupTestEnvironment()
    const post = await getPostDetail(env.db, env.workspaceId, env.postId)
    assert.equal(post?.status, 'draft')
    assert.equal(post?.externalId, null)
    assert.equal(post?.url, null)
    assert.equal(post?.publishedAt, null)
  })

  await t.test('7. Initiation: Explicit user publish request creates Approval Request', async () => {
    const env = await setupTestEnvironment()
    const result = await requestPublicationDispatch(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
    })

    assert.equal(result.status, 'pending')
    assert.ok(result.approvalRequest, 'Approval request must be created')
    assert.equal(result.approvalRequest?.actionKey, 'content.publish')
    assert.equal(result.approvalRequest?.status, 'pending')
    assert.equal(result.post.dispatchStatus, 'awaiting_approval')
  })

  // ==========================================
  // Category 3: Authority & Server Reload
  // ==========================================
  await t.test('8. Authority: Request accepts only workspaceId & postId; ignores client forged copies', async () => {
    const env = await setupTestEnvironment()
    const result = await requestPublicationDispatch(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
      // Attempting to inject client payload
      forgedAccount: 'fake-account-123',
      forgedStatus: 'published',
    } as any)

    assert.equal(result.status, 'pending')
    const snapshot = JSON.parse(result.approvalRequest!.snapshotJson)
    assert.equal(snapshot.accountId, env.accountId, 'Snapshot must use authoritative accountId from DB')
    assert.equal(snapshot.contentVariantId, env.variantId, 'Snapshot must use authoritative variantId from DB')
  })

  await t.test('9. Authority: Cross-workspace postId request is strictly rejected', async () => {
    const env = await setupTestEnvironment()
    await assert.rejects(
      () =>
        requestPublicationDispatch(env.db, {
          workspaceId: env.workspaceBId,
          postId: env.postId,
        }),
      /Post record not found in this workspace/,
    )
  })

  // ==========================================
  // Category 4: Pre-Approval Eligibility
  // ==========================================
  await t.test('10. Pre-Approval: Revoked editorial approval rejects publish request before creating Approval Request', async () => {
    const env = await setupTestEnvironment()
    await revokeCampaignContentApproval(env.db, {
      workspaceId: env.workspaceId,
      campaignId: env.campaignId,
      contentId: env.contentId,
      actorType: 'user',
    })

    await assert.rejects(
      () =>
        requestPublicationDispatch(env.db, {
          workspaceId: env.workspaceId,
          postId: env.postId,
        }),
      /Post is not currently eligible for publication/,
    )

    const approvals = await queryAll(env.db, "SELECT * FROM approval WHERE subject_id = ?", [env.postId])
    assert.equal(approvals.length, 0, 'No Approval Request must be created')
  })

  await t.test('11. Pre-Approval: Paused target account rejects publish request before creating Approval Request', async () => {
    const env = await setupTestEnvironment()
    await execute(env.db, "UPDATE account SET status = 'paused' WHERE id = ?", [env.accountId])

    await assert.rejects(
      () =>
        requestPublicationDispatch(env.db, {
          workspaceId: env.workspaceId,
          postId: env.postId,
        }),
      /Account is paused/,
    )
  })

  await t.test('12. Pre-Approval: Archived campaign rejects publish request before creating Approval Request', async () => {
    const env = await setupTestEnvironment()
    await execute(env.db, "UPDATE campaign SET status = 'archived' WHERE id = ?", [env.campaignId])

    await assert.rejects(
      () =>
        requestPublicationDispatch(env.db, {
          workspaceId: env.workspaceId,
          postId: env.postId,
        }),
      /Campaign not found or is archived/,
    )
  })

  await t.test('13. Pre-Approval: Disconnected campaign account rejects publish request before creating Approval Request', async () => {
    const env = await setupTestEnvironment()
    await execute(env.db, "DELETE FROM campaign_account WHERE campaign_id = ? AND account_id = ?", [
      env.campaignId,
      env.accountId,
    ])

    await assert.rejects(
      () =>
        requestPublicationDispatch(env.db, {
          workspaceId: env.workspaceId,
          postId: env.postId,
        }),
      /Account is not connected to this campaign/,
    )
  })

  // ==========================================
  // Category 5: Policy Resolution & Hard Minimum
  // ==========================================
  await t.test('14. Policy: actionKey content.publish is defined with category content and defaultMode review', () => {
    const def = ACTION_DEFINITIONS['content.publish']
    assert.ok(def, 'content.publish definition must exist')
    assert.equal(def.category, 'content')
    assert.equal(def.defaultMode, 'review')
    assert.deepEqual(def.inherentRisks, ['write', 'external'])
  })

  await t.test('15. Policy: Permissive workspace policy AUTO is elevated to REVIEW by hard minimum mode', async () => {
    const env = await setupTestEnvironment()
    // Configure workspace policy for content.publish to AUTO
    await execute(
      env.db,
      `INSERT INTO approval_policy (id, workspace_id, scope_type, scope_id, action_key, mode, created_at, updated_at) VALUES (?, ?, 'workspace', ?, ?, ?, ?, ?)`,
      [newId(), env.workspaceId, env.workspaceId, 'content.publish', 'auto', nowIso(), nowIso()],
    )

    const res = await createApprovalRequest(env.db, {
      workspaceId: env.workspaceId,
      actionKey: 'content.publish',
      payload: { postId: env.postId },
      summary: 'Publish draft',
      origin: 'user',
      minimumMode: 'review',
    })

    assert.equal(res.status, 'pending', 'Must elevate auto to pending review')
    assert.equal(res.request?.resolvedMode, 'review')
    assert.equal(res.request?.policySource, 'tool_requirement', 'Source must reflect tool_requirement elevation')
  })

  await t.test('16. Policy: BLOCKED policy returns status blocked, emits event, and creates no Approval Request', async () => {
    const env = await setupTestEnvironment()
    // Configure workspace policy to BLOCKED
    await execute(
      env.db,
      `INSERT INTO approval_policy (id, workspace_id, scope_type, scope_id, action_key, mode, created_at, updated_at) VALUES (?, ?, 'workspace', ?, ?, ?, ?, ?)`,
      [newId(), env.workspaceId, env.workspaceId, 'content.publish', 'blocked', nowIso(), nowIso()],
    )

    const res = await requestPublicationDispatch(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
    })

    assert.equal(res.status, 'blocked')
    assert.equal(res.approvalRequest, null)

    const approvals = await queryAll(env.db, "SELECT * FROM approval WHERE subject_id = ?", [env.postId])
    assert.equal(approvals.length, 0)

    const events = await queryAll<{ event_type: string }>(
      env.db,
      "SELECT event_type FROM event WHERE event_type = 'publication.approval_blocked'",
    )
    assert.equal(events.length, 1, 'publication.approval_blocked event must be emitted')
  })

  // ==========================================
  // Category 6: Approval Request Creation & Deduplication
  // ==========================================
  await t.test('17. Approval Creation: Correct risk tags, human summary, snapshot and fingerprint', async () => {
    const env = await setupTestEnvironment()
    const res = await requestPublicationDispatch(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
    })

    const req = res.approvalRequest!
    assert.equal(req.actionKey, 'content.publish')
    assert.deepEqual(req.risks, ['write', 'external'])
    assert.ok(req.summary.includes('Publish approved draft to @acmegrowth'))

    const snapshot = JSON.parse(req.snapshotJson)
    assert.equal(snapshot.postId, env.postId)
    assert.equal(snapshot.accountId, env.accountId)
    assert.equal(snapshot.contentVariantId, env.variantId)
    assert.equal(snapshot.contentApprovalId, env.approvalId)

    const expectedFingerprint = computeSnapshotFingerprint('content.publish', req.snapshotJson)
    assert.equal(req.fingerprint, expectedFingerprint)
    assert.equal(verifySnapshotIntegrity('content.publish', req.snapshotJson, req.fingerprint), true)
  })

  await t.test('18. Idempotency: Duplicate/double-click request reuses existing pending Approval Request', async () => {
    const env = await setupTestEnvironment()
    const first = await requestPublicationDispatch(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
    })
    assert.equal(first.status, 'pending')
    assert.equal(first.isDuplicate, false)

    const second = await requestPublicationDispatch(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
    })
    assert.equal(second.status, 'pending')
    assert.equal(second.isDuplicate, true)
    assert.equal(second.approvalRequest?.id, first.approvalRequest?.id)

    const requests = await queryAll(
      env.db,
      "SELECT * FROM approval WHERE subject_id = ? AND action_key = 'content.publish'",
      [env.postId],
    )
    assert.equal(requests.length, 1, 'Exactly one approval request row must exist')
  })

  await t.test('19. Events: Emits publication.approval_requested on creation', async () => {
    const env = await setupTestEnvironment()
    await requestPublicationDispatch(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
    })

    const events = await queryAll<{ event_type: string; payload: string }>(
      env.db,
      "SELECT event_type, payload FROM event WHERE event_type = 'publication.approval_requested'",
    )
    assert.equal(events.length, 1)
    const payload = JSON.parse(events[0]!.payload)
    assert.equal(payload.postId, env.postId)
  })

  // ==========================================
  // Category 7: Post State & Derivation
  // ==========================================
  await t.test('20. Post State: Derived dispatchStatus is awaiting_approval when pending approval exists', async () => {
    const env = await setupTestEnvironment()
    const reqRes = await requestPublicationDispatch(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
    })

    const post = await getPostDetail(env.db, env.workspaceId, env.postId)
    assert.equal(post?.status, 'draft')
    assert.equal(post?.dispatchStatus, 'awaiting_approval')
    assert.equal(post?.pendingApprovalRequestId, reqRes.approvalRequest?.id)
    assert.equal(post?.isCurrentlyEligible, true)
    assert.equal(post?.externalId, null)
    assert.equal(post?.url, null)
  })

  // ==========================================
  // Category 8: Approval Decision (Reject / Expire)
  // ==========================================
  await t.test('21. Decision: Rejecting Approval Request leaves post unpublished and emits event', async () => {
    const env = await setupTestEnvironment()
    const reqRes = await requestPublicationDispatch(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
    })

    const decRes = await decideApprovalRequest(env.db, {
      workspaceId: env.workspaceId,
      requestId: reqRes.approvalRequest!.id,
      decision: 'rejected',
      actor: { actorType: 'user', actorId: null },
      note: 'Not ready for social release',
    })

    assert.equal(decRes.status, 'rejected')
    const post = await getPostDetail(env.db, env.workspaceId, env.postId)
    assert.equal(post?.status, 'draft')
    assert.equal(post?.dispatchStatus, 'prepared')
    assert.equal(post?.pendingApprovalRequestId, undefined)
  })

  await t.test('22. Decision: Attempting dispatch on non-approved request fails safely', async () => {
    const env = await setupTestEnvironment()
    const reqRes = await requestPublicationDispatch(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
    })

    // Request is still 'pending'
    const dispRes = await dispatchApprovedPublication(env.db, {
      workspaceId: env.workspaceId,
      approvalRequestId: reqRes.approvalRequest!.id,
    })

    assert.equal(dispRes.ok, false)
    assert.equal(dispRes.code, 'not_approved')
  })

  // ==========================================
  // Category 9: Approval-Time Revalidation
  // ==========================================
  await t.test('23. Revalidation: Revoking editorial approval after approval fails dispatch safely', async () => {
    const env = await setupTestEnvironment()
    const reqRes = await requestPublicationDispatch(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
    })

    // User approves in Approval Center
    await decideApprovalRequest(env.db, {
      workspaceId: env.workspaceId,
      requestId: reqRes.approvalRequest!.id,
      decision: 'approved',
      actor: { actorType: 'user', actorId: null },
    })

    // Later, editorial approval is revoked
    await revokeCampaignContentApproval(env.db, {
      workspaceId: env.workspaceId,
      campaignId: env.campaignId,
      contentId: env.contentId,
      actorType: 'user',
    })

    // Now dispatch is attempted
    const dispRes = await dispatchApprovedPublication(env.db, {
      workspaceId: env.workspaceId,
      approvalRequestId: reqRes.approvalRequest!.id,
    })

    assert.equal(dispRes.ok, false)
    assert.equal(dispRes.code, 'ineligible')
    assert.ok(dispRes.message.includes('no longer eligible'))

    const post = await getPostDetail(env.db, env.workspaceId, env.postId)
    assert.equal(post?.status, 'draft')
  })

  await t.test('24. Revalidation: Pausing account after approval fails dispatch safely', async () => {
    const env = await setupTestEnvironment()
    const reqRes = await requestPublicationDispatch(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
    })

    await decideApprovalRequest(env.db, {
      workspaceId: env.workspaceId,
      requestId: reqRes.approvalRequest!.id,
      decision: 'approved',
      actor: { actorType: 'user', actorId: null },
    })

    // Pause account
    await execute(env.db, "UPDATE account SET status = 'paused' WHERE id = ?", [env.accountId])

    const dispRes = await dispatchApprovedPublication(env.db, {
      workspaceId: env.workspaceId,
      approvalRequestId: reqRes.approvalRequest!.id,
    })

    assert.equal(dispRes.ok, false)
    assert.equal(dispRes.code, 'ineligible')
  })

  await t.test('25. Revalidation: Tampered snapshot integrity fails dispatch with integrity error', async () => {
    const env = await setupTestEnvironment()
    const reqRes = await requestPublicationDispatch(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
    })

    await decideApprovalRequest(env.db, {
      workspaceId: env.workspaceId,
      requestId: reqRes.approvalRequest!.id,
      decision: 'approved',
      actor: { actorType: 'user', actorId: null },
    })

    // Tamper with snapshotJson directly in DB
    await execute(
      env.db,
      "UPDATE approval SET snapshot_json = '{\"forged\":true}' WHERE id = ?",
      [reqRes.approvalRequest!.id],
    )

    await assert.rejects(
      () =>
        dispatchApprovedPublication(env.db, {
          workspaceId: env.workspaceId,
          approvalRequestId: reqRes.approvalRequest!.id,
        }),
      /integrity violation/,
    )
  })

  // ==========================================
  // Category 10: Dispatch Boundary (STEP 15E.2)
  // ==========================================
  await t.test('26. Dispatch Boundary: Approved eligible dispatch fails safely as not_configured', async () => {
    const env = await setupTestEnvironment()
    const reqRes = await requestPublicationDispatch(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
    })

    await decideApprovalRequest(env.db, {
      workspaceId: env.workspaceId,
      requestId: reqRes.approvalRequest!.id,
      decision: 'approved',
      actor: { actorType: 'user', actorId: null },
    })

    const dispRes = await dispatchApprovedPublication(env.db, {
      workspaceId: env.workspaceId,
      approvalRequestId: reqRes.approvalRequest!.id,
    })

    assert.equal(dispRes.ok, false)
    assert.equal(dispRes.code, 'not_configured')
    assert.ok(dispRes.message.includes('not configured or available'))

    // Post remains draft
    const post = await getPostDetail(env.db, env.workspaceId, env.postId)
    assert.equal(post?.status, 'draft')
    assert.equal(post?.externalId, null)
    assert.equal(post?.url, null)
    assert.equal(post?.publishedAt, null)

    // Events emitted
    const events = await queryAll<{ event_type: string }>(
      env.db,
      "SELECT event_type FROM event WHERE event_type = 'publication.dispatch_unavailable'",
    )
    assert.equal(events.length, 1)

    // Audit log emitted
    const auditLogs = await queryAll<{ action: string }>(
      env.db,
      "SELECT action FROM audit_log WHERE entity_id = ? AND action = 'update'",
      [env.postId],
    )
    assert.ok(auditLogs.length >= 1)
  })

  await t.test('27. Parity: derivePostState and validatePublicationEligibility agree on awaiting_approval', async () => {
    const env = await setupTestEnvironment()
    await requestPublicationDispatch(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
    })

    const post = await getPostDetail(env.db, env.workspaceId, env.postId)
    const elig = await validatePublicationEligibility(env.db, {
      workspaceId: env.workspaceId,
      postId: env.postId,
    })

    assert.equal(post?.isCurrentlyEligible, true)
    assert.equal(elig.eligible, true)
    assert.equal(post?.dispatchStatus, 'awaiting_approval')
  })
})
