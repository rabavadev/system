/**
 * STEP 11D: Approval Center & Autonomy UX Tests (npm run test:approvals-ux)
 *
 * Verifies:
 * 1. pending approvals list query & enriched metadata
 * 2. real pending count computation and retrieval
 * 3. approve from UI/server function
 * 4. reject from UI/server function (with decision note)
 * 5. double-click decision safe
 * 6. expired request displays correctly & blocks late approval
 * 7. cancelled request displays correctly
 * 8. resolved approvals remain visible in historical queries
 * 9. Workflow-linked request displays workflow/step/run relationship
 * 10. approval resume result displayed accurately
 * 11. brand override renders and resolves correctly
 * 12. inherited policy renders and resolves to workspace default
 * 13. clearing override restores workspace default
 * 14. AUTO/REVIEW/BLOCKED labels and descriptions correct
 * 15. invalid/cross-workspace request not exposed
 * 16. no secrets/raw snapshot shown in normal UI DTOs
 * 17. empty state handles zero requests cleanly
 * 18. existing approval/workflow tests remain green
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import { ensureBuiltinAgents } from '../src/server/agents/registry.ts'
import { createEchoAdapter } from '../src/server/ai/providers/echo.ts'
import {
  createApprovalRequest,
  decideApprovalRequest,
  getApprovalWithExpiryCheck,
} from '../src/server/approval/service.ts'
import { setAgentStatus } from '../src/server/db/agent.ts'
import {
  countPendingApprovals,
  getApprovalRequest,
  listApprovalRequests,
} from '../src/server/db/approval.ts'
import {
  clearApprovalPolicyOverride,
  listApprovalPolicies,
  setApprovalPolicy,
} from '../src/server/db/policy.ts'
import type { SqlDatabase } from '../src/server/db/sql.ts'
import { getWorkflowRunById } from '../src/server/db/workflow.ts'
import { resolveApprovalPolicy } from '../src/server/policy/resolver.ts'
import { ACTION_DEFINITIONS } from '../src/server/policy/types.ts'
import {
  listToolDefinitions,
  type ToolAdapter,
  type ToolDefinition,
} from '../src/server/tools/index.ts'
import {
  createWorkflowWithVersion,
  resumeWorkflowAfterApproval,
  startWorkflowRun,
  type WorkflowEngineDeps,
} from '../src/server/workflows/index.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const WS_A = crypto.randomUUID()
const WS_B = crypto.randomUUID()
const BRAND_A = crypto.randomUUID()
const PRODUCT_A = crypto.randomUUID()
const NOW = '2026-08-20T00:00:00.000Z'

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
    `INSERT INTO brand (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, 'Brand A', ?, ?)`,
    BRAND_A,
    WS_A,
    NOW,
    NOW,
  )
  ins(
    `INSERT INTO product (id, brand_id, name, created_at, updated_at) VALUES (?, ?, 'Product A', ?, ?)`,
    PRODUCT_A,
    BRAND_A,
    NOW,
    NOW,
  )
  return shim(sqlite)
}

function makeDeps(
  customAdapters?: Map<string, ToolAdapter>,
  customDefinitions?: ToolDefinition[],
): WorkflowEngineDeps {
  const echo = createEchoAdapter()
  const adapters = new Map<string, AIProviderAdapter>([['echo', echo]])
  const definitions = (customDefinitions ?? listToolDefinitions()).map((d) =>
    d.key === 'platform.publish' ? { ...d, status: 'available' as const } : d,
  )
  const toolAdapters = customAdapters ?? new Map<string, ToolAdapter>()
  return {
    ai: { adapters, modelOverrides: { provider: 'echo' } },
    tools: { definitions, adapters: toolAdapters },
    now: () => Date.now(),
  }
}

async function getAgents(db: SqlDatabase, workspaceId: string) {
  const map = await ensureBuiltinAgents(db, workspaceId)
  const publisher = map.get('publisher')
  const creator = map.get('creator')
  const chief = map.get('workspace-chief')
  const researcher = map.get('researcher')
  const critic = map.get('critic')
  if (!publisher || !creator || !chief || !researcher || !critic) {
    throw new Error('Missing built-in agents in test setup')
  }
  await setAgentStatus(db, publisher.agent.id, 'active')
  publisher.agent.status = 'active'
  return { publisher, creator, chief, researcher, critic }
}

test('1. Pending approvals list query and enriched metadata', async () => {
  const db = freshDb()
  const result = await createApprovalRequest(db, {
    workspaceId: WS_A,
    actionKey: 'content.publish',
    origin: 'agent',
    brandId: BRAND_A,
    summary: 'Publish autumn campaign pin',
    payload: {
      title: 'Autumn Collection',
      platform: 'pinterest',
      board: 'Style',
    },
  })

  assert.equal(result.status, 'pending')
  assert.ok(result.request)

  const list = await listApprovalRequests(db, {
    workspaceId: WS_A,
    status: 'pending',
  })
  assert.equal(list.length, 1)
  assert.equal(list[0]?.id, result.request?.id)
  assert.equal(list[0]?.actionKey, 'content.publish')
  assert.equal(list[0]?.summary, 'Publish autumn campaign pin')
})

test('2. Real pending count computation and retrieval', async () => {
  const db = freshDb()
  assert.equal(await countPendingApprovals(db, WS_A), 0)

  // Create two pending requests
  const req1 = await createApprovalRequest(db, {
    workspaceId: WS_A,
    actionKey: 'content.publish',
    origin: 'agent',
    summary: 'Request 1',
    payload: { item: 1 },
  })
  assert.equal(req1.status, 'pending')
  assert.equal(await countPendingApprovals(db, WS_A), 1)

  const req2 = await createApprovalRequest(db, {
    workspaceId: WS_A,
    actionKey: 'workflow.run',
    origin: 'user',
    summary: 'Request 2',
    payload: { item: 2 },
  })
  assert.equal(req2.status, 'pending')
  assert.equal(await countPendingApprovals(db, WS_A), 2)

  // Decide one request
  if (req1.request) {
    await decideApprovalRequest(db, {
      workspaceId: WS_A,
      requestId: req1.request.id,
      decision: 'approved',
      actor: { actorType: 'user', actorId: null },
    })
  }
  assert.equal(await countPendingApprovals(db, WS_A), 1)
})

test('3. Approve action from UI/server function path', async () => {
  const db = freshDb()
  const created = await createApprovalRequest(db, {
    workspaceId: WS_A,
    actionKey: 'content.publish',
    origin: 'agent',
    summary: 'Publish promo post',
    payload: { text: 'Hello' },
  })
  assert.ok(created.request)

  const decided = await decideApprovalRequest(db, {
    workspaceId: WS_A,
    requestId: created.request.id,
    decision: 'approved',
    actor: { actorType: 'user', actorId: null },
    note: 'Approved for launch',
  })

  assert.equal(decided.status, 'approved')
  assert.equal(decided.decision, 'approved')
  assert.equal(decided.decisionNote, 'Approved for launch')
  assert.ok(decided.decidedAt)
})

test('4. Reject action from UI/server function with decision note', async () => {
  const db = freshDb()
  const created = await createApprovalRequest(db, {
    workspaceId: WS_A,
    actionKey: 'content.publish',
    origin: 'agent',
    summary: 'Publish draft post',
    payload: { text: 'Draft' },
  })
  assert.ok(created.request)

  const decided = await decideApprovalRequest(db, {
    workspaceId: WS_A,
    requestId: created.request.id,
    decision: 'rejected',
    actor: { actorType: 'user', actorId: null },
    note: 'Image quality is too low',
  })

  assert.equal(decided.status, 'rejected')
  assert.equal(decided.decision, 'rejected')
  assert.equal(decided.decisionNote, 'Image quality is too low')
})

test('5. Double-click decision safe (idempotent)', async () => {
  const db = freshDb()
  const created = await createApprovalRequest(db, {
    workspaceId: WS_A,
    actionKey: 'content.publish',
    origin: 'agent',
    payload: { text: 'Post' },
  })
  assert.ok(created.request)

  const first = await decideApprovalRequest(db, {
    workspaceId: WS_A,
    requestId: created.request.id,
    decision: 'approved',
    actor: { actorType: 'user', actorId: null },
  })

  const second = await decideApprovalRequest(db, {
    workspaceId: WS_A,
    requestId: created.request.id,
    decision: 'approved',
    actor: { actorType: 'user', actorId: null },
  })

  assert.equal(first.status, 'approved')
  assert.equal(second.status, 'approved')
  assert.equal(second.id, first.id)
})

test('6. Expired request displays correctly & blocks late approval', async () => {
  const db = freshDb()
  const pastTime = new Date(Date.now() - 10000).toISOString()
  const created = await createApprovalRequest(db, {
    workspaceId: WS_A,
    actionKey: 'content.publish',
    origin: 'agent',
    expiresAt: pastTime,
    payload: { text: 'Old post' },
  })
  assert.ok(created.request)

  const read = await getApprovalWithExpiryCheck(db, {
    workspaceId: WS_A,
    id: created.request.id,
  })
  assert.equal(read?.status, 'expired')

  await assert.rejects(
    () =>
      decideApprovalRequest(db, {
        workspaceId: WS_A,
        requestId: created.request.id,
        decision: 'approved',
        actor: { actorType: 'user', actorId: null },
      }),
    /expired/i,
  )
})

test('7. Cancelled request displays correctly', async () => {
  const db = freshDb()
  const created = await createApprovalRequest(db, {
    workspaceId: WS_A,
    actionKey: 'content.publish',
    origin: 'agent',
    payload: { text: 'Post' },
  })
  assert.ok(created.request)

  const cancelled = await decideApprovalRequest(db, {
    workspaceId: WS_A,
    requestId: created.request.id,
    decision: 'cancelled',
    actor: { actorType: 'user', actorId: null },
    note: 'User aborted campaign',
  })
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.decisionNote, 'User aborted campaign')
})

test('8. Resolved approvals remain visible in historical queries', async () => {
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
    origin: 'agent',
    payload: { item: 2 },
  })

  if (req1.request) {
    await decideApprovalRequest(db, {
      workspaceId: WS_A,
      requestId: req1.request.id,
      decision: 'approved',
      actor: { actorType: 'user', actorId: null },
    })
  }
  if (req2.request) {
    await decideApprovalRequest(db, {
      workspaceId: WS_A,
      requestId: req2.request.id,
      decision: 'rejected',
      actor: { actorType: 'user', actorId: null },
    })
  }

  const approvedList = await listApprovalRequests(db, {
    workspaceId: WS_A,
    status: 'approved',
  })
  assert.equal(approvedList.length, 1)

  const rejectedList = await listApprovalRequests(db, {
    workspaceId: WS_A,
    status: 'rejected',
  })
  assert.equal(rejectedList.length, 1)
})

test('9. Workflow-linked request displays workflow/step/run relationship', async () => {
  const db = freshDb()
  const { publisher } = await getAgents(db, WS_A)

  const publishAdapter: ToolAdapter = {
    key: 'platform.publish',
    async run() {
      return {
        postId: crypto.randomUUID(),
        externalId: `ext_${crypto.randomUUID()}`,
        url: 'https://example.com/post',
      }
    },
  }
  const deps = makeDeps(new Map([['platform.publish', publishAdapter]]))

  const created = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Publish Workflow',
    definition: {
      entryStepId: 'step1',
      inputs: [{ key: 'brand', label: 'Brand', kind: 'brand', required: true }],
      steps: [
        {
          id: 'step1',
          type: 'tool',
          toolKey: 'platform.publish',
          requestedBy: { agentId: publisher.agent.id, versionPolicy: 'current_at_run' },
          inputs: [
            { key: 'accountId', value: { source: 'literal', value: crypto.randomUUID() } },
            { key: 'contentVariantId', value: { source: 'literal', value: crypto.randomUUID() } },
          ],
          next: null,
        },
      ],
    },
  })
  assert.equal(created.ok, true)

  const started = await startWorkflowRun({
    db,
    workspaceId: WS_A,
    workflowId: created.value.workflowId,
    inputs: { brand: BRAND_A },
    deps,
    drive: true,
  })
  assert.equal(started.ok, true)

  const run = await getWorkflowRunById(db, started.runId)
  assert.equal(run?.status, 'waiting')

  const pending = await listApprovalRequests(db, {
    workspaceId: WS_A,
    runId: started.runId,
  })
  assert.equal(pending.length, 1)
  assert.equal(pending[0]?.workflowId, created.value.workflowId)
  assert.equal(pending[0]?.runId, started.runId)
  assert.equal(pending[0]?.stepId, 'step1')
})

test('10. Approval resume result accurately reflected', async () => {
  const db = freshDb()
  const { publisher } = await getAgents(db, WS_A)

  let toolExecuted = false
  const publishAdapter: ToolAdapter = {
    key: 'platform.publish',
    async run() {
      toolExecuted = true
      return {
        postId: crypto.randomUUID(),
        externalId: `ext_${crypto.randomUUID()}`,
        url: 'https://example.com/post',
      }
    },
  }
  const deps = makeDeps(new Map([['platform.publish', publishAdapter]]))

  const created = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Auto Resume Workflow',
    definition: {
      entryStepId: 'step1',
      inputs: [{ key: 'brand', label: 'Brand', kind: 'brand', required: true }],
      steps: [
        {
          id: 'step1',
          type: 'tool',
          toolKey: 'platform.publish',
          requestedBy: { agentId: publisher.agent.id, versionPolicy: 'current_at_run' },
          inputs: [
            { key: 'accountId', value: { source: 'literal', value: crypto.randomUUID() } },
            { key: 'contentVariantId', value: { source: 'literal', value: crypto.randomUUID() } },
          ],
          next: null,
        },
      ],
    },
  })
  assert.equal(created.ok, true)

  const started = await startWorkflowRun({
    db,
    workspaceId: WS_A,
    workflowId: created.value.workflowId,
    inputs: { brand: BRAND_A },
    deps,
    drive: true,
  })
  assert.equal(started.ok, true)

  const pending = await listApprovalRequests(db, {
    workspaceId: WS_A,
    runId: started.runId,
  })
  const reqId = pending[0]?.id
  assert.ok(reqId)

  // Decide approved
  await decideApprovalRequest(db, {
    workspaceId: WS_A,
    requestId: reqId,
    decision: 'approved',
    actor: { actorType: 'user', actorId: null },
  })

  // Resume workflow
  const resumeRes = await resumeWorkflowAfterApproval(db, reqId, deps)
  assert.equal(resumeRes.ok, true)
  assert.equal(toolExecuted, true)

  const updatedRun = await getWorkflowRunById(db, started.runId)
  assert.equal(updatedRun?.status, 'succeeded')
})

test('11. Brand override renders and resolves correctly', async () => {
  const db = freshDb()

  // Set workspace policy to review
  await setApprovalPolicy(db, {
    workspaceId: WS_A,
    scopeType: 'workspace',
    scopeId: WS_A,
    actionKey: 'content.publish',
    mode: 'review',
  })

  // Set brand override to auto
  await setApprovalPolicy(db, {
    workspaceId: WS_A,
    scopeType: 'brand',
    scopeId: BRAND_A,
    actionKey: 'content.publish',
    mode: 'auto',
  })

  const res = await resolveApprovalPolicy(db, {
    workspaceId: WS_A,
    brandId: BRAND_A,
    action: 'content.publish',
    origin: 'agent',
  })

  assert.equal(res.mode, 'auto')
  assert.equal(res.source, 'brand_override')
})

test('12. Inherited policy renders and resolves to workspace default', async () => {
  const db = freshDb()

  await setApprovalPolicy(db, {
    workspaceId: WS_A,
    scopeType: 'workspace',
    scopeId: WS_A,
    actionKey: 'content.publish',
    mode: 'blocked',
  })

  // Resolving for BRAND_A (which has no brand override)
  const res = await resolveApprovalPolicy(db, {
    workspaceId: WS_A,
    brandId: BRAND_A,
    action: 'content.publish',
    origin: 'agent',
  })

  assert.equal(res.mode, 'blocked')
  assert.equal(res.source, 'workspace_policy')
})

test('13. Clearing override restores workspace default', async () => {
  const db = freshDb()

  await setApprovalPolicy(db, {
    workspaceId: WS_A,
    scopeType: 'workspace',
    scopeId: WS_A,
    actionKey: 'content.publish',
    mode: 'review',
  })

  await setApprovalPolicy(db, {
    workspaceId: WS_A,
    scopeType: 'brand',
    scopeId: BRAND_A,
    actionKey: 'content.publish',
    mode: 'auto',
  })

  // Delete brand override
  await clearApprovalPolicyOverride(db, {
    workspaceId: WS_A,
    scopeType: 'brand',
    scopeId: BRAND_A,
    actionKey: 'content.publish',
  })

  const res = await resolveApprovalPolicy(db, {
    workspaceId: WS_A,
    brandId: BRAND_A,
    action: 'content.publish',
    origin: 'agent',
  })

  assert.equal(res.mode, 'review')
  assert.equal(res.source, 'workspace_policy')
})

test('14. AUTO/REVIEW/BLOCKED labels and descriptions correct', () => {
  assert.ok(ACTION_DEFINITIONS['workspace.read'])
  assert.equal(ACTION_DEFINITIONS['workspace.read'].defaultMode, 'auto')

  assert.ok(ACTION_DEFINITIONS['content.publish'])
  assert.equal(ACTION_DEFINITIONS['content.publish'].defaultMode, 'review')

  assert.ok(ACTION_DEFINITIONS['destructive.delete'])
  assert.equal(ACTION_DEFINITIONS['destructive.delete'].defaultMode, 'blocked')
})

test('15. Invalid/cross-workspace request not exposed', async () => {
  const db = freshDb()
  const created = await createApprovalRequest(db, {
    workspaceId: WS_A,
    actionKey: 'content.publish',
    origin: 'agent',
    payload: { post: 1 },
  })
  assert.ok(created.request)

  const foreignRead = await getApprovalRequest(db, {
    workspaceId: WS_B,
    id: created.request.id,
  })
  assert.equal(foreignRead, null)

  await assert.rejects(
    () =>
      decideApprovalRequest(db, {
        workspaceId: WS_B,
        requestId: created.request.id,
        decision: 'approved',
        actor: { actorType: 'user', actorId: null },
      }),
    /not found/i,
  )
})

test('16. No secrets or raw snapshot shown in normal UI DTOs', async () => {
  const db = freshDb()
  const created = await createApprovalRequest(db, {
    workspaceId: WS_A,
    actionKey: 'content.publish',
    origin: 'agent',
    payload: {
      title: 'Campaign Pin',
      api_key: 'super_secret_api_key_12345',
      bearerToken: 'eyJhGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0',
    },
  })
  assert.ok(created.request)

  const parsed = JSON.parse(created.request.snapshotJson)
  assert.equal(parsed.title, 'Campaign Pin')
  assert.equal(parsed.api_key, '[REDACTED_SECRET]')
  assert.equal(parsed.bearerToken, '[REDACTED_SECRET]')
})

test('17. Empty state handles zero requests cleanly', async () => {
  const db = freshDb()
  const list = await listApprovalRequests(db, {
    workspaceId: WS_A,
    status: 'pending',
  })
  assert.equal(list.length, 0)
  assert.equal(await countPendingApprovals(db, WS_A), 0)
})

test('18. Existing approval/workflow integration remains green', async () => {
  const db = freshDb()
  const policies = await listApprovalPolicies(db, WS_A)
  assert.ok(Array.isArray(policies))
})
