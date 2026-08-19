/**
 * Memory behavior tests (npm run test:memory).
 *
 * Runs the real structural memory repository, transition rules, Context
 * Engine integration, wire validation and view filtering against a fresh
 * better-sqlite3 database migrated from migrations/.
 */

import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import Database from 'better-sqlite3'

import { memoriesForTab } from '../src/features/memory/memory-view.ts'
import type { MemoryListItem } from '../src/features/memory/server.ts'
import { createMemoryWire } from '../src/features/memory/wire.ts'
import { buildContext } from '../src/server/context/index.ts'
import { createConversation } from '../src/server/db/conversation.ts'
import {
  archiveMemory,
  createMemory,
  getMemoryById,
  getMemorySummaryById,
  listMemories,
  markMemorySuperseded,
  rejectMemory,
  restoreMemory,
  supersedeMemory,
  updateMemory,
  validateMemoryScope,
  verifyMemory,
} from '../src/server/db/memory.ts'
import { appendMessage, appendUserMessage } from '../src/server/db/message.ts'
import type { SqlDatabase } from '../src/server/db/sql.ts'
import { evidenceTextToJson, parseEvidence } from '../src/server/memory/rules.ts'

const ROOT = new URL('..', import.meta.url).pathname
const TMP = join(ROOT, 'node_modules/.cache/test-memory.sqlite')

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

const WS1 = crypto.randomUUID()
const WS2 = crypto.randomUUID()
const PLATFORM = crypto.randomUUID()
const BRAND_A = crypto.randomUUID()
const BRAND_B = crypto.randomUUID()
const BRAND_Z = crypto.randomUUID()
const NICHE_A = crypto.randomUUID()
const NICHE_B = crypto.randomUUID()
const PRODUCT_A = crypto.randomUUID()
const PRODUCT_B = crypto.randomUUID()
const ACCOUNT_A = crypto.randomUUID()
const CAMPAIGN_A = crypto.randomUUID()
const NOW = '2026-08-19T00:00:00.000Z'

function futureIso(hours = 24): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString()
}

function pastIso(hours = 24): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()
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
  sqlite
    .prepare(
      `INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)`,
    )
    .run(WS1, 'Workspace One', NOW, NOW)
  sqlite
    .prepare(
      `INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)`,
    )
    .run(WS2, 'Workspace Two', NOW, NOW)
  sqlite
    .prepare(
      `INSERT INTO platform (id, adapter_key, name, created_at) VALUES (?, 'pinterest', 'Pinterest', ?)`,
    )
    .run(PLATFORM, NOW)
  const brand = sqlite.prepare(
    `INSERT INTO brand (id, workspace_id, name, description, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)`,
  )
  brand.run(BRAND_A, WS1, 'Brand A', NOW, NOW)
  brand.run(BRAND_B, WS1, 'Brand B', NOW, NOW)
  brand.run(BRAND_Z, WS2, 'Brand Z', NOW, NOW)
  const niche = sqlite.prepare(
    `INSERT INTO niche (id, brand_id, name, description, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)`,
  )
  niche.run(NICHE_A, BRAND_A, 'Niche A', NOW, NOW)
  niche.run(NICHE_B, BRAND_B, 'Niche B', NOW, NOW)
  const product = sqlite.prepare(
    `INSERT INTO product (id, brand_id, niche_id, name, description, url, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, NULL, 'active', ?, ?)`,
  )
  product.run(PRODUCT_A, BRAND_A, NICHE_A, 'Product A', NOW, NOW)
  product.run(PRODUCT_B, BRAND_B, NICHE_B, 'Product B', NOW, NOW)
  sqlite
    .prepare(
      `INSERT INTO account (id, workspace_id, platform_id, handle, display_name, primary_niche_id, status, created_at, updated_at)
       VALUES (?, ?, ?, '@account_a', 'Account A', ?, 'active', ?, ?)`,
    )
    .run(ACCOUNT_A, WS1, PLATFORM, NICHE_A, NOW, NOW)
  sqlite
    .prepare(`INSERT INTO account_niche (account_id, niche_id, created_at) VALUES (?, ?, ?)`)
    .run(ACCOUNT_A, NICHE_A, NOW)
  sqlite
    .prepare(
      `INSERT INTO campaign (id, workspace_id, brand_id, product_id, goal_id, name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 'Campaign A', 'active', ?, ?)`,
    )
    .run(CAMPAIGN_A, WS1, BRAND_A, PRODUCT_A, NOW, NOW)
  return shim(sqlite)
}

async function contextMemoryIds(db: SqlDatabase, request: Parameters<typeof buildContext>[1]) {
  const pkg = await buildContext(db, request)
  return pkg.memories.map((memory) => memory.id)
}

test('create permanent fact, verified learning, proposed learning and temporary context', async () => {
  const db = freshDb()
  const fact = await createMemory(db, {
    workspaceId: WS1,
    memoryClass: 'permanent_fact',
    content: 'Use simple, non-technical language.',
  })
  assert.equal(fact.status, 'active')
  assert.ok(fact.lastVerifiedAt)

  const verified = await createMemory(db, {
    workspaceId: WS1,
    memoryClass: 'verified_learning',
    content: 'Question hooks produced higher CTR.',
    confidence: 0.85,
    evidenceJson: evidenceTextToJson('18 comparable Pins.'),
  })
  assert.equal(verified.confidence, 0.85)
  assert.ok(verified.lastVerifiedAt)

  const proposed = await createMemory(db, {
    workspaceId: WS1,
    memoryClass: 'proposed_learning',
    content: 'Tax content may outperform budgeting content.',
  })
  assert.equal(proposed.lastVerifiedAt, null)

  const temporary = await createMemory(db, {
    workspaceId: WS1,
    memoryClass: 'temporary_context',
    content: 'This week we are testing tax positioning.',
    expiresAt: futureIso(),
  })
  assert.equal(temporary.confidence, null)
  assert.ok(temporary.expiresAt)
})

test('workspace, brand, niche, product, account, platform and campaign scopes validate', async () => {
  const db = freshDb()
  const scopes = [
    { scopeType: 'workspace' as const, scopeId: null },
    { scopeType: 'brand' as const, scopeId: BRAND_A },
    { scopeType: 'niche' as const, scopeId: NICHE_A },
    { scopeType: 'product' as const, scopeId: PRODUCT_A },
    { scopeType: 'account' as const, scopeId: ACCOUNT_A },
    { scopeType: 'platform' as const, scopeId: PLATFORM },
    { scopeType: 'campaign' as const, scopeId: CAMPAIGN_A },
  ]
  for (const scope of scopes) {
    const memory = await createMemory(db, {
      workspaceId: WS1,
      memoryClass: 'permanent_fact',
      content: `${scope.scopeType} memory`,
      ...scope,
    })
    assert.equal(memory.scopeType, scope.scopeType)
    assert.equal(memory.scopeId, scope.scopeId)
  }

  const productScope = await validateMemoryScope(db, WS1, 'product', PRODUCT_A, {
    brandId: BRAND_A,
    nicheId: NICHE_A,
  })
  assert.equal(productScope.path, 'Brand A / Niche A / Product A')
})

test('invalid cross-workspace and cross-brand scopes are rejected', async () => {
  const db = freshDb()
  await assert.rejects(
    createMemory(db, {
      workspaceId: WS1,
      memoryClass: 'permanent_fact',
      content: 'Foreign brand',
      scopeType: 'brand',
      scopeId: BRAND_Z,
    }),
    /not available/,
  )
  await assert.rejects(
    createMemory(db, {
      workspaceId: WS1,
      memoryClass: 'permanent_fact',
      content: 'Wrong brand product',
      scopeType: 'product',
      scopeId: PRODUCT_A,
      expectedBrandId: BRAND_B,
    }),
    /different brand/,
  )
  await assert.rejects(
    createMemory(db, {
      workspaceId: WS1,
      memoryClass: 'permanent_fact',
      content: 'Wrong account brand',
      scopeType: 'account',
      scopeId: ACCOUNT_A,
      expectedBrandId: BRAND_B,
    }),
    /not associated/,
  )
})

test('archive and restore preserve memory and Context Engine excludes archived rows', async () => {
  const db = freshDb()
  const memory = await createMemory(db, {
    workspaceId: WS1,
    memoryClass: 'permanent_fact',
    content: 'Brand rule',
    scopeType: 'brand',
    scopeId: BRAND_A,
  })
  assert.ok(
    (await contextMemoryIds(db, { workspaceId: WS1, brandId: BRAND_A })).includes(memory.id),
  )

  const archived = await archiveMemory(db, memory.id)
  assert.equal(archived.status, 'archived')
  assert.ok(
    !(await contextMemoryIds(db, { workspaceId: WS1, brandId: BRAND_A })).includes(memory.id),
  )

  const restored = await restoreMemory(db, memory.id)
  assert.equal(restored.status, 'active')
  assert.ok(
    (await contextMemoryIds(db, { workspaceId: WS1, brandId: BRAND_A })).includes(memory.id),
  )
})

test('proposed learning verifies only with evidence and stores verification data', async () => {
  const db = freshDb()
  const proposed = await createMemory(db, {
    workspaceId: WS1,
    memoryClass: 'proposed_learning',
    content: 'Short hooks may work better.',
    scopeType: 'brand',
    scopeId: BRAND_A,
  })
  let pkg = await buildContext(db, { workspaceId: WS1, brandId: BRAND_A })
  assert.equal(pkg.memories.find((memory) => memory.id === proposed.id)?.authority, 'hypothesis')

  await assert.rejects(
    verifyMemory(db, { id: proposed.id, confidence: 0.8, evidenceJson: '' }),
    /evidence/i,
  )
  const verified = await verifyMemory(db, {
    id: proposed.id,
    confidence: 0.85,
    evidenceJson: evidenceTextToJson('Observed across 18 comparable Pins.') ?? '',
  })
  assert.equal(verified.memoryClass, 'verified_learning')
  assert.equal(verified.confidence, 0.85)
  assert.ok(verified.lastVerifiedAt)
  assert.equal(parseEvidence(verified.evidenceJson)[0]?.text, 'Observed across 18 comparable Pins.')

  pkg = await buildContext(db, { workspaceId: WS1, brandId: BRAND_A })
  assert.equal(pkg.memories.find((memory) => memory.id === proposed.id)?.authority, 'trusted')
})

test('supersession preserves history, rejects self-supersession and hides old context', async () => {
  const db = freshDb()
  const old = await createMemory(db, {
    workspaceId: WS1,
    memoryClass: 'permanent_fact',
    content: 'Our main audience is freelance designers.',
    scopeType: 'brand',
    scopeId: BRAND_A,
  })
  const result = await supersedeMemory(db, old.id, {
    workspaceId: WS1,
    memoryClass: 'permanent_fact',
    content: 'Our strongest buyers are freelance developers and designers.',
    scopeType: 'brand',
    scopeId: BRAND_A,
  })
  assert.equal(result.previous.status, 'superseded')
  assert.equal(result.previous.supersededBy, result.replacement.id)
  assert.equal(result.replacement.status, 'active')
  assert.ok(await getMemoryById(db, old.id), 'old memory remains stored')

  const ids = await contextMemoryIds(db, { workspaceId: WS1, brandId: BRAND_A })
  assert.ok(!ids.includes(old.id))
  assert.ok(ids.includes(result.replacement.id))

  await assert.rejects(markMemorySuperseded(db, old.id, old.id), /replace itself/)
})

test('expiry is derived and temporary expired memory stays out of context', async () => {
  const db = freshDb()
  const temporary = await createMemory(db, {
    workspaceId: WS1,
    memoryClass: 'temporary_context',
    content: 'Expired launch push.',
    expiresAt: pastIso(),
  })
  assert.equal(temporary.status, 'active')
  const summary = await getMemorySummaryById(db, temporary.id)
  assert.equal(summary?.freshness, 'expired')
  assert.ok(!(await contextMemoryIds(db, { workspaceId: WS1 })).includes(temporary.id))

  const currentTemporary = await createMemory(db, {
    workspaceId: WS1,
    memoryClass: 'temporary_context',
    content: 'Current launch push.',
    expiresAt: futureIso(),
  })
  assert.ok((await contextMemoryIds(db, { workspaceId: WS1 })).includes(currentTemporary.id))
})

test('confidence, class rules, source and evidence are validated and preserved', async () => {
  const db = freshDb()
  await assert.rejects(
    createMemory(db, {
      workspaceId: WS1,
      memoryClass: 'verified_learning',
      content: 'Unsupported claim',
      confidence: 1.2,
    }),
  )
  await assert.rejects(
    createMemory(db, {
      workspaceId: WS1,
      memoryClass: 'verified_learning',
      content: 'No confidence',
      evidenceJson: evidenceTextToJson('Some evidence.'),
    }),
    /confidence/i,
  )
  await assert.rejects(
    createMemory(db, {
      workspaceId: WS1,
      memoryClass: 'temporary_context',
      content: 'Temporary confidence',
      confidence: 0.5,
    }),
    /does not use confidence/i,
  )

  const memory = await createMemory(db, {
    workspaceId: WS1,
    memoryClass: 'verified_learning',
    content: 'Evidence-backed learning',
    confidence: 0.55,
    sourceType: 'user',
    sourceId: 'manual-review',
    evidenceJson: evidenceTextToJson('Reviewed launch results.'),
  })
  assert.equal(memory.sourceType, 'user')
  assert.equal(memory.sourceId, 'manual-review')
  assert.equal(parseEvidence(memory.evidenceJson)[0]?.text, 'Reviewed launch results.')
})

test('chat messages can be reviewed into user-sourced or Chief-sourced memory', async () => {
  const db = freshDb()
  const conversation = await createConversation(db, { workspaceId: WS1 })
  const userMessage = await appendUserMessage(db, {
    conversationId: conversation.id,
    content: 'Remember that we use plain language.',
  })
  const chiefMessage = await appendMessage(db, {
    conversationId: conversation.id,
    senderType: 'agent',
    content: 'Question hooks may be worth testing.',
  })

  const fromUser = await createMemory(db, {
    workspaceId: WS1,
    memoryClass: 'permanent_fact',
    content: userMessage.content,
    sourceType: userMessage.senderType,
    sourceId: userMessage.id,
  })
  assert.equal(fromUser.sourceType, 'user')
  assert.equal(fromUser.sourceId, userMessage.id)

  const fromChief = await createMemory(db, {
    workspaceId: WS1,
    memoryClass: 'proposed_learning',
    content: chiefMessage.content,
    sourceType: chiefMessage.senderType,
    sourceId: chiefMessage.id,
  })
  assert.equal(fromChief.sourceType, 'agent')
  assert.equal(fromChief.memoryClass, 'proposed_learning')
})

test('client wire input cannot set trusted status, provenance or verification metadata', () => {
  const base = {
    memoryClass: 'verified_learning' as const,
    content: 'Question hooks work.',
    confidenceLevel: 'high' as const,
    evidence: '18 comparable Pins.',
  }
  assert.throws(() => createMemoryWire.parse({ ...base, status: 'active' }))
  assert.throws(() => createMemoryWire.parse({ ...base, sourceType: 'research' }))
  assert.throws(() => createMemoryWire.parse({ ...base, lastVerifiedAt: NOW }))
  assert.throws(() => createMemoryWire.parse({ ...base, supersededBy: crypto.randomUUID() }))
  assert.equal(createMemoryWire.parse(base).memoryClass, 'verified_learning')
})

test('memory filters, deterministic ordering, search and labels work', async () => {
  const db = freshDb()
  const factA = await createMemory(db, {
    workspaceId: WS1,
    memoryClass: 'permanent_fact',
    content: 'Brand A uses plain language.',
    scopeType: 'brand',
    scopeId: BRAND_A,
  })
  const productLearning = await createMemory(db, {
    workspaceId: WS1,
    memoryClass: 'verified_learning',
    content: 'Product A hooks improved CTR.',
    scopeType: 'product',
    scopeId: PRODUCT_A,
    confidence: 0.85,
    evidenceJson: evidenceTextToJson('Product experiment.'),
  })
  const brandB = await createMemory(db, {
    workspaceId: WS1,
    memoryClass: 'permanent_fact',
    content: 'Brand B avoids jargon.',
    scopeType: 'brand',
    scopeId: BRAND_B,
  })
  await archiveMemory(db, brandB.id)

  const brandAMemories = await listMemories(db, WS1, { brandId: BRAND_A })
  assert.deepEqual(
    brandAMemories.map((memory) => memory.id).sort(),
    [factA.id, productLearning.id].sort(),
  )
  const activeFacts = await listMemories(db, WS1, {
    memoryClass: 'permanent_fact',
    status: 'active',
  })
  assert.deepEqual(
    activeFacts.map((memory) => memory.id),
    [factA.id],
  )
  const search = await listMemories(db, WS1, { query: 'hooks' })
  assert.deepEqual(
    search.map((memory) => memory.id),
    [productLearning.id],
  )
  const summary = await getMemorySummaryById(db, productLearning.id)
  assert.equal(summary?.scopePath, 'Brand A / Niche A / Product A')

  const first = await listMemories(db, WS1)
  const second = await listMemories(db, WS1)
  assert.deepEqual(
    first.map((memory) => memory.id),
    second.map((memory) => memory.id),
  )
  assert.deepEqual(
    first.map((memory) => memory.id),
    [...first]
      .sort((a, b) =>
        a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt < b.createdAt ? 1 : -1,
      )
      .map((memory) => memory.id),
  )
})

test('active Memory page grouping hides archived rows and Context ranking stays intact', async () => {
  const db = freshDb()
  const workspaceMemory = await createMemory(db, {
    workspaceId: WS1,
    memoryClass: 'permanent_fact',
    content: 'Workspace rule.',
  })
  const productMemory = await createMemory(db, {
    workspaceId: WS1,
    memoryClass: 'verified_learning',
    content: 'Product rule.',
    scopeType: 'product',
    scopeId: PRODUCT_A,
    confidence: 0.85,
    evidenceJson: evidenceTextToJson('Product evidence.'),
  })
  const archived = await createMemory(db, {
    workspaceId: WS1,
    memoryClass: 'permanent_fact',
    content: 'Archived rule.',
  })
  await archiveMemory(db, archived.id)

  const summaries = await listMemories(db, WS1)
  const activeView = memoriesForTab(summaries as MemoryListItem[], 'all')
  assert.ok(activeView.some((memory) => memory.id === workspaceMemory.id))
  assert.ok(!activeView.some((memory) => memory.id === archived.id))
  assert.ok(
    memoriesForTab(summaries as MemoryListItem[], 'history').some((m) => m.id === archived.id),
  )

  const pkg = await buildContext(db, { workspaceId: WS1, productId: PRODUCT_A })
  assert.deepEqual(
    pkg.memories.map((memory) => memory.id),
    [productMemory.id, workspaceMemory.id],
  )
})

test('memory mutations write audit history and domain events', async () => {
  const db = freshDb()
  const proposed = await createMemory(db, {
    workspaceId: WS1,
    memoryClass: 'proposed_learning',
    content: 'Possible learning.',
  })
  await updateMemory(db, {
    id: proposed.id,
    content: 'Possible learning, refined.',
    scopeType: 'workspace',
    scopeId: null,
  })
  await verifyMemory(db, {
    id: proposed.id,
    confidence: 0.8,
    evidenceJson: evidenceTextToJson('Manual review.') ?? '',
  })
  await archiveMemory(db, proposed.id)
  await restoreMemory(db, proposed.id)

  const rejected = await createMemory(db, {
    workspaceId: WS1,
    memoryClass: 'proposed_learning',
    content: 'Rejected hypothesis.',
  })
  await rejectMemory(db, rejected.id)

  const audit = await db
    .prepare(`SELECT action FROM audit_log WHERE entity_type = 'memory' AND entity_id = ?`)
    .bind(proposed.id)
    .all<{ action: string }>()
  assert.deepEqual(
    audit.results.map((row) => row.action),
    ['create', 'update', 'update', 'delete', 'restore'],
  )
  const events = await db
    .prepare(`SELECT event_type FROM event WHERE subject_type = 'memory' AND subject_id IN (?, ?)`)
    .bind(proposed.id, rejected.id)
    .all<{ event_type: string }>()
  for (const type of [
    'memory.created',
    'memory.updated',
    'memory.verified',
    'memory.archived',
    'memory.restored',
    'memory.rejected',
  ]) {
    assert.ok(
      events.results.some((row) => row.event_type === type),
      `missing ${type}`,
    )
  }
})
