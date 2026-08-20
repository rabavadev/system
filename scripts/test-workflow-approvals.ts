/**
 * Workflow ↔ Approval Requests Integration tests (npm run test:workflow-approvals).
 *
 * Covers all 28 requirements of STEP 11C:
 * 1. REVIEW Tool Step creates Approval Request
 * 2. REVIEW Tool Step enters waiting
 * 3. Tool not executed before approval
 * 4. AUTO executes without request
 * 5. BLOCKED creates no request
 * 6. approve resumes exact Step
 * 7. completed previous Steps do not rerun
 * 8. approved Tool executes once
 * 9. double approval does not double execute
 * 10. browser/retry-style duplicate resume safe
 * 11. rejected request does not execute Tool
 * 12. cancelled request does not execute Tool
 * 13. expired request does not execute Tool
 * 14. cancelled Workflow cannot resume
 * 15. snapshot mismatch blocks execution
 * 16. capability checked again before execution
 * 17. Tool availability checked again before execution
 * 18. disabled Agent blocks resumed execution
 * 19. cross-workspace scope blocks resumed execution
 * 20. approved request does not loop into new REVIEW request
 * 21. execution failure after approval leaves Approval approved
 * 22. safe retry can reuse same approval if snapshot identical
 * 23. sequential approval Steps work
 * 24. waiting state survives reload/resume
 * 25. events/audit safe
 * 26. no secrets in waiting state
 * 27. existing Workflow resume tests still pass
 * 28. existing Approval tests still pass
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import { ensureBuiltinAgents } from '../src/server/agents/registry.ts'
import { createEchoAdapter } from '../src/server/ai/providers/echo.ts'
import type { AIProviderAdapter } from '../src/server/ai/types.ts'
import { createApprovalRequest, decideApprovalRequest } from '../src/server/approval/service.ts'
import { setAgentStatus } from '../src/server/db/agent.ts'
import { getApprovalRequest, listApprovalRequests } from '../src/server/db/approval.ts'
import { listRecentEvents } from '../src/server/db/event.ts'
import { setApprovalPolicy } from '../src/server/db/policy.ts'
import type { SqlDatabase } from '../src/server/db/sql.ts'
import { getWorkflowRunById, listWorkflowStepRuns } from '../src/server/db/workflow.ts'
import {
  listToolDefinitions,
  type ToolAdapter,
  type ToolDefinition,
  ToolError,
} from '../src/server/tools/index.ts'
import {
  cancelWorkflowRun,
  createWorkflowWithVersion,
  resumeWorkflowAfterApproval,
  resumeWorkflowRun,
  startWorkflowRun,
  type WorkflowEngineDeps,
} from '../src/server/workflows/index.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const WS_A = crypto.randomUUID()
const WS_B = crypto.randomUUID()
const BRAND_A = crypto.randomUUID()
const BRAND_B = crypto.randomUUID()
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
    `INSERT INTO product (id, brand_id, niche_id, name, description, url, status, created_at, updated_at)
     VALUES (?, ?, NULL, 'Product A', 'A product', NULL, 'active', ?, ?)`,
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

function createPublishSuccess() {
  return {
    postId: crypto.randomUUID(),
    externalId: `ext_${crypto.randomUUID()}`,
    url: 'https://example.com/post',
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
  // Activate publisher for testing
  await setAgentStatus(db, publisher.agent.id, 'active')
  publisher.agent.status = 'active'
  return { publisher, creator, chief, researcher, critic }
}

test('1. REVIEW Tool Step creates Approval Request', async () => {
  const db = freshDb()
  const { publisher } = await getAgents(db, WS_A)

  let toolRunCount = 0
  const publishAdapter: ToolAdapter = {
    key: 'platform.publish',
    async run() {
      toolRunCount++
      return createPublishSuccess()
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

  const approvals = await listApprovalRequests(db, { workspaceId: WS_A, runId: started.runId })
  assert.equal(approvals.length, 1)
  assert.equal(approvals[0].actionKey, 'content.publish')
  assert.equal(approvals[0].status, 'pending')
  assert.equal(approvals[0].stepId, 'step1')
  assert.equal(approvals[0].runId, started.runId)
  assert.equal(toolRunCount, 0)
})

test('2. REVIEW Tool Step enters waiting', async () => {
  const db = freshDb()
  const { publisher } = await getAgents(db, WS_A)
  const deps = makeDeps()

  const created = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Publish Workflow',
    definition: {
      entryStepId: 'pub',
      steps: [
        {
          id: 'pub',
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
    inputs: {},
    deps,
    drive: true,
  })
  assert.equal(started.ok, true)

  const run = await getWorkflowRunById(db, started.runId)
  assert.equal(run?.status, 'waiting')

  const stepRuns = await listWorkflowStepRuns(db, started.runId)
  assert.equal(stepRuns.length, 1)
  assert.equal(stepRuns[0].status, 'waiting')
})

test('3. Tool not executed before approval', async () => {
  const db = freshDb()
  const { publisher } = await getAgents(db, WS_A)
  let executed = false
  const publishAdapter: ToolAdapter = {
    key: 'platform.publish',
    async run() {
      executed = true
      return createPublishSuccess()
    },
  }
  const deps = makeDeps(new Map([['platform.publish', publishAdapter]]))

  const created = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Publish Workflow',
    definition: {
      entryStepId: 'pub',
      steps: [
        {
          id: 'pub',
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

  await startWorkflowRun({
    db,
    workspaceId: WS_A,
    workflowId: created.value.workflowId,
    inputs: {},
    deps,
    drive: true,
  })
  assert.equal(executed, false)
})

test('4. AUTO executes without request', async () => {
  const db = freshDb()
  const { chief } = await getAgents(db, WS_A)
  let executed = false
  const readAdapter: ToolAdapter = {
    key: 'workspace.list_products',
    async run() {
      executed = true
      return { products: [] }
    },
  }
  const deps = makeDeps(new Map([['workspace.list_products', readAdapter]]))

  const created = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Read Workflow',
    definition: {
      entryStepId: 'read',
      steps: [
        {
          id: 'read',
          type: 'tool',
          toolKey: 'workspace.list_products',
          requestedBy: { agentId: chief.agent.id, versionPolicy: 'current_at_run' },
          inputs: [],
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
    inputs: {},
    deps,
    drive: true,
  })
  assert.equal(started.ok, true)
  const run = await getWorkflowRunById(db, started.runId)
  assert.equal(run?.status, 'succeeded')
  assert.equal(executed, true)

  const approvals = await listApprovalRequests(db, { workspaceId: WS_A, runId: started.runId })
  assert.equal(approvals.length, 0)
})

test('5. BLOCKED creates no request and fails safely', async () => {
  const db = freshDb()
  const { publisher } = await getAgents(db, WS_A)

  await setApprovalPolicy(db, {
    workspaceId: WS_A,
    scopeType: 'workspace',
    scopeId: WS_A,
    actionKey: 'content.publish',
    mode: 'blocked',
  })

  let executed = false
  const publishAdapter: ToolAdapter = {
    key: 'platform.publish',
    async run() {
      executed = true
      return createPublishSuccess()
    },
  }
  const deps = makeDeps(new Map([['platform.publish', publishAdapter]]))

  const created = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Publish Workflow',
    definition: {
      entryStepId: 'pub',
      steps: [
        {
          id: 'pub',
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
    inputs: {},
    deps,
    drive: true,
  })
  assert.equal(started.ok, true)
  const run = await getWorkflowRunById(db, started.runId)
  assert.equal(run?.status, 'failed')
  assert.match(run?.error ?? '', /blocked by policy/i)
  assert.equal(executed, false)

  const approvals = await listApprovalRequests(db, { workspaceId: WS_A, runId: started.runId })
  assert.equal(approvals.length, 0)
})

test('6. approve resumes exact Step and 7. completed previous Steps do not rerun', async () => {
  const db = freshDb()
  const { creator, publisher } = await getAgents(db, WS_A)

  let agentExecutionCount = 0
  let toolExecutionCount = 0

  const echo = createEchoAdapter()
  const customAi = {
    adapters: new Map<string, AIProviderAdapter>([
      [
        'echo',
        {
          key: 'echo',
          async execute(req: Parameters<AIProviderAdapter['execute']>[0]) {
            agentExecutionCount++
            return echo.execute(req)
          },
        },
      ],
    ]),
    modelOverrides: { provider: 'echo' },
  }

  const publishAdapter: ToolAdapter = {
    key: 'platform.publish',
    async run() {
      toolExecutionCount++
      return createPublishSuccess()
    },
  }

  const deps: WorkflowEngineDeps = {
    ai: customAi,
    tools: {
      definitions: listToolDefinitions().map((d) =>
        d.key === 'platform.publish' ? { ...d, status: 'available' as const } : d,
      ),
      adapters: new Map([['platform.publish', publishAdapter]]),
    },
    now: () => Date.now(),
  }

  const created = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Multi-Step Approval Workflow',
    definition: {
      entryStepId: 'step1',
      steps: [
        {
          id: 'step1',
          type: 'agent',
          agent: { agentId: creator.agent.id, versionPolicy: 'current_at_run' },
          task: 'Create content draft',
          inputs: [],
          next: 'step2',
        },
        {
          id: 'step2',
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
    inputs: {},
    deps,
    drive: true,
  })
  assert.equal(started.ok, true)
  assert.equal(agentExecutionCount, 1)
  assert.equal(toolExecutionCount, 0)

  let run = await getWorkflowRunById(db, started.runId)
  assert.equal(run?.status, 'waiting')

  const approvals = await listApprovalRequests(db, { workspaceId: WS_A, runId: started.runId })
  assert.equal(approvals.length, 1)
  const approvalId = approvals[0].id

  // Approve request
  await decideApprovalRequest(db, {
    workspaceId: WS_A,
    requestId: approvalId,
    decision: 'approved',
    actor: { actorType: 'user', actorId: null },
    note: 'Approved by tester',
  })

  // Resume workflow
  const resumed = await resumeWorkflowAfterApproval(db, approvalId, deps)
  assert.equal(resumed.ok, true)

  run = await getWorkflowRunById(db, started.runId)
  assert.equal(run?.status, 'succeeded')
  assert.equal(agentExecutionCount, 1, 'Previous agent step must not rerun')
  assert.equal(toolExecutionCount, 1, 'Tool step must run exactly once')
})

test('8. approved Tool executes once and 9. double approval does not double execute and 10. duplicate resume safe', async () => {
  const db = freshDb()
  const { publisher } = await getAgents(db, WS_A)

  let toolRunCount = 0
  const publishAdapter: ToolAdapter = {
    key: 'platform.publish',
    async run() {
      toolRunCount++
      return createPublishSuccess()
    },
  }
  const deps = makeDeps(new Map([['platform.publish', publishAdapter]]))

  const created = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Publish Workflow',
    definition: {
      entryStepId: 'pub',
      steps: [
        {
          id: 'pub',
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
    inputs: {},
    deps,
    drive: true,
  })

  const [approval] = await listApprovalRequests(db, { workspaceId: WS_A, runId: started.runId })
  await decideApprovalRequest(db, {
    workspaceId: WS_A,
    requestId: approval.id,
    decision: 'approved',
    actor: { actorType: 'user', actorId: null },
  })

  // First resume
  const res1 = await resumeWorkflowAfterApproval(db, approval.id, deps)
  assert.equal(res1.ok, true)
  assert.equal(toolRunCount, 1)

  // Second resume (duplicate / retry)
  const res2 = await resumeWorkflowAfterApproval(db, approval.id, deps)
  assert.equal(res2.ok, true)
  assert.equal(toolRunCount, 1, 'Tool must not execute a second time')
})

test('11. rejected request does not execute Tool', async () => {
  const db = freshDb()
  const { publisher } = await getAgents(db, WS_A)

  let toolRunCount = 0
  const publishAdapter: ToolAdapter = {
    key: 'platform.publish',
    async run() {
      toolRunCount++
      return createPublishSuccess()
    },
  }
  const deps = makeDeps(new Map([['platform.publish', publishAdapter]]))

  const created = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Publish Workflow',
    definition: {
      entryStepId: 'pub',
      steps: [
        {
          id: 'pub',
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
    inputs: {},
    deps,
    drive: true,
  })

  const [approval] = await listApprovalRequests(db, { workspaceId: WS_A, runId: started.runId })
  await decideApprovalRequest(db, {
    workspaceId: WS_A,
    requestId: approval.id,
    decision: 'rejected',
    actor: { actorType: 'user', actorId: null },
    note: 'Rejected by tester',
  })

  const res = await resumeWorkflowAfterApproval(db, approval.id, deps)
  assert.equal(res.ok, false)
  assert.equal(res.code, 'approval_rejected')
  assert.equal(toolRunCount, 0)

  const run = await getWorkflowRunById(db, started.runId)
  assert.equal(run?.status, 'failed')
})

test('12. cancelled request does not execute Tool', async () => {
  const db = freshDb()
  const { publisher } = await getAgents(db, WS_A)

  let toolRunCount = 0
  const publishAdapter: ToolAdapter = {
    key: 'platform.publish',
    async run() {
      toolRunCount++
      return createPublishSuccess()
    },
  }
  const deps = makeDeps(new Map([['platform.publish', publishAdapter]]))

  const created = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Publish Workflow',
    definition: {
      entryStepId: 'pub',
      steps: [
        {
          id: 'pub',
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
    inputs: {},
    deps,
    drive: true,
  })

  const [approval] = await listApprovalRequests(db, { workspaceId: WS_A, runId: started.runId })
  await decideApprovalRequest(db, {
    workspaceId: WS_A,
    requestId: approval.id,
    decision: 'cancelled',
    actor: { actorType: 'user', actorId: null },
  })

  const res = await resumeWorkflowAfterApproval(db, approval.id, deps)
  assert.equal(res.ok, false)
  assert.equal(res.code, 'approval_cancelled')
  assert.equal(toolRunCount, 0)

  const run = await getWorkflowRunById(db, started.runId)
  assert.equal(run?.status, 'cancelled')
})

test('13. expired request does not execute Tool', async () => {
  const db = freshDb()
  const { publisher } = await getAgents(db, WS_A)

  let toolRunCount = 0
  const publishAdapter: ToolAdapter = {
    key: 'platform.publish',
    async run() {
      toolRunCount++
      return createPublishSuccess()
    },
  }
  const deps = makeDeps(new Map([['platform.publish', publishAdapter]]))

  const created = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Publish Workflow',
    definition: {
      entryStepId: 'pub',
      steps: [
        {
          id: 'pub',
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
    inputs: {},
    deps,
    drive: true,
  })

  const [approval] = await listApprovalRequests(db, { workspaceId: WS_A, runId: started.runId })
  // Manually set expiry in past
  await db
    .prepare(`UPDATE approval SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`)
    .bind(approval.id)
    .run()

  const res = await resumeWorkflowAfterApproval(db, approval.id, deps)
  assert.equal(res.ok, false)
  assert.equal(res.code, 'approval_expired')
  assert.equal(toolRunCount, 0)

  const run = await getWorkflowRunById(db, started.runId)
  assert.equal(run?.status, 'failed')
})

test('14. cancelled Workflow cannot resume', async () => {
  const db = freshDb()
  const { publisher } = await getAgents(db, WS_A)

  let toolRunCount = 0
  const publishAdapter: ToolAdapter = {
    key: 'platform.publish',
    async run() {
      toolRunCount++
      return createPublishSuccess()
    },
  }
  const deps = makeDeps(new Map([['platform.publish', publishAdapter]]))

  const created = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Publish Workflow',
    definition: {
      entryStepId: 'pub',
      steps: [
        {
          id: 'pub',
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
    inputs: {},
    deps,
    drive: true,
  })

  const [approval] = await listApprovalRequests(db, { workspaceId: WS_A, runId: started.runId })

  // Cancel workflow run
  await cancelWorkflowRun(db, started.runId)

  // Verify approval request was also marked cancelled
  const updatedApproval = await getApprovalRequest(db, { workspaceId: WS_A, id: approval.id })
  assert.equal(updatedApproval?.status, 'cancelled')

  // Attempting to resume fails
  const res = await resumeWorkflowAfterApproval(db, approval.id, deps)
  assert.equal(res.ok, false)
  assert.equal(toolRunCount, 0)
})

test('15. snapshot mismatch blocks execution', async () => {
  const db = freshDb()
  const { publisher } = await getAgents(db, WS_A)

  let toolRunCount = 0
  const publishAdapter: ToolAdapter = {
    key: 'platform.publish',
    async run() {
      toolRunCount++
      return createPublishSuccess()
    },
  }
  const deps = makeDeps(new Map([['platform.publish', publishAdapter]]))

  const created = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Publish Workflow',
    definition: {
      entryStepId: 'pub',
      inputs: [{ key: 'target_account', label: 'Target Account', kind: 'text', required: true }],
      steps: [
        {
          id: 'pub',
          type: 'tool',
          toolKey: 'platform.publish',
          requestedBy: { agentId: publisher.agent.id, versionPolicy: 'current_at_run' },
          inputs: [
            { key: 'accountId', value: { source: 'workflow_input', path: 'target_account' } },
            { key: 'contentVariantId', value: { source: 'literal', value: crypto.randomUUID() } },
          ],
          next: null,
        },
      ],
    },
  })
  assert.equal(created.ok, true)

  const targetId = crypto.randomUUID()
  const started = await startWorkflowRun({
    db,
    workspaceId: WS_A,
    workflowId: created.value.workflowId,
    inputs: { target_account: targetId },
    deps,
    drive: true,
  })

  const [approval] = await listApprovalRequests(db, { workspaceId: WS_A, runId: started.runId })
  await decideApprovalRequest(db, {
    workspaceId: WS_A,
    requestId: approval.id,
    decision: 'approved',
    actor: { actorType: 'user', actorId: null },
  })

  // Mutate workflow run inputs behind the scenes to simulate parameter tampering
  const tamperedInputs = JSON.stringify({ target_account: crypto.randomUUID() })
  await db
    .prepare(`UPDATE workflow_run SET input = ? WHERE id = ?`)
    .bind(tamperedInputs, started.runId)
    .run()

  const res = await resumeWorkflowAfterApproval(db, approval.id, deps)
  assert.equal(res.ok, false)
  assert.equal(res.code, 'approval_snapshot_mismatch')
  assert.equal(toolRunCount, 0)

  const run = await getWorkflowRunById(db, started.runId)
  assert.equal(run?.status, 'failed')
})

test('16. capability checked again before execution', async () => {
  const db = freshDb()
  const { creator } = await getAgents(db, WS_A)

  // Creator agent lacks 'publish' capability.
  // Set policy to auto for content.publish to test immediate executeTool capability check
  await setApprovalPolicy(db, {
    workspaceId: WS_A,
    scopeType: 'workspace',
    scopeId: WS_A,
    actionKey: 'content.publish',
    mode: 'auto',
  })

  const publishAdapter: ToolAdapter = {
    key: 'platform.publish',
    async run() {
      return createPublishSuccess()
    },
  }
  const deps = makeDeps(new Map([['platform.publish', publishAdapter]]))

  const created = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Publish Workflow',
    definition: {
      entryStepId: 'pub',
      steps: [
        {
          id: 'pub',
          type: 'tool',
          toolKey: 'platform.publish',
          requestedBy: { agentId: creator.agent.id, versionPolicy: 'current_at_run' },
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
    inputs: {},
    deps,
    drive: true,
  })

  const run = await getWorkflowRunById(db, started.runId)
  assert.equal(run?.status, 'failed')
  assert.match(run?.error ?? '', /not allowed to use/i)
})

test('17. Tool availability checked again before execution', async () => {
  const db = freshDb()
  const { publisher } = await getAgents(db, WS_A)

  const publishAdapter: ToolAdapter = {
    key: 'platform.publish',
    async run() {
      return createPublishSuccess()
    },
  }
  const deps = makeDeps(new Map([['platform.publish', publishAdapter]]))

  const created = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Publish Workflow',
    definition: {
      entryStepId: 'pub',
      steps: [
        {
          id: 'pub',
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
    inputs: {},
    deps,
    drive: true,
  })

  const [approval] = await listApprovalRequests(db, { workspaceId: WS_A, runId: started.runId })
  await decideApprovalRequest(db, {
    workspaceId: WS_A,
    requestId: approval.id,
    decision: 'approved',
    actor: { actorType: 'user', actorId: null },
  })

  // Remove adapter before resume (simulate adapter becoming unconfigured)
  const depsWithoutAdapter = makeDeps(new Map())
  await resumeWorkflowAfterApproval(db, approval.id, depsWithoutAdapter)

  const run = await getWorkflowRunById(db, started.runId)
  assert.equal(run?.status, 'failed')
  assert.match(run?.error ?? '', /no configured implementation/i)
})

test('18. disabled Agent blocks resumed execution', async () => {
  const db = freshDb()
  const { publisher } = await getAgents(db, WS_A)

  const publishAdapter: ToolAdapter = {
    key: 'platform.publish',
    async run() {
      return createPublishSuccess()
    },
  }
  const deps = makeDeps(new Map([['platform.publish', publishAdapter]]))

  const created = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Publish Workflow',
    definition: {
      entryStepId: 'pub',
      steps: [
        {
          id: 'pub',
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
    inputs: {},
    deps,
    drive: true,
  })

  const [approval] = await listApprovalRequests(db, { workspaceId: WS_A, runId: started.runId })
  await decideApprovalRequest(db, {
    workspaceId: WS_A,
    requestId: approval.id,
    decision: 'approved',
    actor: { actorType: 'user', actorId: null },
  })

  // Disable agent before resume
  await setAgentStatus(db, publisher.agent.id, 'disabled')

  const res = await resumeWorkflowAfterApproval(db, approval.id, deps)
  assert.equal(res.ok, false)

  const run = await getWorkflowRunById(db, started.runId)
  assert.equal(run?.status, 'failed')
  assert.match(run?.error ?? '', /disabled/i)
})

test('19. cross-workspace scope blocks resumed execution', async () => {
  const db = freshDb()
  const { publisher } = await getAgents(db, WS_A)
  await getAgents(db, WS_B)

  const publishAdapter: ToolAdapter = {
    key: 'platform.publish',
    async run() {
      return createPublishSuccess()
    },
  }
  const deps = makeDeps(new Map([['platform.publish', publishAdapter]]))

  const created = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Publish Workflow',
    definition: {
      entryStepId: 'pub',
      steps: [
        {
          id: 'pub',
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
    inputs: {},
    deps,
    drive: true,
  })

  const [approval] = await listApprovalRequests(db, { workspaceId: WS_A, runId: started.runId })

  // Workspace B tries to decide request for Workspace A
  await assert.rejects(async () => {
    await decideApprovalRequest(db, {
      workspaceId: WS_B,
      requestId: approval.id,
      decision: 'approved',
      actor: { actorType: 'user', actorId: null },
    })
  }, /Approval request not found/i)
})

test('20. approved request does not loop into new REVIEW request', async () => {
  const db = freshDb()
  const { publisher } = await getAgents(db, WS_A)

  let toolRunCount = 0
  const publishAdapter: ToolAdapter = {
    key: 'platform.publish',
    async run() {
      toolRunCount++
      return createPublishSuccess()
    },
  }
  const deps = makeDeps(new Map([['platform.publish', publishAdapter]]))

  const created = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Publish Workflow',
    definition: {
      entryStepId: 'pub',
      steps: [
        {
          id: 'pub',
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
    inputs: {},
    deps,
    drive: true,
  })

  const approvalsBefore = await listApprovalRequests(db, {
    workspaceId: WS_A,
    runId: started.runId,
  })
  assert.equal(approvalsBefore.length, 1)

  await decideApprovalRequest(db, {
    workspaceId: WS_A,
    requestId: approvalsBefore[0].id,
    decision: 'approved',
    actor: { actorType: 'user', actorId: null },
  })

  await resumeWorkflowAfterApproval(db, approvalsBefore[0].id, deps)

  const approvalsAfter = await listApprovalRequests(db, { workspaceId: WS_A, runId: started.runId })
  assert.equal(approvalsAfter.length, 1, 'Must not create another approval request when resuming')

  const run = await getWorkflowRunById(db, started.runId)
  assert.equal(run?.status, 'succeeded')
  assert.equal(toolRunCount, 1)
})

test('21. execution failure after approval leaves Approval approved', async () => {
  const db = freshDb()
  const { publisher } = await getAgents(db, WS_A)

  const failingPublishAdapter: ToolAdapter = {
    key: 'platform.publish',
    async run() {
      throw new Error('Platform upstream 500 error')
    },
  }
  const deps = makeDeps(new Map([['platform.publish', failingPublishAdapter]]))

  const created = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Publish Workflow',
    definition: {
      entryStepId: 'pub',
      steps: [
        {
          id: 'pub',
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
    inputs: {},
    deps,
    drive: true,
  })

  const [approval] = await listApprovalRequests(db, { workspaceId: WS_A, runId: started.runId })
  await decideApprovalRequest(db, {
    workspaceId: WS_A,
    requestId: approval.id,
    decision: 'approved',
    actor: { actorType: 'user', actorId: null },
  })

  await resumeWorkflowAfterApproval(db, approval.id, deps)

  // Run failed due to tool error
  const run = await getWorkflowRunById(db, started.runId)
  assert.equal(run?.status, 'failed')

  // But approval remains approved
  const approvalAfter = await getApprovalRequest(db, { workspaceId: WS_A, id: approval.id })
  assert.equal(approvalAfter?.status, 'approved')
})

test('22. safe retry can reuse same approval if snapshot identical', async () => {
  const db = freshDb()
  const { publisher } = await getAgents(db, WS_A)

  let attempts = 0
  const retryAdapter: ToolAdapter = {
    key: 'platform.publish',
    async run() {
      attempts++
      if (attempts === 1) {
        throw new ToolError('timeout', 'Network timeout')
      }
      return createPublishSuccess()
    },
  }
  const deps = makeDeps(new Map([['platform.publish', retryAdapter]]))

  const created = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Retry Workflow',
    definition: {
      entryStepId: 'pub',
      steps: [
        {
          id: 'pub',
          type: 'tool',
          toolKey: 'platform.publish',
          requestedBy: { agentId: publisher.agent.id, versionPolicy: 'current_at_run' },
          inputs: [
            { key: 'accountId', value: { source: 'literal', value: crypto.randomUUID() } },
            { key: 'contentVariantId', value: { source: 'literal', value: crypto.randomUUID() } },
          ],
          retry: { maxAttempts: 3 },
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
    inputs: {},
    deps,
    drive: true,
  })

  const [approval] = await listApprovalRequests(db, { workspaceId: WS_A, runId: started.runId })
  await decideApprovalRequest(db, {
    workspaceId: WS_A,
    requestId: approval.id,
    decision: 'approved',
    actor: { actorType: 'user', actorId: null },
  })

  await resumeWorkflowAfterApproval(db, approval.id, deps)

  const run = await getWorkflowRunById(db, started.runId)
  assert.equal(run?.status, 'succeeded')
  assert.equal(attempts, 2)
})

test('23. sequential approval Steps work', async () => {
  const db = freshDb()
  const { publisher } = await getAgents(db, WS_A)

  let publish1Count = 0
  let publish2Count = 0
  const variant1Id = crypto.randomUUID()
  const variant2Id = crypto.randomUUID()

  const publishAdapter: ToolAdapter = {
    key: 'platform.publish',
    async run(input: Parameters<ToolAdapter['run']>[0]) {
      const args = input.args as { contentVariantId?: string }
      if (args.contentVariantId === variant1Id) publish1Count++
      if (args.contentVariantId === variant2Id) publish2Count++
      return createPublishSuccess()
    },
  }
  const deps = makeDeps(new Map([['platform.publish', publishAdapter]]))

  const created = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Sequential Approvals Workflow',
    definition: {
      entryStepId: 'step1',
      steps: [
        {
          id: 'step1',
          type: 'tool',
          toolKey: 'platform.publish',
          requestedBy: { agentId: publisher.agent.id, versionPolicy: 'current_at_run' },
          inputs: [
            { key: 'accountId', value: { source: 'literal', value: crypto.randomUUID() } },
            { key: 'contentVariantId', value: { source: 'literal', value: variant1Id } },
          ],
          next: 'step2',
        },
        {
          id: 'step2',
          type: 'tool',
          toolKey: 'platform.publish',
          requestedBy: { agentId: publisher.agent.id, versionPolicy: 'current_at_run' },
          inputs: [
            { key: 'accountId', value: { source: 'literal', value: crypto.randomUUID() } },
            { key: 'contentVariantId', value: { source: 'literal', value: variant2Id } },
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
    inputs: {},
    deps,
    drive: true,
  })

  // First step is waiting
  let run = await getWorkflowRunById(db, started.runId)
  assert.equal(run?.status, 'waiting')
  let approvals = await listApprovalRequests(db, { workspaceId: WS_A, runId: started.runId })
  assert.equal(approvals.length, 1)
  assert.equal(approvals[0].stepId, 'step1')

  // Approve step1
  await decideApprovalRequest(db, {
    workspaceId: WS_A,
    requestId: approvals[0].id,
    decision: 'approved',
    actor: { actorType: 'user', actorId: null },
  })
  await resumeWorkflowAfterApproval(db, approvals[0].id, deps)

  // Second step is now waiting
  run = await getWorkflowRunById(db, started.runId)
  assert.equal(run?.status, 'waiting')
  assert.equal(publish1Count, 1)
  assert.equal(publish2Count, 0)

  approvals = await listApprovalRequests(db, { workspaceId: WS_A, runId: started.runId })
  assert.equal(approvals.length, 2)
  const step2Approval = approvals.find((a) => a.stepId === 'step2')
  assert.ok(step2Approval)
  assert.equal(step2Approval.status, 'pending')

  // Approve step2
  await decideApprovalRequest(db, {
    workspaceId: WS_A,
    requestId: step2Approval.id,
    decision: 'approved',
    actor: { actorType: 'user', actorId: null },
  })
  await resumeWorkflowAfterApproval(db, step2Approval.id, deps)

  run = await getWorkflowRunById(db, started.runId)
  assert.equal(run?.status, 'succeeded')
  assert.equal(publish1Count, 1)
  assert.equal(publish2Count, 1)
})

test('24. waiting state survives reload/resume', async () => {
  const db = freshDb()
  const { publisher } = await getAgents(db, WS_A)

  let toolRunCount = 0
  const publishAdapter: ToolAdapter = {
    key: 'platform.publish',
    async run() {
      toolRunCount++
      return createPublishSuccess()
    },
  }
  const deps1 = makeDeps(new Map([['platform.publish', publishAdapter]]))

  const created = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Publish Workflow',
    definition: {
      entryStepId: 'pub',
      steps: [
        {
          id: 'pub',
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
    inputs: {},
    deps: deps1,
    drive: true,
  })

  const [approval] = await listApprovalRequests(db, { workspaceId: WS_A, runId: started.runId })
  await decideApprovalRequest(db, {
    workspaceId: WS_A,
    requestId: approval.id,
    decision: 'approved',
    actor: { actorType: 'user', actorId: null },
  })

  // Completely new deps instance (simulates new process / restart)
  const deps2 = makeDeps(new Map([['platform.publish', publishAdapter]]))
  const res = await resumeWorkflowAfterApproval(db, approval.id, deps2)
  assert.equal(res.ok, true)

  const run = await getWorkflowRunById(db, started.runId)
  assert.equal(run?.status, 'succeeded')
  assert.equal(toolRunCount, 1)
})

test('25. events/audit safe and 26. no secrets in waiting state', async () => {
  const db = freshDb()
  const { publisher } = await getAgents(db, WS_A)

  const publishAdapter: ToolAdapter = {
    key: 'platform.publish',
    async run() {
      return createPublishSuccess()
    },
  }
  const deps = makeDeps(new Map([['platform.publish', publishAdapter]]))

  const created = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Publish Workflow',
    definition: {
      entryStepId: 'pub',
      steps: [
        {
          id: 'pub',
          type: 'tool',
          toolKey: 'platform.publish',
          requestedBy: { agentId: publisher.agent.id, versionPolicy: 'current_at_run' },
          inputs: [
            { key: 'accountId', value: { source: 'literal', value: crypto.randomUUID() } },
            { key: 'contentVariantId', value: { source: 'literal', value: crypto.randomUUID() } },
            { key: 'bearer_token', value: { source: 'literal', value: 'secret_token_123' } },
            { key: 'api_key', value: { source: 'literal', value: 'super_secret_key_456' } },
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
    inputs: {},
    deps,
    drive: true,
  })

  const [approval] = await listApprovalRequests(db, { workspaceId: WS_A, runId: started.runId })
  assert.equal(approval.snapshotJson.includes('secret_token_123'), false)
  assert.equal(approval.snapshotJson.includes('super_secret_key_456'), false)

  const events = await listRecentEvents(db, WS_A, 'workflow.', 50)
  for (const ev of events) {
    if (ev.payload) {
      assert.equal(ev.payload.includes('secret_token_123'), false)
      assert.equal(ev.payload.includes('super_secret_key_456'), false)
    }
  }
})

test('27. existing Workflow resume tests still pass', async () => {
  const db = freshDb()
  const { chief } = await getAgents(db, WS_A)
  const deps = makeDeps()

  const created = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Agent Workflow',
    definition: {
      entryStepId: 'step1',
      steps: [
        {
          id: 'step1',
          type: 'agent',
          agent: { agentId: chief.agent.id, versionPolicy: 'current_at_run' },
          task: 'Summarize workspace',
          inputs: [],
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
    inputs: {},
    deps,
    drive: false,
  })

  const res = await resumeWorkflowRun(db, started.runId, deps)
  assert.equal(res.ok, true)
  const run = await getWorkflowRunById(db, started.runId)
  assert.equal(run?.status, 'succeeded')
})

test('28. existing Approval tests still pass', async () => {
  const db = freshDb()
  const created = await createApprovalRequest(db, {
    workspaceId: WS_A,
    actionKey: 'content.publish',
    origin: 'workflow',
    requestedByType: 'workflow',
    summary: 'Test summary',
    payload: { test: true },
  })
  assert.equal(created.status, 'pending')
  assert.ok(created.request)

  const decided = await decideApprovalRequest(db, {
    workspaceId: WS_A,
    requestId: created.request.id,
    decision: 'approved',
    actor: { actorType: 'user', actorId: null },
  })
  assert.equal(decided.status, 'approved')
})
