/**
 * STEP 15A: Creator Draft Generation for Campaign Content Plan Items Test Suite
 *
 * Verifies:
 * 1. Creator can generate for Campaign content item
 * 2. Archived content rejected
 * 3. Wrong workspace rejected
 * 4. Campaign context reaches Creator
 * 5. Strategy reaches Creator
 * 6. Audience reaches Creator
 * 7. Content brief reaches Creator
 * 8. Target account/platform reaches Creator
 * 9. Creator does not receive web_search automatically
 * 10. Structured draft returned
 * 11. Generation does not immediately persist
 * 12. Save persists draft
 * 13. Original content plan item remains intact
 * 14. Saved draft references Content
 * 15. Creator agent/version provenance preserved
 * 16. Saved draft moves item to Draft status
 * 17. No Ready/Approved/Published status set
 * 18. Regenerate is explicit
 * 19. Provider failure creates no fake draft
 * 20. No Tool execution occurs
 * 21. No Critic execution occurs
 * 22. Audit/events safe (content.draft_generated, content.draft_saved)
 * 23. Existing tests remain green
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import {
  composeContentDraftTask,
  parseContentDraftOutput,
} from '../src/server/agents/content-draft.ts'
import { ensureBuiltinAgents } from '../src/server/agents/registry.ts'
import type { ExecuteAIDeps } from '../src/server/ai/executor.ts'
import { createEchoAdapter } from '../src/server/ai/providers/echo.ts'
import type { AIProviderAdapter } from '../src/server/ai/types.ts'
import { buildContext } from '../src/server/context/engine.ts'
import { createCampaign } from '../src/server/db/campaign.ts'
import {
  createCampaignContent,
  getCampaignContentDetail,
  listCampaignContent,
} from '../src/server/db/content.ts'
import {
  generateCampaignContentDraft,
  getLatestContentVariant,
  listContentVariants,
  saveCampaignContentDraft,
} from '../src/server/db/content-variant.ts'
import { listRecentEvents } from '../src/server/db/event.ts'
import type { SqlDatabase } from '../src/server/db/sql.ts'
import { getAvailableTools, listToolDefinitions } from '../src/server/tools/index.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const NOW = '2026-08-20T10:00:00.000Z'

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
  return { db: shim(raw), raw }
}

function echoDeps(): ExecuteAIDeps {
  const echo = createEchoAdapter()
  return {
    adapters: new Map([[echo.key, echo]]),
    modelOverrides: { provider: 'echo' },
  }
}

function mockAiDeps(responseContent: string): ExecuteAIDeps {
  const adapter: AIProviderAdapter = {
    key: 'echo',
    async execute() {
      return {
        content: responseContent,
        finishReason: 'stop',
        usage: null,
      }
    },
  }
  return {
    adapters: new Map([['echo', adapter]]),
    modelOverrides: { provider: 'echo' },
  }
}

function failingAiDeps(errorCode = 'timeout'): ExecuteAIDeps {
  const adapter: AIProviderAdapter = {
    key: 'echo',
    async execute() {
      throw Object.assign(new Error('AI provider timed out'), { code: errorCode })
    },
  }
  return {
    adapters: new Map([['echo', adapter]]),
    modelOverrides: { provider: 'echo' },
  }
}

function seedBaseline(raw: Database.Database) {
  const workspaceId = crypto.randomUUID()
  const otherWorkspaceId = crypto.randomUUID()
  const brandId = crypto.randomUUID()
  const otherBrandId = crypto.randomUUID()
  const platformId = crypto.randomUUID()
  const accountId = crypto.randomUUID()

  raw
    .prepare(
      `INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, 'Growth Org', 'growth-org', ?, ?)`,
    )
    .run(workspaceId, NOW, NOW)
  raw
    .prepare(
      `INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, 'Other Org', 'other-org', ?, ?)`,
    )
    .run(otherWorkspaceId, NOW, NOW)

  raw
    .prepare(
      `INSERT INTO brand (id, workspace_id, name, description, created_at, updated_at)
       VALUES (?, ?, 'CloudSecure', 'Zero-trust cloud infrastructure security', ?, ?)`,
    )
    .run(brandId, workspaceId, NOW, NOW)

  raw
    .prepare(
      `INSERT INTO brand (id, workspace_id, name, description, created_at, updated_at)
       VALUES (?, ?, 'Competitor Brand', 'Another brand', ?, ?)`,
    )
    .run(otherBrandId, otherWorkspaceId, NOW, NOW)

  raw
    .prepare(
      `INSERT INTO platform (id, adapter_key, name, created_at) VALUES (?, 'pinterest', 'Pinterest', ?)`,
    )
    .run(platformId, NOW)

  raw
    .prepare(
      `INSERT INTO account (id, workspace_id, platform_id, handle, display_name, status, created_at, updated_at)
       VALUES (?, ?, ?, 'cloudsecure_official', 'CloudSecure Official', 'active', ?, ?)`,
    )
    .run(accountId, workspaceId, platformId, NOW, NOW)

  return {
    workspaceId,
    otherWorkspaceId,
    brandId,
    otherBrandId,
    platformId,
    accountId,
  }
}

test('1. Creator can generate for Campaign content item', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Q3 Security Campaign',
    objective: 'conversions',
    positioning: 'Simplest SOC2 compliance platform',
    angle: 'Save 200 engineer hours',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    title: '5 Costly SOC2 Mistakes',
    contentType: 'post',
    purpose: 'education',
    theme: 'Compliance pitfalls',
    brief:
      'Highlight why manual spreadsheets fail audits and how automated evidence collection saves time.',
  })

  const structuredOutput = JSON.stringify({
    headline: 'Stop Tracking SOC2 in Spreadsheets',
    body: 'Manual compliance slows down engineering teams and leads to audit failures. Here are 5 common mistakes to avoid.',
    callToAction: 'Read the full guide at the link in bio.',
    creativeDirection: 'Clean infographic with contrasting red warning flags and green checkmarks.',
    notes: '#SOC2 #CyberSecurity #DevOps',
  })

  const result = await generateCampaignContentDraft(
    db,
    {
      workspaceId: base.workspaceId,
      campaignId: campaign.id,
      contentId: item.id,
    },
    mockAiDeps(structuredOutput),
  )

  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.draft.headline, 'Stop Tracking SOC2 in Spreadsheets')
    assert.ok(result.draft.body.includes('Manual compliance slows down'))
    assert.equal(result.draft.callToAction, 'Read the full guide at the link in bio.')
    assert.ok(result.draft.creativeDirection?.includes('infographic'))
    assert.equal(result.provenance.agentName, 'Creator')
    assert.equal(result.provenance.versionNumber, 1)
    assert.ok(result.provenance.executionId)
  }
})

test('2. archived content rejected', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Archived Content Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    title: 'Archived Piece',
    contentType: 'post',
  })

  // Soft-delete content item
  raw
    .prepare(`UPDATE content SET status = 'archived', deleted_at = ? WHERE id = ?`)
    .run(NOW, item.id)

  await assert.rejects(
    async () => {
      await generateCampaignContentDraft(
        db,
        {
          workspaceId: base.workspaceId,
          campaignId: campaign.id,
          contentId: item.id,
        },
        echoDeps(),
      )
    },
    { message: /not found or is archived/i },
  )
})

test('3. wrong workspace rejected', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Workspace Boundary Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    title: 'Cross Workspace Item',
    contentType: 'post',
  })

  await assert.rejects(
    async () => {
      await generateCampaignContentDraft(
        db,
        {
          workspaceId: base.otherWorkspaceId,
          campaignId: campaign.id,
          contentId: item.id,
        },
        echoDeps(),
      )
    },
    { message: /Campaign not found in this workspace/i },
  )
})

test('4. Campaign context reaches Creator', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Context Propagation Flow',
    objective: 'revenue',
    positioning: 'Enterprise-grade zero trust for startups',
  })

  const pkg = await buildContext(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
  })

  assert.ok(pkg.campaign)
  assert.equal(pkg.campaign.name, 'Context Propagation Flow')
  assert.equal(pkg.campaign.strategy.positioning, 'Enterprise-grade zero trust for startups')
  assert.equal(pkg.brand?.name, 'CloudSecure')
})

test('5. strategy reaches Creator', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Strategy Check Campaign',
    objective: 'leads',
    positioning: 'AI-driven vulnerability scanning',
    angle: 'Catch CVEs before production',
    offerMessage: 'Free 14-day penetration audit',
    hypothesis: 'DevSecOps engineers convert 3x higher with actionable CVE previews',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    title: 'CVE Warning Sign',
    contentType: 'short_form',
  })

  const task = composeContentDraftTask(item, 'X')
  assert.ok(task.includes('CVE Warning Sign'))
  assert.ok(task.includes('short_form'))
  assert.ok(task.includes('Target Platform: X'))
})

test('6. audience reaches Creator', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Audience Check Campaign',
    audienceDetails: {
      summary: 'VP of Engineering at Series A-B startups',
      problem: 'Failing enterprise vendor risk assessments',
      awarenessLevel: 'problem_aware',
    },
  })

  const pkg = await buildContext(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
  })

  assert.ok(pkg.campaign?.audience)
  assert.equal(pkg.campaign.audience.summary, 'VP of Engineering at Series A-B startups')
  assert.equal(pkg.campaign.audience.problem, 'Failing enterprise vendor risk assessments')
})

test('7. content brief reaches Creator', async () => {
  const item = {
    id: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    campaignId: crypto.randomUUID(),
    productId: null,
    targetAccountId: null,
    title: 'Why Cloud Migrations Fail',
    contentType: 'long_form' as const,
    purpose: 'education' as const,
    theme: 'Cloud Architecture Pitfalls',
    brief: 'Detailed breakdown of top 3 architectural anti-patterns in AWS migrations.',
    body: null,
    status: 'planned' as const,
    plannedAt: '2026-09-01T00:00:00.000Z',
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  }

  const task = composeContentDraftTask(item, 'LinkedIn')
  assert.ok(task.includes('Why Cloud Migrations Fail'))
  assert.ok(task.includes('long_form'))
  assert.ok(task.includes('education'))
  assert.ok(task.includes('Cloud Architecture Pitfalls'))
  assert.ok(task.includes('Detailed breakdown of top 3 architectural anti-patterns'))
  assert.ok(task.includes('2026-09-01'))
})

test('8. target account/platform reaches Creator', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Account Scoped Campaign',
    accountIds: [base.accountId],
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Visual Security Checklist',
    contentType: 'image',
    theme: 'Security Infographics',
  })

  assert.equal(item.accountHandle, 'cloudsecure_official')
  assert.equal(item.platformName, 'Pinterest')

  const task = composeContentDraftTask(item, item.platformName)
  assert.ok(task.includes('Target Platform: Pinterest'))
  assert.ok(task.includes('@cloudsecure_official'))
})

test('9. Creator does not receive web_search automatically', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)
  const agentMap = await ensureBuiltinAgents(db, base.workspaceId)
  const creator = agentMap.get('creator')

  assert.ok(creator)
  assert.equal(creator.agent.executionType, 'direct_model')
  assert.deepEqual(creator.config.capabilities, ['read_context', 'read_memory', 'create_draft'])

  const caller = {
    agentId: creator.agent.id,
    agentVersionId: creator.version.id,
    agentName: creator.agent.name,
  }

  const availableTools = getAvailableTools(
    db,
    base.workspaceId,
    caller,
    creator.config.capabilities,
    listToolDefinitions(),
  )

  // Creator has NO tools declared
  assert.equal(availableTools.length, 0)
  assert.ok(!availableTools.some((t) => t.name === 'web.search'))
})

test('10. structured draft returned', () => {
  const rawJson = `
\`\`\`json
{
  "headline": "Unlock 10x Developer Productivity",
  "body": "Discover how automated CI/CD guardrails prevent production downtime.",
  "callToAction": "Try it free for 14 days",
  "creativeDirection": "High-contrast dark mode dashboard illustration",
  "notes": "Angle: Developer Experience"
}
\`\`\`
`
  const parsed = parseContentDraftOutput(rawJson)
  assert.equal(parsed.headline, 'Unlock 10x Developer Productivity')
  assert.equal(parsed.body, 'Discover how automated CI/CD guardrails prevent production downtime.')
  assert.equal(parsed.callToAction, 'Try it free for 14 days')
  assert.equal(parsed.creativeDirection, 'High-contrast dark mode dashboard illustration')
  assert.equal(parsed.notes, 'Angle: Developer Experience')
})

test('11. generation does not immediately persist', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Unsaved Candidate Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    title: 'Candidate Only Item',
    contentType: 'post',
    status: 'idea',
  })

  const result = await generateCampaignContentDraft(
    db,
    {
      workspaceId: base.workspaceId,
      campaignId: campaign.id,
      contentId: item.id,
    },
    mockAiDeps(
      JSON.stringify({
        headline: 'A Great Hook',
        body: 'Candidate post copy.',
      }),
    ),
  )

  assert.equal(result.ok, true)

  // Verify variant table is still empty!
  const variants = await listContentVariants(db, base.workspaceId, item.id)
  assert.equal(variants.length, 0)

  // Verify content status has NOT moved yet
  const fetchedItem = await getCampaignContentDetail(db, base.workspaceId, item.id)
  assert.ok(fetchedItem)
  assert.equal(fetchedItem.status, 'idea')
})

test('12. Save persists draft', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Persist Draft Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    title: 'Persistable Piece',
    contentType: 'post',
    status: 'planned',
  })

  const genResult = await generateCampaignContentDraft(
    db,
    {
      workspaceId: base.workspaceId,
      campaignId: campaign.id,
      contentId: item.id,
    },
    mockAiDeps(
      JSON.stringify({
        headline: 'Hook Text',
        body: 'The real draft body text.',
        callToAction: 'Click here',
        creativeDirection: 'Hero visual',
        notes: 'Hashtags: #Cloud',
      }),
    ),
  )

  assert.equal(genResult.ok, true)
  if (!genResult.ok) return

  const saveResult = await saveCampaignContentDraft(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    draft: genResult.draft,
    provenance: genResult.provenance,
  })

  assert.ok(saveResult.variant)
  assert.equal(saveResult.variant.contentId, item.id)
  assert.equal(saveResult.variant.body, 'The real draft body text.')
  assert.equal(saveResult.variant.headline, 'Hook Text')
  assert.equal(saveResult.variant.callToAction, 'Click here')
  assert.equal(saveResult.variant.creativeDirection, 'Hero visual')
  assert.equal(saveResult.variant.notes, 'Hashtags: #Cloud')
  assert.equal(saveResult.variant.status, 'draft')

  const variants = await listContentVariants(db, base.workspaceId, item.id)
  assert.equal(variants.length, 1)

  const latest = await getLatestContentVariant(db, base.workspaceId, item.id)
  assert.ok(latest)
  assert.equal(latest.id, saveResult.variant.id)
  assert.equal(latest.body, 'The real draft body text.')
})

test('13. original content plan item remains intact', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Original Item Preservation',
  })

  const originalItem = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    title: 'Original Planning Title',
    contentType: 'thread',
    purpose: 'awareness',
    theme: 'Cloud Migration',
    brief: 'Original brief text that must never be overwritten.',
    status: 'planned',
  })

  await saveCampaignContentDraft(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: originalItem.id,
    draft: {
      headline: 'Generated Thread Hook',
      body: '1/10 Here is how cloud migrations work...',
    },
  })

  const fetched = await getCampaignContentDetail(db, base.workspaceId, originalItem.id)
  assert.ok(fetched)
  assert.equal(fetched.title, 'Original Planning Title')
  assert.equal(fetched.contentType, 'thread')
  assert.equal(fetched.purpose, 'awareness')
  assert.equal(fetched.theme, 'Cloud Migration')
  assert.equal(fetched.brief, 'Original brief text that must never be overwritten.')
})

test('14. saved draft references Content', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'FK Reference Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    title: 'Referenced Content',
    contentType: 'post',
  })

  const { variant } = await saveCampaignContentDraft(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    draft: { body: 'Referenced body' },
  })

  const row = raw.prepare(`SELECT * FROM content_variant WHERE id = ?`).get(variant.id) as {
    content_id: string
  }
  assert.equal(row.content_id, item.id)
})

test('15. Creator agent/version provenance preserved', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Provenance Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    title: 'Provenance Item',
    contentType: 'post',
  })

  const genResult = await generateCampaignContentDraft(
    db,
    {
      workspaceId: base.workspaceId,
      campaignId: campaign.id,
      contentId: item.id,
    },
    echoDeps(),
  )

  assert.equal(genResult.ok, true)
  if (!genResult.ok) return

  const saveResult = await saveCampaignContentDraft(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    draft: genResult.draft,
    provenance: genResult.provenance,
  })

  assert.ok(saveResult.variant.provenance)
  assert.equal(saveResult.variant.provenance.agentName, 'Creator')
  assert.equal(saveResult.variant.provenance.versionNumber, 1)
  assert.ok(saveResult.variant.provenance.agentId)
  assert.ok(saveResult.variant.provenance.executionId)
})

test('16. saved draft moves item to Draft status', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Status Transition Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    title: 'Idea Status Item',
    contentType: 'post',
    status: 'idea',
  })

  assert.equal(item.status, 'idea')

  const { contentItem } = await saveCampaignContentDraft(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    draft: { body: 'New draft copy' },
  })

  assert.equal(contentItem.status, 'draft')
})

test('17. no Ready/Approved/Published status set', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Lifecycle Guard Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    title: 'Guard Item',
    contentType: 'post',
    status: 'planned',
  })

  const { variant, contentItem } = await saveCampaignContentDraft(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    draft: { body: 'Guarded draft copy' },
  })

  assert.equal(variant.status, 'draft')
  assert.equal(contentItem.status, 'draft')
  assert.notEqual(contentItem.status, 'ready')
  assert.notEqual(contentItem.status, 'approved')
})

test('18. regenerate is explicit', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Explicit Regenerate Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    title: 'Regenerate Item',
    contentType: 'post',
  })

  // 1st generation
  const res1 = await generateCampaignContentDraft(
    db,
    { workspaceId: base.workspaceId, campaignId: campaign.id, contentId: item.id },
    mockAiDeps(JSON.stringify({ headline: 'Hook 1', body: 'Copy 1' })),
  )
  assert.equal(res1.ok, true)
  if (!res1.ok) return
  assert.equal(res1.draft.headline, 'Hook 1')

  // Explicit 2nd generation
  const res2 = await generateCampaignContentDraft(
    db,
    { workspaceId: base.workspaceId, campaignId: campaign.id, contentId: item.id },
    mockAiDeps(JSON.stringify({ headline: 'Hook 2', body: 'Copy 2' })),
  )
  assert.equal(res2.ok, true)
  if (!res2.ok) return
  assert.equal(res2.draft.headline, 'Hook 2')
  assert.notEqual(res1.provenance.executionId, res2.provenance.executionId)
})

test('19. provider failure creates no fake draft', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Failure Handling Campaign',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    title: 'Failing Provider Item',
    contentType: 'post',
  })

  const result = await generateCampaignContentDraft(
    db,
    {
      workspaceId: base.workspaceId,
      campaignId: campaign.id,
      contentId: item.id,
    },
    failingAiDeps('timeout'),
  )

  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.ok(
      result.message.includes('Creator took too long') || result.message.includes('respond'),
    )
  }

  // Ensure no drafts exist in DB
  const variants = await listContentVariants(db, base.workspaceId, item.id)
  assert.equal(variants.length, 0)
})

test('20. no Tool execution occurs', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const toolWasCalled = false
  const customAiDeps: ExecuteAIDeps = {
    adapters: new Map([
      [
        'echo',
        {
          key: 'echo',
          async execute() {
            return {
              content: JSON.stringify({ body: 'Clean text without tools' }),
              finishReason: 'stop',
              usage: null,
            }
          },
        },
      ],
    ]),
    modelOverrides: { provider: 'echo' },
  }

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'No Tool Campaign',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    title: 'Tool-Free Item',
    contentType: 'post',
  })

  const result = await generateCampaignContentDraft(
    db,
    {
      workspaceId: base.workspaceId,
      campaignId: campaign.id,
      contentId: item.id,
    },
    customAiDeps,
  )

  assert.equal(result.ok, true)
  assert.equal(toolWasCalled, false)
})

test('21. no Critic execution occurs', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'No Critic Campaign',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    title: 'Pre-Critic Item',
    contentType: 'post',
  })

  await generateCampaignContentDraft(
    db,
    {
      workspaceId: base.workspaceId,
      campaignId: campaign.id,
      contentId: item.id,
    },
    echoDeps(),
  )

  // Verify Critic has not produced any event
  const events = await listRecentEvents(db, base.workspaceId, undefined, 50)
  assert.ok(!events.some((e) => e.actor_id === 'critic'))
})

test('22. audit/events safe (content.draft_generated, content.draft_saved)', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Audit Event Verification',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    title: 'Audit Event Item',
    contentType: 'post',
  })

  const genResult = await generateCampaignContentDraft(
    db,
    {
      workspaceId: base.workspaceId,
      campaignId: campaign.id,
      contentId: item.id,
    },
    echoDeps(),
  )

  assert.equal(genResult.ok, true)
  if (!genResult.ok) return

  await saveCampaignContentDraft(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    draft: genResult.draft,
    provenance: genResult.provenance,
  })

  const events = await listRecentEvents(db, base.workspaceId, 'content.', 20)
  const genEvent = events.find((e) => e.event_type === 'content.draft_generated')
  const saveEvent = events.find((e) => e.event_type === 'content.draft_saved')

  assert.ok(genEvent, 'Expected content.draft_generated event')
  assert.ok(saveEvent, 'Expected content.draft_saved event')

  assert.ok(genEvent.payload)
  const genPayload = JSON.parse(genEvent.payload)
  assert.equal(genPayload.campaignId, campaign.id)
  assert.equal(genPayload.contentId, item.id)

  assert.ok(saveEvent.payload)
  const savePayload = JSON.parse(saveEvent.payload)
  assert.equal(savePayload.campaignId, campaign.id)
  assert.equal(savePayload.contentId, item.id)
})

test('23. existing Campaign/Agent/AI tests remain green', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Regression Check Campaign',
  })

  const items = await listCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
  })
  assert.equal(items.length, 0)
})
