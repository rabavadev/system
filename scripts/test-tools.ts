/**
 * Tool Registry tests (npm run test:tools).
 *
 * Runs the real boundary — definitions, registry filtering, executeTool,
 * internal read adapters, Context Engine memory/research reads, and event
 * emission — against a fresh better-sqlite3 database migrated from
 * migrations/. No network, no cloudflare:workers, no provider SDKs.
 */

import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import Database from 'better-sqlite3'

import type { AgentCapability } from '../src/server/agents/config.ts'
import { listRecentEvents } from '../src/server/db/event.ts'
import type { SqlDatabase } from '../src/server/db/sql.ts'
import {
  executeTool,
  getAvailableTools,
  listToolDefinitions,
  TOOL_KEYS,
  type ToolAdapter,
  type ToolCaller,
  type ToolDefinition,
  type ToolKey,
} from '../src/server/tools/index.ts'

const ROOT = new URL('..', import.meta.url).pathname
const TMP = join(ROOT, 'node_modules/.cache/test-tools.sqlite')

const WS_A = crypto.randomUUID()
const WS_B = crypto.randomUUID()
const BRAND_A = crypto.randomUUID()
const BRAND_B = crypto.randomUUID()
const PLATFORM = crypto.randomUUID()
const PRODUCT_A = crypto.randomUUID()
const PRODUCT_ARCHIVED = crypto.randomUUID()
const PRODUCT_B = crypto.randomUUID()
const ACCOUNT_A = crypto.randomUUID()
const ACCOUNT_ARCHIVED = crypto.randomUUID()
const ACCOUNT_B = crypto.randomUUID()
const NOW = '2026-08-19T00:00:00.000Z'
const PAST = '2020-01-01T00:00:00.000Z'

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
    `INSERT INTO platform (id, adapter_key, name, created_at) VALUES (?, 'test', 'Test Platform', ?)`,
    PLATFORM,
    NOW,
  )
  ins(
    `INSERT INTO product (id, brand_id, niche_id, name, description, url, status, created_at, updated_at)
     VALUES (?, ?, NULL, 'Product A', 'Desc', NULL, 'active', ?, ?)`,
    PRODUCT_A,
    BRAND_A,
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
  ins(
    `INSERT INTO product (id, brand_id, niche_id, name, description, url, status, created_at, updated_at)
     VALUES (?, ?, NULL, 'Product B', NULL, NULL, 'active', ?, ?)`,
    PRODUCT_B,
    BRAND_B,
    NOW,
    NOW,
  )
  ins(
    `INSERT INTO account (id, workspace_id, platform_id, handle, display_name, primary_niche_id, status, created_at, updated_at)
     VALUES (?, ?, ?, '@alpha', 'Alpha', NULL, 'active', ?, ?)`,
    ACCOUNT_A,
    WS_A,
    PLATFORM,
    NOW,
    NOW,
  )
  ins(
    `INSERT INTO account (id, workspace_id, platform_id, handle, display_name, primary_niche_id, status, created_at, updated_at)
     VALUES (?, ?, ?, '@old', 'Old', NULL, 'archived', ?, ?)`,
    ACCOUNT_ARCHIVED,
    WS_A,
    PLATFORM,
    NOW,
    NOW,
  )
  ins(
    `INSERT INTO account (id, workspace_id, platform_id, handle, display_name, primary_niche_id, status, created_at, updated_at)
     VALUES (?, ?, ?, '@beta', 'Beta', NULL, 'active', ?, ?)`,
    ACCOUNT_B,
    WS_B,
    PLATFORM,
    NOW,
    NOW,
  )
  ins(
    `INSERT INTO platform_connection (id, account_id, status, secret_ref, scopes, metadata, connected_at, last_synced_at, created_at, updated_at)
     VALUES (?, ?, 'connected', 'WORKER_SECRET_NAME', 'read write', '{"token":"sk-live"}', ?, NULL, ?, ?)`,
    crypto.randomUUID(),
    ACCOUNT_A,
    NOW,
    NOW,
    NOW,
  )

  const memory = (
    id: string,
    memoryClass: string,
    content: string,
    status = 'active',
    expiresAt: string | null = null,
    supersededBy: string | null = null,
  ) =>
    ins(
      `INSERT INTO memory (id, workspace_id, memory_class, content, scope_type, scope_id, status, confidence, source_type, source_id, evidence, superseded_by, created_at, updated_at, last_verified_at, expires_at)
       VALUES (?, ?, ?, ?, 'workspace', NULL, ?, NULL, 'manual', NULL, NULL, ?, ?, ?, NULL, ?)`,
      id,
      WS_A,
      memoryClass,
      content,
      status,
      supersededBy,
      NOW,
      NOW,
      expiresAt,
    )
  memory(crypto.randomUUID(), 'permanent_fact', 'Active fact')
  memory(crypto.randomUUID(), 'proposed_learning', 'Hypothesis row')
  memory(crypto.randomUUID(), 'permanent_fact', 'Archived fact', 'archived')
  memory(crypto.randomUUID(), 'permanent_fact', 'Expired fact', 'active', PAST)
  const replacement = crypto.randomUUID()
  memory(replacement, 'permanent_fact', 'Replacement fact')
  memory(crypto.randomUUID(), 'permanent_fact', 'Superseded fact', 'superseded', null, replacement)

  const research = (id: string, subject: string, status: string, verified: string | null) =>
    ins(
      `INSERT INTO research (id, workspace_id, subject, findings, status, confidence, scope_type, scope_id, created_at, updated_at, last_verified_at, expires_at, deleted_at)
       VALUES (?, ?, ?, 'Findings', ?, NULL, 'workspace', NULL, ?, ?, ?, NULL, NULL)`,
      id,
      WS_A,
      subject,
      status,
      NOW,
      NOW,
      verified,
    )
  research(crypto.randomUUID(), 'Current research', 'completed', NOW)
  research(crypto.randomUUID(), 'Stale research', 'stale', NOW)
  research(crypto.randomUUID(), 'Draft research', 'draft', null)
  research(crypto.randomUUID(), 'Archived research', 'archived', NOW)

  return shim(sqlite)
}

function caller(
  capabilities: AgentCapability[],
  status: ToolCaller['agentStatus'] = 'active',
): ToolCaller {
  return {
    agentId: crypto.randomUUID(),
    agentVersionId: crypto.randomUUID(),
    agentName: 'Test Agent',
    agentStatus: status,
    capabilities,
  }
}

const CHIEF = caller(['read_context', 'read_memory', 'read_research', 'request_workflow'])

test('registry loads built-in tools with stable keys and no provider schema leakage', () => {
  const definitions = listToolDefinitions()
  assert.equal(new Set(definitions.map((d) => d.key)).size, definitions.length)
  assert.deepEqual(
    definitions.map((d) => d.key),
    [...TOOL_KEYS],
  )
  for (const definition of definitions) {
    assert.equal(typeof definition.inputSchema.safeParse, 'function')
    assert.equal(typeof definition.outputSchema.safeParse, 'function')
    assert.ok(!('parameters' in definition))
    assert.ok(!('function' in definition))
  }
})

test('unknown tool is rejected and emits a safe failed event', async () => {
  const db = freshDb()
  const result = await executeTool({
    db,
    workspaceId: WS_A,
    toolKey: 'web.hack',
    args: {},
    caller: CHIEF,
  })
  assert.equal(result.ok, false)
  assert.equal(result.error?.code, 'tool_not_found')
  const events = await listRecentEvents(db, WS_A, 'tool.execution.', 5)
  assert.equal(events.length, 1)
  assert.equal(events[0]?.event_type, 'tool.execution.failed')
  assert.match(events[0]?.payload ?? '', /tool_not_found/)
})

test('disabled tool is rejected before its adapter runs', async () => {
  const db = freshDb()
  const definitions = listToolDefinitions().map((d) =>
    d.key === 'workspace.get_product' ? { ...d, status: 'disabled' as const } : d,
  )
  let adapterCalls = 0
  const adapters = new Map<ToolKey, ToolAdapter>([
    [
      'workspace.get_product',
      {
        key: 'workspace.get_product',
        async run() {
          adapterCalls += 1
          return {}
        },
      },
    ],
  ])
  const result = await executeTool(
    {
      db,
      workspaceId: WS_A,
      toolKey: 'workspace.get_product',
      args: { productId: PRODUCT_A },
      caller: CHIEF,
    },
    { definitions, adapters },
  )
  assert.equal(result.error?.code, 'tool_disabled')
  assert.equal(adapterCalls, 0)
})

test('needs-setup analytics returns not_configured and never invents metrics', async () => {
  const db = freshDb()
  const analytics = caller(['read_context', 'read_memory', 'read_analytics'])
  const result = await executeTool({
    db,
    workspaceId: WS_A,
    toolKey: 'analytics.read',
    args: {},
    caller: analytics,
  })
  assert.equal(result.ok, false)
  assert.equal(result.error?.code, 'not_configured')
  assert.equal(result.data, null)
})

test('capability denial is server-side and the adapter is never invoked', async () => {
  const db = freshDb()
  const critic = caller(['read_context', 'read_memory'])
  let adapterCalls = 0
  const adapters = new Map<ToolKey, ToolAdapter>([
    [
      'platform.publish',
      {
        key: 'platform.publish',
        async run() {
          adapterCalls += 1
          return { postId: crypto.randomUUID(), externalId: 'x', url: null }
        },
      },
    ],
  ])
  const denied = await executeTool(
    {
      db,
      workspaceId: WS_A,
      toolKey: 'platform.publish',
      args: { accountId: ACCOUNT_A, contentVariantId: crypto.randomUUID() },
      caller: critic,
    },
    { adapters },
  )
  assert.equal(denied.error?.code, 'capability_denied')
  assert.equal(adapterCalls, 0)

  const noMemory = await executeTool(
    {
      db,
      workspaceId: WS_A,
      toolKey: 'memory.list_relevant',
      args: {},
      caller: caller(['read_context']),
    },
    { adapters },
  )
  assert.equal(noMemory.error?.code, 'capability_denied')
})

test('publisher capability does not make publishing available or fake success', async () => {
  const db = freshDb()
  const publisher = caller(['publish'])
  const result = await executeTool({
    db,
    workspaceId: WS_A,
    toolKey: 'platform.publish',
    args: { accountId: ACCOUNT_A, contentVariantId: crypto.randomUUID() },
    caller: publisher,
  })
  assert.equal(result.ok, false)
  assert.equal(result.error?.code, 'not_configured')
  assert.equal(result.data, null)
})

test('disabled agents receive no executable tools and cannot execute', async () => {
  const db = freshDb()
  const disabled = caller(['read_context', 'read_memory'], 'disabled')
  assert.deepEqual(getAvailableTools(disabled), [])
  const result = await executeTool({
    db,
    workspaceId: WS_A,
    toolKey: 'workspace.list_products',
    args: {},
    caller: disabled,
  })
  assert.equal(result.error?.code, 'capability_denied')
})

test('available-tool filtering follows capability, status and adapter presence', () => {
  const chiefTools = getAvailableTools(CHIEF).map((t) => t.key)
  assert.ok(chiefTools.includes('workspace.get_product'))
  assert.ok(chiefTools.includes('memory.list_relevant'))
  assert.ok(chiefTools.includes('research.list_relevant'))
  assert.ok(!chiefTools.includes('analytics.read'))
  assert.ok(!chiefTools.includes('platform.publish'))
  assert.ok(!chiefTools.includes('web.search'))

  const creatorTools = getAvailableTools(
    caller(['read_context', 'read_memory', 'create_draft']),
  ).map((t) => t.key)
  assert.ok(!creatorTools.includes('research.list_relevant'))
  assert.ok(!creatorTools.includes('image.generate'))
})

test('tool argument validation rejects malformed input', async () => {
  const db = freshDb()
  const result = await executeTool({
    db,
    workspaceId: WS_A,
    toolKey: 'workspace.get_product',
    args: { productId: 'not-a-uuid' },
    caller: CHIEF,
  })
  assert.equal(result.error?.code, 'invalid_input')
})

test('workspace.get_product reads an active product and rejects unknown, foreign and archived ids', async () => {
  const db = freshDb()
  const ok = await executeTool({
    db,
    workspaceId: WS_A,
    toolKey: 'workspace.get_product',
    args: { productId: PRODUCT_A },
    caller: CHIEF,
  })
  assert.equal(ok.ok, true)
  assert.equal((ok.data as { id: string }).id, PRODUCT_A)

  for (const [productId, code] of [
    [crypto.randomUUID(), 'scope_denied'],
    [PRODUCT_B, 'scope_denied'],
    [PRODUCT_ARCHIVED, 'scope_denied'],
  ] as const) {
    const result = await executeTool({
      db,
      workspaceId: WS_A,
      toolKey: 'workspace.get_product',
      args: { productId },
      caller: CHIEF,
    })
    assert.equal(result.error?.code, code)
  }
})

test('workspace.list_products is workspace-scoped and validates brand ownership', async () => {
  const db = freshDb()
  const all = await executeTool({
    db,
    workspaceId: WS_A,
    toolKey: 'workspace.list_products',
    args: {},
    caller: CHIEF,
  })
  const products = (all.data as { products: { id: string }[] }).products
  assert.deepEqual(
    products.map((p) => p.id),
    [PRODUCT_A],
  )

  const cross = await executeTool({
    db,
    workspaceId: WS_A,
    toolKey: 'workspace.list_products',
    args: { brandId: BRAND_B },
    caller: CHIEF,
  })
  assert.equal(cross.error?.code, 'scope_denied')
})

test('workspace account tools read safe metadata and reject foreign or archived accounts', async () => {
  const db = freshDb()
  const list = await executeTool({
    db,
    workspaceId: WS_A,
    toolKey: 'workspace.list_accounts',
    args: {},
    caller: CHIEF,
  })
  const accounts = (list.data as { accounts: { id: string }[] }).accounts
  assert.deepEqual(
    accounts.map((a) => a.id),
    [ACCOUNT_A],
  )
  assert.ok(!JSON.stringify(list.data).includes('WORKER_SECRET_NAME'))
  assert.ok(!JSON.stringify(list.data).includes('sk-live'))

  const one = await executeTool({
    db,
    workspaceId: WS_A,
    toolKey: 'workspace.get_account',
    args: { accountId: ACCOUNT_A },
    caller: CHIEF,
  })
  assert.equal(one.ok, true)
  assert.ok(!JSON.stringify(one.data).includes('secret'))

  for (const accountId of [ACCOUNT_B, ACCOUNT_ARCHIVED, crypto.randomUUID()]) {
    const result = await executeTool({
      db,
      workspaceId: WS_A,
      toolKey: 'workspace.get_account',
      args: { accountId },
      caller: CHIEF,
    })
    assert.equal(result.error?.code, 'scope_denied')
  }
})

test('current context tool goes through the Context Engine and returns only a summary', async () => {
  const db = freshDb()
  const result = await executeTool({
    db,
    workspaceId: WS_A,
    toolKey: 'workspace.get_current_context',
    args: {},
    caller: CHIEF,
  })
  assert.equal(result.ok, true)
  const data = result.data as { workspace: { id: string }; counts: { memories: number } }
  assert.equal(data.workspace.id, WS_A)
  assert.equal(typeof data.counts.memories, 'number')
  assert.ok(!('memories' in data))
})

test('memory read respects lifecycle: archived, superseded and expired stay out; proposed stays hypothesis', async () => {
  const db = freshDb()
  const result = await executeTool({
    db,
    workspaceId: WS_A,
    toolKey: 'memory.list_relevant',
    args: {},
    caller: CHIEF,
  })
  assert.equal(result.ok, true)
  const memories = (result.data as { memories: { content: string; authority: string }[] }).memories
  const contents = memories.map((m) => m.content)
  assert.ok(contents.includes('Active fact'))
  assert.ok(contents.includes('Hypothesis row'))
  assert.ok(!contents.includes('Archived fact'))
  assert.ok(!contents.includes('Expired fact'))
  assert.ok(!contents.includes('Superseded fact'))
  assert.equal(memories.find((m) => m.content === 'Hypothesis row')?.authority, 'hypothesis')
})

test('research read distinguishes stored freshness and excludes unfinished work', async () => {
  const db = freshDb()
  const result = await executeTool({
    db,
    workspaceId: WS_A,
    toolKey: 'research.list_relevant',
    args: {},
    caller: CHIEF,
  })
  assert.equal(result.ok, true)
  const research = (result.data as { research: { subject: string; freshness: string }[] }).research
  const bySubject = new Map(research.map((r) => [r.subject, r.freshness]))
  assert.equal(bySubject.get('Stale research'), 'stale')
  assert.ok(bySubject.has('Current research'))
  assert.ok(!bySubject.has('Draft research'))
  assert.ok(!bySubject.has('Archived research'))
})

test('execution ids are stable uuids and results stay JSON-serializable', async () => {
  const db = freshDb()
  const result = await executeTool({
    db,
    workspaceId: WS_A,
    toolKey: 'workspace.list_products',
    args: {},
    caller: CHIEF,
    idempotencyKey: 'read-1',
  })
  assert.match(result.executionId, /^[0-9a-f-]{36}$/i)
  assert.equal(result.metadata.idempotencyKey, 'read-1')
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
})

test('tool events carry safe metadata only', async () => {
  const db = freshDb()
  await executeTool({
    db,
    workspaceId: WS_A,
    toolKey: 'workspace.get_account',
    args: { accountId: ACCOUNT_A },
    caller: CHIEF,
  })
  const events = await listRecentEvents(db, WS_A, 'tool.execution.', 5)
  assert.equal(events.length, 1)
  const payload = events[0]?.payload ?? ''
  assert.match(payload, /tool\.execution\.completed|workspace\.get_account/)
  assert.match(payload, /durationMs/)
  assert.ok(!payload.includes('WORKER_SECRET_NAME'))
  assert.ok(!payload.includes('sk-live'))
  assert.ok(!payload.includes('scopes'))
})

test('external tool timeout policy is centralized and controlled', async () => {
  const db = freshDb()
  const definitions: ToolDefinition[] = listToolDefinitions().map((d) =>
    d.key === 'web.search' ? { ...d, status: 'available' as const, timeoutMs: 5 } : d,
  )
  const adapters = new Map<ToolKey, ToolAdapter>([
    [
      'web.search',
      {
        key: 'web.search',
        run: () => new Promise(() => {}),
      },
    ],
  ])
  const result = await executeTool(
    { db, workspaceId: WS_A, toolKey: 'web.search', args: { query: 'lamps' }, caller: CHIEF },
    { definitions, adapters },
  )
  assert.equal(result.error?.code, 'timeout')
})

test('approval is a separate layer: gated tools cannot run on capability alone', async () => {
  const db = freshDb()
  const definitions: ToolDefinition[] = listToolDefinitions().map((d) =>
    d.key === 'platform.publish' ? { ...d, status: 'available' as const } : d,
  )
  let adapterCalls = 0
  const adapters = new Map<ToolKey, ToolAdapter>([
    [
      'platform.publish',
      {
        key: 'platform.publish',
        async run() {
          adapterCalls += 1
          return { postId: crypto.randomUUID(), externalId: null, url: null }
        },
      },
    ],
  ])
  const publisher = caller(['publish'])
  const result = await executeTool(
    {
      db,
      workspaceId: WS_A,
      toolKey: 'platform.publish',
      args: { accountId: ACCOUNT_A, contentVariantId: crypto.randomUUID() },
      caller: publisher,
    },
    { definitions, adapters },
  )
  assert.equal(result.error?.code, 'approval_required')
  assert.equal(adapterCalls, 0)
})
