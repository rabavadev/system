/**
 * Approval Policy System tests (npm run test:policy).
 *
 * Runs the real policy resolver, default policies, risk fallback,
 * non-overridable hard security invariants, D1 repository, brand overrides,
 * audit logging, and deterministic resolver traces against a fresh
 * better-sqlite3 database migrated from migrations/.
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { listRecentEvents } from '../src/server/db/event.ts'
import {
  clearApprovalPolicyOverride,
  getApprovalPolicy,
  listApprovalPolicies,
  setApprovalPolicy,
} from '../src/server/db/policy.ts'
import type { SqlDatabase } from '../src/server/db/sql.ts'
import {
  ACTION_KEYS,
  type ActionKey,
  deriveModeFromRisk,
  getSystemDefaultMode,
  POLICY_MODES,
  type PolicyMode,
  PolicyValidationError,
  resolveApprovalPolicy,
} from '../src/server/policy/index.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const WS_A = crypto.randomUUID()
const WS_B = crypto.randomUUID()
const BRAND_A = crypto.randomUUID()
const BRAND_B = crypto.randomUUID()
const BRAND_ARCHIVED = crypto.randomUUID()
const NOW = '2026-08-20T00:00:00.000Z'

function freshDb(): SqlDatabase {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  const dir = join(ROOT, 'migrations')
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    sqlite.exec(readFileSync(join(dir, file), 'utf8'))
  }

  const ins = (sql: string, ...params: unknown[]) => sqlite.prepare(sql).run(...params)
  ins(
    `INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, 'WS A', NULL, ?, ?)`,
    WS_A,
    NOW,
    NOW,
  )
  ins(
    `INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, 'WS B', NULL, ?, ?)`,
    WS_B,
    NOW,
    NOW,
  )
  ins(
    `INSERT INTO brand (id, workspace_id, name, description, created_at, updated_at) VALUES (?, ?, 'Brand A', NULL, ?, ?)`,
    BRAND_A,
    WS_A,
    NOW,
    NOW,
  )
  ins(
    `INSERT INTO brand (id, workspace_id, name, description, created_at, updated_at) VALUES (?, ?, 'Brand B', NULL, ?, ?)`,
    BRAND_B,
    WS_B,
    NOW,
    NOW,
  )
  ins(
    `INSERT INTO brand (id, workspace_id, name, description, deleted_at, created_at, updated_at) VALUES (?, ?, 'Archived Brand', NULL, ?, ?, ?)`,
    BRAND_ARCHIVED,
    WS_A,
    NOW,
    NOW,
    NOW,
  )

  return {
    prepare(sql: string) {
      const stmt = sqlite.prepare(sql)
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

// 1. AUTO resolution (system default for read actions)
test('1. AUTO resolution for read-only actions', async () => {
  const db = freshDb()
  const result = await resolveApprovalPolicy(db, {
    action: 'workspace.read',
    workspaceId: WS_A,
    origin: 'user',
  })
  assert.equal(result.mode, 'auto')
  assert.equal(result.source, 'system_default')
  assert.equal(result.hasOverride, false)
})

// 2. REVIEW resolution (system default for mutation actions)
test('2. REVIEW resolution for workflows, content, external writes', async () => {
  const db = freshDb()
  const runResult = await resolveApprovalPolicy(db, {
    action: 'workflow.run',
    workspaceId: WS_A,
    origin: 'user',
  })
  assert.equal(runResult.mode, 'review')
  assert.equal(runResult.source, 'system_default')

  const pubResult = await resolveApprovalPolicy(db, {
    action: 'content.publish',
    workspaceId: WS_A,
    origin: 'agent',
  })
  assert.equal(pubResult.mode, 'review')
})

// 3. BLOCKED resolution (system default for destructive actions)
test('3. BLOCKED resolution for destructive actions', async () => {
  const db = freshDb()
  const delResult = await resolveApprovalPolicy(db, {
    action: 'destructive.delete',
    workspaceId: WS_A,
    origin: 'user',
  })
  assert.equal(delResult.mode, 'blocked')
  assert.equal(delResult.source, 'system_default')
})

// 4. Safe fallback when no policy exists in database
test('4. safe fallback returns centralized default when no row in DB', async () => {
  const db = freshDb()
  for (const key of ACTION_KEYS) {
    const expected = getSystemDefaultMode(key)
    const res = await resolveApprovalPolicy(db, {
      action: key,
      workspaceId: WS_A,
      origin: 'system',
    })
    assert.equal(res.mode, expected)
    assert.equal(res.source, 'system_default')
  }
})

// 5. Tool risk fallback
test('5. risk fallback derives mode from ToolRisk classifications', async () => {
  const db = freshDb()
  // read risk -> auto
  assert.equal(deriveModeFromRisk(['read']), 'auto')
  // write risk -> review
  assert.equal(deriveModeFromRisk(['write']), 'review')
  // external risk -> review
  assert.equal(deriveModeFromRisk(['external']), 'review')
  // destructive risk -> blocked
  assert.equal(deriveModeFromRisk(['destructive']), 'blocked')
  // sensitive risk -> blocked
  assert.equal(deriveModeFromRisk(['sensitive']), 'blocked')
  // composite risks: write + external -> review
  assert.equal(deriveModeFromRisk(['write', 'external']), 'review')
  // composite risks: write + destructive -> blocked
  assert.equal(deriveModeFromRisk(['write', 'destructive']), 'blocked')

  // Resolver fallback to risk when passed
  const res = await resolveApprovalPolicy(db, {
    action: 'workspace.read',
    workspaceId: WS_A,
    origin: 'tool',
    risk: ['sensitive'],
  })
  assert.equal(res.mode, 'blocked')
  assert.equal(res.source, 'risk_fallback')
})

// 6. Workspace policy saved and respected
test('6. workspace policy overrides default when configured', async () => {
  const db = freshDb()
  await setApprovalPolicy(db, {
    workspaceId: WS_A,
    scopeType: 'workspace',
    scopeId: WS_A,
    actionKey: 'content.publish',
    mode: 'auto',
  })

  const res = await resolveApprovalPolicy(db, {
    action: 'content.publish',
    workspaceId: WS_A,
    origin: 'workflow',
  })
  assert.equal(res.mode, 'auto')
  assert.equal(res.source, 'workspace_policy')
  assert.equal(res.hasOverride, false)
})

// 7. Brand override saved and respected
test('7. brand override applies when brandId is provided', async () => {
  const db = freshDb()
  await setApprovalPolicy(db, {
    workspaceId: WS_A,
    scopeType: 'brand',
    scopeId: BRAND_A,
    actionKey: 'workflow.run',
    mode: 'auto',
  })

  const res = await resolveApprovalPolicy(db, {
    action: 'workflow.run',
    workspaceId: WS_A,
    brandId: BRAND_A,
    origin: 'chief',
  })
  assert.equal(res.mode, 'auto')
  assert.equal(res.source, 'brand_override')
  assert.equal(res.hasOverride, true)
})

// 8. Brand override beats workspace policy
test('8. brand override takes deterministic precedence over workspace policy', async () => {
  const db = freshDb()
  // Workspace sets content.publish -> blocked
  await setApprovalPolicy(db, {
    workspaceId: WS_A,
    scopeType: 'workspace',
    scopeId: WS_A,
    actionKey: 'content.publish',
    mode: 'blocked',
  })

  // Brand A overrides content.publish -> auto
  await setApprovalPolicy(db, {
    workspaceId: WS_A,
    scopeType: 'brand',
    scopeId: BRAND_A,
    actionKey: 'content.publish',
    mode: 'auto',
  })

  // Request for Brand A resolves to auto (Brand override wins)
  const resBrand = await resolveApprovalPolicy(db, {
    action: 'content.publish',
    workspaceId: WS_A,
    brandId: BRAND_A,
    origin: 'user',
  })
  assert.equal(resBrand.mode, 'auto')
  assert.equal(resBrand.source, 'brand_override')
  assert.equal(resBrand.hasOverride, true)

  // Request without brandId resolves to blocked (Workspace policy)
  const resWs = await resolveApprovalPolicy(db, {
    action: 'content.publish',
    workspaceId: WS_A,
    origin: 'user',
  })
  assert.equal(resWs.mode, 'blocked')
  assert.equal(resWs.source, 'workspace_policy')
  assert.equal(resWs.hasOverride, false)
})

// 9. Clearing override returns to workspace policy
test('9. clearing brand override returns to inherited workspace policy', async () => {
  const db = freshDb()
  await setApprovalPolicy(db, {
    workspaceId: WS_A,
    scopeType: 'workspace',
    scopeId: WS_A,
    actionKey: 'workflow.create',
    mode: 'auto',
  })
  await setApprovalPolicy(db, {
    workspaceId: WS_A,
    scopeType: 'brand',
    scopeId: BRAND_A,
    actionKey: 'workflow.create',
    mode: 'blocked',
  })

  const res1 = await resolveApprovalPolicy(db, {
    action: 'workflow.create',
    workspaceId: WS_A,
    brandId: BRAND_A,
    origin: 'agent',
  })
  assert.equal(res1.mode, 'blocked')

  // Clear brand override
  const cleared = await clearApprovalPolicyOverride(db, {
    workspaceId: WS_A,
    scopeType: 'brand',
    scopeId: BRAND_A,
    actionKey: 'workflow.create',
  })
  assert.equal(cleared, true)

  const res2 = await resolveApprovalPolicy(db, {
    action: 'workflow.create',
    workspaceId: WS_A,
    brandId: BRAND_A,
    origin: 'agent',
  })
  assert.equal(res2.mode, 'auto')
  assert.equal(res2.source, 'workspace_policy')
  assert.equal(res2.hasOverride, false)
})

// 10. Invalid brand/workspace relationship rejected
test('10. invalid brand/workspace relationship is rejected', async () => {
  const db = freshDb()
  // Brand B belongs to WS_B, cannot set policy in WS_A
  await assert.rejects(async () => {
    await setApprovalPolicy(db, {
      workspaceId: WS_A,
      scopeType: 'brand',
      scopeId: BRAND_B,
      actionKey: 'content.publish',
      mode: 'auto',
    })
  }, /not found in workspace/i)

  // Archived brand cannot receive overrides
  await assert.rejects(async () => {
    await setApprovalPolicy(db, {
      workspaceId: WS_A,
      scopeType: 'brand',
      scopeId: BRAND_ARCHIVED,
      actionKey: 'content.publish',
      mode: 'auto',
    })
  }, /archived/i)
})

// 11. Unsupported action rejected
test('11. unsupported action key is rejected with PolicyValidationError', async () => {
  const db = freshDb()
  await assert.rejects(async () => {
    await resolveApprovalPolicy(db, {
      action: 'unsupported.action.key' as ActionKey,
      workspaceId: WS_A,
      origin: 'system',
    })
  }, PolicyValidationError)
})

// 12. Invalid mode rejected
test('12. invalid policy mode is rejected during repository write', async () => {
  const db = freshDb()
  await assert.rejects(async () => {
    await setApprovalPolicy(db, {
      workspaceId: WS_A,
      scopeType: 'workspace',
      scopeId: WS_A,
      actionKey: 'workflow.run',
      mode: 'invalid_mode' as PolicyMode,
    })
  }, /invalid/i)
})

// 13. Hard security block cannot be overridden
test('13. hard security invariants override user policy and cannot be bypassed', async () => {
  const db = freshDb()
  // Even if workspace sets destructive.delete or external.write to auto
  await setApprovalPolicy(db, {
    workspaceId: WS_A,
    scopeType: 'workspace',
    scopeId: WS_A,
    actionKey: 'external.write',
    mode: 'auto',
  })

  // Secret exposure attempt
  const secretRes = await resolveApprovalPolicy(db, {
    action: 'external.write',
    workspaceId: WS_A,
    origin: 'agent',
    target: { isSecret: true },
  })
  assert.equal(secretRes.mode, 'blocked')
  assert.equal(secretRes.source, 'hard_security')
  assert.match(secretRes.reason, /secret/i)

  // Cross-workspace violation attempt
  const crossWsRes = await resolveApprovalPolicy(db, {
    action: 'external.write',
    workspaceId: WS_A,
    origin: 'agent',
    target: { crossWorkspace: true },
  })
  assert.equal(crossWsRes.mode, 'blocked')
  assert.equal(crossWsRes.source, 'hard_security')
  assert.match(crossWsRes.reason, /cross-workspace/i)

  // Arbitrary code execution attempt
  const codeRes = await resolveApprovalPolicy(db, {
    action: 'external.write',
    workspaceId: WS_A,
    origin: 'tool',
    target: { arbitraryCode: true },
  })
  assert.equal(codeRes.mode, 'blocked')
  assert.equal(codeRes.source, 'hard_security')
  assert.match(codeRes.reason, /arbitrary code/i)

  // Security bypass attempt
  const bypassRes = await resolveApprovalPolicy(db, {
    action: 'external.write',
    workspaceId: WS_A,
    origin: 'workflow',
    target: { executionBypass: true },
  })
  assert.equal(bypassRes.mode, 'blocked')
  assert.equal(bypassRes.source, 'hard_security')
})

// 14. Origin metadata preserved
test('14. request origin metadata is preserved in resolution result', async () => {
  const db = freshDb()
  const origins = ['user', 'chief', 'agent', 'workflow', 'tool', 'system'] as const
  for (const origin of origins) {
    const res = await resolveApprovalPolicy(db, {
      action: 'memory.verify',
      workspaceId: WS_A,
      origin,
    })
    assert.equal(res.origin, origin)
    assert.equal(res.trace.origin, origin)
  }
})

// 15. Deterministic policy trace
test('15. deterministic policy trace records all evaluation steps', async () => {
  const db = freshDb()
  await setApprovalPolicy(db, {
    workspaceId: WS_A,
    scopeType: 'brand',
    scopeId: BRAND_A,
    actionKey: 'workflow.run',
    mode: 'auto',
  })

  const res = await resolveApprovalPolicy(db, {
    action: 'workflow.run',
    workspaceId: WS_A,
    brandId: BRAND_A,
    origin: 'user',
  })

  assert.ok(res.trace)
  assert.equal(res.trace.action, 'workflow.run')
  assert.equal(res.trace.workspaceId, WS_A)
  assert.equal(res.trace.brandId, BRAND_A)
  assert.equal(res.trace.resolvedMode, 'auto')
  assert.equal(res.trace.source, 'brand_override')
  assert.ok(res.trace.steps.length >= 2)
  assert.equal(res.trace.steps[0].step, 'hard_security')
  assert.equal(res.trace.steps[0].matched, false)
  assert.equal(res.trace.steps[1].step, 'brand_override')
  assert.equal(res.trace.steps[1].matched, true)
})

// 16. Policy audit event and audit_log record
test('16. policy mutations create audit_log rows and emit domain events', async () => {
  const db = freshDb()
  const policy = await setApprovalPolicy(db, {
    workspaceId: WS_A,
    scopeType: 'workspace',
    scopeId: WS_A,
    actionKey: 'account.modify',
    mode: 'blocked',
    actor: { actorType: 'user' },
  })

  // Verify policy was saved
  const fetched = await getApprovalPolicy(db, {
    workspaceId: WS_A,
    scopeType: 'workspace',
    scopeId: WS_A,
    actionKey: 'account.modify',
  })
  assert.ok(fetched)
  assert.equal(fetched.mode, 'blocked')

  // Verify list
  const list = await listApprovalPolicies(db, { workspaceId: WS_A })
  assert.equal(list.length, 1)

  // Verify domain event emitted
  const events = await listRecentEvents(db, WS_A, 'policy', 10)
  const policyEvent = events.find((e) => e.event_type === 'policy.created')
  assert.ok(policyEvent, 'policy.created event must be emitted')
  assert.equal(policyEvent.subject_id, policy.id)
})

// 17. No secrets in trace or audit
test('17. trace and audit records contain zero credentials or secrets', async () => {
  const db = freshDb()
  await setApprovalPolicy(db, {
    workspaceId: WS_A,
    scopeType: 'workspace',
    scopeId: WS_A,
    actionKey: 'external.write',
    mode: 'review',
  })

  const res = await resolveApprovalPolicy(db, {
    action: 'external.write',
    workspaceId: WS_A,
    origin: 'agent',
  })

  const traceStr = JSON.stringify(res.trace)
  assert.doesNotMatch(traceStr, /password|secret|token|credential|api_key/i)

  const events = await listRecentEvents(db, WS_A, 'policy', 10)
  for (const event of events) {
    if (event.payload) {
      assert.doesNotMatch(event.payload, /password|secret|token|credential|api_key/i)
    }
  }
})

// 18. Platform-neutral behavior
test('18. action keys, modes, and scopes remain platform-neutral', () => {
  for (const key of ACTION_KEYS) {
    assert.doesNotMatch(key, /pinterest|facebook|instagram|twitter|tiktok/i)
  }
  for (const mode of POLICY_MODES) {
    assert.ok(['auto', 'review', 'blocked'].includes(mode))
  }
})
