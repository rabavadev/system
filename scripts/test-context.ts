/**
 * Context Engine tests (npm run test:context).
 *
 * Runs the real engine (src/server/context) and the real context
 * repository (src/server/db/context.ts) against a fresh better-sqlite3
 * database migrated from migrations/. The engine takes a structural
 * SqlDatabase, which better-sqlite3 satisfies via the shim below — the
 * same SQL the Worker runs, tested in plain node.
 *
 * Covers the STEP 5 contract: scope sources and precedence, relationship
 * validation and conflicts, cross-workspace isolation, archived handling,
 * bounded deterministic messages, memory retrieval/ranking/validity,
 * research freshness, goals, trace quality, serialization and secret
 * safety.
 */

import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import type { ContextPackage, ContextRequest } from '../src/server/context/index.ts'
import { buildContext, ContextError } from '../src/server/context/index.ts'
import type { SqlDatabase } from '../src/server/db/sql.ts'

const ROOT = new URL('..', import.meta.url).pathname
const TMP = join(ROOT, 'node_modules/.cache/test-context.sqlite')

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

function freshDb(): Database.Database {
  rmSync(TMP, { force: true })
  mkdirSync(join(ROOT, 'node_modules/.cache'), { recursive: true })
  const db = new Database(TMP)
  db.pragma('foreign_keys = ON')
  const dir = join(ROOT, 'migrations')
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(join(dir, file), 'utf8'))
  }
  return db
}

/* ---- fixture ---- */

const BASE = Date.now()
const ts = (offsetSeconds: number) => new Date(BASE + offsetSeconds * 1000).toISOString()
const id = () => crypto.randomUUID()

const WS1 = id()
const WS2 = id()
const PLAT1 = id()
const BA = id()
const BB = id()
const BZ = id()
const BRAND_ARCH = id()
const NA1 = id()
const NB1 = id()
const NICHE_ARCH = id()
const PRA1 = id()
const PRB1 = id()
const PRODUCT_ARCH = id()
const ACC_A = id()
const ACC_MULTI = id()
const ACC_NONE = id()
const ACC_Z = id()
const ACCOUNT_ARCH = id()
const CAM_A = id()
const CONV_GEN = id()
const CONV_BA = id()
const CONV_PRB = id()
const CONV_ARCH = id()
const CONV_Z = id()

const MEM_WS = id()
const MEM_BA = id()
const MEM_NA1 = id()
const MEM_PRA1 = id()
const MEM_PRA1_VL = id()
const MEM_PROP = id()
const MEM_TEMP = id()
const MEM_EXP = id()
const MEM_SUPER = id()
const MEM_REJ = id()
const MEM_BB = id()
const MEM_Z = id()
const MEM_PLAT1 = id()
const MEM_EXTRA: string[] = []

const RES_BA_CUR = id()
const RES_BA_STALE = id()
const RES_BA_AGING = id()
const RES_BA_EXP = id()
const RES_BA_DRAFT = id()
const RES_WS = id()
const RES_BB = id()

const GOAL_WS = id()
const GOAL_BA = id()
const GOAL_PRA1 = id()
const GOAL_DONE = id()
const GOAL_BB = id()

const SECRET_REF = 'SECRET-REF-XYZ'
const SECRET_TOKEN = 'access_token_abc123'

let db: Database.Database
let sqlDb: SqlDatabase

function setup(): void {
  db = freshDb()
  sqlDb = shim(db)

  const ws = db.prepare(
    `INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  )
  ws.run(WS1, 'Workspace One', 'one', ts(0), ts(0))
  ws.run(WS2, 'Workspace Two', 'two', ts(0), ts(0))

  db.prepare(`INSERT INTO platform (id, adapter_key, name, created_at) VALUES (?, ?, ?, ?)`).run(
    PLAT1,
    'pinterest',
    'Pinterest',
    ts(0),
  )

  const brand = db.prepare(
    `INSERT INTO brand (id, workspace_id, name, description, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  brand.run(BA, WS1, 'Brand A', 'first brand', ts(1), ts(1), null)
  brand.run(BB, WS1, 'Brand B', 'second brand', ts(2), ts(2), null)
  brand.run(BZ, WS2, 'Brand Z', 'other workspace', ts(3), ts(3), null)
  brand.run(BRAND_ARCH, WS1, 'Brand Archived', null, ts(4), ts(4), ts(4))

  const niche = db.prepare(
    `INSERT INTO niche (id, brand_id, name, description, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  niche.run(NA1, BA, 'Niche A1', null, ts(5), ts(5), null)
  niche.run(NB1, BB, 'Niche B1', null, ts(6), ts(6), null)
  niche.run(NICHE_ARCH, BA, 'Niche Archived', null, ts(7), ts(7), ts(7))

  const product = db.prepare(
    `INSERT INTO product (id, brand_id, niche_id, name, description, url, status, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  product.run(PRA1, BA, NA1, 'Product A1', null, null, 'active', ts(8), ts(8), null)
  product.run(PRB1, BB, NB1, 'Product B1', null, null, 'active', ts(9), ts(9), null)
  product.run(
    PRODUCT_ARCH,
    BA,
    null,
    'Product Archived',
    null,
    null,
    'archived',
    ts(10),
    ts(10),
    null,
  )

  const account = db.prepare(
    `INSERT INTO account (id, workspace_id, platform_id, handle, display_name, primary_niche_id, status, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  account.run(ACC_A, WS1, PLAT1, '@account_a', 'Account A', NA1, 'active', ts(11), ts(11), null)
  account.run(ACC_MULTI, WS1, PLAT1, '@account_multi', null, null, 'active', ts(12), ts(12), null)
  account.run(ACC_NONE, WS1, PLAT1, '@account_none', null, null, 'active', ts(13), ts(13), null)
  account.run(ACC_Z, WS2, PLAT1, '@account_z', null, null, 'active', ts(14), ts(14), null)
  account.run(
    ACCOUNT_ARCH,
    WS1,
    PLAT1,
    '@account_arch',
    null,
    null,
    'archived',
    ts(15),
    ts(15),
    null,
  )

  const accountNiche = db.prepare(
    `INSERT INTO account_niche (account_id, niche_id, created_at) VALUES (?, ?, ?)`,
  )
  accountNiche.run(ACC_A, NA1, ts(16))
  accountNiche.run(ACC_MULTI, NA1, ts(17))
  accountNiche.run(ACC_MULTI, NB1, ts(18))

  // A connection carrying secret-shaped data; none of it may leak.
  db.prepare(
    `INSERT INTO platform_connection (id, account_id, status, secret_ref, scopes, metadata, connected_at, created_at, updated_at)
     VALUES (?, ?, 'connected', ?, 'read write', ?, ?, ?, ?)`,
  ).run(id(), ACC_A, SECRET_REF, `{"token":"${SECRET_TOKEN}"}`, ts(19), ts(19), ts(19))

  db.prepare(
    `INSERT INTO campaign (id, workspace_id, brand_id, product_id, goal_id, name, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, 'active', ?, ?)`,
  ).run(CAM_A, WS1, BA, PRA1, 'Campaign A', ts(20), ts(20))

  const conversation = db.prepare(
    `INSERT INTO conversation (id, workspace_id, title, scope_type, scope_id, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  )
  conversation.run(CONV_GEN, WS1, 'General chat', null, null, ts(21), ts(21))
  conversation.run(CONV_BA, WS1, 'Brand A chat', 'brand', BA, ts(22), ts(22))
  conversation.run(CONV_PRB, WS1, 'Product B chat', 'product', PRB1, ts(23), ts(23))
  conversation.run(CONV_ARCH, WS1, 'Old chat', 'brand', BRAND_ARCH, ts(24), ts(24))
  conversation.run(CONV_Z, WS2, 'Foreign chat', null, null, ts(25), ts(25))

  const message = db.prepare(
    `INSERT INTO message (id, conversation_id, sender_type, content, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
  // CONV_GEN: two messages sharing one timestamp (rowid tiebreak) + one later.
  message.run(id(), CONV_GEN, 'user', 'first same-time', ts(30))
  message.run(id(), CONV_GEN, 'agent', 'second same-time', ts(30))
  message.run(id(), CONV_GEN, 'user', 'later message', ts(31))
  // CONV_BA: 50 messages to exercise the limit.
  for (let i = 0; i < 50; i++) {
    message.run(
      id(),
      CONV_BA,
      i % 2 === 0 ? 'user' : 'agent',
      `msg ${String(i).padStart(2, '0')}`,
      ts(100 + i),
    )
  }

  const memory = db.prepare(
    `INSERT INTO memory (id, workspace_id, memory_class, content, scope_type, scope_id, status,
                         confidence, source_type, source_id, evidence, superseded_by,
                         created_at, updated_at, last_verified_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', NULL, NULL, ?, ?, ?, ?, ?)`,
  )
  // scope relevance ladder
  memory.run(
    MEM_WS,
    WS1,
    'permanent_fact',
    'workspace fact',
    'workspace',
    null,
    'active',
    0.9,
    null,
    ts(200),
    ts(200),
    ts(200),
    null,
  )
  memory.run(
    MEM_BA,
    WS1,
    'verified_learning',
    'brand A learning',
    'brand',
    BA,
    'active',
    0.8,
    null,
    ts(201),
    ts(201),
    ts(201),
    null,
  )
  memory.run(
    MEM_NA1,
    WS1,
    'verified_learning',
    'niche A1 learning',
    'niche',
    NA1,
    'active',
    0.7,
    null,
    ts(202),
    ts(202),
    ts(202),
    null,
  )
  memory.run(
    MEM_PRA1,
    WS1,
    'permanent_fact',
    'product fact',
    'product',
    PRA1,
    'active',
    0.6,
    null,
    ts(203),
    ts(203),
    ts(203),
    null,
  )
  memory.run(
    MEM_PRA1_VL,
    WS1,
    'verified_learning',
    'product learning',
    'product',
    PRA1,
    'active',
    0.99,
    null,
    ts(204),
    ts(204),
    ts(204),
    null,
  )
  memory.run(
    MEM_PROP,
    WS1,
    'proposed_learning',
    'product hypothesis',
    'product',
    PRA1,
    'active',
    0.5,
    null,
    ts(205),
    ts(205),
    ts(205),
    null,
  )
  memory.run(
    MEM_TEMP,
    WS1,
    'temporary_context',
    'account temp',
    'account',
    ACC_A,
    'active',
    null,
    null,
    ts(206),
    ts(206),
    ts(206),
    null,
  )
  memory.run(
    MEM_PLAT1,
    WS1,
    'verified_learning',
    'platform learning',
    'platform',
    PLAT1,
    'active',
    0.7,
    null,
    ts(207),
    ts(207),
    ts(207),
    null,
  )
  // validity cases
  memory.run(
    MEM_EXP,
    WS1,
    'permanent_fact',
    'expired fact',
    'brand',
    BA,
    'active',
    1.0,
    null,
    ts(208),
    ts(208),
    ts(208),
    ts(-1000),
  )
  memory.run(
    MEM_SUPER,
    WS1,
    'verified_learning',
    'old learning',
    'brand',
    BA,
    'superseded',
    0.9,
    MEM_BA,
    ts(209),
    ts(209),
    ts(209),
    null,
  )
  memory.run(
    MEM_REJ,
    WS1,
    'proposed_learning',
    'rejected idea',
    'brand',
    BA,
    'rejected',
    0.4,
    null,
    ts(210),
    ts(210),
    ts(210),
    null,
  )
  // isolation
  memory.run(
    MEM_BB,
    WS1,
    'permanent_fact',
    'brand B fact',
    'brand',
    BB,
    'active',
    0.9,
    null,
    ts(211),
    ts(211),
    ts(211),
    null,
  )
  memory.run(
    MEM_Z,
    WS2,
    'permanent_fact',
    'workspace Z fact',
    'workspace',
    null,
    'active',
    0.9,
    null,
    ts(212),
    ts(212),
    ts(212),
    null,
  )
  // extra workspace memories for the limit test
  for (let i = 0; i < 6; i++) {
    const mid = id()
    MEM_EXTRA.push(mid)
    memory.run(
      mid,
      WS1,
      'temporary_context',
      `extra memory ${i}`,
      'workspace',
      null,
      'active',
      0.1,
      null,
      ts(300 + i),
      ts(300 + i),
      ts(300 + i),
      null,
    )
  }

  const research = db.prepare(
    `INSERT INTO research (id, workspace_id, subject, findings, status, confidence, scope_type, scope_id,
                           created_at, updated_at, last_verified_at, expires_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  )
  research.run(
    RES_BA_CUR,
    WS1,
    'Brand A current research',
    'findings',
    'completed',
    0.9,
    'brand',
    BA,
    ts(400),
    ts(400),
    ts(400),
    null,
  )
  research.run(
    RES_BA_STALE,
    WS1,
    'Brand A stale research',
    'findings',
    'stale',
    0.95,
    'brand',
    BA,
    ts(401),
    ts(401),
    ts(401),
    null,
  )
  research.run(
    RES_BA_AGING,
    WS1,
    'Brand A aging research',
    'findings',
    'completed',
    0.8,
    'brand',
    BA,
    ts(402),
    ts(402),
    ts(-120 * 24 * 3600),
    null,
  )
  research.run(
    RES_BA_EXP,
    WS1,
    'Brand A expired research',
    'findings',
    'completed',
    0.99,
    'brand',
    BA,
    ts(403),
    ts(403),
    ts(403),
    ts(-1000),
  )
  research.run(
    RES_BA_DRAFT,
    WS1,
    'Brand A draft research',
    null,
    'draft',
    null,
    'brand',
    BA,
    ts(404),
    ts(404),
    null,
    null,
  )
  research.run(
    RES_WS,
    WS1,
    'Workspace research',
    'findings',
    'completed',
    0.5,
    null,
    null,
    ts(405),
    ts(405),
    ts(405),
    null,
  )
  research.run(
    RES_BB,
    WS1,
    'Brand B research',
    'findings',
    'completed',
    0.9,
    'brand',
    BB,
    ts(406),
    ts(406),
    ts(406),
    null,
  )

  const goal = db.prepare(
    `INSERT INTO goal (id, workspace_id, scope_type, scope_id, title, description, target_metric_key,
                       target_value, status, due_at, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, NULL)`,
  )
  goal.run(GOAL_WS, WS1, 'workspace', null, 'Workspace goal', 'active', null, ts(500), ts(500))
  goal.run(GOAL_BA, WS1, 'brand', BA, 'Brand A goal', 'active', ts(60000), ts(501), ts(501))
  goal.run(
    GOAL_PRA1,
    WS1,
    'product',
    PRA1,
    'Product A1 goal',
    'active',
    ts(30000),
    ts(502),
    ts(502),
  )
  goal.run(GOAL_DONE, WS1, 'brand', BA, 'Achieved goal', 'achieved', null, ts(503), ts(503))
  goal.run(GOAL_BB, WS1, 'brand', BB, 'Brand B goal', 'active', null, ts(504), ts(504))
}

setup()

async function build(request: ContextRequest): Promise<ContextPackage> {
  return buildContext(sqlDb, request)
}

async function expectContextError(request: ContextRequest, code: string): Promise<ContextError> {
  try {
    await build(request)
  } catch (error) {
    assert.ok(error instanceof ContextError, `expected ContextError, got ${String(error)}`)
    assert.equal(error.code, code)
    return error
  }
  assert.fail(`expected ContextError '${code}', but buildContext succeeded`)
}

function traceEntries(pkg: ContextPackage, action: string, targetType: string) {
  return pkg.trace.entries.filter((e) => e.action === action && e.targetType === targetType)
}

/* ---- scope sources and precedence ---- */

test('1. workspace-only context resolves at workspace scope', async () => {
  const pkg = await build({ workspaceId: WS1 })
  assert.equal(pkg.workspace.id, WS1)
  assert.equal(pkg.activeScope.type, 'workspace')
  assert.equal(pkg.scopeSource, 'workspace')
  assert.equal(pkg.brand, null)
  assert.ok(pkg.memories.some((m) => m.id === MEM_WS))
  assert.ok(!pkg.memories.some((m) => m.id === MEM_BA))
})

test('2. brand context works', async () => {
  const pkg = await build({ workspaceId: WS1, brandId: BA })
  assert.equal(pkg.brand?.id, BA)
  assert.equal(pkg.activeScope.type, 'brand')
  assert.equal(pkg.scopeSource, 'explicit')
  assert.ok(pkg.memories.some((m) => m.id === MEM_BA))
  assert.ok(pkg.memories.some((m) => m.id === MEM_WS))
  assert.ok(!pkg.memories.some((m) => m.id === MEM_BB))
})

test('3. niche context inherits the correct brand', async () => {
  const pkg = await build({ workspaceId: WS1, nicheId: NA1 })
  assert.equal(pkg.niche?.id, NA1)
  assert.equal(pkg.brand?.id, BA)
  assert.equal(pkg.activeScope.type, 'niche')
})

test('4. product context resolves correct niche and brand', async () => {
  const pkg = await build({ workspaceId: WS1, productId: PRA1 })
  assert.equal(pkg.product?.id, PRA1)
  assert.equal(pkg.niche?.id, NA1)
  assert.equal(pkg.brand?.id, BA)
  assert.equal(pkg.activeScope.type, 'product')
})

test('5. account context resolves workspace, brand, platform and niches', async () => {
  const pkg = await build({ workspaceId: WS1, accountId: ACC_A })
  assert.equal(pkg.account?.id, ACC_A)
  assert.equal(pkg.brand?.id, BA)
  assert.equal(pkg.niche?.id, NA1)
  assert.equal(pkg.account?.platform.name, 'Pinterest')
  assert.equal(pkg.account?.platform.connectionStatus, 'connected')
  assert.deepEqual(pkg.account?.nicheIds, [NA1])
  assert.ok(pkg.memories.some((m) => m.id === MEM_PLAT1))
})

test('6. conversation persisted scope resolves', async () => {
  const pkg = await build({ conversationId: CONV_BA })
  assert.equal(pkg.conversation?.id, CONV_BA)
  assert.equal(pkg.brand?.id, BA)
  assert.equal(pkg.scopeSource, 'conversation')
})

test('7. explicit context overrides UI selection', async () => {
  const pkg = await build({ workspaceId: WS1, brandId: BA, uiSelection: { brandId: BB } })
  assert.equal(pkg.brand?.id, BA)
  assert.equal(pkg.scopeSource, 'explicit')
  const ignored = traceEntries(pkg, 'precedence', 'brand')
  assert.ok(ignored.some((e) => e.targetId === BB && e.reason.includes('explicit')))
})

test('8. persisted conversation scope overrides UI selection', async () => {
  const pkg = await build({ conversationId: CONV_BA, uiSelection: { brandId: BB } })
  assert.equal(pkg.brand?.id, BA)
  assert.equal(pkg.scopeSource, 'conversation')
})

test('9. UI selection used when no stronger scope exists', async () => {
  const pkg = await build({ workspaceId: WS1, uiSelection: { brandId: BB } })
  assert.equal(pkg.brand?.id, BB)
  assert.equal(pkg.scopeSource, 'ui')
})

/* ---- conflicts and isolation ---- */

test('10. conflicting explicit brand + product rejects', async () => {
  await expectContextError({ workspaceId: WS1, brandId: BB, productId: PRA1 }, 'scope_conflict')
})

test('11. conflicting niche + product rejects', async () => {
  await expectContextError({ workspaceId: WS1, nicheId: NB1, productId: PRA1 }, 'scope_conflict')
})

test('12. cross-workspace references reject', async () => {
  await expectContextError({ workspaceId: WS1, accountId: ACC_Z }, 'workspace_mismatch')
  await expectContextError({ workspaceId: WS1, conversationId: CONV_Z }, 'workspace_mismatch')
  const pkg = await build({ workspaceId: WS1, brandId: BA })
  assert.ok(!pkg.memories.some((m) => m.id === MEM_Z))
})

test('12b. explicit context conflicting with conversation scope rejects', async () => {
  await expectContextError({ conversationId: CONV_BA, productId: PRB1 }, 'conversation_mismatch')
  await expectContextError({ conversationId: CONV_PRB, brandId: BA }, 'conversation_mismatch')
})

test('12c. account tied to Brand A rejects explicit Brand B', async () => {
  await expectContextError({ workspaceId: WS1, accountId: ACC_A, brandId: BB }, 'scope_conflict')
})

test('12d. multi-brand account accepts a matching explicit brand', async () => {
  const pkg = await build({ workspaceId: WS1, accountId: ACC_MULTI, brandId: BB })
  assert.equal(pkg.account?.id, ACC_MULTI)
  assert.equal(pkg.brand?.id, BB)
})

/* ---- archived handling ---- */

test('13. archived brand is a controlled error', async () => {
  await expectContextError({ workspaceId: WS1, brandId: BRAND_ARCH }, 'entity_archived')
})

test('14. archived niche is a controlled error', async () => {
  await expectContextError({ workspaceId: WS1, nicheId: NICHE_ARCH }, 'entity_archived')
})

test('15. archived product and account are controlled errors', async () => {
  await expectContextError({ workspaceId: WS1, productId: PRODUCT_ARCH }, 'entity_archived')
  await expectContextError({ workspaceId: WS1, accountId: ACCOUNT_ARCH }, 'entity_archived')
})

test('15b. archived conversation scope degrades to historical reference', async () => {
  const pkg = await build({ conversationId: CONV_ARCH })
  assert.equal(pkg.brand, null)
  assert.equal(pkg.scopeSource, 'workspace')
  const excluded = traceEntries(pkg, 'excluded', 'brand')
  assert.ok(excluded.some((e) => e.targetId === BRAND_ARCH && e.reason.includes('historical')))
})

/* ---- messages ---- */

test('16. recent messages are bounded by the central limit', async () => {
  const pkg = await build({ conversationId: CONV_BA })
  assert.equal(pkg.recentMessages.length, 30)
  const small = await build({ conversationId: CONV_BA, limits: { recentMessages: 5 } })
  assert.equal(small.recentMessages.length, 5)
})

test('17. message ordering is deterministic and chronological', async () => {
  const pkg = await build({ conversationId: CONV_BA })
  const contents = pkg.recentMessages.map((m) => m.content)
  assert.deepEqual(
    contents,
    Array.from({ length: 30 }, (_, i) => `msg ${String(i + 20).padStart(2, '0')}`),
  )
  const gen = await build({ conversationId: CONV_GEN })
  assert.deepEqual(
    gen.recentMessages.map((m) => m.content),
    ['first same-time', 'second same-time', 'later message'],
  )
})

/* ---- memory ---- */

test('18. exact-scope memory outranks broader memory', async () => {
  const pkg = await build({ workspaceId: WS1, brandId: BA })
  const ids = pkg.memories.map((m) => m.id)
  assert.ok(ids.indexOf(MEM_BA) < ids.indexOf(MEM_WS))
})

test('19. permanent fact outranks verified learning at the same scope', async () => {
  const pkg = await build({ workspaceId: WS1, productId: PRA1 })
  const ids = pkg.memories.map((m) => m.id)
  assert.ok(ids.indexOf(MEM_PRA1) < ids.indexOf(MEM_PRA1_VL))
  assert.equal(pkg.memories.find((m) => m.id === MEM_PRA1)?.authority, 'fact')
})

test('20. verified learning outranks proposed learning', async () => {
  const pkg = await build({ workspaceId: WS1, productId: PRA1 })
  const ids = pkg.memories.map((m) => m.id)
  assert.ok(ids.indexOf(MEM_PRA1_VL) < ids.indexOf(MEM_PROP))
  assert.equal(pkg.memories.find((m) => m.id === MEM_PRA1_VL)?.authority, 'trusted')
})

test('21. proposed learning is always marked as hypothesis', async () => {
  const pkg = await build({ workspaceId: WS1, productId: PRA1 })
  const proposed = pkg.memories.find((m) => m.id === MEM_PROP)
  assert.ok(proposed)
  assert.equal(proposed.authority, 'hypothesis')
  assert.equal(proposed.memoryClass, 'proposed_learning')
})

test('22. expired memory is excluded and traced', async () => {
  const pkg = await build({ workspaceId: WS1, brandId: BA })
  assert.ok(!pkg.memories.some((m) => m.id === MEM_EXP))
  const excluded = traceEntries(pkg, 'excluded', 'memory')
  assert.ok(
    excluded.some((e) => e.targetId === MEM_EXP && e.reason.toLowerCase().includes('expired')),
  )
})

test('23. superseded memory is excluded and traced with its replacement', async () => {
  const pkg = await build({ workspaceId: WS1, brandId: BA })
  assert.ok(!pkg.memories.some((m) => m.id === MEM_SUPER))
  const excluded = traceEntries(pkg, 'excluded', 'memory')
  assert.ok(excluded.some((e) => e.targetId === MEM_SUPER && e.reason.includes(MEM_BA)))
  assert.ok(!pkg.memories.some((m) => m.id === MEM_REJ))
})

test('24. memory ordering is deterministic across runs', async () => {
  const a = await build({ workspaceId: WS1, productId: PRA1 })
  const b = await build({ workspaceId: WS1, productId: PRA1 })
  assert.deepEqual(
    a.memories.map((m) => m.id),
    b.memories.map((m) => m.id),
  )
})

test('25. memory limit is enforced and over-limit drops are traced', async () => {
  const pkg = await build({ workspaceId: WS1, limits: { maxMemories: 3 } })
  assert.equal(pkg.memories.length, 3)
  const excluded = traceEntries(pkg, 'excluded', 'memory')
  assert.ok(excluded.some((e) => e.reason.includes('memory limit')))
})

/* ---- research ---- */

test('26. fresh research outranks stale research', async () => {
  const pkg = await build({ workspaceId: WS1, brandId: BA })
  const ids = pkg.research.map((r) => r.id)
  assert.ok(ids.indexOf(RES_BA_CUR) < ids.indexOf(RES_BA_STALE))
  assert.equal(pkg.research.find((r) => r.id === RES_BA_STALE)?.freshness, 'stale')
  assert.equal(pkg.research.find((r) => r.id === RES_BA_CUR)?.freshness, 'current')
  assert.equal(pkg.research.find((r) => r.id === RES_BA_AGING)?.freshness, 'aging')
})

test('27. expired and unfinished research is excluded and traced', async () => {
  const pkg = await build({ workspaceId: WS1, brandId: BA })
  assert.ok(!pkg.research.some((r) => r.id === RES_BA_EXP))
  assert.ok(!pkg.research.some((r) => r.id === RES_BA_DRAFT))
  const excluded = traceEntries(pkg, 'excluded', 'research')
  assert.ok(
    excluded.some((e) => e.targetId === RES_BA_EXP && e.reason.toLowerCase().includes('expired')),
  )
  assert.ok(excluded.some((e) => e.targetId === RES_BA_DRAFT && e.reason.includes('draft')))
})

test('27b. workspace-level research with NULL scope resolves', async () => {
  const pkg = await build({ workspaceId: WS1, brandId: BA })
  assert.ok(pkg.research.some((r) => r.id === RES_WS))
  assert.ok(!pkg.research.some((r) => r.id === RES_BB))
})

test('28. research limit is enforced', async () => {
  const pkg = await build({ workspaceId: WS1, brandId: BA, limits: { maxResearch: 1 } })
  assert.equal(pkg.research.length, 1)
  assert.equal(pkg.research[0]?.id, RES_BA_CUR)
})

/* ---- goals ---- */

test('29. relevant goals are returned, unrelated and finished ones are not', async () => {
  const pkg = await build({ workspaceId: WS1, productId: PRA1 })
  const ids = pkg.goals.map((g) => g.id)
  assert.ok(ids.includes(GOAL_PRA1))
  assert.ok(ids.includes(GOAL_BA))
  assert.ok(ids.includes(GOAL_WS))
  assert.ok(!ids.includes(GOAL_BB))
  assert.ok(!ids.includes(GOAL_DONE))
})

test('30. goal ordering is deterministic and scope-specific', async () => {
  const pkg = await build({ workspaceId: WS1, productId: PRA1 })
  const ids = pkg.goals.map((g) => g.id)
  assert.ok(ids.indexOf(GOAL_PRA1) < ids.indexOf(GOAL_BA))
  assert.ok(ids.indexOf(GOAL_BA) < ids.indexOf(GOAL_WS))
})

/* ---- trace ---- */

test('31. trace explains inclusions with reasons', async () => {
  const pkg = await build({ workspaceId: WS1, productId: PRA1 })
  const included = traceEntries(pkg, 'included', 'brand')
  assert.ok(included.some((e) => e.targetId === BA && e.label === 'Brand A'))
  const memIncluded = traceEntries(pkg, 'included', 'memory')
  assert.ok(memIncluded.some((e) => e.targetId === MEM_PRA1 && e.reason.includes('permanent_fact')))
})

test('32. trace explains exclusions with reasons', async () => {
  const pkg = await build({ workspaceId: WS1, brandId: BA })
  const excluded = traceEntries(pkg, 'excluded', 'memory')
  assert.ok(excluded.length >= 3) // expired, superseded, rejected
  assert.ok(excluded.every((e) => e.reason.length > 0))
})

test('33. trace records UI-vs-conversation precedence', async () => {
  const pkg = await build({ conversationId: CONV_BA, uiSelection: { brandId: BB } })
  const precedence = traceEntries(pkg, 'precedence', 'brand')
  assert.ok(
    precedence.some((e) => e.targetId === BB && e.reason.includes('persisted')),
    'expected a precedence entry explaining the ignored UI brand',
  )
})

/* ---- serialization and safety ---- */

test('34. the package survives JSON serialization unchanged', async () => {
  const pkg = await build({ workspaceId: WS1, productId: PRA1, conversationId: undefined })
  assert.deepStrictEqual(JSON.parse(JSON.stringify(pkg)), pkg)
})

test('35. no secrets or secret references enter the package or trace', async () => {
  const pkg = await build({ workspaceId: WS1, accountId: ACC_A })
  const serialized = JSON.stringify(pkg)
  assert.ok(!serialized.includes(SECRET_REF))
  assert.ok(!serialized.includes(SECRET_TOKEN))
  assert.ok(!serialized.includes('secret_ref'))
  assert.ok(!serialized.includes('access_token'))
  assert.ok(!serialized.includes('refresh_token'))
})

test('36. the package carries no provider-specific shapes', async () => {
  const pkg = await build({ conversationId: CONV_GEN })
  for (const message of pkg.recentMessages) {
    // STEP 8 added agentName (display label); still no provider shapes.
    assert.deepEqual(Object.keys(message).sort(), [
      'agentId',
      'agentName',
      'content',
      'createdAt',
      'id',
      'senderType',
    ])
  }
  assert.ok(!('providerMetadataJson' in pkg))
  assert.ok(!('messages' in pkg && !('recentMessages' in pkg)))
})

/* ---- campaign (structural) ---- */

test('37. campaign context resolves its brand and product chain', async () => {
  const pkg = await build({ workspaceId: WS1, campaignId: CAM_A })
  assert.equal(pkg.campaign?.id, CAM_A)
  assert.equal(pkg.brand?.id, BA)
  assert.equal(pkg.product?.id, PRA1)
  assert.equal(pkg.activeScope.type, 'campaign')
})

test('38. unknown entity ids are controlled not-found errors', async () => {
  await expectContextError({ workspaceId: WS1, brandId: id() }, 'entity_not_found')
  await expectContextError({ conversationId: id() }, 'entity_not_found')
})
