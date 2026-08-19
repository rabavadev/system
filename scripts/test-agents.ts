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
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
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
  addAgentVersion,
  createAgent,
  createAgentInput,
  getAgentById,
  getAgentVersion,
  listAgents,
  listAgentVersions,
  setAgentStatus,
} from '../src/server/db/agent.ts'
import { createConversation, getConversationById } from '../src/server/db/conversation.ts'
import { appendUserMessage, listMessages } from '../src/server/db/message.ts'
import type { SqlDatabase } from '../src/server/db/sql.ts'

const ROOT = new URL('..', import.meta.url).pathname
const TMP = join(ROOT, 'node_modules/.cache/test-agents.sqlite')

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
function recordingAdapter(handler?: () => AIAdapterRawResponse): {
  adapter: AIProviderAdapter
  calls: { model: string; messages: { role: string; content: string }[] }[]
} {
  const calls: { model: string; messages: { role: string; content: string }[] }[] = []
  return {
    calls,
    adapter: {
      key: 'workers-ai',
      async execute(input) {
        calls.push(input)
        return (
          handler?.() ?? {
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
) {
  await appendUserMessage(db, { conversationId, content: text })
  return runAgentReply({
    db,
    workspaceId: WS,
    conversationId,
    agentId,
    userText: text,
    deps: depsFor(adapter),
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

test('34/35. Researcher promises no live research; Publisher cannot publish', async () => {
  const db = freshDb()
  await ensureBuiltinAgents(db, WS)
  const researcher = await builtinByName(db, 'Researcher')
  const rConfig = parseAgentVersionConfig(
    (await getAgentVersion(db, researcher.currentVersionId ?? ''))?.configJson ?? '',
  )
  assert.ok(rConfig)
  assert.match(rConfig.instructions, /Live web research is not enabled yet/i)
  assert.match(rConfig.instructions, /[Nn]ever pretend you searched/i)

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
