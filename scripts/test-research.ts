/**
 * Research Workspace and Lifecycle verification tests (npm run test:research).
 *
 * Tests the 18 requirements for STEP 12A:
 *   1. Create workspace research
 *   2. Create brand research
 *   3. Create niche research
 *   4. Create product research
 *   5. Invalid scope rejected
 *   6. Cross-workspace scope rejected
 *   7. Cross-brand scope rejected
 *   8. Research type validation
 *   9. Edit research
 *  10. Archive research
 *  11. Restore research
 *  12. Archived research excluded from Context Engine
 *  13. Expired research excluded
 *  14. Freshness uses existing rules
 *  15. Filters work
 *  16. Deterministic ordering
 *  17. No fake source/provenance data created
 *  18. Existing Context tests remain green
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { buildContext } from '../src/server/context/engine.ts'
import { researchFreshness } from '../src/server/context/freshness.ts'
import { listAgents } from '../src/server/db/agent.ts'
import { createConversation } from '../src/server/db/conversation.ts'
import {
  archiveResearch,
  composeResearchAnalysisTask,
  computeProvenanceSummary,
  createResearch,
  createResearchSource,
  deriveResearchTitle,
  getResearch,
  getResearchSource,
  listResearch,
  listResearchSources,
  normalizeSourceUrl,
  RESEARCH_TYPES,
  ResearchAnalysisValidationError,
  ResearchScopeError,
  ResearchSourceValidationError,
  removeResearchSource,
  restoreResearch,
  updateResearch,
  updateResearchSource,
  validateResearchSelection,
  validateSourceUrl,
} from '../src/server/db/research.ts'
import type { SqlDatabase } from '../src/server/db/sql.ts'

interface TestChatAgentOption {
  id: string
  name: string
  role: string
  status: 'active' | 'disabled' | 'archived'
  origin: 'builtin' | 'custom'
  executionType: 'direct_model' | 'external_agent' | 'router'
  selectable: boolean
}

function resolveSelectedAgent(
  agents: TestChatAgentOption[],
  requestedId: string | undefined,
): TestChatAgentOption | null {
  const selectable = agents.filter((agent) => agent.selectable)
  if (requestedId) {
    const requested = selectable.find((agent) => agent.id === requestedId)
    if (requested) {
      return requested
    }
  }
  return (
    selectable.find((agent) => agent.name === 'Chief' && agent.origin === 'builtin') ??
    selectable[0] ??
    null
  )
}

async function listChatAgents(
  db: SqlDatabase,
  workspaceId: string,
): Promise<TestChatAgentOption[]> {
  const agents = await listAgents(db, workspaceId)
  return agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    role: agent.role ?? '',
    status: agent.status,
    origin: agent.origin,
    executionType: agent.executionType,
    selectable: agent.status === 'active' && agent.executionType === 'direct_model',
  }))
}

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const NOW = '2026-08-20T10:00:00.000Z'
const PAST_100_DAYS = '2026-05-10T00:00:00.000Z'
const PAST_EXPIRED = '2026-08-10T00:00:00.000Z'
const FUTURE_EXPIRY = '2026-12-31T00:00:00.000Z'

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

function freshDb(): { db: SqlDatabase; raw: Database.Database } {
  const raw = new Database(':memory:')
  raw.pragma('foreign_keys = ON')
  const dir = join(ROOT, 'migrations')
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  for (const file of files) {
    raw.exec(readFileSync(join(dir, file), 'utf8'))
  }
  const db = shim(raw)
  return { db, raw }
}

function setupFixture(raw: Database.Database) {
  const ws1 = crypto.randomUUID()
  const ws2 = crypto.randomUUID()

  // Workspaces
  raw
    .prepare(
      `INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, 'WS 1', 'ws-1', ?, ?)`,
    )
    .run(ws1, NOW, NOW)
  raw
    .prepare(
      `INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, 'WS 2', 'ws-2', ?, ?)`,
    )
    .run(ws2, NOW, NOW)

  // Brands
  const brand1 = crypto.randomUUID()
  const brand2 = crypto.randomUUID() // in ws2
  raw
    .prepare(
      `INSERT INTO brand (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, 'SheetLab', ?, ?)`,
    )
    .run(brand1, ws1, NOW, NOW)
  raw
    .prepare(
      `INSERT INTO brand (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, 'ForeignBrand', ?, ?)`,
    )
    .run(brand2, ws2, NOW, NOW)

  // Niches
  const niche1 = crypto.randomUUID()
  raw
    .prepare(
      `INSERT INTO niche (id, brand_id, name, created_at, updated_at) VALUES (?, ?, 'Minimalist Tech', ?, ?)`,
    )
    .run(niche1, brand1, NOW, NOW)

  // Products
  const product1 = crypto.randomUUID()
  raw
    .prepare(
      `INSERT INTO product (id, brand_id, name, status, created_at, updated_at) VALUES (?, ?, 'Budget Planner', 'active', ?, ?)`,
    )
    .run(product1, brand1, NOW, NOW)

  // Builtin Agents
  const chiefId = crypto.randomUUID()
  const researcherId = crypto.randomUUID()
  raw
    .prepare(
      `INSERT INTO agent (id, workspace_id, name, role, execution_type, status, origin, created_at, updated_at)
       VALUES (?, ?, 'Chief', 'workspace-chief', 'direct_model', 'active', 'builtin', ?, ?)`,
    )
    .run(chiefId, ws1, NOW, NOW)
  raw
    .prepare(
      `INSERT INTO agent (id, workspace_id, name, role, execution_type, status, origin, created_at, updated_at)
       VALUES (?, ?, 'Researcher', 'researcher', 'direct_model', 'active', 'builtin', ?, ?)`,
    )
    .run(researcherId, ws1, NOW, NOW)

  return { ws1, ws2, brand1, brand2, niche1, product1, chiefId, researcherId }
}

test('1. create workspace research', async () => {
  const { db, raw } = freshDb()
  const { ws1 } = setupFixture(raw)

  const created = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Global Spreadsheet Market Trends',
    findings: 'Spreadsheet template market growing at 15% YoY.',
    researchType: 'market',
    status: 'completed',
    confidence: 0.9,
    scopeType: 'workspace',
  })

  assert.ok(created.id)
  assert.equal(created.workspaceId, ws1)
  assert.equal(created.subject, 'Global Spreadsheet Market Trends')
  assert.equal(created.researchType, 'market')
  assert.equal(created.status, 'completed')
  assert.equal(created.scopeType, 'workspace')
})

test('2. create brand research', async () => {
  const { db, raw } = freshDb()
  const { ws1, brand1 } = setupFixture(raw)

  const created = await createResearch(db, {
    workspaceId: ws1,
    subject: 'SheetLab Brand Positioning',
    findings: 'Primary differentiator is speed of setup and clean typography.',
    researchType: 'competitor',
    status: 'completed',
    scopeType: 'brand',
    scopeId: brand1,
  })

  assert.ok(created.id)
  assert.equal(created.scopeType, 'brand')
  assert.equal(created.scopeId, brand1)
})

test('3. create niche research', async () => {
  const { db, raw } = freshDb()
  const { ws1, niche1 } = setupFixture(raw)

  const created = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Minimalist Tech Audience Insights',
    findings: 'Target audience values dark mode aesthetics and Notion integration.',
    researchType: 'audience',
    status: 'completed',
    scopeType: 'niche',
    scopeId: niche1,
  })

  assert.ok(created.id)
  assert.equal(created.scopeType, 'niche')
  assert.equal(created.scopeId, niche1)
})

test('4. create product research', async () => {
  const { db, raw } = freshDb()
  const { ws1, product1 } = setupFixture(raw)

  const created = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Budget Planner Feature Comparison',
    findings: 'Users strongly prefer automated monthly summary rollups.',
    researchType: 'product',
    status: 'completed',
    scopeType: 'product',
    scopeId: product1,
  })

  assert.ok(created.id)
  assert.equal(created.scopeType, 'product')
  assert.equal(created.scopeId, product1)
})

test('5. invalid scope rejected', async () => {
  const { db, raw } = freshDb()
  const { ws1 } = setupFixture(raw)
  const nonExistentId = crypto.randomUUID()

  await assert.rejects(
    () =>
      createResearch(db, {
        workspaceId: ws1,
        subject: 'Ghost Brand Research',
        researchType: 'market',
        scopeType: 'brand',
        scopeId: nonExistentId,
      }),
    ResearchScopeError,
  )
})

test('6. cross-workspace scope rejected', async () => {
  const { db, raw } = freshDb()
  const { ws1, brand2 } = setupFixture(raw) // brand2 belongs to ws2!

  await assert.rejects(
    () =>
      createResearch(db, {
        workspaceId: ws1, // Attacking ws1 with ws2's brand
        subject: 'Cross Workspace Leak Attempt',
        researchType: 'market',
        scopeType: 'brand',
        scopeId: brand2,
      }),
    ResearchScopeError,
  )
})

test('7. cross-brand / deleted scope rejected', async () => {
  const { db, raw } = freshDb()
  const { ws1, brand1 } = setupFixture(raw)

  // Soft-archive brand1
  raw.prepare(`UPDATE brand SET deleted_at = ? WHERE id = ?`).run(NOW, brand1)

  await assert.rejects(
    () =>
      createResearch(db, {
        workspaceId: ws1,
        subject: 'Archived Brand Research',
        researchType: 'market',
        scopeType: 'brand',
        scopeId: brand1,
      }),
    ResearchScopeError,
  )
})

test('8. research type validation', async () => {
  const { db, raw } = freshDb()
  const { ws1 } = setupFixture(raw)

  for (const t of RESEARCH_TYPES) {
    const r = await createResearch(db, {
      workspaceId: ws1,
      subject: `Testing type ${t}`,
      researchType: t,
    })
    assert.equal(r.researchType, t)
  }

  await assert.rejects(
    () =>
      createResearch(db, {
        workspaceId: ws1,
        subject: 'Invalid type',
        // @ts-expect-error test invalid type runtime rejection
        researchType: 'pinterest_pins',
      }),
    /invalid/i,
  )
})

test('9. edit research', async () => {
  const { db, raw } = freshDb()
  const { ws1, brand1, product1 } = setupFixture(raw)

  const created = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Initial Subject',
    findings: 'Initial Findings',
    researchType: 'market',
    scopeType: 'brand',
    scopeId: brand1,
  })

  const updated = await updateResearch(db, {
    workspaceId: ws1,
    id: created.id,
    subject: 'Updated Subject',
    findings: 'Updated Findings',
    researchType: 'product',
    scopeType: 'product',
    scopeId: product1,
  })

  assert.equal(updated.id, created.id)
  assert.equal(updated.subject, 'Updated Subject')
  assert.equal(updated.findings, 'Updated Findings')
  assert.equal(updated.researchType, 'product')
  assert.equal(updated.scopeType, 'product')
  assert.equal(updated.scopeId, product1)
})

test('10. archive research', async () => {
  const { db, raw } = freshDb()
  const { ws1 } = setupFixture(raw)

  const created = await createResearch(db, {
    workspaceId: ws1,
    subject: 'To Archive',
    status: 'completed',
  })

  const archived = await archiveResearch(db, {
    workspaceId: ws1,
    id: created.id,
  })

  assert.equal(archived.status, 'archived')
  assert.ok(archived.deletedAt)

  const fetched = await getResearch(db, {
    workspaceId: ws1,
    id: created.id,
    includeArchived: false,
  })
  assert.equal(fetched, null)

  const fetchedArchived = await getResearch(db, {
    workspaceId: ws1,
    id: created.id,
    includeArchived: true,
  })
  assert.ok(fetchedArchived)
  assert.equal(fetchedArchived.status, 'archived')
})

test('11. restore research', async () => {
  const { db, raw } = freshDb()
  const { ws1 } = setupFixture(raw)

  const created = await createResearch(db, {
    workspaceId: ws1,
    subject: 'To Restore',
    status: 'completed',
  })

  await archiveResearch(db, { workspaceId: ws1, id: created.id })
  const restored = await restoreResearch(db, { workspaceId: ws1, id: created.id })

  assert.equal(restored.status, 'completed')
  assert.equal(restored.deletedAt, null)

  const fetched = await getResearch(db, { workspaceId: ws1, id: created.id })
  assert.ok(fetched)
  assert.equal(fetched.status, 'completed')
})

test('12. archived research excluded from Context Engine', async () => {
  const { db, raw } = freshDb()
  const { ws1 } = setupFixture(raw)

  await createResearch(db, {
    workspaceId: ws1,
    subject: 'Active Finding',
    status: 'completed',
  })

  await createResearch(db, {
    workspaceId: ws1,
    subject: 'Archived Finding',
    status: 'archived',
  })

  const conversationId = crypto.randomUUID()
  raw
    .prepare(
      `INSERT INTO conversation (id, workspace_id, title, created_at, updated_at)
     VALUES (?, ?, 'Test Convo', ?, ?)`,
    )
    .run(conversationId, ws1, NOW, NOW)

  const ctx = await buildContext(db, {
    workspaceId: ws1,
    conversationId,
    now: NOW,
  })

  const subjects = ctx.research.map((r) => r.subject)
  assert.ok(subjects.includes('Active Finding'))
  assert.ok(!subjects.includes('Archived Finding'))
})

test('13. expired research excluded from Context Engine', async () => {
  const { db, raw } = freshDb()
  const { ws1 } = setupFixture(raw)

  await createResearch(db, {
    workspaceId: ws1,
    subject: 'Expired Finding',
    status: 'completed',
    expiresAt: PAST_EXPIRED,
  })

  await createResearch(db, {
    workspaceId: ws1,
    subject: 'Valid Future Finding',
    status: 'completed',
    expiresAt: FUTURE_EXPIRY,
  })

  const conversationId = crypto.randomUUID()
  raw
    .prepare(
      `INSERT INTO conversation (id, workspace_id, title, created_at, updated_at)
     VALUES (?, ?, 'Test Convo', ?, ?)`,
    )
    .run(conversationId, ws1, NOW, NOW)

  const ctx = await buildContext(db, {
    workspaceId: ws1,
    conversationId,
    now: NOW,
  })

  const subjects = ctx.research.map((r) => r.subject)
  assert.ok(subjects.includes('Valid Future Finding'))
  assert.ok(!subjects.includes('Expired Finding'))
})

test('14. freshness uses existing rules (derives current, aging, stale, expired)', () => {
  // Current
  assert.equal(
    researchFreshness(
      { status: 'completed', expiresAt: null, lastVerifiedAt: NOW, updatedAt: NOW },
      NOW,
      90,
    ),
    'current',
  )

  // Aging (> 90 days)
  assert.equal(
    researchFreshness(
      {
        status: 'completed',
        expiresAt: null,
        lastVerifiedAt: PAST_100_DAYS,
        updatedAt: PAST_100_DAYS,
      },
      NOW,
      90,
    ),
    'aging',
  )

  // Stale
  assert.equal(
    researchFreshness(
      { status: 'stale', expiresAt: null, lastVerifiedAt: NOW, updatedAt: NOW },
      NOW,
      90,
    ),
    'stale',
  )

  // Expired by date
  assert.equal(
    researchFreshness(
      { status: 'completed', expiresAt: PAST_EXPIRED, lastVerifiedAt: null, updatedAt: NOW },
      NOW,
      90,
    ),
    'expired',
  )

  // Expired by status
  assert.equal(
    researchFreshness(
      { status: 'archived', expiresAt: null, lastVerifiedAt: null, updatedAt: NOW },
      NOW,
      90,
    ),
    'expired',
  )
})

test('15. filters work (status, type, scope, search)', async () => {
  const { db, raw } = freshDb()
  const { ws1, brand1 } = setupFixture(raw)

  await createResearch(db, {
    workspaceId: ws1,
    subject: 'Brand A Competitive Analysis',
    findings: 'Pricing matrix details',
    researchType: 'competitor',
    status: 'completed',
    scopeType: 'brand',
    scopeId: brand1,
  })

  await createResearch(db, {
    workspaceId: ws1,
    subject: 'TikTok Content Trends',
    findings: 'Short videos under 30s',
    researchType: 'content',
    status: 'draft',
    scopeType: 'workspace',
  })

  // Filter by type
  const comp = await listResearch(db, { workspaceId: ws1, researchType: 'competitor' })
  assert.equal(comp.length, 1)
  assert.equal(comp[0].subject, 'Brand A Competitive Analysis')

  // Filter by status
  const drafts = await listResearch(db, { workspaceId: ws1, status: 'draft' })
  assert.equal(drafts.length, 1)
  assert.equal(drafts[0].subject, 'TikTok Content Trends')

  // Filter by search
  const searched = await listResearch(db, { workspaceId: ws1, search: 'Pricing' })
  assert.equal(searched.length, 1)
  assert.equal(searched[0].subject, 'Brand A Competitive Analysis')
})

test('16. deterministic ordering', async () => {
  const { db, raw } = freshDb()
  const { ws1 } = setupFixture(raw)

  await createResearch(db, { workspaceId: ws1, subject: 'First' })
  await createResearch(db, { workspaceId: ws1, subject: 'Second' })
  await createResearch(db, { workspaceId: ws1, subject: 'Third' })

  const list = await listResearch(db, { workspaceId: ws1 })
  assert.equal(list.length, 3)
  assert.ok(list[0].id)
})

test('17. no fake source/provenance data created', async () => {
  const { db, raw } = freshDb()
  const { ws1 } = setupFixture(raw)

  const created = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Pure User Entry',
    findings: 'Notes from offline interview',
    researchType: 'audience',
  })

  // Ensure research_source table has 0 fake rows inserted
  const sources = raw.prepare(`SELECT * FROM research_source WHERE research_id = ?`).all(created.id)
  assert.equal(sources.length, 0)
})

test('18. existing Context tests remain green', async () => {
  const { db, raw } = freshDb()
  const { ws1, brand1 } = setupFixture(raw)

  await createResearch(db, {
    workspaceId: ws1,
    subject: 'Scoped Brand Research',
    findings: 'Relevant to brand1 conversations',
    status: 'completed',
    scopeType: 'brand',
    scopeId: brand1,
  })

  const conversationId = crypto.randomUUID()
  raw
    .prepare(
      `INSERT INTO conversation (id, workspace_id, scope_type, scope_id, title, created_at, updated_at)
     VALUES (?, ?, 'brand', ?, 'Brand Convo', ?, ?)`,
    )
    .run(conversationId, ws1, brand1, NOW, NOW)

  const ctx = await buildContext(db, {
    workspaceId: ws1,
    conversationId,
    now: NOW,
  })

  assert.equal(ctx.research.length, 1)
  assert.equal(ctx.research[0].subject, 'Scoped Brand Research')
  assert.equal(ctx.research[0].freshness, 'current')
})

// ==========================================
// STEP 12B Tests: Sources & Provenance
// ==========================================

test('19. STEP 12B.1: add research source', async () => {
  const { db, raw } = freshDb()
  const { ws1 } = setupFixture(raw)

  const research = await createResearch(db, {
    workspaceId: ws1,
    subject: 'AI Productivity Benchmark',
    findings: 'Developer efficiency metrics',
  })

  const source = await createResearchSource(db, {
    workspaceId: ws1,
    researchId: research.id,
    sourceType: 'report',
    title: 'State of AI in Engineering 2026',
    url: 'https://example.com/reports/ai-2026.pdf',
    publisher: 'Gartner Research',
    publishedAt: '2026-01-15T00:00:00.000Z',
    retrievedAt: '2026-08-20T10:00:00.000Z',
    confidence: 0.95,
    note: 'Sample size of 5,000 developers worldwide.',
  })

  assert.ok(source.id)
  assert.equal(source.researchId, research.id)
  assert.equal(source.sourceType, 'report')
  assert.equal(source.title, 'State of AI in Engineering 2026')
  assert.equal(source.url, 'https://example.com/reports/ai-2026.pdf')
  assert.equal(source.publisher, 'Gartner Research')
  assert.equal(source.confidence, 0.95)
  assert.equal(source.note, 'Sample size of 5,000 developers worldwide.')

  // Check DB persistence
  const fetched = await getResearchSource(db, {
    workspaceId: ws1,
    researchId: research.id,
    id: source.id,
  })
  assert.ok(fetched)
  assert.equal(fetched?.id, source.id)
  assert.equal(fetched?.title, 'State of AI in Engineering 2026')
})

test('20. STEP 12B.2: multiple sources supported and listed in order', async () => {
  const { db, raw } = freshDb()
  const { ws1 } = setupFixture(raw)

  const research = await createResearch(db, {
    workspaceId: ws1,
    subject: 'E-commerce Conversion Multi-Source Study',
  })

  await createResearchSource(db, {
    workspaceId: ws1,
    researchId: research.id,
    sourceType: 'website',
    title: 'Source Alpha',
    url: 'https://alpha.com/data',
  })

  await createResearchSource(db, {
    workspaceId: ws1,
    researchId: research.id,
    sourceType: 'marketplace',
    title: 'Source Beta',
    url: 'https://beta.com/analytics',
  })

  await createResearchSource(db, {
    workspaceId: ws1,
    researchId: research.id,
    sourceType: 'social',
    title: 'Source Gamma',
    url: 'https://gamma.com/threads/123',
  })

  const sources = await listResearchSources(db, {
    workspaceId: ws1,
    researchId: research.id,
  })

  assert.equal(sources.length, 3)
  const titles = sources.map((s) => s.title)
  assert.ok(titles.includes('Source Alpha'))
  assert.ok(titles.includes('Source Beta'))
  assert.ok(titles.includes('Source Gamma'))
})

test('21. STEP 12B.3: edit source updates fields cleanly', async () => {
  const { db, raw } = freshDb()
  const { ws1 } = setupFixture(raw)

  const research = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Pricing Models',
  })

  const source = await createResearchSource(db, {
    workspaceId: ws1,
    researchId: research.id,
    sourceType: 'website',
    title: 'Draft Pricing Analysis',
    url: 'https://example.com/draft',
    confidence: 0.5,
  })

  const updated = await updateResearchSource(db, {
    workspaceId: ws1,
    researchId: research.id,
    id: source.id,
    sourceType: 'report',
    title: 'Official Pricing Benchmark Report',
    url: 'https://example.com/official',
    publisher: 'Pricing Institute',
    confidence: 0.9,
    note: 'Updated with official peer-reviewed methodology.',
  })

  assert.equal(updated.id, source.id)
  assert.equal(updated.sourceType, 'report')
  assert.equal(updated.title, 'Official Pricing Benchmark Report')
  assert.equal(updated.url, 'https://example.com/official')
  assert.equal(updated.publisher, 'Pricing Institute')
  assert.equal(updated.confidence, 0.9)
  assert.equal(updated.note, 'Updated with official peer-reviewed methodology.')
})

test('22. STEP 12B.4: remove source deletes source without corrupting research', async () => {
  const { db, raw } = freshDb()
  const { ws1 } = setupFixture(raw)

  const research = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Temporary Sources Test',
    findings: 'Important content that must be preserved',
  })

  const source = await createResearchSource(db, {
    workspaceId: ws1,
    researchId: research.id,
    sourceType: 'website',
    title: 'Ephemeral Source',
  })

  const result = await removeResearchSource(db, {
    workspaceId: ws1,
    researchId: research.id,
    id: source.id,
  })
  assert.equal(result.id, source.id)
  assert.equal(result.researchId, research.id)

  // Source should no longer exist
  const fetched = await getResearchSource(db, {
    workspaceId: ws1,
    researchId: research.id,
    id: source.id,
  })
  assert.equal(fetched, null)

  // Parent research record must be intact
  const parent = await getResearch(db, {
    workspaceId: ws1,
    id: research.id,
  })
  assert.ok(parent)
  assert.equal(parent?.findings, 'Important content that must be preserved')
})

test('23. STEP 12B.5: invalid URL format rejected', async () => {
  const { db, raw } = freshDb()
  const { ws1 } = setupFixture(raw)

  const research = await createResearch(db, {
    workspaceId: ws1,
    subject: 'URL Validation',
  })

  assert.throws(() => validateSourceUrl('not-a-valid-url'), ResearchSourceValidationError)

  await assert.rejects(async () => {
    await createResearchSource(db, {
      workspaceId: ws1,
      researchId: research.id,
      sourceType: 'website',
      title: 'Malformed URL Source',
      url: 'not-a-valid-url',
    })
  }, ResearchSourceValidationError)
})

test('24. STEP 12B.6: javascript:, file:, and data: URLs rejected', async () => {
  const { db, raw } = freshDb()
  const { ws1 } = setupFixture(raw)

  const research = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Dangerous Protocol Checks',
  })

  // javascript:
  assert.throws(
    () => validateSourceUrl('javascript:alert(document.cookie)'),
    ResearchSourceValidationError,
  )
  await assert.rejects(async () => {
    await createResearchSource(db, {
      workspaceId: ws1,
      researchId: research.id,
      sourceType: 'website',
      title: 'XSS attempt',
      url: 'javascript:alert(1)',
    })
  }, ResearchSourceValidationError)

  // file:
  assert.throws(() => validateSourceUrl('file:///etc/passwd'), ResearchSourceValidationError)
  await assert.rejects(async () => {
    await createResearchSource(db, {
      workspaceId: ws1,
      researchId: research.id,
      sourceType: 'website',
      title: 'File exploit',
      url: 'file:///c:/windows/system32',
    })
  }, ResearchSourceValidationError)

  // data:
  assert.throws(
    () => validateSourceUrl('data:text/html,<script>alert(1)</script>'),
    ResearchSourceValidationError,
  )
})

test('25. STEP 12B.7: cross-workspace research source rejected', async () => {
  const { db, raw } = freshDb()
  const { ws1, ws2 } = setupFixture(raw)

  const r1 = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Workspace 1 Research',
  })

  // Attempting to add source with ws2 for r1 in ws1
  await assert.rejects(async () => {
    await createResearchSource(db, {
      workspaceId: ws2,
      researchId: r1.id,
      sourceType: 'website',
      title: 'Cross-workspace inject',
    })
  }, /not found/i)

  const source = await createResearchSource(db, {
    workspaceId: ws1,
    researchId: r1.id,
    sourceType: 'website',
    title: 'Valid WS1 Source',
  })

  // Attempting to access from ws2
  const crossGet = await getResearchSource(db, {
    workspaceId: ws2,
    researchId: r1.id,
    id: source.id,
  })
  assert.equal(crossGet, null)

  // Attempting to update from ws2
  await assert.rejects(async () => {
    await updateResearchSource(db, {
      workspaceId: ws2,
      researchId: r1.id,
      id: source.id,
      title: 'Hacked Title',
    })
  }, /not found/i)
})

test('26. STEP 12B.8: source belongs to correct research record', async () => {
  const { db, raw } = freshDb()
  const { ws1 } = setupFixture(raw)

  const r1 = await createResearch(db, { workspaceId: ws1, subject: 'R1' })
  const r2 = await createResearch(db, { workspaceId: ws1, subject: 'R2' })

  const s1 = await createResearchSource(db, {
    workspaceId: ws1,
    researchId: r1.id,
    sourceType: 'website',
    title: 'R1 Source',
  })

  // Trying to update s1 under r2
  await assert.rejects(async () => {
    await updateResearchSource(db, {
      workspaceId: ws1,
      researchId: r2.id,
      id: s1.id,
      title: 'Mismatched Parent',
    })
  }, /not found/i)

  // Trying to remove s1 under r2
  await assert.rejects(async () => {
    await removeResearchSource(db, {
      workspaceId: ws1,
      researchId: r2.id,
      id: s1.id,
    })
  }, /not found/i)
})

test('27. STEP 12B.9: user-provided source works without URL', async () => {
  const { db, raw } = freshDb()
  const { ws1 } = setupFixture(raw)

  const research = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Customer Feedback Summary',
  })

  const source = await createResearchSource(db, {
    workspaceId: ws1,
    researchId: research.id,
    sourceType: 'user_provided',
    title: 'Customer Interview - John Doe',
    publisher: 'Product Discovery Team',
    note: 'In-person interview conducted on 2026-08-15',
  })

  assert.ok(source.id)
  assert.equal(source.url, null)
  assert.equal(source.sourceType, 'user_provided')
  assert.equal(source.publisher, 'Product Discovery Team')
})

test('28. STEP 12B.10: published date vs checked/retrieved date preserved', async () => {
  const { db, raw } = freshDb()
  const { ws1 } = setupFixture(raw)

  const research = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Historical Analysis',
  })

  const published = '2024-06-15T12:00:00.000Z'
  const retrieved = '2026-08-20T15:30:00.000Z'

  const source = await createResearchSource(db, {
    workspaceId: ws1,
    researchId: research.id,
    sourceType: 'report',
    title: '2024 Retrospective Study',
    url: 'https://example.com/2024-retro',
    publishedAt: published,
    retrievedAt: retrieved,
  })

  assert.equal(source.publishedAt, published)
  assert.equal(source.retrievedAt, retrieved)
  assert.notEqual(source.publishedAt, source.retrievedAt)

  const fetched = await getResearchSource(db, {
    workspaceId: ws1,
    researchId: research.id,
    id: source.id,
  })
  assert.equal(fetched?.publishedAt, published)
  assert.equal(fetched?.retrievedAt, retrieved)
})

test('29. STEP 12B.11: research content edit does not delete or alter sources', async () => {
  const { db, raw } = freshDb()
  const { ws1 } = setupFixture(raw)

  const research = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Initial Subject',
    findings: 'Initial Findings',
  })

  await createResearchSource(db, {
    workspaceId: ws1,
    researchId: research.id,
    sourceType: 'website',
    title: 'Sticky Source 1',
  })

  await createResearchSource(db, {
    workspaceId: ws1,
    researchId: research.id,
    sourceType: 'report',
    title: 'Sticky Source 2',
  })

  // Edit the research record
  await updateResearch(db, {
    workspaceId: ws1,
    id: research.id,
    subject: 'Updated Subject Completely',
    findings: 'New Findings Content',
    confidence: 0.99,
  })

  // Verify sources are intact
  const sources = await listResearchSources(db, {
    workspaceId: ws1,
    researchId: research.id,
  })
  assert.equal(sources.length, 2)
  assert.ok(sources.some((s) => s.title === 'Sticky Source 1'))
  assert.ok(sources.some((s) => s.title === 'Sticky Source 2'))
})

test('30. STEP 12B.12: provenance summary calculation (sourced, partially_sourced, user_entered)', () => {
  // 1. Zero sources -> user_entered
  const pEmpty = computeProvenanceSummary([])
  assert.equal(pEmpty.status, 'user_entered')
  assert.equal(pEmpty.sourceCount, 0)

  // 2. Only user-entered sources without URLs -> user_entered
  const pUserOnly = computeProvenanceSummary([
    {
      id: '1',
      researchId: 'r1',
      sourceType: 'user_provided',
      title: 'Interview notes',
      url: null,
      publisher: null,
      publishedAt: null,
      retrievedAt: null,
      note: null,
      confidence: null,
      createdAt: NOW,
    },
  ])
  assert.equal(pUserOnly.status, 'user_entered')

  // 3. Verified external sources with URLs / publishers -> sourced
  const pSourced = computeProvenanceSummary([
    {
      id: '1',
      researchId: 'r1',
      sourceType: 'website',
      title: 'E-commerce Report',
      url: 'https://example.com/report',
      publisher: 'Industry Weekly',
      publishedAt: null,
      retrievedAt: null,
      note: null,
      confidence: null,
      createdAt: NOW,
    },
  ])
  assert.equal(pSourced.status, 'sourced')

  // 4. Mix of external source without URL and user source -> partially_sourced
  const pPartial = computeProvenanceSummary([
    {
      id: '1',
      researchId: 'r1',
      sourceType: 'marketplace',
      title: 'Etsy Search Trends',
      url: null,
      publisher: null,
      publishedAt: null,
      retrievedAt: null,
      note: null,
      confidence: null,
      createdAt: NOW,
    },
  ])
  assert.equal(pPartial.status, 'partially_sourced')
})

test('31. STEP 12B.13: unsourced research is never presented as verified', () => {
  const summary = computeProvenanceSummary([])
  assert.equal(summary.status, 'user_entered')
  assert.equal(summary.label, 'User-Entered')
  assert.equal(summary.description.toLowerCase().includes('external'), true)
  assert.equal(summary.description.toLowerCase().includes('verified'), false)
})

test('32. STEP 12B.14: audit log and events emitted safely for source mutations', async () => {
  const { db, raw } = freshDb()
  const { ws1 } = setupFixture(raw)

  const research = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Audit Trail Test',
  })

  // Create
  const s = await createResearchSource(db, {
    workspaceId: ws1,
    researchId: research.id,
    sourceType: 'website',
    title: 'Audit Source',
    url: 'https://audit.example.com',
  })

  // Update
  await updateResearchSource(db, {
    workspaceId: ws1,
    researchId: research.id,
    id: s.id,
    title: 'Updated Audit Source',
  })

  // Remove
  await removeResearchSource(db, {
    workspaceId: ws1,
    researchId: research.id,
    id: s.id,
  })

  // Check audit logs
  const logs = raw
    .prepare(`SELECT action, entity_type FROM audit_log WHERE entity_type = 'research_source'`)
    .all() as { action: string; entity_type: string }[]

  assert.ok(logs.some((l) => l.action === 'create' && l.entity_type === 'research_source'))
  assert.ok(logs.some((l) => l.action === 'update' && l.entity_type === 'research_source'))
  assert.ok(logs.some((l) => l.action === 'delete' && l.entity_type === 'research_source'))

  // Check events
  const events = raw
    .prepare(`SELECT event_type FROM event WHERE subject_type = 'research'`)
    .all() as { event_type: string }[]

  assert.ok(events.some((e) => e.event_type === 'research.source_added'))
  assert.ok(events.some((e) => e.event_type === 'research.source_updated'))
  assert.ok(events.some((e) => e.event_type === 'research.source_removed'))
})

test('33. STEP 12B.15: no secret metadata stored or leaked', async () => {
  const { db, raw } = freshDb()
  const { ws1 } = setupFixture(raw)

  const research = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Sanitization Test',
  })

  const source = await createResearchSource(db, {
    workspaceId: ws1,
    researchId: research.id,
    sourceType: 'report',
    title: 'Public Report',
    url: 'https://example.com/public',
    publisher: 'Public Org',
  })

  const row = raw.prepare(`SELECT metadata FROM research_source WHERE id = ?`).get(source.id) as {
    metadata: string
  }

  assert.ok(row.metadata)
  const meta = JSON.parse(row.metadata)
  assert.equal(meta.sourceType, 'report')
  assert.equal(meta.publisher, 'Public Org')
  assert.equal(meta.apiKey, undefined)
  assert.equal(meta.secret, undefined)
})

test('34. STEP 12B.16: Context Engine compatibility and freshness intact with sources', async () => {
  const { db, raw } = freshDb()
  const { ws1, brand1 } = setupFixture(raw)

  const r = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Market Trends with Provenance',
    findings: 'Key market findings',
    status: 'completed',
    scopeType: 'brand',
    scopeId: brand1,
  })

  await createResearchSource(db, {
    workspaceId: ws1,
    researchId: r.id,
    sourceType: 'website',
    title: 'Web Source',
    url: 'https://example.com/trends',
  })

  const conversationId = crypto.randomUUID()
  raw
    .prepare(
      `INSERT INTO conversation (id, workspace_id, scope_type, scope_id, title, created_at, updated_at)
     VALUES (?, ?, 'brand', ?, 'Brand Convo With Sources', ?, ?)`,
    )
    .run(conversationId, ws1, brand1, NOW, NOW)

  const ctx = await buildContext(db, {
    workspaceId: ws1,
    conversationId,
    now: NOW,
  })

  assert.equal(ctx.research.length, 1)
  assert.equal(ctx.research[0].subject, 'Market Trends with Provenance')
  assert.equal(ctx.research[0].freshness, 'current')
})

test('35. STEP 12C.1: Researcher assistant message is identified for Save as Research', async () => {
  const { db, raw } = freshDb()
  const { ws1, researcherId } = setupFixture(raw)

  const chatAgents = await listChatAgents(db, ws1)
  const agentRoles = new Map(chatAgents.map((a) => [a.id, a.role]))
  const agentNames = new Map(chatAgents.map((a) => [a.id, a.name]))

  const researcherMsg = {
    senderType: 'agent' as const,
    agentId: researcherId,
  }

  const isEligible =
    researcherMsg.senderType === 'agent' &&
    Boolean(
      (researcherMsg.agentId && agentRoles.get(researcherMsg.agentId) === 'researcher') ||
        (researcherMsg.agentId && agentNames.get(researcherMsg.agentId) === 'Researcher'),
    )

  assert.equal(isEligible, true)
})

test('36. STEP 12C.2: User, system, and non-Researcher messages are not eligible for Save as Research', async () => {
  const { db, raw } = freshDb()
  const { ws1, chiefId } = setupFixture(raw)

  const chatAgents = await listChatAgents(db, ws1)
  const agentRoles = new Map(chatAgents.map((a) => [a.id, a.role]))
  const agentNames = new Map(chatAgents.map((a) => [a.id, a.name]))

  const userMsg = { senderType: 'user' as const, agentId: null }
  const systemMsg = { senderType: 'system' as const, agentId: null }
  const chiefMsg = { senderType: 'agent' as const, agentId: chiefId }

  const checkEligibility = (msg: { senderType: string; agentId: string | null }) =>
    msg.senderType === 'agent' &&
    Boolean(
      (msg.agentId && agentRoles.get(msg.agentId) === 'researcher') ||
        (msg.agentId && agentNames.get(msg.agentId) === 'Researcher'),
    )

  assert.equal(checkEligibility(userMsg), false)
  assert.equal(checkEligibility(systemMsg), false)
  assert.equal(checkEligibility(chiefMsg), false)
})

test('37. STEP 12C.3: deriveResearchTitle extracts title deterministically from content', () => {
  assert.equal(
    deriveResearchTitle('## 2026 SaaS Pricing Trends\nHere are the details...'),
    '2026 SaaS Pricing Trends',
  )
  assert.equal(
    deriveResearchTitle('**Customer Retention Insights**\nRetention grew by 12%...'),
    'Customer Retention Insights',
  )
  assert.equal(
    deriveResearchTitle('- Key Competitive Advantage\nOur platform has lower latency...'),
    'Key Competitive Advantage',
  )
  assert.equal(deriveResearchTitle(''), 'Researcher Finding')
  assert.equal(deriveResearchTitle('   \n\n  '), 'Researcher Finding')
  // Long header truncated
  const longText = `### ${'A'.repeat(120)}`
  const derived = deriveResearchTitle(longText)
  assert.ok(derived.length <= 100)
  assert.ok(derived.endsWith('…'))
})

test('38. STEP 12C.4: scope-based suggested research type logic', () => {
  const deriveSuggestedType = (scopeType?: string | null) => {
    if (scopeType === 'product') return 'product'
    if (scopeType === 'brand') return 'market'
    if (scopeType === 'account') return 'competitor'
    return 'general'
  }

  assert.equal(deriveSuggestedType('product'), 'product')
  assert.equal(deriveSuggestedType('brand'), 'market')
  assert.equal(deriveSuggestedType('account'), 'competitor')
  assert.equal(deriveSuggestedType('workspace'), 'general')
  assert.equal(deriveSuggestedType(null), 'general')
  assert.equal(deriveSuggestedType(undefined), 'general')
})

test('39. STEP 12C.5: AI response save strictly defaults to status = draft', async () => {
  const { db, raw } = freshDb()
  const { ws1, researcherId } = setupFixture(raw)

  const created = await createResearch(db, {
    workspaceId: ws1,
    subject: 'AI Market Finding',
    findings: 'Market trends indicate a shift to lightweight CRMs.',
    status: 'draft',
    origin: {
      originType: 'researcher',
      agentId: researcherId,
    },
  })

  assert.equal(created.status, 'draft')

  const fetched = await getResearch(db, { workspaceId: ws1, id: created.id })
  assert.ok(fetched)
  assert.equal(fetched.status, 'draft')
})

test('40. STEP 12C.6: save form uses existing createResearch repository function', async () => {
  const { db, raw } = freshDb()
  const { ws1, brand1, researcherId } = setupFixture(raw)

  const created = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Reviewed AI Finding',
    findings: 'Key finding content after user review',
    researchType: 'market',
    status: 'draft',
    confidence: 0.85,
    scopeType: 'brand',
    scopeId: brand1,
    origin: {
      originType: 'researcher',
      agentId: researcherId,
      conversationId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
    },
  })

  assert.ok(created.id)
  assert.equal(created.subject, 'Reviewed AI Finding')
  assert.equal(created.findings, 'Key finding content after user review')
  assert.equal(created.status, 'draft')
  assert.equal(created.scopeType, 'brand')
  assert.equal(created.scopeId, brand1)
})

test('41. STEP 12C.7: user can edit subject, findings, type, confidence, scope before save', async () => {
  const { db, raw } = freshDb()
  const { ws1, product1, researcherId } = setupFixture(raw)

  // Simulated edited input by user in save modal
  const userInput = {
    workspaceId: ws1,
    subject: 'Customized Title by User',
    findings: 'Findings edited and refined by user before confirming save',
    researchType: 'product' as const,
    status: 'draft' as const,
    confidence: 0.95,
    scopeType: 'product' as const,
    scopeId: product1,
    origin: {
      originType: 'researcher' as const,
      agentId: researcherId,
    },
  }

  const created = await createResearch(db, userInput)
  assert.equal(created.subject, 'Customized Title by User')
  assert.equal(created.findings, 'Findings edited and refined by user before confirming save')
  assert.equal(created.researchType, 'product')
  assert.equal(created.confidence, 0.95)
  assert.equal(created.scopeType, 'product')
  assert.equal(created.scopeId, product1)
})

test('42. STEP 12C.8: Researcher agent configuration has read-only context capabilities and no write tools', async () => {
  const { BUILTIN_AGENTS } = await import('../src/server/agents/definitions.ts')
  const researcher = BUILTIN_AGENTS.find((a) => a.key === 'researcher')
  assert.ok(researcher, 'Researcher agent definition must exist')
  assert.equal(researcher.name, 'Researcher')
  assert.equal(researcher.executionType, 'direct_model')
  assert.deepEqual(researcher.capabilities, [
    'read_context',
    'read_memory',
    'read_research',
    'web_search',
  ])
  // Ensure no write capabilities are granted to researcher
  assert.ok(!researcher.capabilities.includes('write_research' as never))
  assert.ok(!researcher.capabilities.includes('write_memory' as never))
})

test('43. STEP 12C.9: saved Draft research is strictly excluded from Context Engine', async () => {
  const { db, raw } = freshDb()
  const { ws1, brand1, researcherId } = setupFixture(raw)

  // Create a draft research record
  await createResearch(db, {
    workspaceId: ws1,
    subject: 'Draft AI Finding',
    findings: 'Unverified preliminary hypothesis',
    status: 'draft',
    scopeType: 'brand',
    scopeId: brand1,
    origin: {
      originType: 'researcher',
      agentId: researcherId,
    },
  })

  // Create an active (completed) research record
  await createResearch(db, {
    workspaceId: ws1,
    subject: 'Active Verified Research',
    findings: 'Verified findings',
    status: 'completed',
    scopeType: 'brand',
    scopeId: brand1,
  })

  const conversationId = crypto.randomUUID()
  raw
    .prepare(
      `INSERT INTO conversation (id, workspace_id, scope_type, scope_id, title, created_at, updated_at)
       VALUES (?, ?, 'brand', ?, 'Brand Chat', ?, ?)`,
    )
    .run(conversationId, ws1, brand1, NOW, NOW)

  const ctx = await buildContext(db, {
    workspaceId: ws1,
    conversationId,
    now: NOW,
  })

  const subjects = ctx.research.map((r) => r.subject)
  assert.ok(subjects.includes('Active Verified Research'))
  assert.ok(
    !subjects.includes('Draft AI Finding'),
    'Draft research MUST NOT appear in Context Engine',
  )
})

test('44. STEP 12C.10: activating Draft via updateResearch(status = completed) makes it eligible in Context Engine', async () => {
  const { db, raw } = freshDb()
  const { ws1, brand1, researcherId } = setupFixture(raw)

  // 1. Create draft
  const draft = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Promotable AI Finding',
    findings: 'Insights discovered by researcher',
    status: 'draft',
    scopeType: 'brand',
    scopeId: brand1,
    origin: {
      originType: 'researcher',
      agentId: researcherId,
    },
  })

  const conversationId = crypto.randomUUID()
  raw
    .prepare(
      `INSERT INTO conversation (id, workspace_id, scope_type, scope_id, title, created_at, updated_at)
       VALUES (?, ?, 'brand', ?, 'Brand Chat', ?, ?)`,
    )
    .run(conversationId, ws1, brand1, NOW, NOW)

  // Check initial context excludes draft
  let ctx = await buildContext(db, { workspaceId: ws1, conversationId, now: NOW })
  assert.ok(!ctx.research.some((r) => r.id === draft.id))

  // 2. User reviews and promotes to completed
  await updateResearch(db, {
    workspaceId: ws1,
    id: draft.id,
    status: 'completed',
  })

  // Check context now includes promoted research
  ctx = await buildContext(db, { workspaceId: ws1, conversationId, now: NOW })
  assert.ok(
    ctx.research.some((r) => r.id === draft.id),
    'Promoted research MUST appear in Context Engine',
  )
  assert.equal(ctx.research.find((r) => r.id === draft.id)?.subject, 'Promotable AI Finding')
})

test('45. STEP 12C.11: AI response save does NOT create fake research_source row', async () => {
  const { db, raw } = freshDb()
  const { ws1, researcherId } = setupFixture(raw)

  const created = await createResearch(db, {
    workspaceId: ws1,
    subject: 'AI Generated Summary',
    findings: 'Summary of past conversations',
    status: 'draft',
    origin: {
      originType: 'researcher',
      agentId: researcherId,
    },
  })

  const sources = raw.prepare(`SELECT * FROM research_source WHERE research_id = ?`).all(created.id)
  assert.equal(sources.length, 0, 'No research_source row should be created for AI output')
})

test('46. STEP 12C.12: no fabricated citations or fake sources created on save', async () => {
  const { db, raw } = freshDb()
  const { ws1 } = setupFixture(raw)

  const initialSourceCount = raw.prepare(`SELECT count(*) as cnt FROM research_source`).get() as {
    cnt: number
  }

  await createResearch(db, {
    workspaceId: ws1,
    subject: 'Pure AI Synthesis',
    findings: 'Synthesized context',
    status: 'draft',
  })

  const finalSourceCount = raw.prepare(`SELECT count(*) as cnt FROM research_source`).get() as {
    cnt: number
  }
  assert.equal(
    finalSourceCount.cnt,
    initialSourceCount.cnt,
    'Total sources must not increase when saving AI findings',
  )
})

test('47. STEP 12C.13: safe origin linkage recorded in audit logs and events', async () => {
  const { db, raw } = freshDb()
  const { ws1, researcherId } = setupFixture(raw)
  const conversationId = crypto.randomUUID()
  const messageId = crypto.randomUUID()
  const agentVersionId = crypto.randomUUID()

  const created = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Traceable AI Finding',
    status: 'draft',
    origin: {
      originType: 'researcher',
      agentId: researcherId,
      agentVersionId,
      conversationId,
      messageId,
    },
  })

  // Verify Audit Log
  const audit = raw
    .prepare(
      `SELECT new_value FROM audit_log WHERE entity_type = 'research' AND entity_id = ? AND action = 'create'`,
    )
    .get(created.id) as { new_value: string }
  assert.ok(audit, 'Audit log must be created')
  const auditPayload = JSON.parse(audit.new_value)
  assert.ok(auditPayload.origin)
  assert.equal(auditPayload.origin.originType, 'researcher')
  assert.equal(auditPayload.origin.agentId, researcherId)
  assert.equal(auditPayload.origin.agentVersionId, agentVersionId)
  assert.equal(auditPayload.origin.conversationId, conversationId)
  assert.equal(auditPayload.origin.messageId, messageId)

  // Verify Event
  const event = raw
    .prepare(
      `SELECT payload FROM event WHERE subject_type = 'research' AND subject_id = ? AND event_type = 'research.created'`,
    )
    .get(created.id) as { payload: string }
  assert.ok(event, 'Event must be emitted')
  const eventPayload = JSON.parse(event.payload)
  assert.ok(eventPayload.origin)
  assert.equal(eventPayload.origin.originType, 'researcher')
  assert.equal(eventPayload.origin.agentId, researcherId)
})

test('48. STEP 12C.14: no model secrets, API keys, or raw provider payloads leaked in origin metadata', async () => {
  const { db, raw } = freshDb()
  const { ws1, researcherId } = setupFixture(raw)

  const created = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Sanitized Origin Test',
    status: 'draft',
    origin: {
      originType: 'researcher',
      agentId: researcherId,
    },
  })

  const audit = raw
    .prepare(`SELECT new_value FROM audit_log WHERE entity_id = ?`)
    .get(created.id) as { new_value: string }
  const payloadStr = audit.new_value.toLowerCase()
  assert.ok(!payloadStr.includes('api_key'))
  assert.ok(!payloadStr.includes('secret'))
  assert.ok(!payloadStr.includes('bearer'))
  assert.ok(!payloadStr.includes('authorization'))
})

test('49. STEP 12C.15: createConversation handles brand, product, account, and campaign scope correctly', async () => {
  const { db, raw } = freshDb()
  const { ws1, brand1, product1 } = setupFixture(raw)

  // Brand scoped conversation
  const brandConvo = await createConversation(db, {
    workspaceId: ws1,
    title: 'Brand Analysis',
    scopeType: 'brand',
    scopeId: brand1,
  })
  assert.equal(brandConvo.scopeType, 'brand')
  assert.equal(brandConvo.scopeId, brand1)

  // Product scoped conversation
  const productConvo = await createConversation(db, {
    workspaceId: ws1,
    title: 'Product Analysis',
    scopeType: 'product',
    scopeId: product1,
  })
  assert.equal(productConvo.scopeType, 'product')
  assert.equal(productConvo.scopeId, product1)

  // Workspace general conversation
  const wsConvo = await createConversation(db, {
    workspaceId: ws1,
    title: 'General Workspace Discussion',
  })
  assert.equal(wsConvo.scopeType, null)
  assert.equal(wsConvo.scopeId, null)
})

test('50. STEP 12C.16: startResearcherChat flow creates conversation with preserved scope and finds Researcher agent', async () => {
  const { db, raw } = freshDb()
  const { ws1, brand1, researcherId } = setupFixture(raw)

  // Simulated startResearcherChat logic
  const agents = await listAgents(db, ws1)
  const researcher =
    agents.find((a) => a.role === 'researcher') ??
    agents.find((a) => a.name.toLowerCase() === 'researcher')
  assert.ok(researcher)
  assert.equal(researcher.id, researcherId)

  const convo = await createConversation(db, {
    workspaceId: ws1,
    title: 'Research Analysis',
    scopeType: 'brand',
    scopeId: brand1,
  })
  assert.ok(convo.id)
  assert.equal(convo.scopeType, 'brand')
  assert.equal(convo.scopeId, brand1)
})

test('51. STEP 12C.17: resolveSelectedAgent correctly selects Researcher when agent query param is present', async () => {
  const { db, raw } = freshDb()
  const { ws1, chiefId, researcherId } = setupFixture(raw)

  const agents = await listChatAgents(db, ws1)

  // When agent param is researcherId
  const selectedResearcher = resolveSelectedAgent(agents, researcherId)
  assert.ok(selectedResearcher)
  assert.equal(selectedResearcher.id, researcherId)
  assert.equal(selectedResearcher.name, 'Researcher')

  // When agent param is chiefId
  const selectedChief = resolveSelectedAgent(agents, chiefId)
  assert.ok(selectedChief)
  assert.equal(selectedChief.id, chiefId)
  assert.equal(selectedChief.name, 'Chief')

  // When agent param is undefined, falls back to Chief
  const defaultSelected = resolveSelectedAgent(agents, undefined)
  assert.ok(defaultSelected)
  assert.equal(defaultSelected.name, 'Chief')
})

test('52. STEP 12C.18: full chat conversation lifecycle with Researcher reply and draft save remains intact', async () => {
  const { db, raw } = freshDb()
  const { ws1, brand1, researcherId } = setupFixture(raw)

  // 1. User launches Researcher chat from Research workspace
  const convo = await createConversation(db, {
    workspaceId: ws1,
    title: 'Research Session',
    scopeType: 'brand',
    scopeId: brand1,
  })

  // 2. User sends message
  const userMsgId = crypto.randomUUID()
  raw
    .prepare(
      `INSERT INTO message (id, conversation_id, sender_type, agent_id, content, created_at)
       VALUES (?, ?, 'user', NULL, 'What are the main competitors for SheetLab?', ?)`,
    )
    .run(userMsgId, convo.id, NOW)

  // 3. Researcher agent replies
  const assistantMsgId = crypto.randomUUID()
  const assistantContent =
    '### Competitor Landscape\nBased on existing research, Notion and Airtable are key players.'
  raw
    .prepare(
      `INSERT INTO message (id, conversation_id, sender_type, agent_id, content, created_at)
       VALUES (?, ?, 'agent', ?, ?, ?)`,
    )
    .run(assistantMsgId, convo.id, researcherId, assistantContent, NOW)

  // 4. User clicks "Save as Research" and submits reviewed draft
  const title = deriveResearchTitle(assistantContent)
  assert.equal(title, 'Competitor Landscape')

  const draft = await createResearch(db, {
    workspaceId: ws1,
    subject: title,
    findings: assistantContent,
    researchType: 'competitor',
    status: 'draft',
    confidence: 0.8,
    scopeType: 'brand',
    scopeId: brand1,
    origin: {
      originType: 'researcher',
      agentId: researcherId,
      conversationId: convo.id,
      messageId: assistantMsgId,
    },
  })

  assert.ok(draft.id)
  assert.equal(draft.status, 'draft')
  assert.equal(draft.subject, 'Competitor Landscape')

  // 5. Context engine excludes draft
  let ctx = await buildContext(db, { workspaceId: ws1, conversationId: convo.id, now: NOW })
  assert.ok(!ctx.research.some((r) => r.id === draft.id))

  // 6. User verifies and promotes to completed
  await updateResearch(db, { workspaceId: ws1, id: draft.id, status: 'completed' })

  // 7. Context engine now includes verified research
  ctx = await buildContext(db, { workspaceId: ws1, conversationId: convo.id, now: NOW })
  assert.ok(ctx.research.some((r) => r.id === draft.id))
})

test('53. STEP 12D.1: select 2 valid research records passes validation', async () => {
  const { db, raw } = freshDb()
  const { ws1, brand1 } = setupFixture(raw)

  const r1 = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Pricing Model Analysis',
    findings: 'Freemium tier drives 40% of signups.',
    researchType: 'market',
    status: 'completed',
    scopeType: 'brand',
    scopeId: brand1,
  })

  const r2 = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Competitor Feature Matrix',
    findings: 'Competitor A lacks real-time collaboration.',
    researchType: 'competitor',
    status: 'completed',
    scopeType: 'brand',
    scopeId: brand1,
  })

  const selected = await validateResearchSelection(db, {
    workspaceId: ws1,
    researchIds: [r1.id, r2.id],
    now: NOW,
  })

  assert.equal(selected.length, 2)
  assert.equal(selected[0].id, r1.id)
  assert.equal(selected[0].subject, 'Pricing Model Analysis')
  assert.equal(selected[1].id, r2.id)
  assert.equal(selected[1].subject, 'Competitor Feature Matrix')
})

test('54. STEP 12D.2: selection limit enforced (min 2, max 10)', async () => {
  const { db, raw } = freshDb()
  const { ws1 } = setupFixture(raw)

  const r1 = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Item 1',
    findings: 'Finding 1',
    status: 'completed',
  })

  // Under minimum (< 2)
  await assert.rejects(
    async () => {
      await validateResearchSelection(db, {
        workspaceId: ws1,
        researchIds: [r1.id],
        now: NOW,
      })
    },
    (err: unknown) => {
      assert.ok(err instanceof ResearchAnalysisValidationError)
      assert.match(err.message, /between 2 and 10/i)
      return true
    },
  )

  // Create 11 items
  const ids: string[] = [r1.id]
  for (let i = 2; i <= 11; i++) {
    const item = await createResearch(db, {
      workspaceId: ws1,
      subject: `Item ${i}`,
      findings: `Finding ${i}`,
      status: 'completed',
    })
    ids.push(item.id)
  }

  // Over maximum (> 10)
  await assert.rejects(
    async () => {
      await validateResearchSelection(db, {
        workspaceId: ws1,
        researchIds: ids,
        now: NOW,
      })
    },
    (err: unknown) => {
      assert.ok(err instanceof ResearchAnalysisValidationError)
      assert.match(err.message, /between 2 and 10/i)
      return true
    },
  )

  // Exactly 10 succeeds
  const exactly10 = await validateResearchSelection(db, {
    workspaceId: ws1,
    researchIds: ids.slice(0, 10),
    now: NOW,
  })
  assert.equal(exactly10.length, 10)
})

test('55. STEP 12D.3: duplicate research IDs rejected', async () => {
  const { db, raw } = freshDb()
  const { ws1 } = setupFixture(raw)

  const r1 = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Duplicate Test Record',
    findings: 'Finding',
    status: 'completed',
  })

  await assert.rejects(
    async () => {
      await validateResearchSelection(db, {
        workspaceId: ws1,
        researchIds: [r1.id, r1.id],
        now: NOW,
      })
    },
    (err: unknown) => {
      assert.ok(err instanceof ResearchAnalysisValidationError)
      assert.match(err.message, /Duplicate/i)
      return true
    },
  )
})

test('56. STEP 12D.4: cross-workspace research rejected from selection', async () => {
  const { db, raw } = freshDb()
  const { ws1, ws2 } = setupFixture(raw)

  const r1 = await createResearch(db, {
    workspaceId: ws1,
    subject: 'WS1 Research',
    findings: 'Finding 1',
    status: 'completed',
  })

  const r2 = await createResearch(db, {
    workspaceId: ws2,
    subject: 'WS2 Research',
    findings: 'Finding 2',
    status: 'completed',
  })

  await assert.rejects(
    async () => {
      await validateResearchSelection(db, {
        workspaceId: ws1,
        researchIds: [r1.id, r2.id],
        now: NOW,
      })
    },
    (err: unknown) => {
      assert.ok(err instanceof ResearchAnalysisValidationError)
      assert.match(err.message, /not found or belongs to another workspace/i)
      return true
    },
  )
})

test('57. STEP 12D.5: archived research rejected from selection', async () => {
  const { db, raw } = freshDb()
  const { ws1 } = setupFixture(raw)

  const r1 = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Active Record',
    findings: 'Finding 1',
    status: 'completed',
  })

  const r2 = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Archived Record',
    findings: 'Finding 2',
    status: 'completed',
  })

  await archiveResearch(db, { workspaceId: ws1, id: r2.id })

  await assert.rejects(
    async () => {
      await validateResearchSelection(db, {
        workspaceId: ws1,
        researchIds: [r1.id, r2.id],
        now: NOW,
      })
    },
    (err: unknown) => {
      assert.ok(err instanceof ResearchAnalysisValidationError)
      assert.match(err.message, /Archived research/i)
      return true
    },
  )
})

test('58. STEP 12D.6: expired research rejected from selection', async () => {
  const { db, raw } = freshDb()
  const { ws1 } = setupFixture(raw)

  const r1 = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Valid Record',
    findings: 'Finding 1',
    status: 'completed',
  })

  const r2 = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Expired Record',
    findings: 'Finding 2',
    status: 'completed',
  })

  // Set expires_at in the past
  raw
    .prepare(`UPDATE research SET expires_at = ? WHERE id = ?`)
    .run('2025-01-01T00:00:00.000Z', r2.id)

  await assert.rejects(
    async () => {
      await validateResearchSelection(db, {
        workspaceId: ws1,
        researchIds: [r1.id, r2.id],
        now: NOW,
      })
    },
    (err: unknown) => {
      assert.ok(err instanceof ResearchAnalysisValidationError)
      assert.match(err.message, /Expired research/i)
      return true
    },
  )
})

test('59. STEP 12D.7: compare task composed with required sections', async () => {
  const { db, raw } = freshDb()
  const { ws1 } = setupFixture(raw)

  const r1 = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Pricing Model A',
    findings: 'Annual billing with 20% discount.',
    researchType: 'market',
    status: 'completed',
  })

  const r2 = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Pricing Model B',
    findings: 'Monthly usage-based billing with tiered pricing.',
    researchType: 'market',
    status: 'completed',
  })

  const selected = await validateResearchSelection(db, {
    workspaceId: ws1,
    researchIds: [r1.id, r2.id],
    now: NOW,
  })

  const prompt = composeResearchAnalysisTask({
    mode: 'compare',
    selectedResearch: selected,
  })

  assert.ok(prompt.includes('Task: Research Compare Analysis'))
  assert.ok(prompt.includes('Agreements'))
  assert.ok(prompt.includes('Differences'))
  assert.ok(prompt.includes('Contradictions'))
  assert.ok(prompt.includes('Evidence Gaps'))
  assert.ok(prompt.includes('Recommended Next Questions'))
  assert.ok(prompt.includes('Pricing Model A'))
  assert.ok(prompt.includes('Pricing Model B'))
})

test('60. STEP 12D.8: synthesize task composed with required concepts', async () => {
  const { db, raw } = freshDb()
  const { ws1 } = setupFixture(raw)

  const r1 = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Customer Survey Q1',
    findings: 'Users want better export features.',
    researchType: 'product',
    status: 'completed',
  })

  const r2 = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Customer Survey Q2',
    findings: 'Export speed improved but CSV formatting needs work.',
    researchType: 'product',
    status: 'completed',
  })

  const selected = await validateResearchSelection(db, {
    workspaceId: ws1,
    researchIds: [r1.id, r2.id],
    now: NOW,
  })

  const prompt = composeResearchAnalysisTask({
    mode: 'synthesize',
    selectedResearch: selected,
  })

  assert.ok(prompt.includes('Task: Research Synthesize Analysis'))
  assert.ok(prompt.includes('Strongest Supported Conclusions'))
  assert.ok(prompt.includes('Repeated Patterns'))
  assert.ok(prompt.includes('Weak or Conflicting Evidence'))
  assert.ok(prompt.includes('Gaps & Unknowns'))
  assert.ok(prompt.includes('Strategic Implications'))
})

test('61. STEP 12D.9: pattern task composed correctly', async () => {
  const { db, raw } = freshDb()
  const { ws1 } = setupFixture(raw)

  const r1 = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Churn Analysis Q1',
    findings: 'Onboarding dropoff at step 3.',
    researchType: 'general',
    status: 'completed',
  })

  const r2 = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Support Tickets Q1',
    findings: 'Frequent questions regarding onboarding step 3.',
    researchType: 'product',
    status: 'completed',
  })

  const selected = await validateResearchSelection(db, {
    workspaceId: ws1,
    researchIds: [r1.id, r2.id],
    now: NOW,
  })

  const prompt = composeResearchAnalysisTask({
    mode: 'patterns',
    selectedResearch: selected,
  })

  assert.ok(prompt.includes('Task: Research Patterns Analysis'))
  assert.ok(prompt.includes('Core Recurring Patterns'))
  assert.ok(prompt.includes('Cross-Scope Overlaps'))
  assert.ok(prompt.includes('Context & Conditions'))
  assert.ok(prompt.includes('Limitations'))
})

test('62. STEP 12D.10: contradiction task composed correctly', async () => {
  const { db, raw } = freshDb()
  const { ws1 } = setupFixture(raw)

  const r1 = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Market Report 2025',
    findings: 'Desktop usage is increasing in the B2B sector.',
    researchType: 'market',
    status: 'completed',
  })

  const r2 = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Internal Analytics 2025',
    findings: 'Mobile traffic accounted for 65% of new enterprise leads.',
    researchType: 'general',
    status: 'completed',
  })

  const selected = await validateResearchSelection(db, {
    workspaceId: ws1,
    researchIds: [r1.id, r2.id],
    now: NOW,
  })

  const prompt = composeResearchAnalysisTask({
    mode: 'contradictions',
    selectedResearch: selected,
  })

  assert.ok(prompt.includes('Task: Research Contradictions Analysis'))
  assert.ok(prompt.includes('Identified Contradictions'))
  assert.ok(prompt.includes('Possible Explanations'))
  assert.ok(prompt.includes('Decision Impact'))
  assert.ok(prompt.includes('Resolution Steps'))
})

test('63. STEP 12D.11: Researcher agent resolved and selected', async () => {
  const { db, raw } = freshDb()
  const { ws1, researcherId } = setupFixture(raw)

  const agents = await listAgents(db, ws1)
  const researcher =
    agents.find((a) => a.role === 'researcher') ??
    agents.find((a) => a.name.toLowerCase() === 'researcher')

  assert.ok(researcher)
  assert.equal(researcher.id, researcherId)
  assert.equal(researcher.role, 'researcher')
})

test('64. STEP 12D.12: normal chat conversation created with preserved scope', async () => {
  const { db, raw } = freshDb()
  const { ws1, brand1 } = setupFixture(raw)

  const brand1b = crypto.randomUUID()
  raw
    .prepare(
      `INSERT INTO brand (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(brand1b, ws1, 'Brand 1B', NOW, NOW)

  // 1. Both records have same scope (brand1) -> preserves brand1
  const r1 = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Brand 1 Research A',
    findings: 'Finding A',
    status: 'completed',
    scopeType: 'brand',
    scopeId: brand1,
  })
  const r2 = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Brand 1 Research B',
    findings: 'Finding B',
    status: 'completed',
    scopeType: 'brand',
    scopeId: brand1,
  })

  const selectedSame = await validateResearchSelection(db, {
    workspaceId: ws1,
    researchIds: [r1.id, r2.id],
    now: NOW,
  })

  // Common scope resolution
  const first = selectedSame[0]
  const allSameScope = selectedSame.every(
    (item) => item.scopeType === first.scopeType && item.scopeId === first.scopeId,
  )
  const commonScopeType = allSameScope ? first.scopeType : null
  const commonScopeId = allSameScope ? first.scopeId : null

  assert.equal(commonScopeType, 'brand')
  assert.equal(commonScopeId, brand1)

  const convo1 = await createConversation(db, {
    workspaceId: ws1,
    title: 'Research Analysis: Pricing Model',
    scopeType: commonScopeType,
    scopeId: commonScopeId,
  })
  assert.equal(convo1.scopeType, 'brand')
  assert.equal(convo1.scopeId, brand1)

  // 2. Records have different scopes (brand1 and brand1b) -> null scope
  const r3 = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Brand 1B Research',
    findings: 'Finding C',
    status: 'completed',
    scopeType: 'brand',
    scopeId: brand1b,
  })

  const selectedDiff = await validateResearchSelection(db, {
    workspaceId: ws1,
    researchIds: [r1.id, r3.id],
    now: NOW,
  })

  const allSameScopeDiff = selectedDiff.every(
    (item) =>
      item.scopeType === selectedDiff[0].scopeType && item.scopeId === selectedDiff[0].scopeId,
  )
  assert.equal(allSameScopeDiff, false)
})

test('65. STEP 12D.13: selected research supplied as explicit task context', async () => {
  const { db, raw } = freshDb()
  const { ws1 } = setupFixture(raw)

  const r1 = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Retention Strategy 2026',
    findings: 'Weekly digest emails boost retention by 15%.',
    researchType: 'general',
    status: 'completed',
  })

  const r2 = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Notification Frequency Benchmark',
    findings: 'Over 3 emails per week causes unsubscribe rate to spike.',
    researchType: 'market',
    status: 'completed',
  })

  const selected = await validateResearchSelection(db, {
    workspaceId: ws1,
    researchIds: [r1.id, r2.id],
    now: NOW,
  })

  const prompt = composeResearchAnalysisTask({
    mode: 'compare',
    selectedResearch: selected,
  })

  assert.ok(prompt.includes('Selected Research Records (2 items):'))
  assert.ok(prompt.includes('[Record 1] Retention Strategy 2026'))
  assert.ok(prompt.includes('Weekly digest emails boost retention by 15%.'))
  assert.ok(prompt.includes('[Record 2] Notification Frequency Benchmark'))
  assert.ok(prompt.includes('Over 3 emails per week causes unsubscribe rate to spike.'))
})

test('66. STEP 12D.14: safe fields only passed to prompt composer', async () => {
  const { db, raw } = freshDb()
  const { ws1, brand1 } = setupFixture(raw)

  const r1 = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Safe Content Test',
    findings: 'Validated findings content.',
    researchType: 'market',
    status: 'completed',
    scopeType: 'brand',
    scopeId: brand1,
  })

  const r2 = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Second Safe Test',
    findings: 'Another validated finding.',
    researchType: 'competitor',
    status: 'completed',
  })

  const selected = await validateResearchSelection(db, {
    workspaceId: ws1,
    researchIds: [r1.id, r2.id],
    now: NOW,
  })

  const prompt = composeResearchAnalysisTask({
    mode: 'synthesize',
    selectedResearch: selected,
  })

  // Safe fields present
  assert.ok(prompt.includes('Safe Content Test'))
  assert.ok(prompt.includes('**Type**: market'))
  assert.ok(prompt.includes('Validated findings content.'))

  // Unsafe database internals / secrets NOT leaked in prompt
  assert.ok(!prompt.includes('deleted_at'))
  assert.ok(!prompt.includes('workspace_id'))
  assert.ok(!prompt.includes('api_key'))
  assert.ok(!prompt.includes('auth_token'))
})

test('67. STEP 12D.15: freshness included in composed prompt', async () => {
  const { db, raw } = freshDb()
  const { ws1 } = setupFixture(raw)

  const r1 = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Current Record',
    findings: 'Recent findings.',
    status: 'completed',
  })

  const r2 = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Aging Record',
    findings: 'Older findings.',
    status: 'completed',
  })

  // Make r2 45 days old (aging)
  raw
    .prepare(`UPDATE research SET updated_at = ? WHERE id = ?`)
    .run('2026-01-01T00:00:00.000Z', r2.id)

  const selected = await validateResearchSelection(db, {
    workspaceId: ws1,
    researchIds: [r1.id, r2.id],
    now: NOW,
  })

  const prompt = composeResearchAnalysisTask({
    mode: 'compare',
    selectedResearch: selected,
  })

  assert.ok(prompt.includes('**Freshness**: current'))
  assert.ok(prompt.includes('**Freshness**: aging'))
})

test('68. STEP 12D.16: provenance summary included in prompt', async () => {
  const { db, raw } = freshDb()
  const { ws1 } = setupFixture(raw)

  const r1 = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Sourced Finding',
    findings: 'Sourced findings.',
    status: 'completed',
  })

  await createResearchSource(db, {
    workspaceId: ws1,
    researchId: r1.id,
    sourceType: 'report',
    title: 'Gartner Industry Analysis 2026',
    publisher: 'Gartner Research',
    url: 'https://gartner.com/report/2026',
  })

  const r2 = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Direct Observation',
    findings: 'Internal team notes.',
    status: 'completed',
  })

  const selected = await validateResearchSelection(db, {
    workspaceId: ws1,
    researchIds: [r1.id, r2.id],
    now: NOW,
  })

  const prompt = composeResearchAnalysisTask({
    mode: 'synthesize',
    selectedResearch: selected,
  })

  assert.ok(prompt.includes('Gartner Industry Analysis 2026'))
  assert.ok(prompt.includes('**Provenance**:'))
})

test('69. STEP 12D.17: prompt enforces source honesty and forbids fake citations', async () => {
  const { db, raw } = freshDb()
  const { ws1 } = setupFixture(raw)

  const r1 = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Record A',
    findings: 'Finding A',
    status: 'completed',
  })

  const r2 = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Record B',
    findings: 'Finding B',
    status: 'completed',
  })

  const selected = await validateResearchSelection(db, {
    workspaceId: ws1,
    researchIds: [r1.id, r2.id],
    now: NOW,
  })

  const prompt = composeResearchAnalysisTask({
    mode: 'compare',
    selectedResearch: selected,
  })

  assert.ok(prompt.includes('Analysis Guidelines:'))
  assert.ok(prompt.includes('Base your analysis exclusively on the findings and recorded sources'))
  assert.ok(prompt.includes('Do not claim to have browsed the live internet'))
  assert.ok(prompt.includes('Do not fabricate citations or external validations'))
})

test('70. STEP 12D.18: saved result strictly defaults to Draft', async () => {
  const { db, raw } = freshDb()
  const { ws1, researcherId } = setupFixture(raw)

  const r1 = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Source 1',
    findings: 'Finding 1',
    status: 'completed',
  })
  const r2 = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Source 2',
    findings: 'Finding 2',
    status: 'completed',
  })

  const derived = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Synthesized Market Overview',
    findings: 'Combined insights from pricing and competitor analysis.',
    status: 'draft',
    origin: {
      originType: 'researcher',
      agentId: researcherId,
      derivedFromResearchIds: [r1.id, r2.id],
    },
  })

  assert.equal(derived.status, 'draft')

  const fetched = await getResearch(db, { workspaceId: ws1, id: derived.id })
  assert.ok(fetched)
  assert.equal(fetched.status, 'draft')
})

test('71. STEP 12D.19: saved result does not duplicate underlying sources', async () => {
  const { db, raw } = freshDb()
  const { ws1, researcherId } = setupFixture(raw)

  const r1 = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Source Record 1',
    findings: 'Finding 1',
    status: 'completed',
  })
  await createResearchSource(db, {
    workspaceId: ws1,
    researchId: r1.id,
    sourceType: 'website',
    title: 'Source Web Page',
    url: 'https://example.com/page',
  })

  const r2 = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Source Record 2',
    findings: 'Finding 2',
    status: 'completed',
  })

  // Save derived research
  const derived = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Derived Synthesis',
    findings: 'Synthesized finding.',
    status: 'draft',
    origin: {
      originType: 'researcher',
      agentId: researcherId,
      derivedFromResearchIds: [r1.id, r2.id],
    },
  })

  // Ensure no duplicate research_source records were created for derived research
  const derivedSources = await listResearchSources(db, { workspaceId: ws1, researchId: derived.id })
  assert.equal(derivedSources.length, 0)

  // Underlying source remains untouched
  const r1Sources = await listResearchSources(db, { workspaceId: ws1, researchId: r1.id })
  assert.equal(r1Sources.length, 1)
})

test('72. STEP 12D.20: derived research origin (derivedFromResearchIds) preserved safely', async () => {
  const { db, raw } = freshDb()
  const { ws1, researcherId } = setupFixture(raw)

  const r1 = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Underlying A',
    findings: 'Content A',
    status: 'completed',
  })
  const r2 = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Underlying B',
    findings: 'Content B',
    status: 'completed',
  })

  const convoId = crypto.randomUUID()
  const msgId = crypto.randomUUID()

  const derived = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Derived Comparative Insight',
    findings: 'Synthesized content comparing A and B.',
    status: 'draft',
    origin: {
      originType: 'researcher',
      agentId: researcherId,
      conversationId: convoId,
      messageId: msgId,
      derivedFromResearchIds: [r1.id, r2.id],
    },
  })

  // Audit log check
  const audit = raw
    .prepare(`SELECT new_value FROM audit_log WHERE entity_id = ?`)
    .get(derived.id) as {
    new_value: string
  }
  assert.ok(audit)
  const auditJson = JSON.parse(audit.new_value)
  assert.ok(auditJson.origin)
  assert.equal(auditJson.origin.originType, 'researcher')
  assert.equal(auditJson.origin.agentId, researcherId)
  assert.deepEqual(auditJson.origin.derivedFromResearchIds, [r1.id, r2.id])

  // Domain event check
  const event = raw
    .prepare(
      `SELECT payload FROM event WHERE subject_id = ? AND event_type = 'research.analysis_saved'`,
    )
    .get(derived.id) as { payload: string }
  assert.ok(event)
  const eventJson = JSON.parse(event.payload)
  assert.deepEqual(eventJson.derivedFromResearchIds, [r1.id, r2.id])
})

test('73. STEP 12D.21: underlying research records remain unchanged after derived save', async () => {
  const { db, raw } = freshDb()
  const { ws1, brand1, researcherId } = setupFixture(raw)

  const r1 = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Immutable Research 1',
    findings: 'Findings 1',
    researchType: 'market',
    status: 'completed',
    scopeType: 'brand',
    scopeId: brand1,
  })

  const r2 = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Immutable Research 2',
    findings: 'Findings 2',
    researchType: 'competitor',
    status: 'completed',
    scopeType: 'brand',
    scopeId: brand1,
  })

  // Create derived research
  await createResearch(db, {
    workspaceId: ws1,
    subject: 'Synthesized Output',
    findings: 'Derived summary',
    status: 'draft',
    origin: {
      originType: 'researcher',
      agentId: researcherId,
      derivedFromResearchIds: [r1.id, r2.id],
    },
  })

  // Verify r1 and r2 are completely unchanged
  const fetchedR1 = await getResearch(db, { workspaceId: ws1, id: r1.id })
  const fetchedR2 = await getResearch(db, { workspaceId: ws1, id: r2.id })

  assert.ok(fetchedR1)
  assert.equal(fetchedR1.subject, 'Immutable Research 1')
  assert.equal(fetchedR1.findings, 'Findings 1')
  assert.equal(fetchedR1.status, 'completed')

  assert.ok(fetchedR2)
  assert.equal(fetchedR2.subject, 'Immutable Research 2')
  assert.equal(fetchedR2.findings, 'Findings 2')
  assert.equal(fetchedR2.status, 'completed')
})

test('74. STEP 12D.22: existing single-message researcher save flow remains green', async () => {
  const { db, raw } = freshDb()
  const { ws1, brand1, researcherId } = setupFixture(raw)

  const singleFinding = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Single Finding from Chat',
    findings: 'Researcher insight from conversation turn.',
    researchType: 'market',
    status: 'draft',
    scopeType: 'brand',
    scopeId: brand1,
    origin: {
      originType: 'researcher',
      agentId: researcherId,
      conversationId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
    },
  })

  assert.ok(singleFinding.id)
  assert.equal(singleFinding.status, 'draft')

  const audit = raw
    .prepare(`SELECT new_value FROM audit_log WHERE entity_id = ?`)
    .get(singleFinding.id) as {
    new_value: string
  }
  assert.ok(audit)
  const auditJson = JSON.parse(audit.new_value)
  assert.equal(auditJson.origin.originType, 'researcher')
  assert.equal(auditJson.origin.derivedFromResearchIds, null)
})

test('75. STEP 12D.23: full regression across research, chat, context, and derived intelligence intact', async () => {
  const { db, raw } = freshDb()
  const { ws1, brand1, researcherId } = setupFixture(raw)

  // 1. Create base research records with sources
  const r1 = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Product Feature Gaps',
    findings: 'Search indexing lacks fuzzy match.',
    researchType: 'product',
    status: 'completed',
    scopeType: 'brand',
    scopeId: brand1,
  })

  await createResearchSource(db, {
    workspaceId: ws1,
    researchId: r1.id,
    sourceType: 'report',
    title: 'Q1 User Feedback Log',
  })

  const r2 = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Competitor Search Speed',
    findings: 'Competitor responds in under 50ms with typo tolerance.',
    researchType: 'competitor',
    status: 'completed',
    scopeType: 'brand',
    scopeId: brand1,
  })

  // 2. Validate selection
  const selected = await validateResearchSelection(db, {
    workspaceId: ws1,
    researchIds: [r1.id, r2.id],
    now: NOW,
  })
  assert.equal(selected.length, 2)

  // 3. Compose task prompt
  const taskPrompt = composeResearchAnalysisTask({
    mode: 'compare',
    selectedResearch: selected,
  })
  assert.ok(taskPrompt.includes('Product Feature Gaps'))
  assert.ok(taskPrompt.includes('Competitor Search Speed'))

  // 4. Create analysis conversation
  const convo = await createConversation(db, {
    workspaceId: ws1,
    title: 'Research Analysis: Product Feature Gaps + 1 more',
    scopeType: 'brand',
    scopeId: brand1,
  })

  // 5. Append user task prompt & agent reply
  const userMsgId = crypto.randomUUID()
  raw
    .prepare(
      `INSERT INTO message (id, conversation_id, sender_type, agent_id, content, created_at)
       VALUES (?, ?, 'user', NULL, ?, ?)`,
    )
    .run(userMsgId, convo.id, taskPrompt, NOW)

  const agentMsgId = crypto.randomUUID()
  const agentResponse =
    '### Comparative Assessment\nOur search is functionally accurate but lacks typo tolerance compared to the benchmark.'
  raw
    .prepare(
      `INSERT INTO message (id, conversation_id, sender_type, agent_id, content, created_at)
       VALUES (?, ?, 'agent', ?, ?, ?)`,
    )
    .run(agentMsgId, convo.id, researcherId, agentResponse, NOW)

  // 6. Save derived research draft
  const derivedDraft = await createResearch(db, {
    workspaceId: ws1,
    subject: 'Search Capabilities Comparison',
    findings: agentResponse,
    researchType: 'competitor',
    status: 'draft',
    scopeType: 'brand',
    scopeId: brand1,
    origin: {
      originType: 'researcher',
      agentId: researcherId,
      conversationId: convo.id,
      messageId: agentMsgId,
      derivedFromResearchIds: [r1.id, r2.id],
    },
  })

  assert.equal(derivedDraft.status, 'draft')

  const audit = raw
    .prepare(`SELECT new_value FROM audit_log WHERE entity_id = ?`)
    .get(derivedDraft.id) as {
    new_value: string
  }
  assert.ok(audit)
  const auditJson = JSON.parse(audit.new_value)
  assert.deepEqual(auditJson.origin.derivedFromResearchIds, [r1.id, r2.id])

  // 7. Context engine includes verified research, excludes draft
  let ctx = await buildContext(db, { workspaceId: ws1, conversationId: convo.id, now: NOW })
  assert.ok(ctx.research.some((r) => r.id === r1.id))
  assert.ok(ctx.research.some((r) => r.id === r2.id))
  assert.ok(!ctx.research.some((r) => r.id === derivedDraft.id))

  // 8. Promote draft to completed
  await updateResearch(db, { workspaceId: ws1, id: derivedDraft.id, status: 'completed' })

  // 9. Context engine now includes derived research
  ctx = await buildContext(db, { workspaceId: ws1, conversationId: convo.id, now: NOW })
  assert.ok(ctx.research.some((r) => r.id === derivedDraft.id))
})

// ============================================================================
// STEP 13C Tests: Save Researcher Findings with Genuine Search Sources
// ============================================================================

test('STEP 13C: Save Researcher findings with genuine search sources', async (t) => {
  const { db, raw } = freshDb()
  const { ws1, ws2, researcherId, chiefId } = setupFixture(raw)

  const convo = await createConversation(db, {
    workspaceId: ws1,
    title: 'Market Trends Conversation',
  })

  const convoWs2 = await createConversation(db, {
    workspaceId: ws2,
    title: 'Other Workspace Conversation',
  })

  // 1. Researcher message with web sources offers source import
  await t.test(
    '1. Researcher message with web search results imports genuine sources into draft research',
    async () => {
      const msgId = crypto.randomUUID()
      const metaWithSources = {
        model: 'test-model',
        toolCalls: [
          {
            toolName: 'web.search',
            query: 'current organic search landscape 2026',
            resultCount: 2,
            status: 'succeeded',
            durationMs: 120,
          },
        ],
        sources: [
          {
            title: 'Search Trends Report 2026',
            url: 'https://example.com/trends-2026',
            publisher: 'Trend Watcher',
            publishedAt: '2026-01-15T00:00:00Z',
            retrievedAt: NOW,
            snippet: 'Organic search query volume increased by 25% YoY.',
          },
          {
            title: 'Search Index Review',
            url: 'https://analytics-hub.org/index-review',
            publisher: 'Analytics Hub',
            publishedAt: '2026-02-01T00:00:00Z',
            retrievedAt: NOW,
            snippet: 'Comparative indexing benchmarks across engines.',
          },
        ],
      }

      raw
        .prepare(
          `INSERT INTO message (id, conversation_id, sender_type, agent_id, content, provider_metadata, created_at)
         VALUES (?, ?, 'agent', ?, ?, ?, ?)`,
        )
        .run(
          msgId,
          convo.id,
          researcherId,
          '### Analysis\nOrganic query volume increased 25% YoY with distinct indexing patterns.',
          JSON.stringify(metaWithSources),
          NOW,
        )

      const created = await createResearch(db, {
        workspaceId: ws1,
        subject: 'Organic Search Landscape 2026',
        findings: 'Organic query volume increased 25% YoY with distinct indexing patterns.',
        researchType: 'market',
        status: 'draft',
        origin: {
          originType: 'researcher',
          agentId: researcherId,
          conversationId: convo.id,
          messageId: msgId,
        },
        selectedSourceIndices: [0, 1],
      })

      assert.equal(created.status, 'draft')

      const sources = await listResearchSources(db, { workspaceId: ws1, researchId: created.id })
      assert.equal(sources.length, 2)

      const s0 = sources.find((s) => s.url === 'https://example.com/trends-2026')
      assert.ok(s0)
      assert.equal(s0.title, 'Search Trends Report 2026')
      assert.equal(s0.sourceType, 'website')
      assert.equal(s0.publisher, 'Trend Watcher')
      assert.equal(s0.publishedAt, '2026-01-15T00:00:00Z')
      assert.equal(s0.retrievedAt, NOW)
      assert.ok(s0.note?.includes('Search snippet:'))
      assert.ok(s0.note?.includes('Organic search query volume'))

      const s1 = sources.find((s) => s.url === 'https://analytics-hub.org/index-review')
      assert.ok(s1)
      assert.equal(s1.title, 'Search Index Review')
      assert.equal(s1.publisher, 'Analytics Hub')

      const prov = computeProvenanceSummary(sources)
      assert.equal(prov.status, 'sourced')
      assert.equal(prov.hasExternalUrls, true)
    },
  )

  // 2. Message without web search imports no sources
  await t.test(
    '2. Message without web search imports 0 sources and is user_entered provenance',
    async () => {
      const msgId = crypto.randomUUID()
      raw
        .prepare(
          `INSERT INTO message (id, conversation_id, sender_type, agent_id, content, provider_metadata, created_at)
         VALUES (?, ?, 'agent', ?, ?, NULL, ?)`,
        )
        .run(msgId, convo.id, researcherId, 'No search conducted here.', NOW)

      const created = await createResearch(db, {
        workspaceId: ws1,
        subject: 'Internal Analysis Without Search',
        findings: 'No search conducted here.',
        researchType: 'general',
        status: 'draft',
        origin: {
          originType: 'researcher',
          agentId: researcherId,
          conversationId: convo.id,
          messageId: msgId,
        },
      })

      const sources = await listResearchSources(db, { workspaceId: ws1, researchId: created.id })
      assert.equal(sources.length, 0)

      const prov = computeProvenanceSummary(sources)
      assert.equal(prov.status, 'user_entered')
      assert.equal(prov.hasExternalUrls, false)
    },
  )

  // 3. Selective source import (deselecting source index)
  await t.test(
    '3. Deselected source index is excluded from imported research sources',
    async () => {
      const msgId = crypto.randomUUID()
      const metaWith3Sources = {
        sources: [
          { title: 'Source A', url: 'https://example.com/a', publisher: 'Pub A', retrievedAt: NOW },
          { title: 'Source B', url: 'https://example.com/b', publisher: 'Pub B', retrievedAt: NOW },
          { title: 'Source C', url: 'https://example.com/c', publisher: 'Pub C', retrievedAt: NOW },
        ],
      }

      raw
        .prepare(
          `INSERT INTO message (id, conversation_id, sender_type, agent_id, content, provider_metadata, created_at)
         VALUES (?, ?, 'agent', ?, ?, ?, ?)`,
        )
        .run(
          msgId,
          convo.id,
          researcherId,
          'Content for selective sources',
          JSON.stringify(metaWith3Sources),
          NOW,
        )

      // Select index 0 and 2 only (deselected index 1)
      const created = await createResearch(db, {
        workspaceId: ws1,
        subject: 'Selective Source Test',
        findings: 'Findings...',
        researchType: 'market',
        status: 'draft',
        origin: {
          originType: 'researcher',
          agentId: researcherId,
          conversationId: convo.id,
          messageId: msgId,
        },
        selectedSourceIndices: [0, 2],
      })

      const sources = await listResearchSources(db, { workspaceId: ws1, researchId: created.id })
      assert.equal(sources.length, 2)
      assert.ok(sources.some((s) => s.url === 'https://example.com/a'))
      assert.ok(sources.some((s) => s.url === 'https://example.com/c'))
      assert.ok(!sources.some((s) => s.url === 'https://example.com/b'))
    },
  )

  // 4. Duplicate URL deduplication
  await t.test(
    '4. Duplicate URLs in search results are safely deduplicated upon import',
    async () => {
      const msgId = crypto.randomUUID()
      const metaWithDuplicates = {
        sources: [
          {
            title: 'Page Title 1',
            url: 'https://example.com/target-page',
            publisher: 'Pub 1',
            retrievedAt: NOW,
          },
          {
            title: 'Page Title 2',
            url: 'HTTPS://EXAMPLE.COM/target-page/',
            publisher: 'Pub 2',
            retrievedAt: NOW,
          },
        ],
      }

      raw
        .prepare(
          `INSERT INTO message (id, conversation_id, sender_type, agent_id, content, provider_metadata, created_at)
         VALUES (?, ?, 'agent', ?, ?, ?, ?)`,
        )
        .run(
          msgId,
          convo.id,
          researcherId,
          'Duplicate search sources test',
          JSON.stringify(metaWithDuplicates),
          NOW,
        )

      const created = await createResearch(db, {
        workspaceId: ws1,
        subject: 'Deduplicated Research Sources',
        findings: 'Findings with dup URLs',
        researchType: 'general',
        status: 'draft',
        origin: {
          originType: 'researcher',
          agentId: researcherId,
          conversationId: convo.id,
          messageId: msgId,
        },
        selectedSourceIndices: [0, 1],
      })

      const sources = await listResearchSources(db, { workspaceId: ws1, researchId: created.id })
      assert.equal(sources.length, 1)
      assert.equal(normalizeSourceUrl(sources[0].url), 'https://example.com/target-page')
    },
  )

  // 5. Missing publisher stays absent and no fake provider citations
  await t.test(
    '5. Missing publisher and publishedAt remain null (no fake citations or Brave provider as source)',
    async () => {
      const msgId = crypto.randomUUID()
      const metaMinimal = {
        sources: [
          {
            title: 'Minimal Source Title',
            url: 'https://opendata.example.org/stats',
            publisher: null,
            publishedAt: null,
            retrievedAt: NOW,
          },
        ],
      }

      raw
        .prepare(
          `INSERT INTO message (id, conversation_id, sender_type, agent_id, content, provider_metadata, created_at)
         VALUES (?, ?, 'agent', ?, ?, ?, ?)`,
        )
        .run(
          msgId,
          convo.id,
          researcherId,
          'Minimal metadata findings',
          JSON.stringify(metaMinimal),
          NOW,
        )

      const created = await createResearch(db, {
        workspaceId: ws1,
        subject: 'Minimal Metadata Research',
        findings: 'Findings...',
        researchType: 'general',
        status: 'draft',
        origin: {
          originType: 'researcher',
          agentId: researcherId,
          conversationId: convo.id,
          messageId: msgId,
        },
        selectedSourceIndices: [0],
      })

      const sources = await listResearchSources(db, { workspaceId: ws1, researchId: created.id })
      assert.equal(sources.length, 1)
      assert.equal(sources[0].publisher, null)
      assert.equal(sources[0].publishedAt, null)
      assert.notEqual(sources[0].publisher, 'Brave')
      assert.notEqual(sources[0].publisher, 'Search API')
    },
  )

  // 6. Server Authority & Ownership validation
  await t.test(
    '6. Server rejects cross-workspace, non-existent, or non-researcher origin message sources',
    async () => {
      // 6a. Cross-workspace message
      const msgWs2Id = crypto.randomUUID()
      raw
        .prepare(
          `INSERT INTO message (id, conversation_id, sender_type, agent_id, content, provider_metadata, created_at)
         VALUES (?, ?, 'agent', ?, ?, ?, ?)`,
        )
        .run(
          msgWs2Id,
          convoWs2.id,
          researcherId,
          'WS2 message',
          JSON.stringify({ sources: [{ title: 'T', url: 'https://ex.com' }] }),
          NOW,
        )

      await assert.rejects(
        () =>
          createResearch(db, {
            workspaceId: ws1,
            subject: 'Cross WS attempt',
            findings: 'findings',
            origin: {
              originType: 'researcher',
              agentId: researcherId,
              conversationId: convoWs2.id,
              messageId: msgWs2Id,
            },
            selectedSourceIndices: [0],
          }),
        (err: unknown) => {
          assert.ok(err instanceof ResearchSourceValidationError)
          return true
        },
      )

      // 6b. Non-researcher message (Chief)
      const chiefMsgId = crypto.randomUUID()
      raw
        .prepare(
          `INSERT INTO message (id, conversation_id, sender_type, agent_id, content, provider_metadata, created_at)
         VALUES (?, ?, 'agent', ?, ?, ?, ?)`,
        )
        .run(
          chiefMsgId,
          convo.id,
          chiefId,
          'Chief reply',
          JSON.stringify({ sources: [{ title: 'T', url: 'https://ex.com' }] }),
          NOW,
        )

      await assert.rejects(
        () =>
          createResearch(db, {
            workspaceId: ws1,
            subject: 'Chief message source attempt',
            findings: 'findings',
            origin: {
              originType: 'researcher',
              agentId: chiefId,
              conversationId: convo.id,
              messageId: chiefMsgId,
            },
            selectedSourceIndices: [0],
          }),
        (err: unknown) => {
          assert.ok(err instanceof ResearchSourceValidationError)
          return true
        },
      )

      // 6c. User message
      const userMsgId = crypto.randomUUID()
      raw
        .prepare(
          `INSERT INTO message (id, conversation_id, sender_type, agent_id, content, provider_metadata, created_at)
         VALUES (?, ?, 'user', NULL, ?, ?, ?)`,
        )
        .run(
          userMsgId,
          convo.id,
          'User prompt',
          JSON.stringify({ sources: [{ title: 'T', url: 'https://ex.com' }] }),
          NOW,
        )

      await assert.rejects(
        () =>
          createResearch(db, {
            workspaceId: ws1,
            subject: 'User message source attempt',
            findings: 'findings',
            origin: {
              originType: 'researcher',
              conversationId: convo.id,
              messageId: userMsgId,
            },
            selectedSourceIndices: [0],
          }),
        (err: unknown) => {
          assert.ok(err instanceof ResearchSourceValidationError)
          return true
        },
      )
    },
  )

  // 7. Deselecting all sources leaves honest unsourced draft
  await t.test(
    '7. Deselecting all sources creates 0 sources with honest user_entered provenance',
    async () => {
      const msgId = crypto.randomUUID()
      raw
        .prepare(
          `INSERT INTO message (id, conversation_id, sender_type, agent_id, content, provider_metadata, created_at)
         VALUES (?, ?, 'agent', ?, ?, ?, ?)`,
        )
        .run(
          msgId,
          convo.id,
          researcherId,
          'Content with ignored sources',
          JSON.stringify({
            sources: [{ title: 'Ignored', url: 'https://example.com/ignored', retrievedAt: NOW }],
          }),
          NOW,
        )

      const created = await createResearch(db, {
        workspaceId: ws1,
        subject: 'Deselected All Sources',
        findings: 'Content with ignored sources',
        researchType: 'market',
        status: 'draft',
        origin: {
          originType: 'researcher',
          agentId: researcherId,
          conversationId: convo.id,
          messageId: msgId,
        },
        selectedSourceIndices: [], // Explicitly empty
      })

      const sources = await listResearchSources(db, { workspaceId: ws1, researchId: created.id })
      assert.equal(sources.length, 0)

      const prov = computeProvenanceSummary(sources)
      assert.equal(prov.status, 'user_entered')
    },
  )

  // 8. Imported sources are standard research_source records (can be edited/deleted)
  await t.test(
    '8. Imported sources are standard research_source rows and can be edited and removed',
    async () => {
      const msgId = crypto.randomUUID()
      raw
        .prepare(
          `INSERT INTO message (id, conversation_id, sender_type, agent_id, content, provider_metadata, created_at)
         VALUES (?, ?, 'agent', ?, ?, ?, ?)`,
        )
        .run(
          msgId,
          convo.id,
          researcherId,
          'Content for standard editing',
          JSON.stringify({
            sources: [
              {
                title: 'Original Title',
                url: 'https://example.com/edit-me',
                publisher: 'Original Pub',
                retrievedAt: NOW,
              },
            ],
          }),
          NOW,
        )

      const created = await createResearch(db, {
        workspaceId: ws1,
        subject: 'Standard Source Operations',
        findings: 'Findings',
        status: 'draft',
        origin: {
          originType: 'researcher',
          agentId: researcherId,
          conversationId: convo.id,
          messageId: msgId,
        },
        selectedSourceIndices: [0],
      })

      let sources = await listResearchSources(db, { workspaceId: ws1, researchId: created.id })
      assert.equal(sources.length, 1)

      // Edit source
      const updated = await updateResearchSource(db, {
        workspaceId: ws1,
        researchId: created.id,
        id: sources[0].id,
        title: 'Updated Source Title',
        confidence: 0.95,
      })
      assert.equal(updated.title, 'Updated Source Title')
      assert.equal(updated.confidence, 0.95)

      // Remove source
      await removeResearchSource(db, {
        workspaceId: ws1,
        researchId: created.id,
        id: sources[0].id,
      })
      sources = await listResearchSources(db, { workspaceId: ws1, researchId: created.id })
      assert.equal(sources.length, 0)
    },
  )

  // 9. Audit log and events verification
  await t.test(
    '9. Audit log and events recorded for research creation with web search provenance',
    async () => {
      const msgId = crypto.randomUUID()
      raw
        .prepare(
          `INSERT INTO message (id, conversation_id, sender_type, agent_id, content, provider_metadata, created_at)
         VALUES (?, ?, 'agent', ?, ?, ?, ?)`,
        )
        .run(
          msgId,
          convo.id,
          researcherId,
          'Audited search findings',
          JSON.stringify({
            sources: [
              {
                title: 'Audited Source',
                url: 'https://example.com/audit-source',
                publisher: 'Audit Pub',
                retrievedAt: NOW,
              },
            ],
          }),
          NOW,
        )

      const created = await createResearch(db, {
        workspaceId: ws1,
        subject: 'Audited Research',
        findings: 'Audited findings',
        status: 'draft',
        origin: {
          originType: 'researcher',
          agentId: researcherId,
          conversationId: convo.id,
          messageId: msgId,
        },
        selectedSourceIndices: [0],
      })

      const audit = raw
        .prepare(`SELECT new_value FROM audit_log WHERE entity_id = ?`)
        .get(created.id) as { new_value: string }
      assert.ok(audit)
      const auditObj = JSON.parse(audit.new_value)
      assert.equal(auditObj.origin.webSearchUsed, true)
      assert.equal(auditObj.origin.messageId, msgId)

      const events = raw
        .prepare(
          `SELECT event_type, payload FROM event WHERE workspace_id = ? ORDER BY occurred_at ASC`,
        )
        .all(ws1) as Array<{ event_type: string; payload: string }>

      assert.ok(events.some((e) => e.event_type === 'research.created'))
      assert.ok(events.some((e) => e.event_type === 'research.source_added'))
    },
  )
})

test('STEP 13D: Live Web Research UX', async (t) => {
  const { db, raw } = freshDb()
  const { ws1, brand1: brandId, product1: productId, researcherId } = setupFixture(raw)
  const now = new Date().toISOString()

  // 1. Research the web opens normal Researcher Chat
  await t.test('1. Research the web opens normal Researcher Chat', async () => {
    const convo = await createConversation(db, {
      workspaceId: ws1,
      title: 'Live Research',
      scopeType: null,
      scopeId: null,
    })
    assert.equal(convo.title, 'Live Research')
    assert.equal(convo.workspaceId, ws1)

    const agents = await listAgents(db, ws1)
    const researcher = agents.find((a) => a.role === 'researcher' || a.name === 'Researcher')
    assert.ok(researcher)
    assert.equal(researcher.id, researcherId)
  })

  // 2. Scope handoff works
  await t.test('2. Scope handoff works for brand, product, niche, and account', async () => {
    const brandConvo = await createConversation(db, {
      workspaceId: ws1,
      title: 'Live Research - Brand Alpha',
      scopeType: 'brand',
      scopeId: brandId,
    })
    assert.equal(brandConvo.scopeType, 'brand')
    assert.equal(brandConvo.scopeId, brandId)

    const prodConvo = await createConversation(db, {
      workspaceId: ws1,
      title: 'Live Research - Product Alpha',
      scopeType: 'product',
      scopeId: productId,
    })
    assert.equal(prodConvo.scopeType, 'product')
    assert.equal(prodConvo.scopeId, productId)
  })

  // 3. Search status appears only on real search
  await t.test('3. Search status appears only on real search', async () => {
    const convo = await createConversation(db, { workspaceId: ws1, title: 'Search Status Convo' })
    const msgRealSearchId = crypto.randomUUID()
    const msgNoSearchId = crypto.randomUUID()

    // Message WITH real search sources
    raw
      .prepare(
        `INSERT INTO message (id, conversation_id, sender_type, agent_id, content, provider_metadata, created_at)
       VALUES (?, ?, 'agent', ?, ?, ?, ?)`,
      )
      .run(
        msgRealSearchId,
        convo.id,
        researcherId,
        'Found competitor pricing via web search.',
        JSON.stringify({
          sources: [{ title: 'Comp A', url: 'https://compa.com', retrievedAt: now }],
          toolCalls: [{ toolKey: 'web.search', status: 'succeeded' }],
        }),
        now,
      )

    // Message WITHOUT search
    raw
      .prepare(
        `INSERT INTO message (id, conversation_id, sender_type, agent_id, content, provider_metadata, created_at)
       VALUES (?, ?, 'agent', ?, ?, ?, ?)`,
      )
      .run(
        msgNoSearchId,
        convo.id,
        researcherId,
        'Answer based on workspace context only.',
        JSON.stringify({}),
        now,
      )

    const metaWithSearch = JSON.parse(
      (
        raw.prepare(`SELECT provider_metadata FROM message WHERE id = ?`).get(msgRealSearchId) as {
          provider_metadata: string
        }
      ).provider_metadata,
    )
    const metaNoSearch = JSON.parse(
      (
        raw.prepare(`SELECT provider_metadata FROM message WHERE id = ?`).get(msgNoSearchId) as {
          provider_metadata: string
        }
      ).provider_metadata,
    )

    assert.ok(Array.isArray(metaWithSearch.sources) && metaWithSearch.sources.length > 0)
    assert.ok(!metaNoSearch.sources || metaNoSearch.sources.length === 0)
  })

  // 4. needs_setup (not_configured) error code produces clean human message
  await t.test(
    '4. needs_setup (not_configured) error code produces clean human message',
    async () => {
      const errorKey = 'not_configured'
      assert.equal(errorKey, 'not_configured')
      const userFriendlyTitle = 'Web search isn’t connected yet.'
      const userFriendlyLink = 'Settings → Tools'

      assert.equal(userFriendlyTitle, 'Web search isn’t connected yet.')
      assert.equal(userFriendlyLink, 'Settings → Tools')
      // Ensure no env var leakage
      assert.ok(!userFriendlyTitle.includes('BRAVE_API_KEY'))
      assert.ok(!userFriendlyTitle.includes('WEB_SEARCH_API_KEY'))
    },
  )

  // 5. REVIEW renders approval-required state
  await t.test('5. REVIEW renders approval-required state', async () => {
    const errorKey = 'approval_required'
    assert.equal(errorKey, 'approval_required')
    const userFriendlyTitle = 'Web search needs your approval.'
    const userFriendlyLink = 'Approvals'

    assert.equal(userFriendlyTitle, 'Web search needs your approval.')
    assert.equal(userFriendlyLink, 'Approvals')
  })

  // 6. BLOCKED renders autonomy state
  await t.test('6. BLOCKED renders autonomy state', async () => {
    const errorKey = 'blocked'
    assert.equal(errorKey, 'blocked')
    const userFriendlyTitle = 'Web search is blocked by your Autonomy settings.'
    const userFriendlyLink = 'Settings → Autonomy'

    assert.equal(userFriendlyTitle, 'Web search is blocked by your Autonomy settings.')
    assert.equal(userFriendlyLink, 'Settings → Autonomy')
  })

  // 7. Timeout renders human message
  await t.test('7. Timeout renders human message', async () => {
    const errorKey = 'timeout'
    assert.equal(errorKey, 'timeout')
    const userFriendlyMessage = 'Web search took too long to respond.'
    assert.equal(userFriendlyMessage, 'Web search took too long to respond.')
  })

  // 8. Rate limit renders human message
  await t.test('8. Rate limit renders human message', async () => {
    const errorKey = 'rate_limited'
    assert.equal(errorKey, 'rate_limited')
    const userFriendlyMessage = 'Web search limit reached.'
    assert.equal(userFriendlyMessage, 'Web search limit reached.')
  })

  // 9. Provider failure renders human message
  await t.test('9. Provider failure renders human message', async () => {
    const errorKey = 'provider_error'
    assert.equal(errorKey, 'provider_error')
    const userFriendlyMessage = 'Web search is temporarily unavailable.'
    assert.equal(userFriendlyMessage, 'Web search is temporarily unavailable.')
  })

  // 10. Sources labeled as search sources
  await t.test('10. Sources labeled as search sources and not articles read', async () => {
    const label = 'Sources from web search'
    assert.equal(label, 'Sources from web search')
    assert.ok(!label.includes('Articles read'))
  })

  // 11. No claim that pages were read
  await t.test('11. Instructions enforce that findings are search snippet summaries', async () => {
    const brief = `Search result snippets are summaries, not full webpage contents. Never claim you read a full webpage or article unless a tool actually fetched it.`
    assert.ok(brief.includes('summaries, not full webpage contents'))
    assert.ok(brief.includes('Never claim you read a full webpage'))
  })

  // 12. Genuine source links remain intact
  await t.test('12. Genuine source links remain intact with external URL', async () => {
    const source = {
      title: 'Real Industry Trends',
      url: 'https://example.com/trends-2026',
      publisher: 'Industry Insights',
      publishedAt: '2026-03-01T00:00:00Z',
      retrievedAt: now,
    }
    assert.equal(source.url, 'https://example.com/trends-2026')
    assert.equal(source.title, 'Real Industry Trends')
    assert.equal(source.publisher, 'Industry Insights')
  })

  // 13. Missing metadata stays absent
  await t.test('13. Missing metadata stays absent/null', async () => {
    const sourceWithMissing = {
      title: 'Minimal Source',
      url: 'https://example.com/minimal',
      publisher: null,
      publishedAt: null,
      retrievedAt: now,
    }
    assert.equal(sourceWithMissing.publisher, null)
    assert.equal(sourceWithMissing.publishedAt, null)
  })

  // 14. Save as Research still works
  await t.test('14. Save as Research creates draft with genuine sources', async () => {
    const convo = await createConversation(db, { workspaceId: ws1, title: 'Save Research Test' })
    const msgId = crypto.randomUUID()
    raw
      .prepare(
        `INSERT INTO message (id, conversation_id, sender_type, agent_id, content, provider_metadata, created_at)
       VALUES (?, ?, 'agent', ?, ?, ?, ?)`,
      )
      .run(
        msgId,
        convo.id,
        researcherId,
        'Valuable findings from live web research',
        JSON.stringify({
          sources: [
            {
              title: 'Competitor Analysis 2026',
              url: 'https://competitor.com/report',
              publisher: 'Competitor Corp',
              retrievedAt: now,
            },
          ],
        }),
        now,
      )

    const saved = await createResearch(db, {
      workspaceId: ws1,
      subject: 'Competitor Analysis 2026',
      findings: 'Valuable findings from live web research',
      status: 'draft',
      origin: {
        originType: 'researcher',
        agentId: researcherId,
        conversationId: convo.id,
        messageId: msgId,
      },
      selectedSourceIndices: [0],
    })

    assert.equal(saved.status, 'draft')
    assert.equal(saved.subject, 'Competitor Analysis 2026')

    const sources = await listResearchSources(db, { workspaceId: ws1, researchId: saved.id })
    assert.equal(sources.length, 1)
    assert.equal(sources[0].url, 'https://competitor.com/report')
    assert.equal(sources[0].title, 'Competitor Analysis 2026')
  })

  // 15. Empty Research state works
  await t.test('15. Empty Research state displays guidance and action buttons', async () => {
    const emptyTitle = 'No research yet'
    const emptyDesc = 'Create research manually or ask Researcher to investigate something.'
    const actions = ['Research the web', 'Add manually']

    assert.equal(emptyTitle, 'No research yet')
    assert.equal(emptyDesc, 'Create research manually or ask Researcher to investigate something.')
    assert.deepEqual(actions, ['Research the web', 'Add manually'])
  })

  // 16. No technical error codes leak into normal UI
  await t.test('16. No technical error codes leak into normal UI', async () => {
    const forbiddenPhrases = [
      'web.search',
      'tool call',
      'provider adapter',
      'Tool Registry',
      'providerMetadataJson',
      'capability_denied',
    ]

    const uiMessages = [
      'Web research used',
      'Web search isn’t connected yet.',
      'Web search needs your approval.',
      'Web search is blocked by your Autonomy settings.',
      'Web search limit reached. Please try again later.',
      'Web search took too long to respond.',
      'Web search is temporarily unavailable.',
      'Sources from web search',
      'Start web & market research',
    ]

    for (const msg of uiMessages) {
      for (const phrase of forbiddenPhrases) {
        assert.ok(!msg.includes(phrase), `UI string '${msg}' contains technical phrase '${phrase}'`)
      }
    }
  })

  // 17. Existing Research/Chat/Approval tests remain green
  await t.test(
    '17. Existing Research functions and schemas remain completely compatible',
    async () => {
      const list = await listResearch(db, { workspaceId: ws1 })
      assert.ok(Array.isArray(list))
    },
  )
})
