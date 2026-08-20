/**
 * STEP 11B: Approval Requests Engine Tests (npm run test:approvals)
 *
 * Verifies:
 * 1. REVIEW creates pending request
 * 2. AUTO creates no request
 * 3. BLOCKED creates no request
 * 4. request stores resolved policy metadata
 * 5. request stores origin
 * 6. safe snapshot created
 * 7. snapshot fingerprint deterministic
 * 8. secret data excluded
 * 9. duplicate pending request deduplicated
 * 10. approve works
 * 11. approve idempotent
 * 12. reject works
 * 13. reject idempotent
 * 14. cancel works
 * 15. expired request cannot approve
 * 16. approved request cannot reject later
 * 17. rejected request cannot approve later
 * 18. cancelled request cannot approve
 * 19. snapshot cannot be mutated after creation (integrity verification)
 * 20. changed action requires new request
 * 21. policy changes do not modify existing pending request
 * 22. Agent cannot approve
 * 23. Chief cannot self-approve
 * 24. cross-workspace request rejected
 * 25. invalid scope rejected
 * 26. unsupported action rejected
 * 27. audit/event metadata safe
 * 28. listing/filtering works
 * 29. archived historical requests remain readable
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import {
  computeSnapshotFingerprint,
  createApprovalRequest,
  createSafeActionSnapshot,
  decideApprovalRequest,
  getApprovalWithExpiryCheck,
} from '../src/server/approval/index.ts'
import { listApprovalRequests } from '../src/server/db/approval.ts'
import { listRecentEvents } from '../src/server/db/event.ts'
import { setApprovalPolicy } from '../src/server/db/policy.ts'
import type { SqlDatabase } from '../src/server/db/sql.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const NOW = '2026-08-20T00:00:00.000Z'

function freshDb(): SqlDatabase {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')

  const dir = join(ROOT, 'migrations')
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  for (const file of files) {
    db.exec(readFileSync(join(dir, file), 'utf8'))
  }

  // Seed default workspaces and brand
  db.prepare(
    `INSERT INTO workspace (id, name, created_at, updated_at) VALUES (?, 'WS A', ?, ?)`,
  ).run(WS_A, NOW, NOW)
  db.prepare(
    `INSERT INTO workspace (id, name, created_at, updated_at) VALUES (?, 'WS B', ?, ?)`,
  ).run(WS_B, NOW, NOW)
  db.prepare(
    `INSERT INTO brand (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, 'Brand Alpha', ?, ?)`,
  ).run(BRAND_A, WS_A, NOW, NOW)

  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql)
      return {
        bind(...params: unknown[]) {
          return {
            async all<T>() {
              const results = stmt.all(...params) as T[]
              return { results }
            },
            async first<T>() {
              const row = stmt.get(...params) as T | undefined
              return row ?? null
            },
            async run() {
              return stmt.run(...params)
            },
          }
        },
      }
    },
  }
}

const WS_A = '11111111-1111-4111-8111-111111111111'
const WS_B = '22222222-2222-4222-8222-222222222222'
const BRAND_A = '33333333-3333-4333-8333-333333333333'
const AGENT_ID = '44444444-4444-4444-8444-444444444444'

// 1. REVIEW creates pending request
test('1. REVIEW policy creates a pending Approval Request', async () => {
  const db = freshDb()
  const result = await createApprovalRequest(db, {
    workspaceId: WS_A,
    actionKey: 'content.publish',
    origin: 'agent',
    requestedById: AGENT_ID,
    summary: 'Publish autumn lookbook post',
    payload: { title: 'Autumn Lookbook', tags: ['fashion', 'fall'] },
  })

  assert.equal(result.status, 'pending')
  assert.equal(result.created, true)
  assert.ok(result.request)
  assert.equal(result.request.status, 'pending')
  assert.equal(result.request.actionKey, 'content.publish')
  assert.equal(result.request.resolvedMode, 'review')
})

// 2. AUTO creates no request
test('2. AUTO policy creates no Approval Request and returns auto status', async () => {
  const db = freshDb()
  const result = await createApprovalRequest(db, {
    workspaceId: WS_A,
    actionKey: 'workspace.read',
    origin: 'agent',
    payload: { query: 'all products' },
  })

  assert.equal(result.status, 'auto')
  assert.equal(result.created, false)
  assert.equal(result.request, null)

  const list = await listApprovalRequests(db, { workspaceId: WS_A })
  assert.equal(list.length, 0, 'No approval request row should exist in database')
})

// 3. BLOCKED creates no request
test('3. BLOCKED policy creates no Approval Request and returns blocked status', async () => {
  const db = freshDb()
  const result = await createApprovalRequest(db, {
    workspaceId: WS_A,
    actionKey: 'destructive.delete',
    origin: 'agent',
    payload: { entity: 'brand', id: BRAND_A },
  })

  assert.equal(result.status, 'blocked')
  assert.equal(result.created, false)
  assert.equal(result.request, null)

  const list = await listApprovalRequests(db, { workspaceId: WS_A })
  assert.equal(list.length, 0)
})

// 4. Request stores resolved policy metadata
test('4. request stores resolved policy metadata (mode, source, reason)', async () => {
  const db = freshDb()
  // Configure custom workspace policy for workflow.run
  await setApprovalPolicy(db, {
    workspaceId: WS_A,
    scopeType: 'workspace',
    scopeId: WS_A,
    actionKey: 'workflow.run',
    mode: 'review',
  })

  const result = await createApprovalRequest(db, {
    workspaceId: WS_A,
    actionKey: 'workflow.run',
    origin: 'workflow',
    payload: { workflowId: 'wf-1' },
  })

  assert.ok(result.request)
  assert.equal(result.request.resolvedMode, 'review')
  assert.equal(result.request.policySource, 'workspace_policy')
  assert.ok(result.request.reason.length > 0)
})

// 5. Request stores origin
test('5. request stores origin correctly', async () => {
  const db = freshDb()
  const result = await createApprovalRequest(db, {
    workspaceId: WS_A,
    actionKey: 'memory.verify',
    origin: 'chief',
    requestedById: 'chief-uuid',
    payload: { memoryId: 'mem-1', statement: 'Verified target CPA' },
  })

  assert.ok(result.request)
  assert.equal(result.request.origin, 'chief')
  assert.equal(result.request.requestedByType, 'chief')
})

// 6. Safe snapshot created
test('6. safe snapshot is sanitized and serializable', async () => {
  const db = freshDb()
  const result = await createApprovalRequest(db, {
    workspaceId: WS_A,
    actionKey: 'external.write',
    origin: 'agent',
    payload: {
      accountName: 'Main Store',
      settings: { syncInterval: 60 },
    },
  })

  assert.ok(result.request)
  const parsed = JSON.parse(result.request.snapshotJson)
  assert.equal(parsed.accountName, 'Main Store')
  assert.equal(parsed.settings.syncInterval, 60)
})

// 7. Snapshot fingerprint deterministic
test('7. snapshot fingerprint is deterministic SHA-256 hash', () => {
  const payloadA = { b: 2, a: 1 }
  const payloadB = { a: 1, b: 2 }

  const snapA = createSafeActionSnapshot(payloadA)
  const snapB = createSafeActionSnapshot(payloadB)

  const fpA = computeSnapshotFingerprint('content.publish', snapA.snapshotJson)
  const fpB = computeSnapshotFingerprint('content.publish', snapB.snapshotJson)

  assert.equal(fpA, fpB, 'Sorted keys must produce identical deterministic fingerprint')
  assert.match(fpA, /^[a-f0-9]{64}$/, 'Must be a 64-char hex SHA-256 string')
})

// 8. Secret data excluded from snapshot
test('8. secret data and credentials are completely excluded from snapshot', async () => {
  const db = freshDb()
  const result = await createApprovalRequest(db, {
    workspaceId: WS_A,
    actionKey: 'content.publish',
    origin: 'agent',
    payload: {
      title: 'Spring Campaign',
      api_key: 'sk-secret-key-12345',
      bearerToken: 'Bearer eyJhbGciOi...',
      password: 'SuperSecretPassword!',
    },
  })

  assert.ok(result.request)
  const snapStr = result.request.snapshotJson
  assert.doesNotMatch(snapStr, /sk-secret-key-12345/)
  assert.doesNotMatch(snapStr, /SuperSecretPassword/)
  assert.match(snapStr, /\[REDACTED_SECRET\]/)
})

// 9. Duplicate pending request deduplicated
test('9. duplicate pending request is deduplicated and reuses existing ID', async () => {
  const db = freshDb()
  const payload = { title: 'Deduplicated Post', body: 'Content body' }

  const res1 = await createApprovalRequest(db, {
    workspaceId: WS_A,
    actionKey: 'content.publish',
    origin: 'agent',
    executionId: 'exec-100',
    payload,
  })

  const res2 = await createApprovalRequest(db, {
    workspaceId: WS_A,
    actionKey: 'content.publish',
    origin: 'agent',
    executionId: 'exec-100',
    payload,
  })

  assert.equal(res1.created, true)
  assert.equal(res2.created, false)
  assert.equal(res2.isDuplicate, true)
  assert.equal(res1.request?.id, res2.request?.id)

  const list = await listApprovalRequests(db, { workspaceId: WS_A })
  assert.equal(list.length, 1, 'Only one row should exist in database')
})

// 10. Approve works
test('10. approve works and transitions status to approved', async () => {
  const db = freshDb()
  const created = await createApprovalRequest(db, {
    workspaceId: WS_A,
    actionKey: 'content.publish',
    origin: 'agent',
    payload: { title: 'Post 1' },
  })

  assert.ok(created.request)
  const approved = await decideApprovalRequest(db, {
    workspaceId: WS_A,
    requestId: created.request.id,
    decision: 'approved',
    actor: { actorType: 'user', actorId: 'user-1' },
    note: 'Looks good to publish',
  })

  assert.equal(approved.status, 'approved')
  assert.equal(approved.decision, 'approved')
  assert.equal(approved.decidedByType, 'user')
  assert.equal(approved.decisionNote, 'Looks good to publish')
  assert.ok(approved.decidedAt)
})

// 11. Approve idempotent
test('11. double-click approve is idempotent and does not error', async () => {
  const db = freshDb()
  const created = await createApprovalRequest(db, {
    workspaceId: WS_A,
    actionKey: 'content.publish',
    origin: 'agent',
    payload: { title: 'Post 1' },
  })

  assert.ok(created.request)
  const app1 = await decideApprovalRequest(db, {
    workspaceId: WS_A,
    requestId: created.request.id,
    decision: 'approved',
    actor: { actorType: 'user', actorId: 'user-1' },
  })

  const app2 = await decideApprovalRequest(db, {
    workspaceId: WS_A,
    requestId: created.request.id,
    decision: 'approved',
    actor: { actorType: 'user', actorId: 'user-1' },
  })

  assert.equal(app1.status, 'approved')
  assert.equal(app2.status, 'approved')
  assert.equal(app1.id, app2.id)
})

// 12. Reject works
test('12. reject works and records decision note', async () => {
  const db = freshDb()
  const created = await createApprovalRequest(db, {
    workspaceId: WS_A,
    actionKey: 'workflow.run',
    origin: 'workflow',
    payload: { workflowId: 'wf-1' },
  })

  assert.ok(created.request)
  const rejected = await decideApprovalRequest(db, {
    workspaceId: WS_A,
    requestId: created.request.id,
    decision: 'rejected',
    actor: { actorType: 'user' },
    note: 'Not ready for execution',
  })

  assert.equal(rejected.status, 'rejected')
  assert.equal(rejected.decision, 'rejected')
  assert.equal(rejected.decisionNote, 'Not ready for execution')
})

// 13. Reject idempotent
test('13. reject is idempotent', async () => {
  const db = freshDb()
  const created = await createApprovalRequest(db, {
    workspaceId: WS_A,
    actionKey: 'workflow.run',
    origin: 'workflow',
    payload: { workflowId: 'wf-1' },
  })

  assert.ok(created.request)
  const rej1 = await decideApprovalRequest(db, {
    workspaceId: WS_A,
    requestId: created.request.id,
    decision: 'rejected',
    actor: { actorType: 'user' },
  })
  const rej2 = await decideApprovalRequest(db, {
    workspaceId: WS_A,
    requestId: created.request.id,
    decision: 'rejected',
    actor: { actorType: 'user' },
  })

  assert.equal(rej1.status, 'rejected')
  assert.equal(rej2.status, 'rejected')
})

// 14. Cancel works
test('14. cancel works when requester no longer needs the action', async () => {
  const db = freshDb()
  const created = await createApprovalRequest(db, {
    workspaceId: WS_A,
    actionKey: 'content.publish',
    origin: 'agent',
    payload: { title: 'Obsolete Draft' },
  })

  assert.ok(created.request)
  const cancelled = await decideApprovalRequest(db, {
    workspaceId: WS_A,
    requestId: created.request.id,
    decision: 'cancelled',
    actor: { actorType: 'user' },
    note: 'Draft discarded',
  })

  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.decision, 'cancelled')
})

// 15. Expired request cannot approve
test('15. expired request cannot be approved and transitions to expired', async () => {
  const db = freshDb()
  const pastDate = new Date(Date.now() - 3600 * 1000).toISOString()
  const created = await createApprovalRequest(db, {
    workspaceId: WS_A,
    actionKey: 'content.publish',
    origin: 'agent',
    payload: { title: 'Time-sensitive Flash Sale' },
    expiresAt: pastDate,
  })

  assert.ok(created.request)

  await assert.rejects(
    () =>
      decideApprovalRequest(db, {
        workspaceId: WS_A,
        requestId: created.request.id,
        decision: 'approved',
        actor: { actorType: 'user' },
      }),
    /expired/i,
  )

  const fetched = await getApprovalWithExpiryCheck(db, {
    workspaceId: WS_A,
    id: created.request.id,
  })
  assert.equal(fetched?.status, 'expired')
})

// 16. Approved request cannot reject later
test('16. approved request cannot be rejected later', async () => {
  const db = freshDb()
  const created = await createApprovalRequest(db, {
    workspaceId: WS_A,
    actionKey: 'content.publish',
    origin: 'agent',
    payload: { title: 'Post' },
  })

  assert.ok(created.request)
  await decideApprovalRequest(db, {
    workspaceId: WS_A,
    requestId: created.request.id,
    decision: 'approved',
    actor: { actorType: 'user' },
  })

  await assert.rejects(
    () =>
      decideApprovalRequest(db, {
        workspaceId: WS_A,
        requestId: created.request.id,
        decision: 'rejected',
        actor: { actorType: 'user' },
      }),
    /Cannot rejected a request that is already approved|already approved/i,
  )
})

// 17. Rejected request cannot approve later
test('17. rejected request cannot be approved later', async () => {
  const db = freshDb()
  const created = await createApprovalRequest(db, {
    workspaceId: WS_A,
    actionKey: 'content.publish',
    origin: 'agent',
    payload: { title: 'Post' },
  })

  assert.ok(created.request)
  await decideApprovalRequest(db, {
    workspaceId: WS_A,
    requestId: created.request.id,
    decision: 'rejected',
    actor: { actorType: 'user' },
  })

  await assert.rejects(
    () =>
      decideApprovalRequest(db, {
        workspaceId: WS_A,
        requestId: created.request.id,
        decision: 'approved',
        actor: { actorType: 'user' },
      }),
    /already rejected/i,
  )
})

// 18. Cancelled request cannot approve
test('18. cancelled request cannot be approved', async () => {
  const db = freshDb()
  const created = await createApprovalRequest(db, {
    workspaceId: WS_A,
    actionKey: 'content.publish',
    origin: 'agent',
    payload: { title: 'Post' },
  })

  assert.ok(created.request)
  await decideApprovalRequest(db, {
    workspaceId: WS_A,
    requestId: created.request.id,
    decision: 'cancelled',
    actor: { actorType: 'user' },
  })

  await assert.rejects(
    () =>
      decideApprovalRequest(db, {
        workspaceId: WS_A,
        requestId: created.request.id,
        decision: 'approved',
        actor: { actorType: 'user' },
      }),
    /already cancelled/i,
  )
})

// 19. Snapshot cannot be mutated after creation (tamper integrity check)
test('19. snapshot tampering fails integrity check during decision', async () => {
  const db = freshDb()
  const created = await createApprovalRequest(db, {
    workspaceId: WS_A,
    actionKey: 'content.publish',
    origin: 'agent',
    payload: { account: 'Account-A', text: 'Original message' },
  })

  assert.ok(created.request)

  // Direct database tampering simulation (e.g. malicious update)
  await db
    .prepare(`UPDATE approval SET snapshot_json = ? WHERE id = ?`)
    .bind(JSON.stringify({ account: 'Account-B', text: 'Tampered message' }), created.request.id)
    .run()

  await assert.rejects(
    () =>
      decideApprovalRequest(db, {
        workspaceId: WS_A,
        requestId: created.request.id,
        decision: 'approved',
        actor: { actorType: 'user' },
      }),
    /integrity violation/i,
  )
})

// 20. Changed action requires new request
test('20. changed action parameters require a distinct Approval Request', async () => {
  const db = freshDb()
  const req1 = await createApprovalRequest(db, {
    workspaceId: WS_A,
    actionKey: 'content.publish',
    origin: 'agent',
    payload: { title: 'Draft v1' },
  })

  const req2 = await createApprovalRequest(db, {
    workspaceId: WS_A,
    actionKey: 'content.publish',
    origin: 'agent',
    payload: { title: 'Draft v2 with modifications' },
  })

  assert.notEqual(req1.request?.id, req2.request?.id)
  assert.notEqual(req1.request?.fingerprint, req2.request?.fingerprint)
})

// 21. Policy changes do not modify existing pending request
test('21. subsequent policy changes do not alter existing pending requests', async () => {
  const db = freshDb()
  const created = await createApprovalRequest(db, {
    workspaceId: WS_A,
    actionKey: 'content.publish',
    origin: 'agent',
    payload: { title: 'Post' },
  })

  assert.ok(created.request)
  assert.equal(created.request.resolvedMode, 'review')

  // Later user changes policy for content.publish to AUTO
  await setApprovalPolicy(db, {
    workspaceId: WS_A,
    scopeType: 'workspace',
    scopeId: WS_A,
    actionKey: 'content.publish',
    mode: 'auto',
  })

  // The historical pending request must stay unchanged and pending
  const fetched = await getApprovalWithExpiryCheck(db, {
    workspaceId: WS_A,
    id: created.request.id,
  })
  assert.equal(fetched?.status, 'pending')
  assert.equal(fetched?.resolvedMode, 'review')
})

// 22. Agent cannot approve
test('22. Agent cannot approve requests (anti-self-approval)', async () => {
  const db = freshDb()
  const created = await createApprovalRequest(db, {
    workspaceId: WS_A,
    actionKey: 'content.publish',
    origin: 'agent',
    payload: { title: 'Post' },
  })

  assert.ok(created.request)
  await assert.rejects(
    () =>
      decideApprovalRequest(db, {
        workspaceId: WS_A,
        requestId: created.request.id,
        decision: 'approved',
        actor: { actorType: 'agent' as any, actorId: AGENT_ID },
      }),
    /Only human users or system/i,
  )
})

// 23. Chief cannot self-approve
test('23. Chief cannot self-approve requests', async () => {
  const db = freshDb()
  const created = await createApprovalRequest(db, {
    workspaceId: WS_A,
    actionKey: 'workflow.run',
    origin: 'chief',
    payload: { workflowId: 'wf-1' },
  })

  assert.ok(created.request)
  await assert.rejects(
    () =>
      decideApprovalRequest(db, {
        workspaceId: WS_A,
        requestId: created.request.id,
        decision: 'approved',
        actor: { actorType: 'chief' as any },
      }),
    /Only human users or system/i,
  )
})

// 24. Cross-workspace request rejected
test('24. approval request cannot be accessed or decided from another workspace', async () => {
  const db = freshDb()
  const created = await createApprovalRequest(db, {
    workspaceId: WS_A,
    actionKey: 'content.publish',
    origin: 'agent',
    payload: { title: 'Post in WS A' },
  })

  assert.ok(created.request)

  // Attempt to decide from WS_B must fail
  await assert.rejects(
    () =>
      decideApprovalRequest(db, {
        workspaceId: WS_B,
        requestId: created.request.id,
        decision: 'approved',
        actor: { actorType: 'user' },
      }),
    /not found/i,
  )
})

// 25. Invalid scope rejected
test('25. invalid brand scope belonging to foreign workspace is rejected', async () => {
  const db = freshDb()
  await assert.rejects(
    () =>
      createApprovalRequest(db, {
        workspaceId: WS_B,
        brandId: BRAND_A, // Belongs to WS_A
        actionKey: 'content.publish',
        origin: 'agent',
        payload: { title: 'Post' },
      }),
    /Brand not found or does not belong to workspace/i,
  )
})

// 26. Unsupported action rejected
test('26. unsupported action key is rejected with clean error', async () => {
  const db = freshDb()
  await assert.rejects(
    () =>
      createApprovalRequest(db, {
        workspaceId: WS_A,
        actionKey: 'unsupported.action.key',
        origin: 'agent',
        payload: {},
      }),
    /Unsupported action key/i,
  )
})

// 27. Audit/event metadata safe
test('27. approval events and audit records contain safe metadata and zero secrets', async () => {
  const db = freshDb()
  const created = await createApprovalRequest(db, {
    workspaceId: WS_A,
    actionKey: 'external.write',
    origin: 'agent',
    payload: {
      account: 'Account-1',
      api_key: 'secret-token-value',
    },
  })

  assert.ok(created.request)
  await decideApprovalRequest(db, {
    workspaceId: WS_A,
    requestId: created.request.id,
    decision: 'approved',
    actor: { actorType: 'user' },
  })

  const events = await listRecentEvents(db, WS_A, 'approval', 10)
  assert.ok(events.length >= 2, 'approval.requested and approval.approved events must exist')

  for (const ev of events) {
    if (ev.payload) {
      assert.doesNotMatch(ev.payload, /secret-token-value/)
    }
  }
})

// 28. Listing and filtering works
test('28. listing and filtering by status and actionKey works', async () => {
  const db = freshDb()
  const req1 = await createApprovalRequest(db, {
    workspaceId: WS_A,
    actionKey: 'content.publish',
    origin: 'agent',
    payload: { item: 1 },
  })

  const req2 = await createApprovalRequest(db, {
    workspaceId: WS_A,
    actionKey: 'workflow.run',
    origin: 'workflow',
    payload: { item: 2 },
  })

  assert.ok(req1.request)
  assert.ok(req2.request)

  await decideApprovalRequest(db, {
    workspaceId: WS_A,
    requestId: req1.request.id,
    decision: 'approved',
    actor: { actorType: 'user' },
  })

  const pendingList = await listApprovalRequests(db, {
    workspaceId: WS_A,
    status: 'pending',
  })
  assert.equal(pendingList.length, 1)
  assert.equal(pendingList[0]?.id, req2.request.id)

  const approvedList = await listApprovalRequests(db, {
    workspaceId: WS_A,
    status: 'approved',
  })
  assert.equal(approvedList.length, 1)
  assert.equal(approvedList[0]?.id, req1.request.id)
})

// 29. Archived historical requests remain readable
test('29. decided historical requests remain permanently queryable and immutable', async () => {
  const db = freshDb()
  const created = await createApprovalRequest(db, {
    workspaceId: WS_A,
    actionKey: 'content.publish',
    origin: 'agent',
    payload: { title: 'Historical Item' },
  })

  assert.ok(created.request)
  await decideApprovalRequest(db, {
    workspaceId: WS_A,
    requestId: created.request.id,
    decision: 'approved',
    actor: { actorType: 'user' },
    note: 'Permanent historical record',
  })

  const record = await getApprovalWithExpiryCheck(db, {
    workspaceId: WS_A,
    id: created.request.id,
  })
  assert.ok(record)
  assert.equal(record.status, 'approved')
  assert.equal(record.decisionNote, 'Permanent historical record')
})
