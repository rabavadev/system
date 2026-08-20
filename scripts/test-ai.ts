/**
 * AI execution + Workspace Chief tests (npm run test:ai).
 *
 * Runs the real stack — Context Engine, composer, executor, Chief,
 * message/event repositories — against a fresh better-sqlite3 database
 * migrated from migrations/, with provider adapters stubbed through the
 * executor's dependency injection (no network, no cloudflare:workers).
 *
 * Covers: agent versioning, Context Engine usage, scope precedence,
 * memory authority labels, research freshness, goals, provider-neutral
 * boundaries, persistence + agent/version metadata, role policy, failure
 * containment, idempotency, timeout, retry, usage parsing, secret hygiene,
 * and invalid model configuration.
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import {
  CHIEF_INSTRUCTIONS_V1,
  ensureChiefAgent,
  runChiefReply,
} from '../src/server/agents/chief.ts'
import { composeChiefPrompt, renderContextDocument } from '../src/server/ai/composer.ts'
import { type ExecuteAIDeps, executeAI } from '../src/server/ai/executor.ts'
import { createWorkersAiAdapter } from '../src/server/ai/providers/workers-ai.ts'
import {
  AIAdapterError,
  type AIAdapterRawResponse,
  type AIExecutionRequest,
  type AIProviderAdapter,
} from '../src/server/ai/types.ts'
import { buildContext } from '../src/server/context/index.ts'
import { createConversation } from '../src/server/db/conversation.ts'
import { listRecentEvents } from '../src/server/db/event.ts'
import {
  appendUserMessage,
  findMessageByClientRequestId,
  listMessages,
} from '../src/server/db/message.ts'
import type { SqlDatabase } from '../src/server/db/sql.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

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

const WS = crypto.randomUUID()
const BRAND_A = crypto.randomUUID()
const BRAND_B = crypto.randomUUID()
const PRODUCT_A = crypto.randomUUID()
const NOW = '2026-08-19T00:00:00.000Z'

function freshDb(): SqlDatabase {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  const dir = join(ROOT, 'migrations')
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    sqlite.exec(readFileSync(join(dir, file), 'utf8'))
  }
  sqlite
    .prepare(
      `INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, 'Test WS', NULL, ?, ?)`,
    )
    .run(WS, NOW, NOW)
  sqlite
    .prepare(
      `INSERT INTO brand (id, workspace_id, name, description, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)`,
    )
    .run(BRAND_A, WS, 'Brand Alpha', NOW, NOW)
  sqlite
    .prepare(
      `INSERT INTO brand (id, workspace_id, name, description, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)`,
    )
    .run(BRAND_B, WS, 'Brand Beta', NOW, NOW)
  sqlite
    .prepare(
      `INSERT INTO product (id, brand_id, niche_id, name, description, url, status, created_at, updated_at)
       VALUES (?, ?, NULL, 'Product One', 'A sturdy lamp.', NULL, 'active', ?, ?)`,
    )
    .run(PRODUCT_A, BRAND_A, NOW, NOW)
  return shim(sqlite)
}

function addMemory(
  db: SqlDatabase,
  memoryClass: string,
  content: string,
  scope: { type: string; id: string | null } = { type: 'workspace', id: null },
) {
  return db
    .prepare(
      `INSERT INTO memory (id, workspace_id, memory_class, content, scope_type, scope_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
    .bind(crypto.randomUUID(), WS, memoryClass, content, scope.type, scope.id, NOW, NOW)
    .run()
}

function addResearch(db: SqlDatabase, subject: string, status: string) {
  return db
    .prepare(
      `INSERT INTO research (id, workspace_id, subject, findings, status, scope_type, scope_id, created_at, updated_at)
       VALUES (?, ?, ?, 'Some findings.', ?, 'workspace', NULL, ?, ?)`,
    )
    .bind(crypto.randomUUID(), WS, subject, status, NOW, NOW)
    .run()
}

function addGoal(db: SqlDatabase, title: string) {
  return db
    .prepare(
      `INSERT INTO goal (id, workspace_id, scope_type, scope_id, title, status, created_at, updated_at)
       VALUES (?, ?, 'workspace', NULL, ?, 'active', ?, ?)`,
    )
    .bind(crypto.randomUUID(), WS, title, NOW, NOW)
    .run()
}

/** Adapter that records what it received and returns a scripted response. */
function recordingAdapter(
  handler: (input: {
    model: string
    messages: { role: string; content: string }[]
  }) => Promise<AIAdapterRawResponse> | AIAdapterRawResponse,
  key = 'workers-ai',
): {
  adapter: AIProviderAdapter
  calls: { model: string; messages: { role: string; content: string }[] }[]
} {
  const calls: { model: string; messages: { role: string; content: string }[] }[] = []
  return {
    calls,
    adapter: {
      key,
      async execute(input) {
        calls.push(input)
        return handler(input)
      },
    },
  }
}

function depsFor(
  adapter: AIProviderAdapter,
  overrides?: ExecuteAIDeps['modelOverrides'],
): ExecuteAIDeps {
  return {
    adapters: new Map([[adapter.key, adapter]]),
    ...(overrides ? { modelOverrides: overrides } : {}),
    sleep: () => Promise.resolve(), // no real backoff in tests
  }
}

const okResponse: AIAdapterRawResponse = {
  content: 'Understood. Here is my read of the situation.',
  finishReason: 'stop',
  usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
}

async function setupConversation(db: SqlDatabase, scope?: { type: 'brand'; id: string }) {
  const conversation = await createConversation(db, {
    workspaceId: WS,
    ...(scope ? { scopeType: scope.type, scopeId: scope.id } : {}),
  })
  await appendUserMessage(db, { conversationId: conversation.id, content: 'What is going on?' })
  return conversation
}

/* ---- 1. Chief agent + versioning ---- */

test('chief agent is created idempotently with a versioned config', async () => {
  const db = freshDb()
  const first = await ensureChiefAgent(db, WS)
  assert.equal(first.agent.name, 'Chief')
  assert.equal(first.agent.role, 'workspace-chief')
  assert.equal(first.agent.executionType, 'direct_model')
  assert.equal(first.version.version, 1)
  const config = JSON.parse(first.version.configJson)
  assert.equal(config.instructions, CHIEF_INSTRUCTIONS_V1)
  assert.equal(config.model.strategy, 'default')

  const again = await ensureChiefAgent(db, WS)
  assert.equal(again.agent.id, first.agent.id)
  assert.equal(again.version.id, first.version.id)
})

test('chief policy instructions: no fake actions, no invented facts, no internals', () => {
  assert.match(CHIEF_INSTRUCTIONS_V1, /cannot execute actions/i)
  assert.match(CHIEF_INSTRUCTIONS_V1, /Never invent workspace facts/i)
  assert.match(CHIEF_INSTRUCTIONS_V1, /Never claim you did something/i)
  assert.match(CHIEF_INSTRUCTIONS_V1, /Never mention internal ids/i)
  assert.match(CHIEF_INSTRUCTIONS_V1, /Hypotheses/i)
  // Practical length, not a novel.
  assert.ok(CHIEF_INSTRUCTIONS_V1.length < 4000)
})

/* ---- 2-6. Context Engine usage + scope ---- */

test('chief reply runs through the Context Engine and persists with metadata', async () => {
  const db = freshDb()
  addMemory(db, 'permanent_fact', 'The workspace ships lamps.')
  const conversation = await setupConversation(db, { type: 'brand', id: BRAND_A })
  const { adapter, calls } = recordingAdapter(() => okResponse)

  const reply = await runChiefReply({
    db,
    workspaceId: WS,
    conversationId: conversation.id,
    userText: 'What do you know about the current brand?',
    uiBrandId: null,
    deps: depsFor(adapter),
  })

  assert.equal(reply.ok, true)
  if (!reply.ok) return

  // 11/12. The adapter received a provider-neutral, composed request.
  assert.equal(calls.length, 1)
  const sent = calls.at(0)
  assert.ok(sent)
  assert.ok(sent.model.startsWith('@cf/'), 'model id resolved from strategy, not passed raw')
  assert.equal(sent.messages.length, 2)
  assert.equal(sent.messages[0]?.role, 'system')
  assert.equal(sent.messages[0]?.content, CHIEF_INSTRUCTIONS_V1)
  const doc = sent.messages[1]?.content
  // 2/3. Workspace + brand context reached the composer.
  assert.match(doc, /# Workspace\nTest WS/)
  assert.match(doc, /Brand Alpha/)
  assert.ok(!doc.includes('Brand Beta'), 'no cross-brand leakage')
  // 7. Verified memory labeled.
  assert.match(doc, /# Verified memory/)
  assert.match(doc, /\[FACT\] The workspace ships lamps/)
  // Conversation transcript is part of the context document.
  assert.match(doc, /# Recent conversation/)
  assert.match(doc, /# Current user request\nWhat do you know about the current brand\?/)

  // 13/14. Assistant message persisted with correct agent + version.
  assert.equal(reply.message.senderType, 'agent')
  const chief = await ensureChiefAgent(db, WS)
  assert.equal(reply.message.agentId, chief.agent.id)
  assert.equal(reply.message.agentVersionId, chief.version.id)

  // Provider metadata: provider/model/usage/execution, no secrets (21).
  const meta = JSON.parse(reply.message.providerMetadataJson ?? '{}')
  assert.equal(meta.provider, 'workers-ai')
  assert.ok(meta.model.startsWith('@cf/'))
  assert.equal(meta.usage.totalTokens, 150)
  assert.equal(meta.scopeSource, 'conversation')
  assert.equal(typeof meta.executionId, 'string')
  assert.equal(typeof meta.latencyMs, 'number')
  const metaKeys = JSON.stringify(meta).toLowerCase()
  for (const forbidden of ['api_key', 'apikey', 'secret', 'token_value', 'authorization']) {
    assert.ok(!metaKeys.includes(forbidden), `no '${forbidden}' in provider metadata`)
  }

  // 25. Messages reload in order (deep link / refresh path).
  const all = await listMessages(db, conversation.id)
  assert.deepEqual(
    all.map((m) => m.senderType),
    ['user', 'agent'],
  )

  // 35. Events emitted for traceability.
  const events = await listRecentEvents(db, WS, 'ai.execution.', 10)
  assert.deepEqual(events.map((e) => e.event_type).sort(), [
    'ai.execution.completed',
    'ai.execution.started',
  ])
  const completed = events.find((e) => e.event_type === 'ai.execution.completed')
  assert.ok(completed)
  const payload = JSON.parse(completed.payload ?? '{}')
  assert.equal(payload.agentVersionId, chief.version.id)
  assert.ok(payload.trace.entries.length > 0, 'context trace is attached to the event')
  assert.ok(!JSON.stringify(payload).toLowerCase().includes('secret'))
})

test('persisted conversation scope wins over the UI selection', async () => {
  const db = freshDb()
  const conversation = await setupConversation(db, { type: 'brand', id: BRAND_A })
  const { adapter, calls } = recordingAdapter(() => okResponse)

  const reply = await runChiefReply({
    db,
    workspaceId: WS,
    conversationId: conversation.id,
    userText: 'Which brand are we talking about?',
    uiBrandId: BRAND_B, // the UI has another brand active — must NOT win
    deps: depsFor(adapter),
  })
  assert.equal(reply.ok, true)
  const doc = calls[0]?.messages[1]?.content
  assert.match(doc, /Brand Alpha/)
  assert.ok(!doc.includes('Brand Beta'))
  assert.match(doc, /decided by: conversation/)
})

test('UI selection applies when the conversation has no scope', async () => {
  const db = freshDb()
  const conversation = await setupConversation(db)
  const { adapter, calls } = recordingAdapter(() => okResponse)
  await runChiefReply({
    db,
    workspaceId: WS,
    conversationId: conversation.id,
    userText: 'Hi',
    uiBrandId: BRAND_B,
    deps: depsFor(adapter),
  })
  const doc = calls[0]?.messages[1]?.content
  assert.match(doc, /Brand Beta/)
  assert.match(doc, /decided by: ui/)
})

test('product context reaches Chief through a product-scoped package', async () => {
  const db = freshDb()
  const pkg = await buildContext(db, { workspaceId: WS, productId: PRODUCT_A })
  const doc = renderContextDocument(pkg)
  assert.match(doc, /# Product\nName: Product One/)
  assert.match(doc, /A sturdy lamp\./)
  assert.match(doc, /Brand Alpha/)
})

/* ---- 7-10. Knowledge labels in the composed context ---- */

test('memory authority and research freshness survive serialization', async () => {
  const db = freshDb()
  addMemory(db, 'verified_learning', 'Lamp buyers respond to warm light photos.')
  addMemory(db, 'proposed_learning', 'Maybe reels outperform static pins.')
  addResearch(db, 'Competitor lamp study', 'stale')
  addResearch(db, 'Fresh keyword scan', 'completed')
  addGoal(db, 'Reach 10k monthly visitors')

  const pkg = await buildContext(db, { workspaceId: WS })
  const doc = renderContextDocument(pkg)

  // 7. Verified learning under verified memory, labeled TRUSTED.
  assert.match(doc, /# Verified memory[\s\S]*\[TRUSTED \(verified learning\)\] Lamp buyers/)
  // 8. Proposed learning in the Hypotheses section, never as fact.
  assert.match(doc, /# Hypotheses[\s\S]*Maybe reels outperform static pins/)
  const verifiedSection = doc.split('# Hypotheses').at(0) ?? ''
  assert.ok(!verifiedSection.includes('Maybe reels'))
  // 9. Stale research stays marked stale.
  assert.match(doc, /\[STALE \(outdated[^\]]*\)\] Competitor lamp study/)
  assert.match(doc, /\[current\] Fresh keyword scan/)
  // 10. Goals reach the context.
  assert.match(doc, /# Goals \(active\)\n- Reach 10k monthly visitors/)
})

/* ---- 16-20. Execution behavior ---- */

test('failed provider call: no assistant message, safe error, failed event', async () => {
  const db = freshDb()
  const conversation = await setupConversation(db)
  const { adapter } = recordingAdapter(() => {
    throw new AIAdapterError('provider_unavailable', 'backend exploded with stack trace', true)
  })

  const reply = await runChiefReply({
    db,
    workspaceId: WS,
    conversationId: conversation.id,
    userText: 'Hello',
    uiBrandId: null,
    deps: depsFor(adapter),
  })

  assert.equal(reply.ok, false)
  if (reply.ok) return
  // 17. Safe user-facing text: no provider internals.
  assert.equal(reply.userMessage, "Chief couldn't respond. Try again.")
  assert.ok(!reply.userMessage.includes('stack trace'))
  // 16. No fake assistant message; user message still persisted.
  const all = await listMessages(db, conversation.id)
  assert.deepEqual(
    all.map((m) => m.senderType),
    ['user'],
  )
  const events = await listRecentEvents(db, WS, 'ai.execution.', 10)
  assert.ok(events.some((e) => e.event_type === 'ai.execution.failed'))
  const failed = events.find((e) => e.event_type === 'ai.execution.failed')
  assert.ok(failed)
  assert.match(failed.payload ?? '', /provider_unavailable/)
})

test('retry policy: one extra attempt for retryable failures, none otherwise', async () => {
  const db = freshDb()
  let attempt = 0
  const { adapter: flaky } = recordingAdapter(() => {
    attempt += 1
    if (attempt === 1) throw new AIAdapterError('rate_limited', 'slow down', true)
    return okResponse
  })
  const conversation = await setupConversation(db)
  const reply = await runChiefReply({
    db,
    workspaceId: WS,
    conversationId: conversation.id,
    userText: 'Hi',
    uiBrandId: null,
    deps: depsFor(flaky),
  })
  assert.equal(reply.ok, true)
  assert.equal(attempt, 2, 'one controlled retry happened')
  if (reply.ok) assert.equal(reply.execution.attempts, 2)

  const { adapter: hard } = recordingAdapter(() => {
    throw new AIAdapterError('invalid_model_config', 'bad model', false)
  })
  const second = await setupConversation(db)
  const failed = await runChiefReply({
    db,
    workspaceId: WS,
    conversationId: second.id,
    userText: 'Hi',
    uiBrandId: null,
    deps: depsFor(hard),
  })
  assert.equal(failed.ok, false)
  if (!failed.ok) assert.equal(failed.errorCode, 'invalid_model_config')
})

test('timeout: a hung provider resolves as a bounded failure', async () => {
  const db = freshDb()
  const hung: AIProviderAdapter = {
    key: 'workers-ai',
    execute: () => new Promise(() => {}), // never settles, ignores the signal
  }
  const conversation = await setupConversation(db)
  const started = Date.now()
  const reply = await runChiefReply({
    db,
    workspaceId: WS,
    conversationId: conversation.id,
    userText: 'Hi',
    uiBrandId: null,
    deps: { ...depsFor(hung), timeoutMs: 250 },
  })
  assert.equal(reply.ok, false)
  if (!reply.ok) {
    assert.equal(reply.errorCode, 'timeout')
    assert.equal(reply.userMessage, 'Chief took too long to respond. Try again.')
  }
  assert.ok(Date.now() - started < 10_000, 'bounded by the executor timeout')
  const all = await listMessages(db, conversation.id)
  assert.equal(all.filter((m) => m.senderType === 'agent').length, 0)
})

test('idempotency: the same clientRequestId never executes or persists twice', async () => {
  const db = freshDb()
  const conversation = await createConversation(db, { workspaceId: WS })
  const clientRequestId = crypto.randomUUID()

  const userMessage = await appendUserMessage(db, {
    conversationId: conversation.id,
    content: 'Double click protection',
    clientRequestId,
  })
  const { adapter, calls } = recordingAdapter(() => okResponse)
  const input = {
    db,
    workspaceId: WS,
    conversationId: conversation.id,
    userText: 'Double click protection',
    uiBrandId: null,
    clientRequestId: `${clientRequestId}:chief`,
    deps: depsFor(adapter),
  }
  const first = await runChiefReply(input)
  const second = await runChiefReply(input)

  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(calls.length, 1, 'provider was called exactly once')
  if (first.ok && second.ok) {
    assert.equal(first.message.id, second.message.id)
  }
  const all = await listMessages(db, conversation.id)
  assert.equal(all.filter((m) => m.senderType === 'agent').length, 1)
  // The send path can resolve the idempotent user message too.
  const found = await findMessageByClientRequestId(db, conversation.id, clientRequestId)
  assert.equal(found?.id, userMessage.id)
})

test('usage parsing: the Workers AI adapter normalizes provider responses', async () => {
  const raw = {
    response: 'An answer.',
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }
  const adapter = createWorkersAiAdapter({ run: async () => raw })
  const out = await adapter.execute({
    model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    messages: [{ role: 'user', content: 'Hi' }],
    generation: { maxTokens: 100, temperature: 0.4 },
    signal: new AbortController().signal,
  })
  assert.equal(out.content, 'An answer.')
  assert.deepEqual(out.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 })

  // Missing usage → null, not a crash.
  const noUsage = createWorkersAiAdapter({ run: async () => ({ response: 'Hi.' }) })
  const out2 = await noUsage.execute({
    model: 'm',
    messages: [],
    generation: { maxTokens: 1, temperature: 0 },
    signal: new AbortController().signal,
  })
  assert.equal(out2.usage, null)

  // Wrong shape → typed malformed_response, not a raw exception.
  const broken = createWorkersAiAdapter({ run: async () => ({ unexpected: true }) })
  await assert.rejects(
    broken.execute({
      model: 'm',
      messages: [],
      generation: { maxTokens: 1, temperature: 0 },
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof AIAdapterError && error.code === 'malformed_response',
  )

  // Gateway option is passed through when configured.
  let seenOptions: unknown
  const gateway = createWorkersAiAdapter(
    {
      run: async (_model, _input, options) => {
        seenOptions = options
        return { response: 'ok' }
      },
    },
    'my-gateway',
  )
  await gateway.execute({
    model: 'm',
    messages: [],
    generation: { maxTokens: 1, temperature: 0 },
    signal: new AbortController().signal,
  })
  assert.deepEqual(seenOptions, { gateway: { id: 'my-gateway' } })
})

/* ---- 22-24. Boundaries + configuration ---- */

test('execution request/result stay provider-neutral end to end', async () => {
  // 22. ContextPackage: pure JSON, no provider concepts.
  const db = freshDb()
  const pkg = await buildContext(db, { workspaceId: WS, task: { text: 'x' } })
  const roundTrip = JSON.parse(JSON.stringify(pkg))
  assert.deepEqual(roundTrip.workspace, pkg.workspace)
  assert.ok(!('toPrompt' in pkg))
  assert.ok(!Object.keys(pkg).some((k) => /provider|sdk|client/i.test(k)))
  for (const m of pkg.recentMessages) {
    assert.ok(!('providerMetadataJson' in m), 'message provider metadata stays out of context')
  }

  // 11. Executor receives OUR request type; strategy resolves centrally.
  const { adapter, calls } = recordingAdapter(() => okResponse, 'test-provider')
  const request: AIExecutionRequest = {
    executionId: crypto.randomUUID(),
    agent: {
      agentId: crypto.randomUUID(),
      name: 'Chief',
      versionId: crypto.randomUUID(),
      version: 1,
      executionType: 'direct_model',
    },
    messages: [{ role: 'user', content: 'Hi' }],
    model: { strategy: 'default' },
    generation: { maxTokens: 50, temperature: 0.2 },
    metadata: { conversationId: crypto.randomUUID() },
  }
  const result = await executeAI(request, depsFor(adapter, { provider: 'test-provider' }))
  assert.equal(result.status, 'succeeded')
  assert.equal(result.provider, 'test-provider')
  assert.ok(calls[0]?.model.startsWith('@cf/'), 'adapter got the resolved model id')
  // Result carries no SDK objects.
  assert.deepEqual(Object.keys(result).sort(), [
    'attempts',
    'content',
    'error',
    'executionId',
    'finishReason',
    'latencyMs',
    'model',
    'provider',
    'status',
    'usage',
  ])
})

test('external_agent and router execution types fail in a controlled way', async () => {
  const { adapter } = recordingAdapter(() => okResponse)
  for (const executionType of ['external_agent', 'router'] as const) {
    const result = await executeAI(
      {
        executionId: crypto.randomUUID(),
        agent: {
          agentId: crypto.randomUUID(),
          name: 'Future',
          versionId: crypto.randomUUID(),
          version: 1,
          executionType,
        },
        messages: [],
        model: { strategy: 'default' },
        generation: { maxTokens: 1, temperature: 0 },
      },
      depsFor(adapter),
    )
    assert.equal(result.status, 'failed')
    assert.equal(result.error?.code, 'unsupported_execution_type')
    assert.equal(result.content, null)
  }
})

test('invalid model configuration fails cleanly', async () => {
  const { adapter, calls } = recordingAdapter(() => okResponse)
  const base: AIExecutionRequest = {
    executionId: crypto.randomUUID(),
    agent: {
      agentId: crypto.randomUUID(),
      name: 'Chief',
      versionId: crypto.randomUUID(),
      version: 1,
      executionType: 'direct_model',
    },
    messages: [{ role: 'user', content: 'Hi' }],
    model: { strategy: 'default' },
    generation: { maxTokens: 1, temperature: 0 },
  }

  // Unknown provider override → not_configured, adapter never called.
  const missing = await executeAI(base, depsFor(adapter, { provider: 'nope' }))
  assert.equal(missing.status, 'failed')
  assert.equal(missing.error?.code, 'not_configured')
  assert.equal(calls.length, 0)

  // Empty model override → invalid_model_config.
  const empty = await executeAI(base, depsFor(adapter, { models: { default: '' } }))
  assert.equal(empty.status, 'failed')
  assert.equal(empty.error?.code, 'invalid_model_config')
})

test('composer: structure, empty context, and context summary', () => {
  const pkg = {
    generatedAt: NOW,
    workspace: { id: WS, name: 'Test WS', slug: null },
    activeScope: { type: 'workspace', id: null },
    scopeSource: 'workspace',
    brand: null,
    niche: null,
    product: null,
    account: null,
    platform: null,
    campaign: null,
    agent: null,
    conversation: null,
    recentMessages: [],
    memories: [],
    research: [],
    goals: [],
    currentTask: { text: 'Hello Chief' },
    metadata: {
      limits: {
        recentMessages: 30,
        maxMemories: 20,
        maxResearch: 10,
        maxGoals: 10,
        researchAgingDays: 90,
      },
      counts: { messages: 0, memories: 0, research: 0, goals: 0 },
    },
    trace: { request: {}, scopeSource: 'workspace', entries: [] },
  } as const
  const composed = composeChiefPrompt('INSTRUCTIONS', pkg as never)
  assert.deepEqual(
    composed.messages.map((m) => m.role),
    ['system', 'user'],
  )
  assert.equal(composed.messages[0]?.content, 'INSTRUCTIONS')
  assert.match(composed.messages[1]?.content, /# Workspace\nTest WS/)
  assert.match(composed.messages[1]?.content, /# Current user request\nHello Chief/)
  assert.ok(!composed.messages[1]?.content.includes('# Goals'))
  assert.equal(composed.contextSummary.scopeSource, 'workspace')
})
