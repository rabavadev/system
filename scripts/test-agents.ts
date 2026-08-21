/**
 * Agent Registry tests (npm run test:agents).
 *
 * Runs the real stack — registry provisioning, versioning, config
 * validation, generic agent reply runtime, Context Engine, composer,
 * executor — against a fresh better-sqlite3 database migrated from
 * migrations/, with provider adapters stubbed through the executor's
 * dependency injection (no network, no cloudflare:workers).
 *
 * Covers STEP 8: built-in roster, Chief reuse, immutable versioning,
 * status policy, agent switching in one conversation, shared context,
 * instruction injection safety, secret hygiene, declarative capabilities,
 * and honest unavailability of external/router/publisher execution.
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import { CHIEF_INSTRUCTIONS_V1, ensureChiefAgent } from '../src/server/agents/chief.ts'
import {
  AGENT_CAPABILITIES,
  agentVersionConfigSchema,
  MODEL_STRATEGIES,
  parseAgentVersionConfig,
} from '../src/server/agents/config.ts'
import {
  AGENT_BASE_POLICY,
  BUILTIN_AGENTS,
  builtinConfig,
} from '../src/server/agents/definitions.ts'
import {
  assertAgentNameAvailable,
  ensureBuiltinAgents,
  resolveChatAgent,
} from '../src/server/agents/registry.ts'
import { runAgentReply } from '../src/server/agents/reply.ts'
import type { ExecuteAIDeps } from '../src/server/ai/executor.ts'
import type { AIAdapterRawResponse, AIProviderAdapter } from '../src/server/ai/types.ts'
import {
  ApprovalServiceError,
  createApprovalRequest,
  decideApprovalRequest,
} from '../src/server/approval/service.ts'
import {
  addAgentVersion,
  createAgent,
  createAgentInput,
  getAgentById,
  getAgentVersion,
  listAgents,
  listAgentVersions,
  setAgentStatus,
} from '../src/server/db/agent.ts'
import { getApprovalRequest, listApprovalRequests } from '../src/server/db/approval.ts'
import { createConversation, getConversationById } from '../src/server/db/conversation.ts'
import { listRecentEvents } from '../src/server/db/event.ts'
import { appendUserMessage, listMessages } from '../src/server/db/message.ts'
import { setApprovalPolicy } from '../src/server/db/policy.ts'
import type { SqlDatabase } from '../src/server/db/sql.ts'
import { resolveActionKeyForTool } from '../src/server/policy/tool-action.ts'
import {
  createWebSearchAdapter,
  type ExecuteToolDeps,
  MockWebSearchClient,
  type ToolAdapter,
  ToolError,
  type ToolKey,
} from '../src/server/tools/index.ts'

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
  return shim(sqlite)
}

/** Adapter that records what it received and returns a scripted response. */
function recordingAdapter(
  handler?: (input: {
    model: string
    messages: { role: string; content: string }[]
    tools?: unknown
  }) => AIAdapterRawResponse,
): {
  adapter: AIProviderAdapter
  calls: { model: string; messages: { role: string; content: string }[]; tools?: unknown }[]
} {
  const calls: {
    model: string
    messages: { role: string; content: string }[]
    tools?: unknown
  }[] = []
  return {
    calls,
    adapter: {
      key: 'workers-ai',
      async execute(input) {
        calls.push(input)
        return (
          handler?.(input) ?? {
            content: 'Noted. Here is my take.',
            finishReason: 'stop',
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          }
        )
      },
    },
  }
}

function depsFor(adapter: AIProviderAdapter): ExecuteAIDeps {
  return { adapters: new Map([[adapter.key, adapter]]), sleep: () => Promise.resolve() }
}

async function builtinByName(db: SqlDatabase, name: string) {
  await ensureBuiltinAgents(db, WS)
  const agents = await listAgents(db, WS)
  const agent = agents.find((a) => a.name === name)
  assert.ok(agent, `built-in '${name}' should exist`)
  return agent
}

async function sendTo(
  db: SqlDatabase,
  conversationId: string,
  agentId: string | null,
  text: string,
  adapter: AIProviderAdapter,
  toolDeps?: ExecuteToolDeps,
) {
  await appendUserMessage(db, { conversationId, content: text })
  return runAgentReply({
    db,
    workspaceId: WS,
    conversationId,
    agentId,
    userText: text,
    deps: depsFor(adapter),
    ...(toolDeps ? { toolDeps } : {}),
  })
}

/* ---- 1-7. Built-in roster + Chief reuse ---- */

test('1. existing Chief identity is reused, never rebuilt', async () => {
  const db = freshDb()
  // Simulate a STEP 6 database: Chief exists with the original config shape
  // (no capabilities key), provisioned before STEP 8 shipped.
  const legacyConfig = JSON.stringify({
    instructions: CHIEF_INSTRUCTIONS_V1,
    model: { strategy: 'default' },
    generation: { maxTokens: 1024, temperature: 0.4 },
  })
  const legacy = await createAgent(db, {
    workspaceId: WS,
    name: 'Chief',
    role: 'workspace-chief',
    executionType: 'direct_model',
  })
  const legacyVersion = await addAgentVersion(db, legacy.id, legacyConfig)

  const chief = await ensureChiefAgent(db, WS)
  // Same identity row; history (v1) untouched.
  assert.equal(chief.agent.id, legacy.id)
  const versions = await listAgentVersions(db, legacy.id)
  assert.equal(versions.length, 2)
  assert.equal(versions.at(-1)?.id, legacyVersion.id)
  assert.equal(versions.at(-1)?.configJson, legacyConfig, 'historical version never rewritten')
  // Current version is the new one; instructions unchanged.
  assert.equal(chief.version.version, 2)
  assert.equal(chief.config.instructions, CHIEF_INSTRUCTIONS_V1)
  // Idempotent: second run changes nothing.
  const again = await ensureChiefAgent(db, WS)
  assert.equal(again.version.id, chief.version.id)
  assert.equal((await listAgentVersions(db, legacy.id)).length, 2)
})

test('2-7. all built-in agents are provisioned with safe configuration', async () => {
  const db = freshDb()
  await ensureBuiltinAgents(db, WS)
  const expected = [
    'Chief',
    'Researcher',
    'Strategist',
    'Creator',
    'Critic',
    'Analytics',
    'Publisher',
  ]
  const agents = await listAgents(db, WS)
  for (const name of expected) {
    const agent = agents.find((a) => a.name === name)
    assert.ok(agent, `${name} exists`)
    assert.equal(agent.origin, 'builtin')
    assert.ok(agent.description, `${name} has a purpose`)
    assert.ok(agent.currentVersionId, `${name} has a current version`)
  }
  // Publisher exists but ships disabled: it can never pretend to publish.
  const publisher = await builtinByName(db, 'Publisher')
  assert.equal(publisher.status, 'disabled')
  // Every specialist instruction includes the shared base policy.
  for (const def of BUILTIN_AGENTS) {
    const config = builtinConfig(def)
    if (def.verbatimInstructions) {
      assert.equal(config.instructions, CHIEF_INSTRUCTIONS_V1)
    } else {
      assert.ok(
        config.instructions?.startsWith(AGENT_BASE_POLICY),
        `${def.name} carries the base policy`,
      )
    }
  }
})

/* ---- 8. Built-in protection ---- */

test('8. built-in identities cannot be archived; custom agents can', async () => {
  const db = freshDb()
  await ensureBuiltinAgents(db, WS)
  const critic = await builtinByName(db, 'Critic')
  await assert.rejects(() => setAgentStatus(db, critic.id, 'archived'), /cannot be archived/)
  // Disable/enable is allowed.
  const disabled = await setAgentStatus(db, critic.id, 'disabled')
  assert.equal(disabled.status, 'disabled')
  const enabled = await setAgentStatus(db, critic.id, 'active')
  assert.equal(enabled.status, 'active')
  // Custom agents can be archived.
  const custom = await createAgent(db, { workspaceId: WS, name: 'My Helper' })
  const archived = await setAgentStatus(db, custom.id, 'archived')
  assert.equal(archived.status, 'archived')
})

/* ---- 9-12. Versioning ---- */

test('9-12. editing creates an immutable new version and moves the pointer', async () => {
  const db = freshDb()
  await ensureBuiltinAgents(db, WS)
  const critic = await builtinByName(db, 'Critic')

  // 9. Current version resolves.
  const resolved = await resolveChatAgent(db, WS, critic.id)
  assert.ok(resolved.ok)
  assert.equal(resolved.handle.version.version, 1)

  // 10/11. New version appends; v1 stays byte-identical.
  const v1 = resolved.handle.version
  const newConfig = JSON.stringify({
    ...JSON.parse(v1.configJson),
    instructions: 'Be extra picky about hooks.',
    source: 'user',
  })
  const v2 = await addAgentVersion(db, critic.id, newConfig, 'Sharper hook critique')
  assert.equal(v2.version, 2)
  assert.equal(v2.changeNote, 'Sharper hook critique')
  const v1After = await getAgentVersion(db, v1.id)
  assert.equal(v1After?.configJson, v1.configJson, 'old version immutable')

  // 12. The agent now points at v2.
  const updated = await getAgentById(db, critic.id)
  assert.equal(updated?.currentVersionId, v2.id)
  const reresolved = await resolveChatAgent(db, WS, critic.id)
  assert.ok(reresolved.ok)
  assert.equal(reresolved.handle.version.id, v2.id)
})

/* ---- 13, 24, 25, 31. Switching agents in one conversation ---- */

test('13/24/25/31. one conversation, three agents, correct version on each reply', async () => {
  const db = freshDb()
  const { adapter, calls } = recordingAdapter()
  const conversation = await createConversation(db, { workspaceId: WS })

  // Chief answers first (default when no agentId is given — test 23 too).
  const chiefReply = await sendTo(
    db,
    conversation.id,
    null,
    'Help me understand this product.',
    adapter,
  )
  assert.ok(chiefReply.ok)
  const chief = await ensureChiefAgent(db, WS)
  assert.equal(chiefReply.message.agentId, chief.agent.id)
  assert.equal(chiefReply.message.agentVersionId, chief.version.id)

  // Switch to Critic in the SAME conversation.
  const critic = await builtinByName(db, 'Critic')
  const criticReply = await sendTo(
    db,
    conversation.id,
    critic.id,
    "Critique Chief's answer.",
    adapter,
  )
  assert.ok(criticReply.ok)
  assert.equal(criticReply.message.agentId, critic.id)

  // Critic evolves to v2; tomorrow's messages use v2, history keeps v1.
  const criticV1 = await resolveChatAgent(db, WS, critic.id)
  assert.ok(criticV1.ok)
  const v2Config = JSON.stringify({
    ...criticV1.handle.config,
    instructions: `${criticV1.handle.config.instructions}\n- MARKER_V2`,
    source: 'user',
  })
  const v2 = await addAgentVersion(db, critic.id, v2Config)
  const criticReply2 = await sendTo(db, conversation.id, critic.id, 'And the hook?', adapter)
  assert.ok(criticReply2.ok)
  assert.equal(criticReply2.message.agentVersionId, v2.id)
  // 13. The earlier Critic message still points at v1.
  const messages = await listMessages(db, conversation.id)
  const firstCriticMessage = messages.find((m) => m.id === criticReply.message.id)
  assert.equal(firstCriticMessage?.agentVersionId, criticV1.handle.version.id)

  // 25. Switch to Strategist in the same conversation.
  const strategist = await builtinByName(db, 'Strategist')
  const strategistReply = await sendTo(
    db,
    conversation.id,
    strategist.id,
    'Give me the better direction.',
    adapter,
  )
  assert.ok(strategistReply.ok)
  assert.equal(strategistReply.message.agentId, strategist.id)

  // 28. The CURRENT version's instructions reached the composer.
  const criticCall = calls.at(-1)
  assert.ok(criticCall?.messages[0]?.content.includes('positioning, audience, angles'))

  // 26. Conversation scope never changed while switching.
  const after = await getConversationById(db, conversation.id)
  assert.equal(after?.scopeType, null)
  assert.equal(after?.scopeId, null)

  // Every adapter call used the shared system+context layout.
  assert.ok(
    calls.every((call) => call.messages.length === 2 && call.messages[0]?.role === 'system'),
  )
})

/* ---- 27, 29, 30, 32, 33. Shared context through the Context Engine ---- */

test('27/29/30. switched agents receive the same scoped ContextPackage', async () => {
  const db = freshDb()
  const { adapter, calls } = recordingAdapter()
  const conversation = await createConversation(db, {
    workspaceId: WS,
    scopeType: 'brand',
    scopeId: BRAND_A,
  })
  db.prepare(
    `INSERT INTO memory (id, workspace_id, memory_class, content, scope_type, scope_id, status, created_at, updated_at)
     VALUES (?, ?, 'permanent_fact', 'We sell sturdy lamps.', 'workspace', NULL, 'active', ?, ?)`,
  )
    .bind(crypto.randomUUID(), WS, NOW, NOW)
    .run()

  const critic = await builtinByName(db, 'Critic')
  const strategist = await builtinByName(db, 'Strategist')
  await sendTo(db, conversation.id, critic.id, 'Review our positioning.', adapter)
  await sendTo(db, conversation.id, strategist.id, 'Now propose a direction.', adapter)

  assert.equal(calls.length, 2)
  const criticDoc = calls[0]?.messages[1]?.content ?? ''
  const strategistDoc = calls[1]?.messages[1]?.content ?? ''
  // Both agents got the SAME workspace/brand/memory context — nobody queries
  // the database for context themselves (the Context Engine is the only path).
  for (const doc of [criticDoc, strategistDoc]) {
    assert.match(doc, /# Workspace\nTest WS/)
    assert.match(doc, /Brand Alpha/)
    assert.match(doc, /We sell sturdy lamps\./)
    assert.match(doc, /decided by: conversation/)
  }
  // The transcripts differ only where they should (the user's latest request).
  assert.match(criticDoc, /Review our positioning\./)
  assert.match(strategistDoc, /Now propose a direction\./)
})

test('32/33. hypotheses stay hypotheses; archived memory never enters context', async () => {
  const db = freshDb()
  const { adapter, calls } = recordingAdapter()
  const conversation = await createConversation(db, { workspaceId: WS })
  db.prepare(
    `INSERT INTO memory (id, workspace_id, memory_class, content, scope_type, scope_id, status, created_at, updated_at)
     VALUES (?, ?, 'proposed_learning', 'Maybe short hooks win.', 'workspace', NULL, 'active', ?, ?)`,
  )
    .bind(crypto.randomUUID(), WS, NOW, NOW)
    .run()
  db.prepare(
    `INSERT INTO memory (id, workspace_id, memory_class, content, scope_type, scope_id, status, created_at, updated_at)
     VALUES (?, ?, 'permanent_fact', 'OLD ARCHIVED FACT', 'workspace', NULL, 'archived', ?, ?)`,
  )
    .bind(crypto.randomUUID(), WS, NOW, NOW)
    .run()

  const researcher = await builtinByName(db, 'Researcher')
  const reply = await sendTo(db, conversation.id, researcher.id, 'What do we know?', adapter)
  assert.ok(reply.ok)
  const doc = calls[0]?.messages[1]?.content ?? ''
  assert.match(doc, /# Hypotheses[\s\S]*Maybe short hooks win\./)
  const verifiedSection = doc.split('# Hypotheses').at(0) ?? ''
  assert.ok(!verifiedSection.includes('Maybe short hooks'), 'hypothesis never presented as fact')
  assert.ok(!doc.includes('OLD ARCHIVED FACT'), 'archived memory excluded')
})

/* ---- 14, 15. Disabled and unknown agents ---- */

test('14/15. disabled or unknown agents cannot execute; no fake replies', async () => {
  const db = freshDb()
  const { adapter, calls } = recordingAdapter()
  const conversation = await createConversation(db, { workspaceId: WS })
  const critic = await builtinByName(db, 'Critic')
  await setAgentStatus(db, critic.id, 'disabled')

  const reply = await sendTo(db, conversation.id, critic.id, 'Review this.', adapter)
  assert.ok(!reply.ok)
  assert.match(reply.userMessage, /disabled/i)
  assert.equal(calls.length, 0, 'disabled agent never reaches a provider')

  const bogus = await sendTo(db, conversation.id, crypto.randomUUID(), 'Hi?', adapter)
  assert.ok(!bogus.ok)
  assert.match(bogus.userMessage, /could not be found/i)
  assert.equal(calls.length, 0)

  // The user message persists; no fake assistant message was created.
  const messages = await listMessages(db, conversation.id)
  assert.ok(messages.every((m) => m.senderType === 'user'))
})

/* ---- 16, 17. Custom agents ---- */

test('16/17. custom agents can be created; reserved and duplicate names rejected', async () => {
  const db = freshDb()
  await ensureBuiltinAgents(db, WS)
  const custom = await createAgent(db, {
    workspaceId: WS,
    name: 'Launch Planner',
    description: 'Plans launches.',
    origin: 'custom',
  })
  assert.equal(custom.origin, 'custom')
  await addAgentVersion(
    db,
    custom.id,
    JSON.stringify(
      agentVersionConfigSchema.parse({
        instructions: 'Plan launches carefully.',
        model: { strategy: 'fast' },
        capabilities: ['read_context'],
      }),
    ),
  )
  const resolved = await resolveChatAgent(db, WS, custom.id)
  assert.ok(resolved.ok)
  assert.equal(resolved.handle.agent.name, 'Launch Planner')

  await assert.rejects(() => assertAgentNameAvailable(db, WS, 'critic'), /built-in/)
  await assert.rejects(() => assertAgentNameAvailable(db, WS, 'LAUNCH PLANNER'), /already exists/)
  await assertAgentNameAvailable(db, WS, 'Launch Planner', custom.id) // self-rename is fine
})

/* ---- 18-20, 22, 36. Validation ---- */

test('18/19/20. execution type, model strategy and capabilities are validated', async () => {
  assert.throws(() =>
    createAgentInput.parse({ workspaceId: WS, name: 'X', executionType: 'magic' }),
  )
  for (const type of ['direct_model', 'external_agent', 'router']) {
    assert.doesNotThrow(() =>
      createAgentInput.parse({ workspaceId: WS, name: 'X', executionType: type }),
    )
  }
  assert.ok(
    !agentVersionConfigSchema.safeParse({
      instructions: 'Do things.',
      model: { strategy: 'gpt-4o' },
    }).success,
    'raw provider model names are not strategies',
  )
  assert.ok(
    !agentVersionConfigSchema.safeParse({
      instructions: 'Do things.',
      capabilities: ['delete_workspace'],
    }).success,
  )
  assert.ok(
    agentVersionConfigSchema.safeParse({
      instructions: 'Do things.',
      model: { strategy: 'reasoning' },
      capabilities: ['read_context', 'create_draft'],
    }).success,
  )
})

test('22/36. secrets can never enter agent configuration', async () => {
  // Secret-looking keys are rejected.
  assert.ok(
    !agentVersionConfigSchema.safeParse({
      instructions: 'Do things.',
      external: { endpoint: 'https://agents.example.com/x', apiKey: 'abc' },
    }).success,
  )
  // Secret-looking values are rejected.
  assert.ok(
    !agentVersionConfigSchema.safeParse({
      instructions: 'sk-1234567890abcdef is my key, use it.',
    }).success,
  )
  // Only https endpoints; no javascript:/file:/localhost tricks.
  for (const endpoint of [
    'javascript:alert(1)',
    'file:///etc/passwd',
    'http://insecure.example.com',
  ]) {
    assert.ok(
      !agentVersionConfigSchema.safeParse({
        instructions: 'Do things.',
        external: { endpoint },
      }).success,
      endpoint,
    )
  }
  // A credential NAME reference is allowed (it is not the secret).
  const ok = agentVersionConfigSchema.safeParse({
    instructions: 'Do things.',
    external: { endpoint: 'https://agents.example.com/x', credentialRef: 'MY_AGENT_KEY' },
  })
  assert.ok(ok.success)
})

/* ---- 21, 28. Server-authoritative instructions ---- */

test('21/28. replies use the stored version config, never client-supplied text', async () => {
  const db = freshDb()
  const { adapter, calls } = recordingAdapter()
  const conversation = await createConversation(db, { workspaceId: WS })
  const creator = await builtinByName(db, 'Creator')

  // runAgentReply accepts an agent id only — there is no instructions
  // channel. The composed system message must be the stored config verbatim.
  const reply = await sendTo(db, conversation.id, creator.id, 'Write a hook.', adapter)
  assert.ok(reply.ok)
  const stored = await resolveChatAgent(db, WS, creator.id)
  assert.ok(stored.ok)
  assert.equal(calls[0]?.messages[0]?.content, stored.handle.config.instructions)

  // New version → new instructions reach the composer (28).
  const v2 = await addAgentVersion(
    db,
    creator.id,
    JSON.stringify({
      ...stored.handle.config,
      instructions: 'MARKER instruction v2',
      source: 'user',
    }),
  )
  await sendTo(db, conversation.id, creator.id, 'Another hook.', adapter)
  assert.equal(calls[1]?.messages[0]?.content, 'MARKER instruction v2')
  assert.equal(v2.version, 2)
})

/* ---- 34, 35. Honest limitations ---- */

test('34/35. Researcher uses web.search responsibly; Publisher cannot publish', async () => {
  const db = freshDb()
  await ensureBuiltinAgents(db, WS)
  const researcher = await builtinByName(db, 'Researcher')
  const rConfig = parseAgentVersionConfig(
    (await getAgentVersion(db, researcher.currentVersionId ?? ''))?.configJson ?? '',
  )
  assert.ok(rConfig)
  assert.match(rConfig.instructions, /web\.search/i)
  assert.match(rConfig.instructions, /snippets are summaries/i)
  assert.match(rConfig.instructions, /[Nn]ever invent sources/i)

  const analytics = await builtinByName(db, 'Analytics')
  const aConfig = parseAgentVersionConfig(
    (await getAgentVersion(db, analytics.currentVersionId ?? ''))?.configJson ?? '',
  )
  assert.ok(aConfig)
  assert.match(aConfig.instructions, /never invent metrics/i)

  const publisher = await builtinByName(db, 'Publisher')
  assert.equal(publisher.status, 'disabled', 'Publisher ships disabled')
  const pConfig = parseAgentVersionConfig(
    (await getAgentVersion(db, publisher.currentVersionId ?? ''))?.configJson ?? '',
  )
  assert.ok(pConfig)
  assert.match(pConfig.instructions, /never claim something was published/i)
  // 'publish' is declared intent only; no execution path exists for it.
  assert.ok(pConfig.capabilities.includes('publish'))
  // Disabled: cannot be chatted with.
  const resolved = await resolveChatAgent(db, WS, publisher.id)
  assert.ok(!resolved.ok)
})

/* ---- External agent / router honesty ---- */

test('external and router agents fail controlled, never fake success', async () => {
  const db = freshDb()
  const { adapter, calls } = recordingAdapter()
  const conversation = await createConversation(db, { workspaceId: WS })

  const external = await createAgent(db, {
    workspaceId: WS,
    name: 'Outside Brain',
    executionType: 'external_agent',
  })
  await addAgentVersion(
    db,
    external.id,
    JSON.stringify(
      agentVersionConfigSchema.parse({
        instructions: 'You are external.',
        external: { endpoint: 'https://agents.example.com/brain', credentialRef: 'BRAIN_KEY' },
      }),
    ),
  )
  const extReply = await sendTo(db, conversation.id, external.id, 'Hello?', adapter)
  assert.ok(!extReply.ok)
  assert.equal(extReply.errorCode, 'unsupported_execution_type')
  assert.match(extReply.userMessage, /no connection yet/i)
  assert.equal(calls.length, 0, 'no network call was made')

  const router = await createAgent(db, {
    workspaceId: WS,
    name: 'Chooser',
    executionType: 'router',
  })
  await addAgentVersion(
    db,
    router.id,
    JSON.stringify(
      agentVersionConfigSchema.parse({
        instructions: 'You route.',
        router: { allowedStrategies: ['fast', 'reasoning'] },
      }),
    ),
  )
  const routerReply = await sendTo(db, conversation.id, router.id, 'Pick a model.', adapter)
  assert.ok(!routerReply.ok)
  assert.match(routerReply.userMessage, /not enabled yet/i)
  assert.equal(calls.length, 0)
})

/* ---- 37. Provider neutrality ---- */

test('37. built-in configs carry strategies, never provider or model ids', async () => {
  for (const def of BUILTIN_AGENTS) {
    const config = JSON.parse(JSON.stringify(builtinConfig(def))) as {
      model?: { strategy?: string }
    }
    assert.deepEqual(Object.keys(config).sort(), [
      'capabilities',
      'generation',
      'instructions',
      'model',
      'source',
    ])
    assert.deepEqual(Object.keys(config.model ?? {}), ['strategy'])
    assert.ok(
      MODEL_STRATEGIES.includes(config.model?.strategy as (typeof MODEL_STRATEGIES)[number]),
    )
    const serialized = JSON.stringify(config)
    assert.ok(!serialized.includes('@cf/'), 'no Workers AI model ids in registry config')
    assert.ok(!/openai|anthropic|gemini/i.test(serialized), 'no provider names in registry config')
  }
  // Capability vocabulary is the declared one.
  for (const def of BUILTIN_AGENTS) {
    for (const capability of def.capabilities) {
      assert.ok((AGENT_CAPABILITIES as readonly string[]).includes(capability))
    }
  }
})

/* ---- 23. Chat defaults to Chief ---- */

test('23. no selection means Chief answers', async () => {
  const db = freshDb()
  const { adapter } = recordingAdapter()
  const conversation = await createConversation(db, { workspaceId: WS })
  const reply = await sendTo(db, conversation.id, null, 'Hello.', adapter)
  assert.ok(reply.ok)
  const chief = await ensureChiefAgent(db, WS)
  assert.equal(reply.message.agentId, chief.agent.id)

  const resolved = await resolveChatAgent(db, WS, null)
  assert.ok(resolved.ok)
  assert.equal(resolved.handle.agent.name, 'Chief')
})

/* ---- Transcript labeling ---- */

test('context transcript labels each reply with its authoring agent', async () => {
  const db = freshDb()
  const { adapter, calls } = recordingAdapter()
  const conversation = await createConversation(db, { workspaceId: WS })
  const critic = await builtinByName(db, 'Critic')

  await sendTo(db, conversation.id, null, 'First question.', adapter)
  await sendTo(db, conversation.id, critic.id, 'Critique that.', adapter)
  // The Critic's context document shows Chief's earlier reply as "Chief:".
  const criticDoc = calls.at(-1)?.messages[1]?.content ?? ''
  assert.match(criticDoc, /Chief: Noted\. Here is my take\./)
})

/* ---- Failure containment for specialists (same as Chief) ---- */

test('provider failure: safe message, no fake assistant reply', async () => {
  const db = freshDb()
  const failing: AIProviderAdapter = {
    key: 'workers-ai',
    async execute() {
      const { AIAdapterError } = await import('../src/server/ai/types.ts')
      throw new AIAdapterError('provider_unavailable', 'down', true)
    },
  }
  const conversation = await createConversation(db, { workspaceId: WS })
  const strategist = await builtinByName(db, 'Strategist')
  await appendUserMessage(db, { conversationId: conversation.id, content: 'Think.' })
  const reply = await runAgentReply({
    db,
    workspaceId: WS,
    conversationId: conversation.id,
    agentId: strategist.id,
    userText: 'Think.',
    deps: depsFor(failing),
  })
  assert.ok(!reply.ok)
  assert.match(reply.userMessage, /Strategist/)
  const messages = await listMessages(db, conversation.id)
  assert.ok(messages.every((m) => m.senderType === 'user'))
})

/* ========================================================================= */
/* STEP 13B: Researcher Web Search & Generic AI Tool Loop Tests              */
/* ========================================================================= */

test('STEP 13B: Built-in Researcher has web_search capability, other agents do not', async () => {
  const db = freshDb()
  await ensureBuiltinAgents(db, WS)
  const agents = await listAgents(db, WS)

  for (const agent of agents) {
    const version = await getAgentVersion(db, agent.currentVersionId ?? '')
    assert.ok(version, `current version for ${agent.name} should exist`)
    const parsed = parseAgentVersionConfig(version.configJson)

    if (agent.name === 'Researcher') {
      assert.ok(
        parsed.capabilities.includes('web_search'),
        'Researcher must have web_search capability',
      )
      assert.ok(
        parsed.instructions.includes('web.search'),
        'Researcher instructions should mention web.search',
      )
    } else {
      assert.ok(
        !parsed.capabilities.includes('web_search'),
        `${agent.name} must NOT have web_search capability`,
      )
    }
  }
})

test('STEP 13B: Researcher executes web.search via generic AI tool calling loop', async () => {
  const db = freshDb()
  const mockClient = new MockWebSearchClient({
    resultsByQuery: {
      'eco coffee packaging': [
        {
          title: 'Eco Coffee Solutions',
          url: 'https://ecocoffee.example/packaging',
          snippet: 'Biodegradable packaging for specialty coffee roasters.',
          publisher: 'ecocoffee.example',
          publishedAt: '2026-08-10',
        },
      ],
    },
  })
  const toolDeps: ExecuteToolDeps = {
    adapters: new Map<ToolKey, ToolAdapter>([
      ['web.search', createWebSearchAdapter({ client: mockClient })],
    ]),
  }

  let turn = 0
  const { adapter, calls } = recordingAdapter((input) => {
    turn += 1
    if (turn === 1) {
      // Turn 1: Model requests web.search tool
      const tools = input.tools as Array<{ key: string }>
      assert.ok(tools?.some((t) => t.key === 'web.search'))
      return {
        content: null,
        toolCalls: [
          {
            id: 'call-1',
            toolKey: 'web.search',
            args: { query: 'eco coffee packaging', limit: 5 },
          },
        ],
        finishReason: 'tool_calls',
        usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      }
    }
    // Turn 2: Model receives tool result and produces final answer
    const toolMsg = input.messages.find((m) => m.role === 'tool')
    assert.ok(toolMsg, 'Model must receive tool response message')
    assert.match(toolMsg.content, /Eco Coffee Solutions/)
    return {
      content:
        'Based on recent findings from Eco Coffee Solutions (https://ecocoffee.example/packaging), biodegradable packaging is standard.',
      finishReason: 'stop',
      usage: { inputTokens: 40, outputTokens: 25, totalTokens: 65 },
    }
  })

  const conversation = await createConversation(db, { workspaceId: WS })
  const researcher = await builtinByName(db, 'Researcher')
  await setApprovalPolicy(db, {
    workspaceId: WS,
    scopeType: 'workspace',
    scopeId: WS,
    actionKey: 'external.read',
    mode: 'auto',
  })

  const reply = await sendTo(
    db,
    conversation.id,
    researcher.id,
    'What eco coffee packaging exists?',
    adapter,
    toolDeps,
  )

  assert.ok(reply.ok)
  assert.equal(calls.length, 2, 'AI loop must run 2 turns (tool call + final reply)')
  assert.match(reply.message.content, /Eco Coffee Solutions/)

  // Verify trace execution and sources
  assert.equal(reply.execution.toolCalls?.length, 1)
  assert.equal(reply.execution.toolCalls[0].toolKey, 'web.search')
  assert.equal(reply.execution.toolCalls[0].status, 'succeeded')
  assert.equal(reply.execution.toolCalls[0].resultCount, 1)

  assert.equal(reply.execution.sources?.length, 1)
  assert.equal(reply.execution.sources[0].title, 'Eco Coffee Solutions')
  assert.equal(reply.execution.sources[0].url, 'https://ecocoffee.example/packaging')
  assert.equal(reply.execution.sources[0].publisher, 'ecocoffee.example')

  // Verify metadata persisted on message
  assert.ok(reply.message.providerMetadataJson)
  const persistedMeta = JSON.parse(reply.message.providerMetadataJson)
  assert.equal(persistedMeta.sources?.length, 1)
  assert.equal(persistedMeta.toolCalls?.length, 1)
})

test('STEP 13B: Tool calling loop is bounded to maximum 3 tool calls', async () => {
  const db = freshDb()
  const mockClient = new MockWebSearchClient({
    results: [{ title: 'Generic Result', url: 'https://example.com/res' }],
  })
  const toolDeps: ExecuteToolDeps = {
    adapters: new Map<ToolKey, ToolAdapter>([
      ['web.search', createWebSearchAdapter({ client: mockClient })],
    ]),
  }

  let callCount = 0
  const { adapter } = recordingAdapter((input) => {
    callCount += 1
    if (callCount <= 3) {
      // Model keeps trying to call tools
      return {
        content: null,
        toolCalls: [
          {
            id: `call-${callCount}`,
            toolKey: 'web.search',
            args: { query: `query ${callCount}` },
          },
        ],
        finishReason: 'tool_calls',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      }
    }
    // Final turn after tool limit is reached
    assert.equal(input.tools, undefined, 'Tools must be disabled after max calls reached')
    return {
      content: 'Here is the summary after 3 searches.',
      finishReason: 'stop',
      usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 },
    }
  })

  const conversation = await createConversation(db, { workspaceId: WS })
  const researcher = await builtinByName(db, 'Researcher')
  await setApprovalPolicy(db, {
    workspaceId: WS,
    scopeType: 'workspace',
    scopeId: WS,
    actionKey: 'external.read',
    mode: 'auto',
  })

  const reply = await sendTo(
    db,
    conversation.id,
    researcher.id,
    'Search repeatedly.',
    adapter,
    toolDeps,
  )

  assert.ok(reply.ok)
  // Max 3 tool calls executed in loop
  assert.equal(reply.execution.toolCalls?.length, 3)
  assert.equal(reply.message.content, 'Here is the summary after 3 searches.')
})

test('STEP 13B: Non-permitted agent model call to web.search is rejected with capability_denied', async () => {
  const db = freshDb()
  await setApprovalPolicy(db, {
    workspaceId: WS,
    scopeType: 'workspace',
    scopeId: WS,
    actionKey: 'external.read',
    mode: 'auto',
  })
  const mockClient = new MockWebSearchClient({
    results: [{ title: 'Secret', url: 'https://secret.com' }],
  })
  const toolDeps: ExecuteToolDeps = {
    adapters: new Map<ToolKey, ToolAdapter>([
      ['web.search', createWebSearchAdapter({ client: mockClient })],
    ]),
  }

  let turn = 0
  const { adapter } = recordingAdapter((input) => {
    turn += 1
    if (turn === 1) {
      // Chief model tries to invoke web.search anyway
      return {
        content: null,
        toolCalls: [
          {
            id: 'call-unauthorized',
            toolKey: 'web.search',
            args: { query: 'unauthorized search' },
          },
        ],
        finishReason: 'tool_calls',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      }
    }
    // Turn 2: Chief model receives capability_denied error
    const toolMsg = input.messages.find((m) => m.role === 'tool')
    assert.ok(toolMsg)
    assert.match(toolMsg.content, /capability_denied/)
    return {
      content: 'I cannot use web search. I will answer from workspace context.',
      finishReason: 'stop',
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
    }
  })

  const conversation = await createConversation(db, { workspaceId: WS })
  const chief = await builtinByName(db, 'Chief')

  const reply = await sendTo(
    db,
    conversation.id,
    chief.id,
    'Search the web for competitors.',
    adapter,
    toolDeps,
  )

  assert.ok(reply.ok)
  assert.match(reply.message.content, /cannot use web search/)
  // Mock client was never called
  assert.equal(mockClient.calls.length, 0)
  assert.equal(reply.execution.toolCalls?.length, 1)
  assert.equal(reply.execution.toolCalls[0].status, 'failed')
  assert.equal(reply.execution.toolCalls[0].error, 'capability_denied')
})

test('STEP 13B: Search provider error (e.g. not_configured) is handled gracefully by model loop', async () => {
  const db = freshDb()
  await setApprovalPolicy(db, {
    workspaceId: WS,
    scopeType: 'workspace',
    scopeId: WS,
    actionKey: 'external.read',
    mode: 'auto',
  })
  const mockClient = new MockWebSearchClient({
    error: new ToolError('not_configured', 'Web search provider is not configured.'),
  })
  const toolDeps: ExecuteToolDeps = {
    adapters: new Map<ToolKey, ToolAdapter>([
      ['web.search', createWebSearchAdapter({ client: mockClient })],
    ]),
  }

  let turn = 0
  const { adapter } = recordingAdapter((input) => {
    turn += 1
    if (turn === 1) {
      return {
        content: null,
        toolCalls: [
          {
            id: 'call-not-configured',
            toolKey: 'web.search',
            args: { query: 'unconfigured search' },
          },
        ],
        finishReason: 'tool_calls',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      }
    }
    const toolMsg = input.messages.find((m) => m.role === 'tool')
    assert.ok(toolMsg)
    assert.match(toolMsg.content, /not_configured/)
    return {
      content:
        'Web search is not configured in this workspace yet. Here is what we have in context.',
      finishReason: 'stop',
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
    }
  })

  const conversation = await createConversation(db, { workspaceId: WS })
  const researcher = await builtinByName(db, 'Researcher')

  const reply = await sendTo(db, conversation.id, researcher.id, 'Search web.', adapter, toolDeps)

  assert.ok(reply.ok)
  assert.match(reply.message.content, /not configured/)
  assert.equal(reply.execution.toolCalls?.length, 1)
  assert.equal(reply.execution.toolCalls[0].status, 'failed')
  assert.equal(reply.execution.toolCalls[0].error, 'not_configured')
})

test('STEP 13B: Unconfigured web.search is not advertised in model tool definitions', async () => {
  const db = freshDb()
  let modelReceivedTools: unknown = null

  const { adapter } = recordingAdapter((input) => {
    modelReceivedTools = input.tools
    return {
      content: 'I did not receive web.search since it is unconfigured.',
      finishReason: 'stop',
      usage: { inputTokens: 15, outputTokens: 10, totalTokens: 25 },
    }
  })

  const conversation = await createConversation(db, { workspaceId: WS })
  const researcher = await builtinByName(db, 'Researcher')

  // Execute without configured toolDeps -> web.search unconfigured
  const reply = await sendTo(db, conversation.id, researcher.id, 'Help me research.', adapter)

  assert.ok(reply.ok)
  const toolDefs = (modelReceivedTools ?? []) as Array<{ key: string }>
  assert.ok(
    !toolDefs.some((t) => t.key === 'web.search'),
    'Unconfigured web.search must not be sent to the model',
  )
})

/* ========================================================================= */
/* HARDENING H1B: Agent Tool Execution Approval Policy Integration Tests     */
/* ========================================================================= */

test('H1B: Direct Agent Tool AUTO executes adapter and returns results', async () => {
  const db = freshDb()
  await setApprovalPolicy(db, {
    workspaceId: WS,
    scopeType: 'workspace',
    scopeId: WS,
    actionKey: 'external.read',
    mode: 'auto',
  })

  let adapterCalled = false
  const mockClient = new MockWebSearchClient({
    results: [
      {
        title: 'Auto Result',
        url: 'https://example.com/auto',
        snippet: 'Ran under AUTO policy.',
      },
    ],
  })
  const customAdapter = createWebSearchAdapter({ client: mockClient })
  const toolDeps: ExecuteToolDeps = {
    adapters: new Map<ToolKey, ToolAdapter>([
      [
        'web.search',
        {
          key: 'web.search',
          isConfigured: () => true,
          async run(input) {
            adapterCalled = true
            return customAdapter.run(input)
          },
        },
      ],
    ]),
  }

  let turn = 0
  const { adapter } = recordingAdapter((input) => {
    turn += 1
    if (turn === 1) {
      return {
        content: null,
        toolCalls: [
          {
            id: 'call-auto',
            toolKey: 'web.search',
            args: { query: 'auto search' },
          },
        ],
        finishReason: 'tool_calls',
      }
    }
    const toolMsg = input.messages.find((m) => m.role === 'tool')
    assert.ok(toolMsg)
    assert.match(toolMsg.content, /Auto Result/)
    return {
      content: 'Here are the auto results.',
      finishReason: 'stop',
    }
  })

  const conversation = await createConversation(db, { workspaceId: WS })
  const researcher = await builtinByName(db, 'Researcher')

  const reply = await sendTo(db, conversation.id, researcher.id, 'Search auto.', adapter, toolDeps)

  assert.ok(reply.ok)
  assert.ok(adapterCalled, 'Adapter must be executed under AUTO policy')
  assert.equal(reply.execution.toolCalls?.[0]?.status, 'succeeded')

  // Zero approval requests should be created for AUTO
  const approvals = await listApprovalRequests(db, { workspaceId: WS })
  assert.equal(approvals.length, 0, 'No approval request must be created for AUTO mode')
})

test('H1B: Direct Agent Tool REVIEW creates Approval Request and does NOT execute adapter', async () => {
  const db = freshDb()
  // Default policy for external.read is review
  let adapterCalled = false
  const mockClient = new MockWebSearchClient({
    results: [{ title: 'Should Not Run', url: 'https://example.com/never' }],
  })
  const toolDeps: ExecuteToolDeps = {
    adapters: new Map<ToolKey, ToolAdapter>([
      [
        'web.search',
        {
          key: 'web.search',
          isConfigured: () => true,
          async run(input) {
            adapterCalled = true
            return createWebSearchAdapter({ client: mockClient }).run(input)
          },
        },
      ],
    ]),
  }

  let turn = 0
  const { adapter } = recordingAdapter((input) => {
    turn += 1
    if (turn === 1) {
      return {
        content: null,
        toolCalls: [
          {
            id: 'call-review',
            toolKey: 'web.search',
            args: { query: 'review query', limit: 5 },
          },
        ],
        finishReason: 'tool_calls',
      }
    }
    const toolMsg = input.messages.find((m) => m.role === 'tool')
    assert.ok(toolMsg)
    assert.match(toolMsg.content, /approval_required/)
    return {
      content: 'Web search needs your approval before it can run.',
      finishReason: 'stop',
    }
  })

  const conversation = await createConversation(db, { workspaceId: WS })
  const researcher = await builtinByName(db, 'Researcher')

  const reply = await sendTo(
    db,
    conversation.id,
    researcher.id,
    'Search review.',
    adapter,
    toolDeps,
  )

  assert.ok(reply.ok)
  assert.equal(adapterCalled, false, 'Tool adapter MUST NOT run under REVIEW policy')

  // Tool trace records approval_required
  assert.equal(reply.execution.toolCalls?.length, 1)
  assert.equal(reply.execution.toolCalls[0].status, 'failed')
  assert.equal(reply.execution.toolCalls[0].error, 'approval_required')

  // Real Approval Request created in database
  const approvals = await listApprovalRequests(db, { workspaceId: WS })
  assert.equal(approvals.length, 1, 'Real Approval Request must be created')
  const req = approvals[0]

  // Linkage assertions
  assert.equal(req.origin, 'agent')
  assert.equal(req.requestedByType, 'agent')
  assert.equal(req.requestedById, researcher.id)
  assert.equal(req.actionKey, 'external.read')
  assert.deepEqual(req.risks, ['read', 'external'])
  assert.equal(req.risk, 'read')
  assert.equal(req.conversationId, conversation.id)
  assert.ok(req.executionId, 'Execution ID must be populated')
  assert.equal(req.status, 'pending')
  assert.match(req.summary, /Researcher requests Web search/i)

  // Snapshot integrity & secret hygiene
  const snapshot = JSON.parse(req.snapshotJson)
  assert.equal(snapshot.toolKey, 'web.search')
  assert.deepEqual(snapshot.args, { query: 'review query', limit: 5 })
  assert.equal(snapshot.agentId, researcher.id)
  assert.ok(!req.snapshotJson.includes('API_KEY'))
  assert.ok(!req.snapshotJson.includes('secret'))
})

test('H1B: Duplicate identical pending request is deduplicated', async () => {
  const db = freshDb()
  const researcher = await builtinByName(db, 'Researcher')

  // Calling createApprovalRequest with identical fingerprint and executionId deduplicates
  const res1 = await createApprovalRequest(db, {
    workspaceId: WS,
    actionKey: 'external.read',
    origin: 'agent',
    requestedByType: 'agent',
    requestedById: researcher.id,
    executionId: 'exec-agent-1',
    summary: 'Researcher requests Web search',
    payload: {
      toolKey: 'web.search',
      args: { query: 'dedup query', limit: 5 },
    },
    risk: ['read', 'external'],
  })

  const res2 = await createApprovalRequest(db, {
    workspaceId: WS,
    actionKey: 'external.read',
    origin: 'agent',
    requestedByType: 'agent',
    requestedById: researcher.id,
    executionId: 'exec-agent-1',
    summary: 'Researcher requests Web search',
    payload: {
      toolKey: 'web.search',
      args: { query: 'dedup query', limit: 5 },
    },
    risk: ['read', 'external'],
  })

  assert.equal(res1.created, true)
  assert.equal(res2.created, false)
  assert.equal(res2.isDuplicate, true)
  assert.equal(res1.request?.id, res2.request?.id)

  const approvals = await listApprovalRequests(db, { workspaceId: WS })
  assert.equal(
    approvals.length,
    1,
    'Duplicate identical request must be deduplicated, not duplicated',
  )
})

test('H1B: Direct Agent Tool BLOCKED returns canonical blocked result and creates NO approval request', async () => {
  const db = freshDb()
  await setApprovalPolicy(db, {
    workspaceId: WS,
    scopeType: 'workspace',
    scopeId: WS,
    actionKey: 'external.read',
    mode: 'blocked',
  })

  let adapterCalled = false
  const mockClient = new MockWebSearchClient({
    results: [{ title: 'Should Never Run', url: 'https://example.com/blocked' }],
  })
  const toolDeps: ExecuteToolDeps = {
    adapters: new Map<ToolKey, ToolAdapter>([
      [
        'web.search',
        {
          key: 'web.search',
          isConfigured: () => true,
          async run(input) {
            adapterCalled = true
            return createWebSearchAdapter({ client: mockClient }).run(input)
          },
        },
      ],
    ]),
  }

  let turn = 0
  const { adapter } = recordingAdapter((input) => {
    turn += 1
    if (turn === 1) {
      return {
        content: null,
        toolCalls: [
          {
            id: 'call-blocked',
            toolKey: 'web.search',
            args: { query: 'blocked search' },
          },
        ],
        finishReason: 'tool_calls',
      }
    }
    const toolMsg = input.messages.find((m) => m.role === 'tool')
    assert.ok(toolMsg)
    assert.match(toolMsg.content, /blocked/)
    return {
      content: 'Web search is blocked by your Autonomy settings.',
      finishReason: 'stop',
    }
  })

  const conversation = await createConversation(db, { workspaceId: WS })
  const researcher = await builtinByName(db, 'Researcher')

  const reply = await sendTo(
    db,
    conversation.id,
    researcher.id,
    'Search blocked.',
    adapter,
    toolDeps,
  )

  assert.ok(reply.ok)
  assert.equal(adapterCalled, false, 'Adapter MUST NOT run when policy is BLOCKED')
  assert.equal(reply.execution.toolCalls?.[0]?.status, 'failed')
  assert.equal(reply.execution.toolCalls?.[0]?.error, 'blocked')

  // No approval request should be created for BLOCKED mode
  const approvals = await listApprovalRequests(db, { workspaceId: WS })
  assert.equal(approvals.length, 0, 'No approval request must be created for BLOCKED mode')
})

test('H1B: Capability denial happens before policy check even if policy is AUTO', async () => {
  const db = freshDb()
  await setApprovalPolicy(db, {
    workspaceId: WS,
    scopeType: 'workspace',
    scopeId: WS,
    actionKey: 'external.read',
    mode: 'auto',
  })

  let adapterCalled = false
  const mockClient = new MockWebSearchClient({
    results: [{ title: 'Unauthorized', url: 'https://example.com/unauth' }],
  })
  const toolDeps: ExecuteToolDeps = {
    adapters: new Map<ToolKey, ToolAdapter>([
      [
        'web.search',
        {
          key: 'web.search',
          isConfigured: () => true,
          async run(input) {
            adapterCalled = true
            return createWebSearchAdapter({ client: mockClient }).run(input)
          },
        },
      ],
    ]),
  }

  const { adapter } = recordingAdapter(() => {
    return {
      content: 'Creator cannot search web.',
      toolCalls: [
        {
          id: 'call-creator-search',
          toolKey: 'web.search',
          args: { query: 'creator search' },
        },
      ],
      finishReason: 'stop',
    }
  })

  const conversation = await createConversation(db, { workspaceId: WS })
  const creator = await builtinByName(db, 'Creator')

  const reply = await sendTo(db, conversation.id, creator.id, 'Search web.', adapter, toolDeps)

  assert.ok(reply.ok)
  assert.equal(adapterCalled, false)
  assert.equal(reply.execution.toolCalls?.[0]?.status, 'failed')
  assert.equal(reply.execution.toolCalls?.[0]?.error, 'capability_denied')

  const approvals = await listApprovalRequests(db, { workspaceId: WS })
  assert.equal(approvals.length, 0, 'Capability denied calls must never create approval requests')
})

test('H1B: Invalid Tool args reject with invalid_input and do not create Approval Request', async () => {
  const db = freshDb()
  const mockClient = new MockWebSearchClient({ results: [] })
  const toolDeps: ExecuteToolDeps = {
    adapters: new Map<ToolKey, ToolAdapter>([
      ['web.search', createWebSearchAdapter({ client: mockClient })],
    ]),
  }

  let turn = 0
  const { adapter } = recordingAdapter((input) => {
    turn += 1
    if (turn === 1) {
      return {
        content: null,
        toolCalls: [
          {
            id: 'call-invalid-query',
            toolKey: 'web.search',
            args: { query: '   ' }, // empty query fails validation
          },
        ],
        finishReason: 'tool_calls',
      }
    }
    const toolMsg = input.messages.find((m) => m.role === 'tool')
    assert.ok(toolMsg)
    assert.match(toolMsg.content, /invalid_input/)
    return {
      content: 'Invalid search query.',
      finishReason: 'stop',
    }
  })

  const conversation = await createConversation(db, { workspaceId: WS })
  const researcher = await builtinByName(db, 'Researcher')

  const reply = await sendTo(db, conversation.id, researcher.id, 'Search empty.', adapter, toolDeps)

  assert.ok(reply.ok)
  assert.equal(reply.execution.toolCalls?.[0]?.status, 'failed')
  assert.equal(reply.execution.toolCalls?.[0]?.error, 'invalid_input')

  const approvals = await listApprovalRequests(db, { workspaceId: WS })
  assert.equal(approvals.length, 0, 'Invalid input must not create approval request')
})

test('H1B: Unconfigured Tool rejects with not_configured and does not create Approval Request', async () => {
  const db = freshDb()
  const toolDeps: ExecuteToolDeps = {
    adapters: new Map<ToolKey, ToolAdapter>([
      ['web.search', createWebSearchAdapter({ client: null })], // unconfigured
    ]),
  }

  let turn = 0
  const { adapter } = recordingAdapter((input) => {
    turn += 1
    if (turn === 1) {
      return {
        content: null,
        toolCalls: [
          {
            id: 'call-unconf',
            toolKey: 'web.search',
            args: { query: 'unconfigured test' },
          },
        ],
        finishReason: 'tool_calls',
      }
    }
    const toolMsg = input.messages.find((m) => m.role === 'tool')
    assert.ok(toolMsg)
    assert.match(toolMsg.content, /not_configured/)
    return {
      content: 'Search not configured.',
      finishReason: 'stop',
    }
  })

  const conversation = await createConversation(db, { workspaceId: WS })
  const researcher = await builtinByName(db, 'Researcher')

  const reply = await sendTo(
    db,
    conversation.id,
    researcher.id,
    'Search unconfigured.',
    adapter,
    toolDeps,
  )

  assert.ok(reply.ok)
  assert.equal(reply.execution.toolCalls?.[0]?.status, 'failed')
  assert.equal(reply.execution.toolCalls?.[0]?.error, 'not_configured')

  const approvals = await listApprovalRequests(db, { workspaceId: WS })
  assert.equal(approvals.length, 0, 'Unconfigured tool must not create approval request')
})

test('H1B: Inactive agent cannot execute Tool request or create Approval Request', async () => {
  const db = freshDb()
  const mockClient = new MockWebSearchClient({ results: [] })
  const toolDeps: ExecuteToolDeps = {
    adapters: new Map<ToolKey, ToolAdapter>([
      ['web.search', createWebSearchAdapter({ client: mockClient })],
    ]),
  }

  const researcher = await builtinByName(db, 'Researcher')
  await setAgentStatus(db, researcher.id, 'disabled')

  const conversation = await createConversation(db, { workspaceId: WS })
  const { adapter } = recordingAdapter()

  const reply = await sendTo(
    db,
    conversation.id,
    researcher.id,
    'Search disabled.',
    adapter,
    toolDeps,
  )

  assert.ok(!reply.ok, 'Disabled agent reply must fail')
  const approvals = await listApprovalRequests(db, { workspaceId: WS })
  assert.equal(approvals.length, 0, 'Disabled agent must not create approval request')
})

test('H1B: Tool -> ActionKey mapping is shared and consistent across Workflows and Agents', async () => {
  assert.equal(resolveActionKeyForTool('web.search'), 'workspace.read')
  const defs = (await import('../src/server/tools/definitions.ts')).TOOL_DEFINITIONS
  const webDef = defs.find((d) => d.key === 'web.search')
  const postsDef = defs.find((d) => d.key === 'platform.get_posts')
  const analyticsDef = defs.find((d) => d.key === 'platform.get_analytics')
  const publishDef = defs.find((d) => d.key === 'platform.publish')
  const imageDef = defs.find((d) => d.key === 'image.generate')
  const memoryDef = defs.find((d) => d.key === 'memory.list_relevant')

  // 1. web.search maps to external.read
  assert.equal(resolveActionKeyForTool('web.search', webDef), 'external.read')
  // 2. platform.get_posts maps to external.read
  assert.equal(resolveActionKeyForTool('platform.get_posts', postsDef), 'external.read')
  // 3. platform.get_analytics maps to external.read
  assert.equal(resolveActionKeyForTool('platform.get_analytics', analyticsDef), 'external.read')
  // 4. platform.publish remains content.publish
  assert.equal(resolveActionKeyForTool('platform.publish', publishDef), 'content.publish')
  // 5. external write tool remains external.write
  assert.equal(resolveActionKeyForTool('image.generate', imageDef), 'external.write')
  // 6. destructive remains destructive.delete
  assert.equal(
    resolveActionKeyForTool('custom.delete', {
      key: 'files.read' as unknown as ToolKey,
      name: 'Delete',
      description: 'delete',
      category: 'workspace',
      inputSchema: null as any,
      outputSchema: null as any,
      requiredCapability: 'read_context',
      risk: ['destructive'],
      executionMode: 'sync',
      status: 'available',
      origin: 'internal',
      version: 1,
      cost: 'none',
      summarizeInput: () => ({}),
    }),
    'destructive.delete',
  )
  // 7. pure internal read remains workspace.read
  assert.equal(resolveActionKeyForTool('memory.list_relevant', memoryDef), 'workspace.read')
  // 8. approval:'required' alone on read tool does NOT turn it into external.write
  assert.equal(
    resolveActionKeyForTool('custom.read_gated', {
      key: 'files.read' as unknown as ToolKey,
      name: 'Gated Read',
      description: 'gated read',
      category: 'workspace',
      inputSchema: null as any,
      outputSchema: null as any,
      requiredCapability: 'read_context',
      risk: ['read'],
      executionMode: 'sync',
      status: 'available',
      origin: 'internal',
      version: 1,
      cost: 'none',
      approval: 'required',
      summarizeInput: () => ({}),
    }),
    'workspace.read',
  )
  // 12. Workflow and Agent resolver return same mapping
  assert.equal(resolveActionKeyForTool('platform.publish'), 'content.publish')
  assert.equal(resolveActionKeyForTool('workflow.run'), 'workflow.run')
  assert.equal(resolveActionKeyForTool('image.generate'), 'external.write')
  assert.equal(resolveActionKeyForTool('workspace.get_product'), 'workspace.read')
})

test('H1B: Agent cannot decide its own Approval Request (Anti-Self-Approval)', async () => {
  const db = freshDb()
  const researcher = await builtinByName(db, 'Researcher')

  // Create an approval request
  const approvalRes = await createApprovalRequest(db, {
    workspaceId: WS,
    actionKey: 'external.read',
    origin: 'agent',
    requestedByType: 'agent',
    requestedById: researcher.id,
    summary: 'Researcher web search',
    payload: { toolKey: 'web.search', query: 'self approve test' },
    risk: ['read', 'external'],
  })

  assert.ok(approvalRes.request)
  const requestId = approvalRes.request.id

  // Attempt to self-approve with actorType: 'agent'
  await assert.rejects(
    async () => {
      await decideApprovalRequest(db, {
        workspaceId: WS,
        requestId,
        decision: 'approved',
        actor: {
          actorType: 'agent' as unknown as 'user',
          actorId: researcher.id,
        },
      })
    },
    (err: Error) => {
      assert.ok(err instanceof ApprovalServiceError)
      assert.match(err.message, /Only human users or system can decide approval requests/i)
      return true
    },
  )

  // Status remains pending
  const req = await getApprovalRequest(db, { workspaceId: WS, id: requestId })
  assert.equal(req?.status, 'pending')
})

test('H1B: Zero API key or secret leakage in snapshot, trace, or event metadata', async () => {
  const db = freshDb()
  const mockClient = new MockWebSearchClient({ results: [] })
  const toolDeps: ExecuteToolDeps = {
    adapters: new Map<ToolKey, ToolAdapter>([
      ['web.search', createWebSearchAdapter({ client: mockClient })],
    ]),
  }

  const { adapter } = recordingAdapter((input) => {
    const isFirst = !input.messages.some((m) => m.role === 'tool')
    if (isFirst) {
      return {
        content: null,
        toolCalls: [
          {
            id: 'call-secret-check',
            toolKey: 'web.search',
            args: { query: 'secret test' },
          },
        ],
        finishReason: 'tool_calls',
      }
    }
    return {
      content: 'Done checking.',
      finishReason: 'stop',
    }
  })

  const conversation = await createConversation(db, { workspaceId: WS })
  const researcher = await builtinByName(db, 'Researcher')

  const reply = await sendTo(
    db,
    conversation.id,
    researcher.id,
    'Check secrets.',
    adapter,
    toolDeps,
  )
  assert.ok(reply.ok)

  // Inspect approval snapshot
  const approvals = await listApprovalRequests(db, { workspaceId: WS })
  assert.equal(approvals.length, 1)
  const snapshotStr = JSON.stringify(approvals[0])
  assert.ok(!snapshotStr.includes('BRAVE_API_KEY'))
  assert.ok(!snapshotStr.includes('WEB_SEARCH_API_KEY'))

  // Inspect message provider metadata
  assert.ok(reply.message.providerMetadataJson)
  assert.ok(!reply.message.providerMetadataJson.includes('BRAVE_API_KEY'))
  assert.ok(!reply.message.providerMetadataJson.includes('WEB_SEARCH_API_KEY'))

  // Inspect events emitted
  const events = await listRecentEvents(db, WS, '', 50)
  for (const evt of events) {
    const payload = JSON.stringify(evt)
    assert.ok(!payload.includes('BRAVE_API_KEY'))
    assert.ok(!payload.includes('WEB_SEARCH_API_KEY'))
  }
})

/* ========================================================================= */
/* HARDENING H1B.1: Hard Tool Approval Elevation and Multi-Risk Preservation */
/* ========================================================================= */

test('H1B.1: Hard-required tool under Policy AUTO elevates to REVIEW and creates real DB request', async () => {
  const db = freshDb()
  const { TOOL_DEFINITIONS } = await import('../src/server/tools/definitions.ts')

  // Policy for content.publish is AUTO
  await setApprovalPolicy(db, {
    workspaceId: WS,
    scopeType: 'workspace',
    scopeId: WS,
    actionKey: 'content.publish',
    mode: 'auto',
  })

  let adapterCalled = false
  const toolDeps: ExecuteToolDeps = {
    definitions: TOOL_DEFINITIONS.map((d) =>
      d.key === 'platform.publish' ? { ...d, status: 'available' } : d,
    ),
    adapters: new Map<ToolKey, ToolAdapter>([
      [
        'platform.publish',
        {
          key: 'platform.publish',
          isConfigured: () => true,
          async run() {
            adapterCalled = true
            return { ok: true, output: { publishedId: 'pub-1', url: 'https://example.com' } }
          },
        },
      ],
    ]),
  }

  const sampleAccountId = crypto.randomUUID()
  const sampleContentVariantId = crypto.randomUUID()

  const { adapter } = recordingAdapter((input) => {
    const isFirst = !input.messages.some((m) => m.role === 'tool')
    if (isFirst) {
      return {
        content: null,
        toolCalls: [
          {
            id: 'call-hard-publish',
            toolKey: 'platform.publish',
            args: {
              accountId: sampleAccountId,
              contentVariantId: sampleContentVariantId,
            },
          },
        ],
        finishReason: 'tool_calls',
      }
    }
    return {
      content: 'Publishing requires user approval.',
      finishReason: 'stop',
    }
  })

  const conversation = await createConversation(db, { workspaceId: WS })
  const publisher = await builtinByName(db, 'Publisher')
  await setAgentStatus(db, publisher.id, 'active')

  const reply = await sendTo(db, conversation.id, publisher.id, 'Publish post.', adapter, toolDeps)

  assert.ok(reply.ok)
  // 24. Adapter NOT called
  assert.equal(adapterCalled, false, 'Hard-gated tool adapter MUST NOT run without approval')

  // 25. Trace says approval_required
  assert.equal(reply.execution.toolCalls?.length, 1)
  assert.equal(reply.execution.toolCalls[0].status, 'failed')
  assert.equal(reply.execution.toolCalls[0].error, 'approval_required')

  // 23. Real Approval Request created in database
  const approvals = await listApprovalRequests(db, { workspaceId: WS })
  assert.equal(approvals.length, 1, 'Real Approval Request MUST exist in database')
  const req = approvals[0]

  // 26, 27. Request linked to execution and conversation
  assert.equal(req.actionKey, 'content.publish')
  assert.equal(req.conversationId, conversation.id)
  assert.ok(req.executionId)
  assert.equal(req.status, 'pending')
  assert.equal(req.policySource, 'tool_requirement')
  assert.equal(req.reason, 'Tool definition requires human approval')
  assert.deepEqual(req.risks, ['write', 'external'])
  assert.equal(req.risk, 'write')
  assert.match(req.summary, /Publisher requests Publish content/i)
})

test('H1B.1: Hard-required tool under Policy BLOCKED remains BLOCKED and creates NO request', async () => {
  const db = freshDb()
  const { TOOL_DEFINITIONS } = await import('../src/server/tools/definitions.ts')

  await setApprovalPolicy(db, {
    workspaceId: WS,
    scopeType: 'workspace',
    scopeId: WS,
    actionKey: 'content.publish',
    mode: 'blocked',
  })

  let adapterCalled = false
  const toolDeps: ExecuteToolDeps = {
    definitions: TOOL_DEFINITIONS.map((d) =>
      d.key === 'platform.publish' ? { ...d, status: 'available' } : d,
    ),
    adapters: new Map<ToolKey, ToolAdapter>([
      [
        'platform.publish',
        {
          key: 'platform.publish',
          isConfigured: () => true,
          async run() {
            adapterCalled = true
            return { ok: true, output: {} }
          },
        },
      ],
    ]),
  }

  const sampleAccountId = crypto.randomUUID()
  const sampleContentVariantId = crypto.randomUUID()

  const { adapter } = recordingAdapter((input) => {
    const isFirst = !input.messages.some((m) => m.role === 'tool')
    if (isFirst) {
      return {
        content: null,
        toolCalls: [
          {
            id: 'call-blocked-publish',
            toolKey: 'platform.publish',
            args: {
              accountId: sampleAccountId,
              contentVariantId: sampleContentVariantId,
            },
          },
        ],
        finishReason: 'tool_calls',
      }
    }
    return { content: 'Publish is blocked.', finishReason: 'stop' }
  })

  const conversation = await createConversation(db, { workspaceId: WS })
  const publisher = await builtinByName(db, 'Publisher')
  await setAgentStatus(db, publisher.id, 'active')

  const reply = await sendTo(db, conversation.id, publisher.id, 'Publish post.', adapter, toolDeps)

  assert.ok(reply.ok)
  // 31. Adapter NOT called
  assert.equal(adapterCalled, false)
  assert.equal(reply.execution.toolCalls?.[0]?.status, 'failed')
  assert.equal(reply.execution.toolCalls?.[0]?.error, 'blocked')

  // 30. No approval request created
  const approvals = await listApprovalRequests(db, { workspaceId: WS })
  assert.equal(approvals.length, 0, 'Blocked hard-required tool must NOT create approval request')
})

test('H1B.1: Approval Request preserves multi-risk array in database and backward compatibility', async () => {
  const db = freshDb()
  await setApprovalPolicy(db, {
    workspaceId: WS,
    scopeType: 'workspace',
    scopeId: WS,
    actionKey: 'external.write',
    mode: 'review',
  })

  // 14. image tool retains write + external + sensitive
  const resImage = await createApprovalRequest(db, {
    workspaceId: WS,
    actionKey: 'external.write',
    origin: 'agent',
    payload: { prompt: 'Generate logo' },
    risk: ['write', 'external', 'sensitive'],
  })
  assert.ok(resImage.request)
  assert.deepEqual(resImage.request.risks, ['write', 'external', 'sensitive'])
  assert.equal(resImage.request.risk, 'write')

  // 16. Legacy single-string row in DB loads cleanly into risks array
  const legacyId = crypto.randomUUID()
  const now = '2026-08-20T00:00:00.000Z'
  await db
    .prepare(
      `INSERT INTO approval (
        id, workspace_id, action_key, origin, requested_by_type, requested_by_id,
        subject_type, subject_id, summary, reason, resolved_mode, policy_source,
        risk, snapshot_json, fingerprint, status, expires_at, decision,
        decided_by_type, decided_by_id, decision_note, decided_at,
        workflow_id, run_id, step_id, execution_id, conversation_id,
        created_at, updated_at
      ) VALUES (?, ?, 'content.publish', 'agent', 'agent', NULL, NULL, NULL, 'Legacy request', 'Legacy reason', 'review', 'system_default', 'write', '{}', 'fp-legacy', 'pending', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    )
    .bind(legacyId, WS, now, now)
    .run()

  const loadedLegacy = await getApprovalRequest(db, { workspaceId: WS, id: legacyId })
  assert.ok(loadedLegacy)
  assert.deepEqual(loadedLegacy.risks, ['write'])
  assert.equal(loadedLegacy.risk, 'write')

  // 18, 19. Malformed stored risk string normalizes without crashing
  const malformedId = crypto.randomUUID()
  await db
    .prepare(
      `INSERT INTO approval (
        id, workspace_id, action_key, origin, requested_by_type, requested_by_id,
        subject_type, subject_id, summary, reason, resolved_mode, policy_source,
        risk, snapshot_json, fingerprint, status, expires_at, decision,
        decided_by_type, decided_by_id, decision_note, decided_at,
        workflow_id, run_id, step_id, execution_id, conversation_id,
        created_at, updated_at
      ) VALUES (?, ?, 'content.publish', 'agent', 'agent', NULL, NULL, NULL, 'Malformed request', 'Malformed reason', 'review', 'system_default', '["invalid_risk", "write", 123]', '{}', 'fp-malformed', 'pending', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    )
    .bind(malformedId, WS, now, now)
    .run()

  const loadedMalformed = await getApprovalRequest(db, { workspaceId: WS, id: malformedId })
  assert.ok(loadedMalformed)
  assert.deepEqual(loadedMalformed.risks, ['write'])
  assert.equal(loadedMalformed.risk, 'write')
})

test('H1B.1: executeTool static guard prevents direct unauthorized execution of hard-gated tools', async () => {
  const db = freshDb()
  const { executeTool } = await import('../src/server/tools/executor.ts')
  const { TOOL_DEFINITIONS } = await import('../src/server/tools/definitions.ts')
  const pubDef = TOOL_DEFINITIONS.find((d) => d.key === 'platform.publish')
  assert.equal(pubDef?.approval, 'required')

  const sampleAccountId = crypto.randomUUID()
  const sampleContentVariantId = crypto.randomUUID()
  const sampleAgentId = crypto.randomUUID()
  const sampleVersionId = crypto.randomUUID()

  // Call executeTool without approvalGranted
  const res = await executeTool(
    {
      db,
      workspaceId: WS,
      toolKey: 'platform.publish',
      args: {
        accountId: sampleAccountId,
        contentVariantId: sampleContentVariantId,
      },
      caller: {
        agentId: sampleAgentId,
        agentName: 'Publisher',
        agentStatus: 'active',
        agentVersionId: sampleVersionId,
        capabilities: ['publish'],
      },
      approvalGranted: false,
    },
    {
      definitions: TOOL_DEFINITIONS.map((d) =>
        d.key === 'platform.publish' ? { ...d, status: 'available' } : d,
      ),
      adapters: new Map([
        [
          'platform.publish',
          {
            key: 'platform.publish',
            isConfigured: () => true,
            async run() {
              return { ok: true, output: {} }
            },
          },
        ],
      ]),
    },
  )

  assert.equal(res.ok, false)
  assert.equal(res.error?.code, 'approval_required')
})

test('HARDENING H2A: Researcher receives real Tool inputSchema and executes multi-turn tool loop end to end', async () => {
  const db = freshDb()
  await setApprovalPolicy(db, {
    workspaceId: WS,
    scopeType: 'workspace',
    scopeId: WS,
    actionKey: 'external.read',
    mode: 'auto',
  })

  const mockClient = new MockWebSearchClient({
    resultsByQuery: {
      'latest AI trends': [
        {
          title: 'Trend 1: Agentic Systems',
          url: 'https://example.com/trend1',
          snippet: 'Agents are rising.',
        },
        {
          title: 'Trend 2: Reasoning Models',
          url: 'https://example.com/trend2',
          snippet: 'Reasoning is key.',
        },
      ],
    },
  })

  const toolDeps: ExecuteToolDeps = {
    adapters: new Map<ToolKey, ToolAdapter>([
      ['web.search', createWebSearchAdapter({ client: mockClient })],
    ]),
  }

  let turn = 0
  let capturedTools: unknown = null

  const { adapter } = recordingAdapter((input) => {
    turn += 1
    if (turn === 1) {
      capturedTools = input.tools
      return {
        content: null,
        toolCalls: [
          {
            id: 'call_h2a_search_1',
            toolKey: 'web.search',
            args: { query: 'latest AI trends', limit: 2 },
          },
        ],
        finishReason: 'tool_calls',
        usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 },
      }
    }

    // Turn 2: inspect continuation messages
    const toolMsg = input.messages.find((m) => m.role === 'tool')
    assert.ok(toolMsg, 'Must receive tool response message')
    assert.equal(toolMsg.toolCallId, 'call_h2a_search_1')
    assert.equal(toolMsg.toolKey, 'web.search')
    assert.ok(toolMsg.content.includes('Trend 1: Agentic Systems'))

    return {
      content: 'Here are the latest AI trends: Agentic Systems and Reasoning Models.',
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 },
    }
  })

  const conversation = await createConversation(db, { workspaceId: WS })
  const researcher = await builtinByName(db, 'Researcher')

  const reply = await sendTo(
    db,
    conversation.id,
    researcher.id,
    'What are the latest AI trends?',
    adapter,
    toolDeps,
  )

  assert.ok(reply.ok)
  assert.equal(
    reply.message.content,
    'Here are the latest AI trends: Agentic Systems and Reasoning Models.',
  )

  // Check that the model received real JSON schema for web.search
  const tools = capturedTools as Array<{ key: string; inputSchema: Record<string, unknown> }>
  assert.ok(Array.isArray(tools))
  const searchTool = tools.find((t) => t.key === 'web.search')
  assert.ok(searchTool)
  assert.ok(searchTool.inputSchema)
  assert.equal(searchTool.inputSchema.type, 'object')
  const props = searchTool.inputSchema.properties as Record<string, unknown>
  assert.ok(props.query)
  assert.ok(props.limit)

  // Verify tool execution
  assert.equal(mockClient.calls.length, 1)
  assert.equal(mockClient.calls[0].query, 'latest AI trends')
  assert.equal(mockClient.calls[0].limit, 2)
  assert.equal(reply.execution.toolCalls?.length, 1)
  assert.equal(reply.execution.toolCalls[0].status, 'succeeded')
})

test('HARDENING H2A: Server Zod validation strictly guards execution even with invalid model arguments', async () => {
  const db = freshDb()
  await setApprovalPolicy(db, {
    workspaceId: WS,
    scopeType: 'workspace',
    scopeId: WS,
    actionKey: 'external.read',
    mode: 'auto',
  })

  const mockClient = new MockWebSearchClient({
    results: [{ title: 'Never called', url: 'https://example.com' }],
  })

  const toolDeps: ExecuteToolDeps = {
    adapters: new Map<ToolKey, ToolAdapter>([
      ['web.search', createWebSearchAdapter({ client: mockClient })],
    ]),
  }

  let turn = 0
  const { adapter } = recordingAdapter((input) => {
    turn += 1
    if (turn === 1) {
      // Model sends limit 999 which violates limit <= 10 Zod schema
      return {
        content: null,
        toolCalls: [
          {
            id: 'call_invalid_limit',
            toolKey: 'web.search',
            args: { query: 'valid query', limit: 999 },
          },
        ],
        finishReason: 'tool_calls',
        usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 },
      }
    }

    // Turn 2: Model receives invalid_input error
    const toolMsg = input.messages.find((m) => m.role === 'tool')
    assert.ok(toolMsg)
    assert.match(toolMsg.content, /invalid_input/)
    return {
      content: 'I corrected my search parameter error.',
      finishReason: 'stop',
      usage: { inputTokens: 70, outputTokens: 10, totalTokens: 80 },
    }
  })

  const conversation = await createConversation(db, { workspaceId: WS })
  const researcher = await builtinByName(db, 'Researcher')

  const reply = await sendTo(
    db,
    conversation.id,
    researcher.id,
    'Search with bad params.',
    adapter,
    toolDeps,
  )

  assert.ok(reply.ok)
  assert.equal(mockClient.calls.length, 0, 'Adapter must never be invoked on invalid args')
  assert.equal(reply.execution.toolCalls?.length, 1)
  assert.equal(reply.execution.toolCalls[0].status, 'failed')
  assert.equal(reply.execution.toolCalls[0].error, 'invalid_input')
})

test('HARDENING H2A: Multiple tool calls in one turn preserve separate correlation IDs', async () => {
  const db = freshDb()
  await setApprovalPolicy(db, {
    workspaceId: WS,
    scopeType: 'workspace',
    scopeId: WS,
    actionKey: 'external.read',
    mode: 'auto',
  })

  const mockClient = new MockWebSearchClient({
    resultsByQuery: {
      'topic one': [{ title: 'Topic 1', url: 'https://topic1.com' }],
      'topic two': [{ title: 'Topic 2', url: 'https://topic2.com' }],
    },
  })

  const toolDeps: ExecuteToolDeps = {
    adapters: new Map<ToolKey, ToolAdapter>([
      ['web.search', createWebSearchAdapter({ client: mockClient })],
    ]),
  }

  let turn = 0
  const { adapter } = recordingAdapter((input) => {
    turn += 1
    if (turn === 1) {
      return {
        content: null,
        toolCalls: [
          { id: 'call_first_topic', toolKey: 'web.search', args: { query: 'topic one' } },
          { id: 'call_second_topic', toolKey: 'web.search', args: { query: 'topic two' } },
        ],
        finishReason: 'tool_calls',
        usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
      }
    }

    // Turn 2: verify each tool message has its own correlated ID
    const toolMsgs = input.messages.filter((m) => m.role === 'tool')
    assert.equal(toolMsgs.length, 2)
    assert.equal(toolMsgs[0].toolCallId, 'call_first_topic')
    assert.ok(toolMsgs[0].content.includes('Topic 1'))
    assert.equal(toolMsgs[1].toolCallId, 'call_second_topic')
    assert.ok(toolMsgs[1].content.includes('Topic 2'))

    return {
      content: 'Combined summary of topic one and topic two.',
      finishReason: 'stop',
      usage: { inputTokens: 120, outputTokens: 20, totalTokens: 140 },
    }
  })

  const conversation = await createConversation(db, { workspaceId: WS })
  const researcher = await builtinByName(db, 'Researcher')

  const reply = await sendTo(
    db,
    conversation.id,
    researcher.id,
    'Compare topic one and two.',
    adapter,
    toolDeps,
  )

  assert.ok(reply.ok)
  assert.equal(mockClient.calls.length, 2)
  assert.equal(reply.execution.toolCalls?.length, 2)
  assert.equal(reply.execution.toolCalls[0].status, 'succeeded')
  assert.equal(reply.execution.toolCalls[1].status, 'succeeded')
})
