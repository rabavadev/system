/**
 * Tool Registry tests (npm run test:tools).
 *
 * Runs the real boundary — definitions, registry filtering, executeTool,
 * internal read adapters, Context Engine memory/research reads, and event
 * emission — against a fresh better-sqlite3 database migrated from
 * migrations/. No network, no cloudflare:workers, no provider SDKs.
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import type { AgentCapability } from '../src/server/agents/config.ts'
import { listRecentEvents } from '../src/server/db/event.ts'
import type { SqlDatabase } from '../src/server/db/sql.ts'
import {
  BraveSearchClient,
  createWebSearchAdapter,
  executeTool,
  getAvailableTools,
  listToolDefinitions,
  MockWebSearchClient,
  TOOL_KEYS,
  type ToolAdapter,
  type ToolCaller,
  type ToolDefinition,
  ToolError,
  type ToolKey,
} from '../src/server/tools/index.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

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
const RESEARCHER = caller(['read_context', 'read_memory', 'read_research', 'web_search'])

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
  assert.ok(!chiefTools.includes('web.search'), 'Chief does not have web_search capability')

  // When web.search adapter is unconfigured by default, it is omitted from available tools
  const researcherToolsUnconfigured = getAvailableTools(RESEARCHER).map((t) => t.key)
  assert.ok(
    !researcherToolsUnconfigured.includes('web.search'),
    'Unconfigured web.search is not advertised',
  )

  // When web.search adapter is configured, it is included for Researcher
  const configuredToolDeps = {
    adapters: new Map<ToolKey, ToolAdapter>([
      ['web.search', createWebSearchAdapter({ client: new MockWebSearchClient() })],
    ]),
  }
  const researcherToolsConfigured = getAvailableTools(RESEARCHER, configuredToolDeps).map(
    (t) => t.key,
  )
  assert.ok(
    researcherToolsConfigured.includes('web.search'),
    'Configured web.search is available for Researcher',
  )

  const chiefToolsConfigured = getAvailableTools(CHIEF, configuredToolDeps).map((t) => t.key)
  assert.ok(
    !chiefToolsConfigured.includes('web.search'),
    'Chief lacks capability even when web.search is configured',
  )

  const creatorTools = getAvailableTools(
    caller(['read_context', 'read_memory', 'create_draft']),
  ).map((t) => t.key)
  assert.ok(!creatorTools.includes('research.list_relevant'))
  assert.ok(!creatorTools.includes('web.search'))
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
    { db, workspaceId: WS_A, toolKey: 'web.search', args: { query: 'lamps' }, caller: RESEARCHER },
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

/* ========================================================================= */
/* STEP 13A: Real Provider-Neutral Web Search Tool Tests                     */
/* ========================================================================= */

test('web.search tool metadata is registered with correct category, risk, capability, and schemas', () => {
  const definitions = listToolDefinitions()
  const webSearch = definitions.find((d) => d.key === 'web.search')
  assert.ok(webSearch, 'web.search definition must exist')
  assert.equal(webSearch.key, 'web.search')
  assert.equal(webSearch.category, 'web')
  assert.deepEqual(webSearch.risk, ['read', 'external'])
  assert.equal(webSearch.requiredCapability, 'web_search')
  assert.equal(webSearch.status, 'available')
  assert.equal(webSearch.timeoutMs, 10_000)
  assert.equal(webSearch.cost, 'metered')

  // Validate inputSchema
  assert.equal(webSearch.inputSchema.safeParse({ query: 'ai trends' }).success, true)
  assert.equal(webSearch.inputSchema.safeParse({ query: 'ai trends', limit: 5 }).success, true)
  assert.equal(
    webSearch.inputSchema.safeParse({ query: 'ai trends', freshness: 'week' }).success,
    true,
  )
  assert.equal(webSearch.inputSchema.safeParse({ query: '' }).success, false)
  assert.equal(webSearch.inputSchema.safeParse({ query: '   ' }).success, false)
  assert.equal(webSearch.inputSchema.safeParse({ query: 'test', limit: 0 }).success, false)
  assert.equal(webSearch.inputSchema.safeParse({ query: 'test', limit: 11 }).success, false)

  // Validate outputSchema
  const validOutput = {
    query: 'ai trends',
    provider: 'mock',
    resultCount: 1,
    results: [
      {
        title: 'AI News',
        url: 'https://example.com/ai',
        snippet: 'Latest trends in AI',
        publisher: 'example.com',
        publishedAt: '2026-08-20T00:00:00Z',
        retrievedAt: '2026-08-20T00:00:00.000Z',
      },
    ],
  }
  assert.equal(webSearch.outputSchema.safeParse(validOutput).success, true)
})

test('web.search adapter reports isConfigured correctly based on client options', () => {
  const unconfigured1 = createWebSearchAdapter()
  assert.equal(unconfigured1.isConfigured?.(), false)

  const unconfigured2 = createWebSearchAdapter({ client: null })
  assert.equal(unconfigured2.isConfigured?.(), false)

  const unconfigured3 = createWebSearchAdapter({ getClient: () => null })
  assert.equal(unconfigured3.isConfigured?.(), false)

  const configured1 = createWebSearchAdapter({ client: new MockWebSearchClient() })
  assert.equal(configured1.isConfigured?.(), true)

  const configured2 = createWebSearchAdapter({ getClient: () => new MockWebSearchClient() })
  assert.equal(configured2.isConfigured?.(), true)
})

test('web.search tool returns not_configured when no provider client is active', async () => {
  const db = freshDb()

  const result = await executeTool({
    db,
    workspaceId: WS_A,
    toolKey: 'web.search',
    args: { query: 'test query' },
    caller: RESEARCHER,
  })

  assert.equal(result.ok, false)
  assert.equal(result.error?.code, 'not_configured')
  assert.match(result.error?.message ?? '', /needs setup/i)
})

test('web.search executes with MockWebSearchClient and returns normalized result structure', async () => {
  const db = freshDb()
  const mockClient = new MockWebSearchClient({
    results: [
      {
        title: 'Modern Architecture',
        url: 'https://example.org/modern-arch',
        snippet: 'A deep dive into clean modular software design.',
        publisher: 'example.org',
        publishedAt: '2026-08-15',
      },
      {
        title: 'TypeScript Best Practices',
        url: 'https://ts.dev/guide',
        snippet: 'Effective type-level modeling in enterprise apps.',
        publisher: 'ts.dev',
        publishedAt: null,
      },
    ],
  })

  const result = await executeTool(
    {
      db,
      workspaceId: WS_A,
      toolKey: 'web.search',
      args: { query: 'typescript modular architecture', limit: 5 },
      caller: RESEARCHER,
    },
    {
      adapters: new Map<ToolKey, ToolAdapter>([
        ['web.search', createWebSearchAdapter({ client: mockClient })],
      ]),
    },
  )

  assert.equal(result.ok, true)
  const data = result.data as {
    query: string
    provider: string
    resultCount: number
    results: Array<{
      title: string
      url: string
      snippet: string | null
      publisher: string | null
      publishedAt: string | null
      retrievedAt: string
    }>
  }

  assert.equal(data.query, 'typescript modular architecture')
  assert.equal(data.provider, 'mock')
  assert.equal(data.resultCount, 2)
  assert.equal(data.results.length, 2)

  assert.equal(data.results[0].title, 'Modern Architecture')
  assert.equal(data.results[0].url, 'https://example.org/modern-arch')
  assert.equal(data.results[0].snippet, 'A deep dive into clean modular software design.')
  assert.equal(data.results[0].publisher, 'example.org')
  assert.equal(data.results[0].publishedAt, '2026-08-15')
  assert.match(data.results[0].retrievedAt, /^\d{4}-\d{2}-\d{2}T/)

  assert.equal(data.results[1].title, 'TypeScript Best Practices')
  assert.equal(data.results[1].url, 'https://ts.dev/guide')
  assert.equal(data.results[1].snippet, 'Effective type-level modeling in enterprise apps.')
  assert.equal(data.results[1].publisher, 'ts.dev')
  assert.equal(data.results[1].publishedAt, null)
})

test('web.search rejects empty or whitespace-only query', async () => {
  const db = freshDb()
  const mockClient = new MockWebSearchClient({ results: [] })
  const deps = {
    adapters: new Map<ToolKey, ToolAdapter>([
      ['web.search', createWebSearchAdapter({ client: mockClient })],
    ]),
  }

  const resEmpty = await executeTool(
    {
      db,
      workspaceId: WS_A,
      toolKey: 'web.search',
      args: { query: '' },
      caller: RESEARCHER,
    },
    deps,
  )
  assert.equal(resEmpty.ok, false)
  assert.equal(resEmpty.error?.code, 'invalid_input')

  const resWhitespace = await executeTool(
    {
      db,
      workspaceId: WS_A,
      toolKey: 'web.search',
      args: { query: '    ' },
      caller: RESEARCHER,
    },
    deps,
  )
  assert.equal(resWhitespace.ok, false)
  assert.equal(resWhitespace.error?.code, 'invalid_input')
})

test('web.search rejects oversized query (> 300 characters)', async () => {
  const db = freshDb()
  const mockClient = new MockWebSearchClient({ results: [] })
  const deps = {
    adapters: new Map<ToolKey, ToolAdapter>([
      ['web.search', createWebSearchAdapter({ client: mockClient })],
    ]),
  }

  const longQuery = 'x'.repeat(301)
  const result = await executeTool(
    {
      db,
      workspaceId: WS_A,
      toolKey: 'web.search',
      args: { query: longQuery },
      caller: RESEARCHER,
    },
    deps,
  )
  assert.equal(result.ok, false)
  assert.equal(result.error?.code, 'invalid_input')
})

test('web.search enforces limit bounds and defaults', async () => {
  const db = freshDb()
  const mockClient = new MockWebSearchClient({
    results: [
      { title: 'R1', url: 'https://e.com/1' },
      { title: 'R2', url: 'https://e.com/2' },
      { title: 'R3', url: 'https://e.com/3' },
      { title: 'R4', url: 'https://e.com/4' },
      { title: 'R5', url: 'https://e.com/5' },
      { title: 'R6', url: 'https://e.com/6' },
    ],
  })
  const deps = {
    adapters: new Map<ToolKey, ToolAdapter>([
      ['web.search', createWebSearchAdapter({ client: mockClient })],
    ]),
  }

  // Default limit is 5
  const resDefault = await executeTool(
    {
      db,
      workspaceId: WS_A,
      toolKey: 'web.search',
      args: { query: 'test' },
      caller: RESEARCHER,
    },
    deps,
  )
  assert.equal(resDefault.ok, true)
  const defaultData = resDefault.data as { results: unknown[] }
  assert.equal(defaultData.results.length, 5)

  // Explicit limit 2
  const res2 = await executeTool(
    {
      db,
      workspaceId: WS_A,
      toolKey: 'web.search',
      args: { query: 'test', limit: 2 },
      caller: RESEARCHER,
    },
    deps,
  )
  assert.equal(res2.ok, true)
  const data2 = res2.data as { results: unknown[] }
  assert.equal(data2.results.length, 2)

  // Invalid limit rejected by schema validation
  const resInvalid = await executeTool(
    {
      db,
      workspaceId: WS_A,
      toolKey: 'web.search',
      args: { query: 'test', limit: 0 },
      caller: RESEARCHER,
    },
    deps,
  )
  assert.equal(resInvalid.ok, false)
  assert.equal(resInvalid.error?.code, 'invalid_input')
})

test('web.search leaves missing metadata fields as null and does not fabricate data', async () => {
  const db = freshDb()
  const mockClient = new MockWebSearchClient({
    results: [
      {
        title: 'Minimal Entry',
        url: 'https://minimal.test/path',
        snippet: undefined,
        publisher: undefined,
        publishedAt: undefined,
      },
    ],
  })
  const deps = {
    adapters: new Map<ToolKey, ToolAdapter>([
      ['web.search', createWebSearchAdapter({ client: mockClient })],
    ]),
  }

  const result = await executeTool(
    {
      db,
      workspaceId: WS_A,
      toolKey: 'web.search',
      args: { query: 'minimal' },
      caller: RESEARCHER,
    },
    deps,
  )

  assert.equal(result.ok, true)
  const data = result.data as {
    results: Array<{
      title: string
      url: string
      snippet: string | null
      publisher: string | null
      publishedAt: string | null
      retrievedAt: string
    }>
  }

  assert.equal(data.results.length, 1)
  const item = data.results[0]
  assert.equal(item.title, 'Minimal Entry')
  assert.equal(item.url, 'https://minimal.test/path')
  assert.equal(item.snippet, null)
  assert.equal(item.publisher, 'minimal.test') // derived strictly from URL hostname
  assert.equal(item.publishedAt, null) // not fabricated
  assert.ok(item.retrievedAt)
})

test('web.search discards unsafe URL schemes (javascript, file, data, ftp)', async () => {
  const db = freshDb()
  const mockClient = new MockWebSearchClient({
    results: [
      { title: 'Safe HTTP', url: 'http://example.com/safe' },
      { title: 'Safe HTTPS', url: 'https://example.com/safe' },
      { title: 'Unsafe JS', url: 'javascript:alert(1)' },
      { title: 'Unsafe File', url: 'file:///etc/passwd' },
      { title: 'Unsafe Data', url: 'data:text/html,<script>evil()</script>' },
      { title: 'Unsafe FTP', url: 'ftp://ftp.example.com/file' },
      { title: 'Malformed URL', url: 'not-a-valid-url' },
    ],
  })
  const deps = {
    adapters: new Map<ToolKey, ToolAdapter>([
      ['web.search', createWebSearchAdapter({ client: mockClient })],
    ]),
  }

  const result = await executeTool(
    {
      db,
      workspaceId: WS_A,
      toolKey: 'web.search',
      args: { query: 'security test', limit: 10 },
      caller: RESEARCHER,
    },
    deps,
  )

  assert.equal(result.ok, true)
  const data = result.data as { results: Array<{ title: string; url: string }> }
  assert.equal(data.results.length, 2)
  assert.equal(data.results[0].url, 'http://example.com/safe')
  assert.equal(data.results[1].url, 'https://example.com/safe')
})

test('web.search hides raw provider payloads from tool output', async () => {
  const db = freshDb()
  const mockClient = new MockWebSearchClient({
    results: [
      {
        title: 'Result With Extra Props',
        url: 'https://example.com/res',
        snippet: 'Snippet here',
      },
    ],
  })
  const deps = {
    adapters: new Map<ToolKey, ToolAdapter>([
      ['web.search', createWebSearchAdapter({ client: mockClient })],
    ]),
  }

  const result = await executeTool(
    {
      db,
      workspaceId: WS_A,
      toolKey: 'web.search',
      args: { query: 'test extra' },
      caller: RESEARCHER,
    },
    deps,
  )

  assert.equal(result.ok, true)
  const data = result.data as Record<string, unknown>
  const expectedKeys = new Set(['query', 'provider', 'resultCount', 'results'])
  assert.deepEqual(new Set(Object.keys(data)), expectedKeys)

  const item = (data.results as Record<string, unknown>[])[0]
  const expectedItemKeys = new Set([
    'title',
    'url',
    'snippet',
    'publisher',
    'publishedAt',
    'retrievedAt',
  ])
  assert.deepEqual(new Set(Object.keys(item)), expectedItemKeys)
})

test('web.search prevents secret leakage in execution events and logs', async () => {
  const db = freshDb()
  const mockClient = new MockWebSearchClient({
    results: [{ title: 'Secret Test', url: 'https://secret.example.com' }],
  })
  const deps = {
    adapters: new Map<ToolKey, ToolAdapter>([
      ['web.search', createWebSearchAdapter({ client: mockClient })],
    ]),
  }

  await executeTool(
    {
      db,
      workspaceId: WS_A,
      toolKey: 'web.search',
      args: { query: 'find private keys' },
      caller: RESEARCHER,
    },
    deps,
  )

  const events = await listRecentEvents(db, WS_A, 'tool.execution.', 5)
  assert.ok(events.length >= 1)
  const payload = events[0]?.payload ?? ''
  // Query should be redacted in summary
  assert.match(payload, /"query":\s*"\[redacted\]"/)
  assert.ok(!payload.includes('X-Subscription-Token'))
  assert.ok(!payload.includes('BRAVE_API_KEY'))
  assert.ok(!payload.includes('WEB_SEARCH_API_KEY'))
})

test('web.search enforces required capability (web_search)', async () => {
  const db = freshDb()
  const mockClient = new MockWebSearchClient({ results: [] })
  const deps = {
    adapters: new Map<ToolKey, ToolAdapter>([
      ['web.search', createWebSearchAdapter({ client: mockClient })],
    ]),
  }

  const noCapabilityCaller = caller(['read_context', 'read_memory', 'read_research']) // missing web_search
  const result = await executeTool(
    {
      db,
      workspaceId: WS_A,
      toolKey: 'web.search',
      args: { query: 'unauthorized search' },
      caller: noCapabilityCaller,
    },
    deps,
  )

  assert.equal(result.ok, false)
  assert.equal(result.error?.code, 'capability_denied')
})

test('web.search approval requirement blocks execution without approval', async () => {
  const db = freshDb()
  const mockClient = new MockWebSearchClient({
    results: [{ title: 'Approved Result', url: 'https://example.com' }],
  })

  // Create definitions where web.search approval is required
  const definitions: ToolDefinition[] = listToolDefinitions().map((d) =>
    d.key === 'web.search' ? { ...d, approval: 'required' as const } : d,
  )
  const adapter = createWebSearchAdapter({ client: mockClient })
  const adapters = new Map<ToolKey, ToolAdapter>([['web.search', adapter]])

  // Without approvalGranted
  const resDenied = await executeTool(
    {
      db,
      workspaceId: WS_A,
      toolKey: 'web.search',
      args: { query: 'approval test' },
      caller: RESEARCHER,
      approvalGranted: false,
    },
    { definitions, adapters },
  )
  assert.equal(resDenied.ok, false)
  assert.equal(resDenied.error?.code, 'approval_required')

  // With approvalGranted: true
  const resApproved = await executeTool(
    {
      db,
      workspaceId: WS_A,
      toolKey: 'web.search',
      args: { query: 'approval test' },
      caller: RESEARCHER,
      approvalGranted: true,
    },
    { definitions, adapters },
  )
  assert.equal(resApproved.ok, true)
})

test('web.search timeout is handled cleanly', async () => {
  const db = freshDb()
  const slowClient = new MockWebSearchClient({
    results: [{ title: 'Slow', url: 'https://slow.com' }],
    delayMs: 50,
  })

  const definitions: ToolDefinition[] = listToolDefinitions().map((d) =>
    d.key === 'web.search' ? { ...d, timeoutMs: 10 } : d,
  )
  const adapter = createWebSearchAdapter({ client: slowClient })
  const adapters = new Map<ToolKey, ToolAdapter>([['web.search', adapter]])

  const result = await executeTool(
    {
      db,
      workspaceId: WS_A,
      toolKey: 'web.search',
      args: { query: 'timeout test' },
      caller: RESEARCHER,
    },
    { definitions, adapters },
  )

  assert.equal(result.ok, false)
  assert.equal(result.error?.code, 'timeout')
})

test('web.search provider errors are normalized to provider_error', async () => {
  const db = freshDb()
  const errorClient = new MockWebSearchClient({
    error: new ToolError('provider_error', 'Upstream search provider 500 error'),
  })
  const deps = {
    adapters: new Map<ToolKey, ToolAdapter>([
      ['web.search', createWebSearchAdapter({ client: errorClient })],
    ]),
  }

  const result = await executeTool(
    {
      db,
      workspaceId: WS_A,
      toolKey: 'web.search',
      args: { query: 'failing query' },
      caller: RESEARCHER,
    },
    deps,
  )

  assert.equal(result.ok, false)
  assert.equal(result.error?.code, 'provider_error')
})

test('web.search rate limits are normalized to rate_limited', async () => {
  const db = freshDb()
  const rateLimitedClient = new MockWebSearchClient({
    error: new ToolError('rate_limited', 'Too many search requests'),
  })
  const deps = {
    adapters: new Map<ToolKey, ToolAdapter>([
      ['web.search', createWebSearchAdapter({ client: rateLimitedClient })],
    ]),
  }

  const result = await executeTool(
    {
      db,
      workspaceId: WS_A,
      toolKey: 'web.search',
      args: { query: 'rate limited query' },
      caller: RESEARCHER,
    },
    deps,
  )

  assert.equal(result.ok, false)
  assert.equal(result.error?.code, 'rate_limited')
})

test('MockWebSearchClient records search parameters accurately offline', async () => {
  const mockClient = new MockWebSearchClient({
    resultsByQuery: {
      'custom query': [
        { title: 'Custom 1', url: 'https://custom.com/1' },
        { title: 'Custom 2', url: 'https://custom.com/2' },
      ],
    },
  })

  const results = await mockClient.search('custom query', 1, 'month')
  assert.equal(results.length, 1)
  assert.equal(results[0].title, 'Custom 1')
  assert.equal(mockClient.calls.length, 1)
  assert.equal(mockClient.calls[0].query, 'custom query')
  assert.equal(mockClient.calls[0].limit, 1)
  assert.equal(mockClient.calls[0].freshness, 'month')
})

test('BraveSearchClient parses successful response correctly with mock fetch', async () => {
  const fakePayload = {
    web: {
      results: [
        {
          title: 'Brave Search Engine',
          url: 'https://brave.com/search',
          description: 'Privacy-first web search.',
          page_age: '2026-08-01',
          meta_url: { hostname: 'brave.com' },
        },
      ],
    },
  }

  const mockFetch = async () =>
    new Response(JSON.stringify(fakePayload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })

  const client = new BraveSearchClient({
    apiKey: 'test-key-123',
    fetchFn: mockFetch as unknown as typeof fetch,
  })

  const results = await client.search('privacy search', 5, 'week')
  assert.equal(results.length, 1)
  assert.equal(results[0].title, 'Brave Search Engine')
  assert.equal(results[0].url, 'https://brave.com/search')
  assert.equal(results[0].snippet, 'Privacy-first web search.')
  assert.equal(results[0].publisher, 'brave.com')
  assert.equal(results[0].publishedAt, '2026-08-01')
})

test('BraveSearchClient maps HTTP 401/403, 429, 500, and network failure to appropriate ToolErrors', async () => {
  // 401 Unauthorized
  const client401 = new BraveSearchClient({
    apiKey: 'bad-key',
    fetchFn: (async () => new Response('Unauthorized', { status: 401 })) as unknown as typeof fetch,
  })
  await assert.rejects(
    () => client401.search('query', 5),
    (err: unknown) => err instanceof ToolError && err.code === 'not_configured',
  )

  // 429 Rate Limit
  const client429 = new BraveSearchClient({
    apiKey: 'key',
    fetchFn: (async () => new Response('Rate limited', { status: 429 })) as unknown as typeof fetch,
  })
  await assert.rejects(
    () => client429.search('query', 5),
    (err: unknown) => err instanceof ToolError && err.code === 'rate_limited',
  )

  // 500 Server Error
  const client500 = new BraveSearchClient({
    apiKey: 'key',
    fetchFn: (async () => new Response('Server error', { status: 500 })) as unknown as typeof fetch,
  })
  await assert.rejects(
    () => client500.search('query', 5),
    (err: unknown) => err instanceof ToolError && err.code === 'provider_error',
  )

  // Network Fetch Failure
  const clientNetErr = new BraveSearchClient({
    apiKey: 'key',
    fetchFn: (async () => {
      throw new Error('DNS failure')
    }) as unknown as typeof fetch,
  })
  await assert.rejects(
    () => clientNetErr.search('query', 5),
    (err: unknown) => err instanceof ToolError && err.code === 'execution_failed',
  )
})
