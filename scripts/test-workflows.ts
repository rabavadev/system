/**
 * Workflow Engine tests (npm run test:workflows).
 *
 * Runs the real engine — definitions, validation, run plan freezing, the
 * drive loop, branching, bounded loops, resume, cancellation, tool
 * capability enforcement, approval waiting — against a fresh better-sqlite3
 * database migrated from migrations/. AI execution uses the deterministic
 * echo adapter; tools run through the real executeTool boundary. No
 * network, no cloudflare:workers, no provider SDKs.
 */

import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { z } from 'zod'
import { parseAgentVersionConfig } from '../src/server/agents/config.ts'
import { ensureBuiltinAgents } from '../src/server/agents/registry.ts'
import { createEchoAdapter } from '../src/server/ai/providers/echo.ts'
import type { AIAdapterRawResponse, AIProviderAdapter } from '../src/server/ai/types.ts'
import { addAgentVersion, setAgentStatus } from '../src/server/db/agent.ts'
import { listRecentEvents } from '../src/server/db/event.ts'
import { queryAll, type SqlDatabase } from '../src/server/db/sql.ts'
import {
  getWorkflowById,
  getWorkflowRunById,
  getWorkflowVersion,
  listWorkflowStepRuns,
  listWorkflowVersions,
} from '../src/server/db/workflow.ts'
import { TOOL_ADAPTERS } from '../src/server/tools/adapters/index.ts'
import {
  listToolDefinitions,
  type ToolAdapter,
  type ToolDefinition,
} from '../src/server/tools/index.ts'
import {
  cancelWorkflowRun,
  createWorkflowWithVersion,
  driveRun,
  resumeWorkflowRun,
  saveWorkflowVersion,
  startWorkflowRun,
  validateWorkflowDefinition,
  type WorkflowEngineDeps,
} from '../src/server/workflows/index.ts'

const getRun = getWorkflowRunById

const ROOT = new URL('..', import.meta.url).pathname
const TMP = join(ROOT, 'node_modules/.cache/test-workflows.sqlite')

const WS_A = crypto.randomUUID()
const WS_B = crypto.randomUUID()
const BRAND_A = crypto.randomUUID()
const BRAND_B = crypto.randomUUID()
const PRODUCT_A = crypto.randomUUID()
const PRODUCT_B = crypto.randomUUID()
const PRODUCT_ARCHIVED = crypto.randomUUID()
const NOW = '2026-08-19T00:00:00.000Z'

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
  rmSync(TMP, { force: true })
  mkdirSync(join(ROOT, 'node_modules/.cache'), { recursive: true })
  const sqlite = new Database(TMP)
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
  ins(
    `INSERT INTO product (id, brand_id, niche_id, name, description, url, status, created_at, updated_at)
     VALUES (?, ?, NULL, 'Product B', NULL, NULL, 'active', ?, ?)`,
    PRODUCT_B,
    BRAND_B,
    NOW,
    NOW,
  )
  ins(
    `INSERT INTO product (id, brand_id, niche_id, name, description, url, status, created_at, updated_at)
     VALUES (?, ?, NULL, 'Old Product', NULL, NULL, 'archived', ?, ?)`,
    PRODUCT_ARCHIVED,
    BRAND_A,
    NOW,
    NOW,
  )
  return shim(sqlite)
}

/** Deterministic AI: the echo adapter, wired as the provider for all strategies. */
function echoDeps(): WorkflowEngineDeps {
  const echo = createEchoAdapter()
  return {
    ai: { adapters: new Map([[echo.key, echo]]), modelOverrides: { provider: 'echo' } },
  }
}

/** An AI adapter whose responses come from a script (per call index). */
function scriptedAdapter(script: ((call: number) => AIAdapterRawResponse | Error)[]): {
  deps: WorkflowEngineDeps
  calls: { count: number }
} {
  const calls = { count: 0 }
  const adapter: AIProviderAdapter = {
    key: 'echo',
    async execute() {
      const entry = script[Math.min(calls.count, script.length - 1)]
      calls.count += 1
      if (entry instanceof Error) throw entry
      return entry(calls.count - 1)
    },
  }
  return {
    deps: {
      ai: { adapters: new Map([[adapter.key, adapter]]), modelOverrides: { provider: 'echo' } },
    },
    calls,
  }
}

async function agentIds(db: SqlDatabase) {
  const handles = await ensureBuiltinAgents(db, WS_A)
  const researcher = handles.get('researcher')
  const strategist = handles.get('strategist')
  const critic = handles.get('critic')
  const analytics = handles.get('analytics')
  assert.ok(researcher && strategist && critic && analytics)
  return { researcher, strategist, critic, analytics }
}

function twoAgentDefinition(researcherId: string, criticId: string) {
  return {
    entryStepId: 'draft',
    inputs: [
      { key: 'product_id', label: 'Product', kind: 'product', required: true },
      { key: 'focus', label: 'Focus', kind: 'text', required: false },
    ],
    steps: [
      {
        id: 'draft',
        type: 'agent',
        agent: { agentId: researcherId, versionPolicy: 'current_at_run' },
        task: 'Analyze the available context.',
        inputs: [{ key: 'focus', value: { source: 'workflow_input', path: 'focus' } }],
        next: 'review',
      },
      {
        id: 'review',
        type: 'agent',
        agent: { agentId: criticId, versionPolicy: 'current_at_run' },
        task: 'Critique the analysis.',
        inputs: [
          { key: 'analysis', value: { source: 'step_output', stepId: 'draft', path: 'content' } },
        ],
        next: null,
      },
    ],
    output: { stepId: 'review', path: 'content' },
  }
}

/* ================= definition & versioning ================= */

test('create workflow + first version; editing creates v2 and never mutates v1', async () => {
  const db = freshDb()
  const { researcher, critic } = await agentIds(db)

  const created = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Analyze Product',
    description: 'Researcher drafts, critic reviews.',
    definition: twoAgentDefinition(researcher.agent.id, critic.agent.id),
    changeNote: 'First version',
  })
  assert.ok(created.ok)
  const workflow = await getWorkflowById(db, created.value.workflowId)
  assert.ok(workflow)
  assert.equal(workflow.status, 'active')
  const v1 = await getWorkflowVersion(db, created.value.versionId)
  assert.ok(v1)
  assert.equal(v1.version, 1)

  const edited = await saveWorkflowVersion(db, {
    workspaceId: WS_A,
    workflowId: workflow.id,
    definition: {
      ...twoAgentDefinition(researcher.agent.id, critic.agent.id),
      steps: [
        ...twoAgentDefinition(researcher.agent.id, critic.agent.id).steps,
        { id: 'done', type: 'end' },
      ].map((s) => (s.id === 'review' ? { ...s, next: 'done' } : s)),
    },
    changeNote: 'Added explicit end',
  })
  assert.ok(edited.ok)
  assert.equal(edited.value.version, 2)

  const v1After = await getWorkflowVersion(db, v1.id)
  assert.equal(v1After?.definitionJson, v1.definitionJson, 'v1 must be immutable')
  const workflowAfter = await getWorkflowById(db, workflow.id)
  assert.equal(workflowAfter?.currentVersionId, edited.value.versionId)
  const versions = await listWorkflowVersions(db, workflow.id)
  assert.equal(versions.length, 2)
})

test('validation: duplicate step ids, missing entry, bad targets, bad operator', async () => {
  const db = freshDb()
  const { researcher } = await agentIds(db)
  const base = twoAgentDefinition(researcher.agent.id, researcher.agent.id)

  const dup = await validateWorkflowDefinition(db, WS_A, {
    ...base,
    steps: [base.steps[0], base.steps[0]],
  })
  assert.ok(!dup.ok)
  assert.ok(dup.errors.some((e) => e.includes('Duplicate step id')))

  const noEntry = await validateWorkflowDefinition(db, WS_A, { ...base, entryStepId: 'nope' })
  assert.ok(!noEntry.ok)
  assert.ok(noEntry.errors.some((e) => e.includes('Entry step')))

  const badTarget = await validateWorkflowDefinition(db, WS_A, {
    ...base,
    steps: [{ ...base.steps[0], next: 'ghost' }, base.steps[1]],
  })
  assert.ok(!badTarget.ok)
  assert.ok(badTarget.errors.some((e) => e.includes('unknown step')))

  const badOp = await validateWorkflowDefinition(db, WS_A, {
    entryStepId: 'c',
    steps: [
      {
        id: 'c',
        type: 'condition',
        condition: { left: { source: 'literal', value: 1 }, operator: 'magic', value: 1 },
        branches: { yes: null, no: null },
      },
    ],
  })
  assert.ok(!badOp.ok)
})

test('validation: unknown agent, pinned version mismatch, unknown tool, bad bindings', async () => {
  const db = freshDb()
  const { researcher, critic } = await agentIds(db)

  const badAgent = await validateWorkflowDefinition(db, WS_A, {
    entryStepId: 'a',
    steps: [
      {
        id: 'a',
        type: 'agent',
        agent: { agentId: crypto.randomUUID(), versionPolicy: 'current_at_run' },
        task: 'Do something.',
        inputs: [],
        next: null,
      },
    ],
  })
  assert.ok(!badAgent.ok)
  assert.ok(badAgent.errors.some((e) => e.includes('unknown agent')))

  const { getCurrentAgentVersion } = await import('../src/server/db/agent.ts')
  const criticCurrent = await getCurrentAgentVersion(db, critic.agent)
  assert.ok(criticCurrent)
  const wrongPin = await validateWorkflowDefinition(db, WS_A, {
    entryStepId: 'a',
    steps: [
      {
        id: 'a',
        type: 'agent',
        agent: {
          agentId: researcher.agent.id,
          versionPolicy: 'pinned',
          agentVersionId: criticCurrent.id, // belongs to Critic, not Researcher
        },
        task: 'Do something.',
        inputs: [],
        next: null,
      },
    ],
  })
  assert.ok(!wrongPin.ok)
  assert.ok(wrongPin.errors.some((e) => e.includes('pins an agent version')))

  const badTool = await validateWorkflowDefinition(db, WS_A, {
    entryStepId: 't',
    steps: [
      {
        id: 't',
        type: 'tool',
        toolKey: 'does.not_exist',
        requestedBy: { agentId: researcher.agent.id, versionPolicy: 'current_at_run' },
        inputs: [],
        next: null,
      },
    ],
  })
  assert.ok(!badTool.ok)
  assert.ok(badTool.errors.some((e) => e.includes('unknown tool')))

  const badBinding = await validateWorkflowDefinition(db, WS_A, {
    entryStepId: 'a',
    steps: [
      {
        id: 'a',
        type: 'agent',
        agent: { agentId: researcher.agent.id, versionPolicy: 'current_at_run' },
        task: 'Do something.',
        inputs: [{ key: 'x', value: { source: 'workflow_input', path: 'undeclared' } }],
        next: null,
      },
    ],
  })
  assert.ok(!badBinding.ok)
  assert.ok(badBinding.errors.some((e) => e.includes('not declared')))

  const badStepRef = await validateWorkflowDefinition(db, WS_A, {
    entryStepId: 'a',
    steps: [
      {
        id: 'a',
        type: 'agent',
        agent: { agentId: researcher.agent.id, versionPolicy: 'current_at_run' },
        task: 'Do something.',
        inputs: [{ key: 'x', value: { source: 'step_output', stepId: 'ghost', path: 'content' } }],
        next: null,
      },
    ],
  })
  assert.ok(!badStepRef.ok)
})

test('validation: bounded cycles accepted, unbounded rejected, terminating path required', async () => {
  const db = freshDb()
  const { researcher, critic } = await agentIds(db)

  // Bounded: create → review → (no) → create. Default visit cap bounds it.
  const bounded = await validateWorkflowDefinition(db, WS_A, {
    entryStepId: 'create',
    steps: [
      {
        id: 'create',
        type: 'agent',
        agent: { agentId: researcher.agent.id, versionPolicy: 'current_at_run' },
        task: 'Draft.',
        inputs: [],
        next: 'review',
        maxVisits: 3,
      },
      {
        id: 'review',
        type: 'agent',
        agent: { agentId: critic.agent.id, versionPolicy: 'current_at_run' },
        task: 'Review.',
        inputs: [],
        next: 'decide',
      },
      {
        id: 'decide',
        type: 'condition',
        condition: {
          left: { source: 'literal', value: 90 },
          operator: 'greater_or_equal',
          value: 85,
        },
        branches: { yes: null, no: 'create' },
      },
    ],
  })
  assert.ok(bounded.ok, bounded.errors.join('; '))

  // Unbounded: same cycle but a step explicitly requests no visit cap.
  const unbounded = await validateWorkflowDefinition(db, WS_A, {
    entryStepId: 'create',
    steps: [
      {
        id: 'create',
        type: 'agent',
        agent: { agentId: researcher.agent.id, versionPolicy: 'current_at_run' },
        task: 'Draft.',
        inputs: [],
        next: 'decide',
        maxVisits: null,
      },
      {
        id: 'decide',
        type: 'condition',
        condition: { left: { source: 'literal', value: false }, operator: 'equals', value: true },
        branches: { yes: null, no: 'create' },
      },
    ],
  })
  assert.ok(!unbounded.ok)
  assert.ok(unbounded.errors.some((e) => e.includes('loop')))

  // No terminating path: pure cycle with no exit.
  const noExit = await validateWorkflowDefinition(db, WS_A, {
    entryStepId: 'a',
    steps: [
      {
        id: 'a',
        type: 'agent',
        agent: { agentId: researcher.agent.id, versionPolicy: 'current_at_run' },
        task: 'Loop.',
        inputs: [],
        next: 'a',
        maxVisits: 2,
      },
    ],
  })
  assert.ok(!noExit.ok)
  assert.ok(noExit.errors.some((e) => e.includes('no path')))
})

test('validation: definition size and step count limits', async () => {
  const db = freshDb()
  const { researcher } = await agentIds(db)
  const steps = Array.from({ length: 26 }, (_, i) => ({
    id: `s${i}`,
    type: 'agent',
    agent: { agentId: researcher.agent.id, versionPolicy: 'current_at_run' },
    task: 'Work.',
    inputs: [],
    next: i === 25 ? null : `s${i + 1}`,
  }))
  const result = await validateWorkflowDefinition(db, WS_A, { entryStepId: 's0', steps })
  assert.ok(!result.ok)
})

/* ================= runs ================= */

test('run: completes end-to-end, freezes versions, passes outputs, no chat pollution', async () => {
  const db = freshDb()
  const { researcher, critic } = await agentIds(db)

  const created = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Analyze Product',
    definition: twoAgentDefinition(researcher.agent.id, critic.agent.id),
  })
  assert.ok(created.ok)

  const started = await startWorkflowRun({
    db,
    workspaceId: WS_A,
    workflowId: created.value.workflowId,
    inputs: { product_id: PRODUCT_A, focus: 'pricing' },
    deps: echoDeps(),
  })
  assert.ok(started.ok)

  const run = await getRun(db, started.runId)
  assert.ok(run)
  assert.equal(run.status, 'succeeded')
  const workflow = await getWorkflowById(db, created.value.workflowId)
  assert.equal(run.workflowVersionId, workflow?.currentVersionId, 'run captures the version')

  const steps = await listWorkflowStepRuns(db, run.id)
  assert.deepEqual(
    steps.map((s) => [s.stepKey, s.status]),
    [
      ['draft', 'succeeded'],
      ['review', 'succeeded'],
    ],
  )
  // Frozen exact agent versions recorded per step.
  assert.equal(steps[0]?.agentVersionId, researcher.version.id)
  assert.equal(steps[1]?.agentVersionId, critic.version.id)

  // Output passing: Critic received Researcher's content as a bound input.
  const reviewInput = JSON.parse(steps[1]?.inputJson ?? '{}') as Record<string, unknown>
  const draftOutput = JSON.parse(steps[0]?.outputJson ?? '{}') as { content: string }
  assert.equal(reviewInput.analysis, draftOutput.content)
  assert.ok(draftOutput.content.includes('offline dev echo'))

  // Workflow input binding arrived at step 1.
  const draftInput = JSON.parse(steps[0]?.inputJson ?? '{}') as Record<string, unknown>
  assert.equal(draftInput.focus, 'pricing')

  // Run output mapped from the review step.
  assert.ok(run.outputJson)
  const output = JSON.parse(run.outputJson)
  assert.ok(typeof output === 'string' && output.includes('offline dev echo'))

  // Context snapshot exists and is clean.
  assert.ok(run.contextJson)
  const snapshot = run.contextJson.toLowerCase()
  assert.ok(
    !snapshot.includes('secret') && !snapshot.includes('bearer') && !snapshot.includes('sk-'),
  )

  // No chat messages were created anywhere.
  const messages = await queryAll(db, `SELECT id FROM message`, [])
  assert.equal(messages.length, 0)

  // Plan froze the resolved versions.
  const plan = JSON.parse(run.planJson ?? '{}') as {
    agents: Record<string, { agentVersionId: string }>
  }
  assert.equal(plan.agents.draft?.agentVersionId, researcher.version.id)
})

test('run: current_at_run version stays frozen across a mid-run version bump', async () => {
  const db = freshDb()
  const { researcher, critic } = await agentIds(db)
  const created = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Freeze Test',
    definition: twoAgentDefinition(researcher.agent.id, critic.agent.id),
  })
  assert.ok(created.ok)

  // Start WITHOUT driving: the plan freezes now.
  const started = await startWorkflowRun({
    db,
    workspaceId: WS_A,
    workflowId: created.value.workflowId,
    inputs: { product_id: PRODUCT_A },
    deps: echoDeps(),
    drive: false,
  })
  assert.ok(started.ok)

  // Critic ships a new version AFTER the run started.
  const newConfig = parseAgentVersionConfig(critic.version.configJson)
  assert.ok(newConfig)
  await addAgentVersion(db, critic.agent.id, JSON.stringify({ ...newConfig, instructions: 'v2' }))

  await driveRun(db, started.runId, echoDeps())
  const steps = await listWorkflowStepRuns(db, started.runId)
  const reviewStep = steps.find((s) => s.stepKey === 'review')
  assert.equal(
    reviewStep?.agentVersionId,
    critic.version.id,
    'the run keeps the version it resolved at start',
  )
})

test('run: pinned agent version policy', async () => {
  const db = freshDb()
  const { researcher } = await agentIds(db)
  const pinnedVersion = researcher.version.id

  // Bump researcher so "current" differs from the pinned one.
  const config = parseAgentVersionConfig(researcher.version.configJson)
  assert.ok(config)
  await addAgentVersion(db, researcher.agent.id, JSON.stringify({ ...config, instructions: 'v2' }))

  const created = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Pinned',
    definition: {
      entryStepId: 'a',
      steps: [
        {
          id: 'a',
          type: 'agent',
          agent: {
            agentId: researcher.agent.id,
            versionPolicy: 'pinned',
            agentVersionId: pinnedVersion,
          },
          task: 'Work.',
          inputs: [],
          next: null,
        },
      ],
    },
  })
  assert.ok(created.ok)
  const started = await startWorkflowRun({
    db,
    workspaceId: WS_A,
    workflowId: created.value.workflowId,
    inputs: {},
    deps: echoDeps(),
  })
  assert.ok(started.ok)
  const steps = await listWorkflowStepRuns(db, started.runId)
  assert.equal(steps[0]?.agentVersionId, pinnedVersion)
})

test('run: scope validation through the Context Engine', async () => {
  const db = freshDb()
  const { researcher, critic } = await agentIds(db)
  const created = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Scoped',
    definition: twoAgentDefinition(researcher.agent.id, critic.agent.id),
  })
  assert.ok(created.ok)

  // Cross-workspace product → rejected before anything starts.
  const cross = await startWorkflowRun({
    db,
    workspaceId: WS_A,
    workflowId: created.value.workflowId,
    inputs: { product_id: PRODUCT_B },
    deps: echoDeps(),
  })
  assert.ok(!cross.ok)

  // Archived product → rejected.
  const archived = await startWorkflowRun({
    db,
    workspaceId: WS_A,
    workflowId: created.value.workflowId,
    inputs: { product_id: PRODUCT_ARCHIVED },
    deps: echoDeps(),
  })
  assert.ok(!archived.ok)
  assert.match(archived.message, /archived/i)

  // Missing required input → rejected.
  const missing = await startWorkflowRun({
    db,
    workspaceId: WS_A,
    workflowId: created.value.workflowId,
    inputs: {},
    deps: echoDeps(),
  })
  assert.ok(!missing.ok)
  assert.match(missing.message, /required/i)
})

test('run: disabled agent is rejected at run start', async () => {
  const db = freshDb()
  const { researcher, critic } = await agentIds(db)
  const created = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Will Break',
    definition: twoAgentDefinition(researcher.agent.id, critic.agent.id),
  })
  assert.ok(created.ok)

  await setAgentStatus(db, critic.agent.id, 'disabled')
  const started = await startWorkflowRun({
    db,
    workspaceId: WS_A,
    workflowId: created.value.workflowId,
    inputs: { product_id: PRODUCT_A },
    deps: echoDeps(),
  })
  assert.ok(!started.ok)
  assert.match(started.message, /disabled/i)
})

test('run: tool step goes through executeTool with capability enforcement', async () => {
  const db = freshDb()
  const { researcher, critic } = await agentIds(db)

  // Researcher may read workspace data (read_context).
  const allowed = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'List Products',
    definition: {
      entryStepId: 'list',
      inputs: [],
      steps: [
        {
          id: 'list',
          type: 'tool',
          toolKey: 'workspace.list_products',
          requestedBy: { agentId: researcher.agent.id, versionPolicy: 'current_at_run' },
          inputs: [],
          next: null,
        },
      ],
    },
  })
  assert.ok(allowed.ok)
  const started = await startWorkflowRun({
    db,
    workspaceId: WS_A,
    workflowId: allowed.value.workflowId,
    inputs: {},
    deps: echoDeps(),
  })
  assert.ok(started.ok)
  const run = await getRun(db, started.runId)
  assert.equal(run?.status, 'succeeded')
  const steps = await listWorkflowStepRuns(db, started.runId)
  assert.ok(steps[0]?.toolExecutionId, 'tool execution id is recorded')
  const output = JSON.parse(steps[0]?.outputJson ?? '{}') as { data: { products: unknown[] } }
  assert.ok(Array.isArray(output.data.products))

  // Critic lacks read_research → capability_denied, the workflow is no super-user.
  const denied = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Denied',
    definition: {
      entryStepId: 'read',
      inputs: [],
      steps: [
        {
          id: 'read',
          type: 'tool',
          toolKey: 'research.list_relevant',
          requestedBy: { agentId: critic.agent.id, versionPolicy: 'current_at_run' },
          inputs: [],
          next: null,
        },
      ],
    },
  })
  assert.ok(denied.ok)
  const deniedRun = await startWorkflowRun({
    db,
    workspaceId: WS_A,
    workflowId: denied.value.workflowId,
    inputs: {},
    deps: echoDeps(),
  })
  assert.ok(deniedRun.ok)
  const deniedRunRow = await getRun(db, deniedRun.runId)
  assert.equal(deniedRunRow?.status, 'failed')
  assert.match(deniedRunRow?.error ?? '', /not allowed/i)

  // Unavailable tool → controlled failure, never faked. Analytics HAS the
  // read_analytics capability, so availability (not capability) is what fails.
  const { analytics } = await agentIds(db)
  const unavailable = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Unavailable Tool',
    definition: {
      entryStepId: 'metrics',
      inputs: [],
      steps: [
        {
          id: 'metrics',
          type: 'tool',
          toolKey: 'analytics.read',
          requestedBy: { agentId: analytics.agent.id, versionPolicy: 'current_at_run' },
          inputs: [],
          next: null,
        },
      ],
    },
  })
  assert.ok(unavailable.ok)
  const unRun = await startWorkflowRun({
    db,
    workspaceId: WS_A,
    workflowId: unavailable.value.workflowId,
    inputs: {},
    deps: echoDeps(),
  })
  assert.ok(unRun.ok)
  const unRow = await getRun(db, unRun.runId)
  assert.equal(unRow?.status, 'failed')
  assert.match(unRow?.error ?? '', /setup|available/i)
})

test('run: approval_required pauses the run in a waiting state', async () => {
  const db = freshDb()
  const { researcher } = await agentIds(db)

  const gatedTool: ToolDefinition = {
    key: 'test.gated' as never,
    name: 'Gated Tool',
    description: 'Requires approval.',
    category: 'system',
    inputSchema: z.object({}),
    outputSchema: z.object({ ok: z.boolean() }),
    requiredCapability: 'read_context',
    risk: ['write'],
    executionMode: 'sync',
    status: 'available',
    origin: 'internal',
    version: 1,
    cost: 'none',
    approval: 'required',
  }
  const gatedAdapter: ToolAdapter = {
    key: 'test.gated' as never,
    async run() {
      return { ok: true }
    },
  }
  const deps: WorkflowEngineDeps = {
    ...echoDeps(),
    tools: {
      definitions: [...listToolDefinitions(), gatedTool],
      adapters: new Map([...TOOL_ADAPTERS, ['test.gated' as never, gatedAdapter]]),
    },
  }

  const validation = await validateWorkflowDefinition(
    db,
    WS_A,
    {
      entryStepId: 'work',
      steps: [
        {
          id: 'work',
          type: 'tool',
          toolKey: 'test.gated',
          requestedBy: { agentId: researcher.agent.id, versionPolicy: 'current_at_run' },
          inputs: [],
          next: null,
        },
      ],
    },
    { toolDefinitions: deps.tools?.definitions },
  )
  assert.ok(validation.ok)

  const created = await createWorkflowWithVersion(
    db,
    {
      workspaceId: WS_A,
      name: 'Gated',
      definition: validation.definition,
    },
    { toolDefinitions: deps.tools?.definitions },
  )
  assert.ok(created.ok)

  const started = await startWorkflowRun({
    db,
    workspaceId: WS_A,
    workflowId: created.value.workflowId,
    inputs: {},
    deps,
  })
  assert.ok(started.ok)
  const run = await getRun(db, started.runId)
  assert.equal(run?.status, 'waiting', 'approval_required pauses, not fails')

  const steps = await listWorkflowStepRuns(db, started.runId)
  assert.equal(steps[0]?.status, 'waiting')
  assert.ok(steps[0]?.toolExecutionId)

  // Resuming without an approval grant waits again; history stays intact.
  const resumed = await resumeWorkflowRun(db, started.runId, deps)
  assert.ok(resumed.ok)
  const runAfter = await getRun(db, started.runId)
  assert.equal(runAfter?.status, 'waiting')
  const stepsAfter = await listWorkflowStepRuns(db, started.runId)
  assert.equal(stepsAfter.length, 2, 'the resume is a new attempt, not a rerun of history')
})

test('run: condition branching — both branches, decision persisted', async () => {
  const db = freshDb()
  const { researcher, critic } = await agentIds(db)

  const def = (score: number) => ({
    entryStepId: 'score',
    steps: [
      {
        id: 'score',
        type: 'agent',
        agent: { agentId: critic.agent.id, versionPolicy: 'current_at_run' },
        task: 'Score the work.',
        inputs: [{ key: 'score', value: { source: 'literal', value: score } }],
        next: 'decide',
      },
      {
        id: 'decide',
        type: 'condition',
        condition: {
          left: { source: 'step_output', stepId: 'score', path: 'kind' },
          operator: 'equals',
          value: 'agent',
        },
        branches: { yes: 'ship', no: 'revise' },
      },
      {
        id: 'ship',
        type: 'agent',
        agent: { agentId: researcher.agent.id, versionPolicy: 'current_at_run' },
        task: 'Finalize.',
        inputs: [],
        next: null,
      },
      {
        id: 'revise',
        type: 'agent',
        agent: { agentId: critic.agent.id, versionPolicy: 'current_at_run' },
        task: 'Ask for revision.',
        inputs: [],
        next: null,
      },
    ],
  })

  // YES branch
  const yes = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Branch Yes',
    definition: def(90),
  })
  assert.ok(yes.ok)
  const yesRun = await startWorkflowRun({
    db,
    workspaceId: WS_A,
    workflowId: yes.value.workflowId,
    inputs: {},
    deps: echoDeps(),
  })
  assert.ok(yesRun.ok)
  const yesSteps = await listWorkflowStepRuns(db, yesRun.runId)
  const decideYes = yesSteps.find((s) => s.stepKey === 'decide')
  assert.equal(JSON.parse(decideYes?.decisionJson ?? '{}').branch, 'yes')
  assert.equal(JSON.parse(decideYes?.decisionJson ?? '{}').target, 'ship')
  assert.ok(yesSteps.some((s) => s.stepKey === 'ship' && s.status === 'succeeded'))
  assert.ok(!yesSteps.some((s) => s.stepKey === 'revise'))

  // NO branch: condition on a missing path.
  const no = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Branch No',
    definition: {
      entryStepId: 'decide',
      inputs: [{ key: 'maybe', label: 'Maybe', kind: 'text', required: false }],
      steps: [
        {
          id: 'decide',
          type: 'condition',
          condition: { left: { source: 'workflow_input', path: 'maybe' }, operator: 'exists' },
          branches: { yes: 'a', no: 'b' },
        },
        {
          id: 'a',
          type: 'agent',
          agent: { agentId: researcher.agent.id, versionPolicy: 'current_at_run' },
          task: 'A.',
          inputs: [],
          next: null,
        },
        {
          id: 'b',
          type: 'agent',
          agent: { agentId: critic.agent.id, versionPolicy: 'current_at_run' },
          task: 'B.',
          inputs: [],
          next: null,
        },
      ],
    },
  })
  assert.ok(no.ok)
  const noRun = await startWorkflowRun({
    db,
    workspaceId: WS_A,
    workflowId: no.value.workflowId,
    inputs: {},
    deps: echoDeps(),
  })
  assert.ok(noRun.ok)
  const noSteps = await listWorkflowStepRuns(db, noRun.runId)
  const decideNo = noSteps.find((s) => s.stepKey === 'decide')
  assert.equal(JSON.parse(decideNo?.decisionJson ?? '{}').branch, 'no')
  assert.ok(noSteps.some((s) => s.stepKey === 'b'))
  assert.ok(!noSteps.some((s) => s.stepKey === 'a'))
})

test('run: bounded loop enforces the visit limit', async () => {
  const db = freshDb()
  const { researcher } = await agentIds(db)

  const created = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Loop',
    definition: {
      entryStepId: 'draft',
      steps: [
        {
          id: 'draft',
          type: 'agent',
          agent: { agentId: researcher.agent.id, versionPolicy: 'current_at_run' },
          task: 'Draft.',
          inputs: [],
          next: 'decide',
          maxVisits: 3,
        },
        {
          id: 'decide',
          type: 'condition',
          // Always false → loops back to draft.
          condition: {
            left: { source: 'literal', value: 1 },
            operator: 'greater_than',
            value: 100,
          },
          branches: { yes: null, no: 'draft' },
        },
      ],
    },
  })
  assert.ok(created.ok)

  const started = await startWorkflowRun({
    db,
    workspaceId: WS_A,
    workflowId: created.value.workflowId,
    inputs: {},
    deps: echoDeps(),
  })
  assert.ok(started.ok)
  const run = await getRun(db, started.runId)
  assert.equal(run?.status, 'failed')
  assert.match(run?.error ?? '', /visit limit/i)

  const steps = await listWorkflowStepRuns(db, started.runId)
  const drafts = steps.filter((s) => s.stepKey === 'draft')
  assert.equal(drafts.length, 3, 'draft ran exactly maxVisits times')
})

test('run: global step execution limit is enforced', async () => {
  const db = freshDb()
  const { researcher } = await agentIds(db)

  const created = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Tight Limit',
    definition: {
      entryStepId: 'a',
      limits: { maxStepExecutions: 2 },
      steps: [
        {
          id: 'a',
          type: 'agent',
          agent: { agentId: researcher.agent.id, versionPolicy: 'current_at_run' },
          task: 'Loop.',
          inputs: [],
          next: 'b',
        },
        {
          id: 'b',
          type: 'agent',
          agent: { agentId: researcher.agent.id, versionPolicy: 'current_at_run' },
          task: 'Loop back.',
          inputs: [],
          next: 'a',
        },
        { id: 'exit', type: 'end' },
      ],
    },
  })
  // Note: no exit edge — the workflow has no terminating path, so creation
  // must fail validation. Add the exit edge and keep the tight limit.
  assert.ok(!created.ok)

  const created2 = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Tight Limit 2',
    definition: {
      entryStepId: 'a',
      limits: { maxStepExecutions: 3 },
      steps: [
        {
          id: 'a',
          type: 'agent',
          agent: { agentId: researcher.agent.id, versionPolicy: 'current_at_run' },
          task: 'Work.',
          inputs: [],
          next: 'decide',
        },
        {
          id: 'decide',
          type: 'condition',
          condition: {
            left: { source: 'literal', value: 0 },
            operator: 'greater_than',
            value: 100,
          },
          branches: { yes: null, no: 'a' },
        },
      ],
    },
  })
  assert.ok(created2.ok)
  const started = await startWorkflowRun({
    db,
    workspaceId: WS_A,
    workflowId: created2.value.workflowId,
    inputs: {},
    deps: echoDeps(),
  })
  assert.ok(started.ok)
  const run = await getRun(db, started.runId)
  assert.equal(run?.status, 'failed')
  const steps = await listWorkflowStepRuns(db, started.runId)
  assert.ok(steps.length <= 3, 'the global step cap held')
})

test('run: retryable agent failure retries bounded; non-retryable does not', async () => {
  const db = freshDb()
  const { researcher } = await agentIds(db)

  const def = (retry?: { maxAttempts: number }) => ({
    entryStepId: 'a',
    steps: [
      {
        id: 'a',
        type: 'agent',
        agent: { agentId: researcher.agent.id, versionPolicy: 'current_at_run' },
        task: 'Work.',
        inputs: [],
        next: null,
        ...(retry ? { retry } : {}),
      },
    ],
  })

  // Retryable (rate_limited) with maxAttempts 2 → exactly 2 attempts.
  const rateLimited = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Retry',
    definition: def({ maxAttempts: 2 }),
  })
  assert.ok(rateLimited.ok)
  const { AIAdapterError } = await import('../src/server/ai/types.ts')
  const failing = scriptedAdapter([
    () => {
      throw new AIAdapterError('rate_limited', 'slow down', true)
    },
    () => {
      throw new AIAdapterError('rate_limited', 'slow down', true)
    },
    () => {
      throw new AIAdapterError('rate_limited', 'slow down', true)
    },
    () => {
      throw new AIAdapterError('rate_limited', 'slow down', true)
    },
  ])
  const run1 = await startWorkflowRun({
    db,
    workspaceId: WS_A,
    workflowId: rateLimited.value.workflowId,
    inputs: {},
    deps: failing.deps,
  })
  assert.ok(run1.ok)
  const row1 = await getRun(db, run1.runId)
  assert.equal(row1?.status, 'failed')
  const steps1 = await listWorkflowStepRuns(db, run1.runId)
  assert.equal(steps1.length, 2, 'one retry, then stop')

  // Non-retryable (malformed_response) → exactly 1 attempt even with retry policy.
  const fatal = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'No Retry',
    definition: def({ maxAttempts: 3 }),
  })
  assert.ok(fatal.ok)
  const fatalAdapter = scriptedAdapter([
    () => {
      throw new AIAdapterError('malformed_response', 'bad', false)
    },
  ])
  const run2 = await startWorkflowRun({
    db,
    workspaceId: WS_A,
    workflowId: fatal.value.workflowId,
    inputs: {},
    deps: fatalAdapter.deps,
  })
  assert.ok(run2.ok)
  const steps2 = await listWorkflowStepRuns(db, run2.runId)
  assert.equal(steps2.length, 1, 'non-retryable failures never retry')
})

test('run: resume after interruption skips completed steps', async () => {
  const db = freshDb()
  const { researcher, critic } = await agentIds(db)

  const created = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Resume',
    definition: twoAgentDefinition(researcher.agent.id, critic.agent.id),
  })
  assert.ok(created.ok)

  // Start without driving, then fake an interruption: step 1 left 'running'.
  const started = await startWorkflowRun({
    db,
    workspaceId: WS_A,
    workflowId: created.value.workflowId,
    inputs: { product_id: PRODUCT_A },
    deps: echoDeps(),
    drive: false,
  })
  assert.ok(started.ok)

  const { createWorkflowStepRun } = await import('../src/server/db/workflow.ts')
  await createWorkflowStepRun(db, {
    workflowRunId: started.runId,
    stepKey: 'draft',
    stepType: 'agent',
    attempt: 1,
    agentVersionId: researcher.version.id,
  })

  await resumeWorkflowRun(db, started.runId, echoDeps())
  const run = await getRun(db, started.runId)
  assert.equal(run?.status, 'succeeded')

  const steps = await listWorkflowStepRuns(db, started.runId)
  const drafts = steps.filter((s) => s.stepKey === 'draft')
  assert.equal(drafts.length, 2)
  assert.equal(drafts[0]?.status, 'failed')
  assert.match(drafts[0]?.error ?? '', /interrupted/i)
  assert.equal(drafts[1]?.status, 'succeeded')
  assert.equal(drafts[1]?.attempt, 2)
})

test('run: cancellation prevents later steps and keeps history', async () => {
  const db = freshDb()
  const { researcher, critic } = await agentIds(db)

  const created = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Cancel',
    definition: twoAgentDefinition(researcher.agent.id, critic.agent.id),
  })
  assert.ok(created.ok)

  const started = await startWorkflowRun({
    db,
    workspaceId: WS_A,
    workflowId: created.value.workflowId,
    inputs: { product_id: PRODUCT_A },
    deps: echoDeps(),
    drive: false,
  })
  assert.ok(started.ok)

  const cancelled = await cancelWorkflowRun(db, started.runId)
  assert.ok(cancelled.ok)
  const run = await getRun(db, started.runId)
  assert.equal(run?.status, 'cancelled')

  // A cancelled run cannot be resumed/driven further.
  const resumed = await resumeWorkflowRun(db, started.runId, echoDeps())
  assert.ok(!resumed.ok)
  const steps = await listWorkflowStepRuns(db, started.runId)
  assert.equal(steps.length, 0)

  const events = await listRecentEvents(db, WS_A, 'workflow.', 20)
  assert.ok(events.some((e) => e.event_type === 'workflow.run_cancelled'))
})

test('events: lifecycle events are emitted and carry no secrets', async () => {
  const db = freshDb()
  const { researcher, critic } = await agentIds(db)
  const created = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Events',
    definition: twoAgentDefinition(researcher.agent.id, critic.agent.id),
  })
  assert.ok(created.ok)
  const started = await startWorkflowRun({
    db,
    workspaceId: WS_A,
    workflowId: created.value.workflowId,
    inputs: { product_id: PRODUCT_A },
    deps: echoDeps(),
  })
  assert.ok(started.ok)

  const events = await listRecentEvents(db, WS_A, 'workflow.', 50)
  const types = events.map((e) => e.event_type)
  assert.ok(types.includes('workflow.run_started'))
  assert.ok(types.includes('workflow.step_started'))
  assert.ok(types.includes('workflow.step_completed'))
  assert.ok(types.includes('workflow.run_completed'))
  for (const event of events) {
    const payload = (event.payload ?? '').toLowerCase()
    assert.ok(!payload.includes('bearer') && !payload.includes('sk-'), 'no secrets in events')
  }
})

test('draft workflows cannot run; fallback onFailure routes correctly', async () => {
  const db = freshDb()
  const { researcher, critic } = await agentIds(db)

  // Draft (not activated) cannot run.
  const draft = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Draft',
    definition: twoAgentDefinition(researcher.agent.id, critic.agent.id),
    activate: false,
  })
  assert.ok(draft.ok)
  const draftRun = await startWorkflowRun({
    db,
    workspaceId: WS_A,
    workflowId: draft.value.workflowId,
    inputs: { product_id: PRODUCT_A },
    deps: echoDeps(),
  })
  assert.ok(!draftRun.ok)
  assert.match(draftRun.message, /draft/i)

  // onFailure goto: a failing tool step routes to the fallback step.
  const fallback = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Fallback',
    definition: {
      entryStepId: 'try',
      steps: [
        {
          id: 'try',
          type: 'tool',
          toolKey: 'research.list_relevant',
          requestedBy: { agentId: critic.agent.id, versionPolicy: 'current_at_run' },
          inputs: [],
          next: null,
          onFailure: { action: 'goto', stepId: 'recover' },
        },
        {
          id: 'recover',
          type: 'agent',
          agent: { agentId: researcher.agent.id, versionPolicy: 'current_at_run' },
          task: 'Explain the failure.',
          inputs: [],
          next: null,
        },
      ],
    },
  })
  assert.ok(fallback.ok)
  const run = await startWorkflowRun({
    db,
    workspaceId: WS_A,
    workflowId: fallback.value.workflowId,
    inputs: {},
    deps: echoDeps(),
  })
  assert.ok(run.ok)
  const row = await getRun(db, run.runId)
  assert.equal(row?.status, 'succeeded', 'fallback step let the run complete')
  const steps = await listWorkflowStepRuns(db, run.runId)
  assert.equal(steps.find((s) => s.stepKey === 'try')?.status, 'failed')
  assert.equal(steps.find((s) => s.stepKey === 'recover')?.status, 'succeeded')
})

test('bindings: invalid output path resolves to absent, not an explosion', async () => {
  const db = freshDb()
  const { researcher } = await agentIds(db)

  const created = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Paths',
    definition: {
      entryStepId: 'a',
      steps: [
        {
          id: 'a',
          type: 'agent',
          agent: { agentId: researcher.agent.id, versionPolicy: 'current_at_run' },
          task: 'Work.',
          inputs: [],
          next: 'b',
        },
        {
          id: 'b',
          type: 'agent',
          agent: { agentId: researcher.agent.id, versionPolicy: 'current_at_run' },
          task: 'Work more.',
          inputs: [
            { key: 'nope', value: { source: 'step_output', stepId: 'a', path: 'missing.deep' } },
          ],
          next: null,
        },
      ],
    },
  })
  assert.ok(created.ok)
  const started = await startWorkflowRun({
    db,
    workspaceId: WS_A,
    workflowId: created.value.workflowId,
    inputs: {},
    deps: echoDeps(),
  })
  assert.ok(started.ok)
  const run = await getRun(db, started.runId)
  assert.equal(run?.status, 'succeeded')
  const steps = await listWorkflowStepRuns(db, started.runId)
  const bInput = JSON.parse(steps.find((s) => s.stepKey === 'b')?.inputJson ?? '{}')
  assert.ok(!('nope' in bInput), 'missing path is simply absent')
})

test('step outputs stay serializable and bounded', async () => {
  const db = freshDb()
  const { researcher, critic } = await agentIds(db)
  const created = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'Serializable',
    definition: twoAgentDefinition(researcher.agent.id, critic.agent.id),
  })
  assert.ok(created.ok)
  const started = await startWorkflowRun({
    db,
    workspaceId: WS_A,
    workflowId: created.value.workflowId,
    inputs: { product_id: PRODUCT_A },
    deps: echoDeps(),
  })
  assert.ok(started.ok)
  const steps = await listWorkflowStepRuns(db, started.runId)
  for (const step of steps) {
    if (step.outputJson) {
      const roundTrip = JSON.stringify(JSON.parse(step.outputJson))
      assert.ok(roundTrip.length > 0)
      assert.ok(step.outputJson.length <= 21_000, 'snapshots are size-bounded')
    }
  }
})

test('engine runs write zero chat messages (chat suites cover the chat path)', async () => {
  const db = freshDb()
  const { researcher, critic } = await agentIds(db)
  const created = await createWorkflowWithVersion(db, {
    workspaceId: WS_A,
    name: 'No Chat',
    definition: twoAgentDefinition(researcher.agent.id, critic.agent.id),
  })
  assert.ok(created.ok)
  const started = await startWorkflowRun({
    db,
    workspaceId: WS_A,
    workflowId: created.value.workflowId,
    inputs: { product_id: PRODUCT_A },
    deps: echoDeps(),
  })
  assert.ok(started.ok)
  const run = await getRun(db, started.runId)
  assert.equal(run?.status, 'succeeded')
  const messages = await queryAll(db, `SELECT id FROM message`, [])
  assert.equal(messages.length, 0, 'workflow steps never create chat messages')
})
