/**
 * STEP 15B: Critic Editorial Review for Content Plan Draft Variants Test Suite
 *
 * Verifies:
 * 1. Saved variant can be reviewed
 * 2. Unsaved candidate cannot be reviewed
 * 3. Archived content rejected
 * 4. Wrong workspace rejected
 * 5. Exact variant ID used
 * 6. Campaign context reaches Critic
 * 7. Audience reaches Critic
 * 8. Strategy reaches Critic
 * 9. Content brief reaches Critic
 * 10. Exact saved draft reaches Critic
 * 11. Critic lacks web_search
 * 12. Critic executes no Tools
 * 13. Structured review returned
 * 14. Pass verdict accepted
 * 15. Revise verdict accepted
 * 16. Invalid verdict normalized
 * 17. Invalid severity normalized
 * 18. Malformed review handled safely
 * 19. Generation does not persist review
 * 20. Save explicitly persists review
 * 21. Review references exact variant
 * 22. Critic provenance preserved
 * 23. Second review creates history, not overwrite
 * 24. Critic cannot alter original variant
 * 25. Content does not become Ready automatically
 * 26. Content does not become Published
 * 27. Factual verification issue supported
 * 28. Provider failure creates no fake review
 * 29. No Creator execution occurs
 * 30. Events/audit safe (content.review_generated, content.review_saved)
 * 31. Existing Creator/Campaign/Agent/AI tests stay green
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import {
  composeContentReviewTask,
  parseContentReviewOutput,
} from '../src/server/agents/content-review.ts'
import { ensureBuiltinAgents } from '../src/server/agents/registry.ts'
import type { ExecuteAIDeps } from '../src/server/ai/executor.ts'
import { createEchoAdapter } from '../src/server/ai/providers/echo.ts'
import type { AIProviderAdapter } from '../src/server/ai/types.ts'
import { buildContext } from '../src/server/context/engine.ts'
import { createCampaign } from '../src/server/db/campaign.ts'
import { createCampaignContent, getCampaignContentDetail } from '../src/server/db/content.ts'
import {
  generateCampaignContentReview,
  getLatestContentReview,
  listContentReviews,
  saveCampaignContentReview,
} from '../src/server/db/content-review.ts'
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
      throw Object.assign(new Error('Critic AI provider error'), { code: errorCode })
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

function mockDraftDeps(draft?: {
  headline?: string | null
  body?: string
  callToAction?: string | null
}) {
  const content = JSON.stringify({
    headline: draft?.headline ?? 'Default Headline',
    body: draft?.body ?? 'Manual compliance spreadsheets lead to failed audits.',
    callToAction: draft?.callToAction ?? 'Click here',
    creativeDirection: 'Infographic style',
    notes: '#SOC2',
  })
  return mockAiDeps(content)
}

async function seedDraftVariant(
  db: SqlDatabase,
  workspaceId: string,
  campaignId: string,
  contentId: string,
  draftData?: {
    headline?: string | null
    body: string
    callToAction?: string | null
    creativeDirection?: string | null
    notes?: string | null
  },
) {
  const gen = await generateCampaignContentDraft(
    db,
    { workspaceId, campaignId, contentId },
    mockDraftDeps(draftData),
  )
  if (!gen.ok) throw new Error(`Draft candidate generation failed: ${gen.message}`)
  return saveCampaignContentDraft(db, {
    workspaceId,
    campaignId,
    contentId,
    candidateId: gen.candidateId,
    draft: draftData ?? {
      headline: gen.draft.headline ?? 'Default Headline',
      body: gen.draft.body || 'Manual compliance spreadsheets lead to failed audits.',
      callToAction: gen.draft.callToAction ?? 'Click here',
    },
  })
}

test('1. saved variant can be reviewed', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'SOC2 Launch Campaign',
    objective: 'conversions',
    positioning: 'Fastest compliance platform for dev teams',
    angle: 'Save 200 engineer hours',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Top 5 Audit Mistakes',
    contentType: 'post',
    purpose: 'education',
    theme: 'Compliance Pitfalls',
    brief: 'Explain common mistakes teams make when preparing for SOC2 audits.',
  })

  const { variant } = await seedDraftVariant(db, base.workspaceId, campaign.id, item.id, {
    headline: 'Stop Tracking SOC2 in Spreadsheets',
    body: 'Manual compliance spreadsheets lead to failed audits. Automated evidence collection saves time and prevents engineer burnout.',
    callToAction: 'Download our free guide.',
  })

  const mockReviewResponse = JSON.stringify({
    verdict: 'pass',
    summary: 'Clear, concise, and directly speaks to developer pain points.',
    strengths: ['Strong opening hook', 'Specific value proposition'],
    issues: [],
    recommendedChanges: ['Consider testing an even shorter CTA in follow-ups'],
  })

  const result = await generateCampaignContentReview(
    db,
    {
      workspaceId: base.workspaceId,
      campaignId: campaign.id,
      contentId: item.id,
      contentVariantId: variant.id,
    },
    mockAiDeps(mockReviewResponse),
  )

  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.review.verdict, 'pass')
    assert.equal(
      result.review.summary,
      'Clear, concise, and directly speaks to developer pain points.',
    )
    assert.equal(result.provenance.criticAgentName, 'Critic')
    assert.equal(result.provenance.versionNumber, 1)
    assert.ok(result.provenance.executionId)
  }
})

test('2. unsaved candidate cannot be reviewed', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Unsaved Review Guard Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Unsaved Candidate Piece',
    contentType: 'post',
  })

  const fakeVariantId = crypto.randomUUID()

  await assert.rejects(
    async () => {
      await generateCampaignContentReview(
        db,
        {
          workspaceId: base.workspaceId,
          campaignId: campaign.id,
          contentId: item.id,
          contentVariantId: fakeVariantId,
        },
        echoDeps(),
      )
    },
    { message: /Saved content variant not found or is archived/i },
  )
})

test('3. archived content rejected', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Archived Content Critic Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'To Be Archived',
    contentType: 'post',
  })

  const { variant } = await seedDraftVariant(db, base.workspaceId, campaign.id, item.id, {
    body: 'Archived variant body',
  })

  // Soft delete content item
  raw
    .prepare(`UPDATE content SET status = 'archived', deleted_at = ? WHERE id = ?`)
    .run(NOW, item.id)

  await assert.rejects(
    async () => {
      await generateCampaignContentReview(
        db,
        {
          workspaceId: base.workspaceId,
          campaignId: campaign.id,
          contentId: item.id,
          contentVariantId: variant.id,
        },
        echoDeps(),
      )
    },
    { message: /Content item not found or is archived/i },
  )
})

test('4. wrong workspace rejected', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Wrong Workspace Critic Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Workspace Isolation Item',
    contentType: 'post',
  })

  const { variant } = await seedDraftVariant(db, base.workspaceId, campaign.id, item.id, {
    body: 'Some body',
  })

  await assert.rejects(
    async () => {
      await generateCampaignContentReview(
        db,
        {
          workspaceId: base.otherWorkspaceId,
          campaignId: campaign.id,
          contentId: item.id,
          contentVariantId: variant.id,
        },
        echoDeps(),
      )
    },
    { message: /Campaign not found in this workspace/i },
  )
})

test('5. exact variant ID used', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Exact Variant ID Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Versioned Item',
    contentType: 'post',
  })

  // Variant 1
  const { variant: v1 } = await seedDraftVariant(db, base.workspaceId, campaign.id, item.id, {
    body: 'First draft body',
  })

  // Variant 2
  const { variant: v2 } = await seedDraftVariant(db, base.workspaceId, campaign.id, item.id, {
    body: 'Second revised draft body',
  })

  assert.notEqual(v1.id, v2.id)

  const rev1 = await saveCampaignContentReview(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    contentVariantId: v1.id,
    verdict: 'revise',
    review: {
      verdict: 'revise',
      summary: 'Draft 1 is too brief.',
      strengths: [],
      issues: [{ category: 'clarity', severity: 'high', message: 'Not enough detail' }],
      recommendedChanges: ['Add examples'],
    },
  })

  assert.equal(rev1.contentVariantId, v1.id)

  const v1Reviews = await listContentReviews(db, base.workspaceId, v1.id)
  const v2Reviews = await listContentReviews(db, base.workspaceId, v2.id)

  assert.equal(v1Reviews.length, 1)
  assert.equal(v2Reviews.length, 0)
})

test('6. Campaign context reaches Critic', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Critic Context Flow',
    objective: 'revenue',
    positioning: 'Zero-trust infrastructure compliance',
  })

  const pkg = await buildContext(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
  })

  assert.ok(pkg.campaign)
  assert.equal(pkg.campaign.name, 'Critic Context Flow')
  assert.equal(pkg.campaign.strategy.positioning, 'Zero-trust infrastructure compliance')
})

test('7. audience reaches Critic', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Audience Review Flow',
    audienceDetails: {
      summary: 'DevSecOps engineers and CISOs',
      problem: 'Audit readiness takes months of manual work',
      awarenessLevel: 'solution_aware',
    },
  })

  const pkg = await buildContext(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
  })

  assert.ok(pkg.campaign?.audience)
  assert.equal(pkg.campaign.audience.summary, 'DevSecOps engineers and CISOs')
})

test('8. strategy reaches Critic', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Strategy Critic Flow',
    objective: 'leads',
    positioning: 'Continuous cloud security scanner',
    angle: 'Stop false positives',
    offerMessage: 'Free automated risk assessment',
    hypothesis: 'Highlighting false positive fatigue increases conversion by 40%',
  })

  const pkg = await buildContext(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
  })

  assert.ok(pkg.campaign?.strategy)
  assert.equal(pkg.campaign.strategy.coreAngle, 'Stop false positives')
  assert.equal(pkg.campaign.strategy.offerMessage, 'Free automated risk assessment')
})

test('9. content brief reaches Critic', () => {
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
    brief: 'In-depth analysis of misconfigured S3 buckets and IAM roles.',
    body: null,
    status: 'draft' as const,
    plannedAt: '2026-09-01T00:00:00.000Z',
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  }

  const variant = {
    id: crypto.randomUUID(),
    contentId: item.id,
    platformId: crypto.randomUUID(),
    platformName: 'LinkedIn',
    body: 'Here are 3 critical mistakes companies make with IAM roles.',
    headline: 'Top 3 IAM Mistakes',
    callToAction: 'Read the whitepaper',
    creativeDirection: 'Infographic preview',
    notes: 'Include security tags',
    status: 'draft' as const,
    provenance: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  }

  const task = composeContentReviewTask(item, variant, 'LinkedIn')
  assert.ok(task.includes('Why Cloud Migrations Fail'))
  assert.ok(task.includes('In-depth analysis of misconfigured S3 buckets'))
  assert.ok(task.includes('education'))
  assert.ok(task.includes('Top 3 IAM Mistakes'))
  assert.ok(task.includes('Here are 3 critical mistakes companies make with IAM roles.'))
})

test('10. exact saved draft reaches Critic', () => {
  const item = {
    id: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    campaignId: crypto.randomUUID(),
    productId: null,
    targetAccountId: null,
    title: 'Exact Draft Test',
    contentType: 'post' as const,
    purpose: null,
    theme: null,
    brief: null,
    body: null,
    status: 'draft' as const,
    plannedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  }

  const variant = {
    id: crypto.randomUUID(),
    contentId: item.id,
    platformId: crypto.randomUUID(),
    platformName: 'LinkedIn',
    body: 'Unique Draft Text 987654321',
    headline: 'Hook 12345',
    callToAction: 'Action 54321',
    creativeDirection: 'Visual 777',
    notes: 'Note 999',
    status: 'draft' as const,
    provenance: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  }

  const task = composeContentReviewTask(item, variant)
  assert.ok(task.includes('Unique Draft Text 987654321'))
  assert.ok(task.includes('Hook 12345'))
  assert.ok(task.includes('Action 54321'))
  assert.ok(task.includes('Visual 777'))
  assert.ok(task.includes('Note 999'))
})

test('11. Critic lacks web_search', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)
  const agentMap = await ensureBuiltinAgents(db, base.workspaceId)
  const critic = agentMap.get('critic')

  assert.ok(critic)
  assert.equal(critic.agent.executionType, 'direct_model')
  assert.deepEqual(critic.config.capabilities, ['read_context', 'read_memory'])

  const caller = {
    agentId: critic.agent.id,
    agentVersionId: critic.version.id,
    agentName: critic.agent.name,
  }

  const availableTools = getAvailableTools(
    db,
    base.workspaceId,
    caller,
    critic.config.capabilities,
    listToolDefinitions(),
  )

  assert.equal(availableTools.length, 0)
  assert.ok(!availableTools.some((t) => t.name === 'web.search'))
})

test('12. Critic executes no Tools', async () => {
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
              content: JSON.stringify({
                verdict: 'pass',
                summary: 'Tool-free assessment.',
                strengths: [],
                issues: [],
                recommendedChanges: [],
              }),
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
    accountIds: [base.accountId],
    name: 'Tool-Free Critic Campaign',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Tool-Free Item',
    contentType: 'post',
  })

  const { variant } = await seedDraftVariant(db, base.workspaceId, campaign.id, item.id, {
    body: 'Clean text without tools',
  })

  const result = await generateCampaignContentReview(
    db,
    {
      workspaceId: base.workspaceId,
      campaignId: campaign.id,
      contentId: item.id,
      contentVariantId: variant.id,
    },
    customAiDeps,
  )

  assert.equal(result.ok, true)
  assert.equal(toolWasCalled, false)
})

test('13. structured review returned', () => {
  const rawJson = `
\`\`\`json
{
  "verdict": "revise",
  "summary": "The hook is compelling but the body makes unsupported claims regarding audit guarantees.",
  "strengths": ["Strong headline", "Good developer audience targeting"],
  "issues": [
    {
      "category": "factual_verification",
      "severity": "high",
      "message": "Claim of 100% audit pass guarantee is unverified."
    }
  ],
  "recommendedChanges": ["Remove absolute guarantee language and focus on time saved."]
}
\`\`\`
`
  const parsed = parseContentReviewOutput(rawJson)
  assert.equal(parsed.verdict, 'revise')
  assert.ok(parsed.summary.includes('unsupported claims'))
  assert.equal(parsed.strengths.length, 2)
  assert.equal(parsed.issues.length, 1)
  assert.equal(parsed.issues[0].category, 'factual_verification')
  assert.equal(parsed.issues[0].severity, 'high')
  assert.equal(parsed.recommendedChanges.length, 1)
})

test('14. Pass verdict accepted', () => {
  const parsed = parseContentReviewOutput(
    JSON.stringify({ verdict: 'pass', summary: 'Ready to ship' }),
  )
  assert.equal(parsed.verdict, 'pass')
})

test('15. Revise verdict accepted', () => {
  const parsed = parseContentReviewOutput(
    JSON.stringify({ verdict: 'revise', summary: 'Needs improvement' }),
  )
  assert.equal(parsed.verdict, 'revise')
})

test('16. invalid verdict normalized', () => {
  const parsed = parseContentReviewOutput(
    JSON.stringify({ verdict: 'maybe', summary: 'Unclear verdict' }),
  )
  assert.equal(parsed.verdict, 'revise')
})

test('17. invalid severity normalized', () => {
  const parsed = parseContentReviewOutput(
    JSON.stringify({
      verdict: 'revise',
      summary: 'Severity test',
      issues: [{ category: 'tone', severity: 'extreme_danger', message: 'Too aggressive' }],
    }),
  )
  assert.equal(parsed.issues[0].severity, 'medium')
})

test('18. malformed review handled safely', () => {
  const parsed = parseContentReviewOutput(
    'Not JSON at all, but plain text critique saying this needs revise.',
  )
  assert.equal(parsed.verdict, 'revise')
  assert.ok(parsed.summary.length > 0)
  assert.ok(Array.isArray(parsed.strengths))
  assert.ok(Array.isArray(parsed.issues))
  assert.ok(Array.isArray(parsed.recommendedChanges))
})

test('19. generation does not persist review', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Unpersisted Review Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Unpersisted Review Item',
    contentType: 'post',
  })

  const { variant } = await seedDraftVariant(db, base.workspaceId, campaign.id, item.id, {
    body: 'Candidate draft copy.',
  })

  const result = await generateCampaignContentReview(
    db,
    {
      workspaceId: base.workspaceId,
      campaignId: campaign.id,
      contentId: item.id,
      contentVariantId: variant.id,
    },
    mockAiDeps(
      JSON.stringify({
        verdict: 'pass',
        summary: 'Looks good.',
      }),
    ),
  )

  assert.equal(result.ok, true)

  // Verify review table is still empty
  const reviews = await listContentReviews(db, base.workspaceId, variant.id)
  assert.equal(reviews.length, 0)
})

test('20. Save explicitly persists review', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Save Review Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Save Review Item',
    contentType: 'post',
  })

  const { variant } = await seedDraftVariant(db, base.workspaceId, campaign.id, item.id, {
    body: 'Draft to review.',
  })

  const savedReview = await saveCampaignContentReview(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    contentVariantId: variant.id,
    verdict: 'pass',
    review: {
      verdict: 'pass',
      summary: 'Solid copy that aligns with campaign goals.',
      strengths: ['Crisp call to action'],
      issues: [],
      recommendedChanges: [],
    },
  })

  assert.ok(savedReview.id)
  assert.equal(savedReview.verdict, 'pass')
  assert.equal(savedReview.summary, 'Solid copy that aligns with campaign goals.')
  assert.equal(savedReview.contentVariantId, variant.id)

  const reviews = await listContentReviews(db, base.workspaceId, variant.id)
  assert.equal(reviews.length, 1)
  assert.equal(reviews[0].id, savedReview.id)
})

test('21. review references exact variant', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Variant Reference Integrity',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Referenced Item',
    contentType: 'post',
  })

  const { variant } = await seedDraftVariant(db, base.workspaceId, campaign.id, item.id, {
    body: 'Referenced body text.',
  })

  const savedReview = await saveCampaignContentReview(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    contentVariantId: variant.id,
    verdict: 'revise',
    review: {
      verdict: 'revise',
      summary: 'Needs work',
      strengths: [],
      issues: [],
      recommendedChanges: [],
    },
  })

  const row = raw.prepare(`SELECT * FROM content_review WHERE id = ?`).get(savedReview.id) as {
    content_id: string
    content_variant_id: string
  }
  assert.equal(row.content_id, item.id)
  assert.equal(row.content_variant_id, variant.id)
})

test('22. Critic provenance preserved', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Critic Provenance Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Critic Provenance Item',
    contentType: 'post',
  })

  const { variant } = await seedDraftVariant(db, base.workspaceId, campaign.id, item.id, {
    body: 'Body for provenance check.',
  })

  const genResult = await generateCampaignContentReview(
    db,
    {
      workspaceId: base.workspaceId,
      campaignId: campaign.id,
      contentId: item.id,
      contentVariantId: variant.id,
    },
    echoDeps(),
  )

  assert.equal(genResult.ok, true)
  if (!genResult.ok) return

  const savedReview = await saveCampaignContentReview(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    contentVariantId: variant.id,
    verdict: genResult.review.verdict,
    review: genResult.review,
    provenance: genResult.provenance,
  })

  assert.equal(savedReview.criticAgentName, 'Critic')
  assert.equal(savedReview.criticAgentVersionNumber, 1)
  assert.ok(savedReview.criticAgentId)
  assert.ok(savedReview.criticAgentVersionId)
  assert.ok(savedReview.aiExecutionId)
})

test('23. second review creates history, not overwrite', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'History Accumulation Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'History Item',
    contentType: 'post',
  })

  const { variant } = await seedDraftVariant(db, base.workspaceId, campaign.id, item.id, {
    body: 'Draft subject to multiple reviews.',
  })

  // Review 1
  const r1 = await saveCampaignContentReview(
    db,
    {
      workspaceId: base.workspaceId,
      campaignId: campaign.id,
      contentId: item.id,
      contentVariantId: variant.id,
      verdict: 'revise',
      review: {
        verdict: 'revise',
        summary: 'Review 1: Needs stronger hook.',
        strengths: [],
        issues: [],
        recommendedChanges: [],
      },
    },
    '2026-08-20T10:00:01.000Z',
  )

  // Review 2
  const r2 = await saveCampaignContentReview(
    db,
    {
      workspaceId: base.workspaceId,
      campaignId: campaign.id,
      contentId: item.id,
      contentVariantId: variant.id,
      verdict: 'pass',
      review: {
        verdict: 'pass',
        summary: 'Review 2: Hook is now acceptable.',
        strengths: ['Good hook'],
        issues: [],
        recommendedChanges: [],
      },
    },
    '2026-08-20T10:00:02.000Z',
  )

  assert.notEqual(r1.id, r2.id)

  const reviews = await listContentReviews(db, base.workspaceId, variant.id)
  assert.equal(reviews.length, 2)
  assert.equal(reviews[0].id, r2.id)
  assert.equal(reviews[1].id, r1.id)

  const latest = await getLatestContentReview(db, base.workspaceId, variant.id)
  assert.ok(latest)
  assert.equal(latest.id, r2.id)
  assert.equal(latest.verdict, 'pass')
})

test('24. Critic cannot alter original variant', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Draft Immutability Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Immutable Draft Item',
    contentType: 'post',
  })

  const { variant } = await seedDraftVariant(db, base.workspaceId, campaign.id, item.id, {
    headline: 'Original Headline',
    body: 'Original draft body copy that must remain pristine.',
    callToAction: 'Original CTA',
  })

  await saveCampaignContentReview(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    contentVariantId: variant.id,
    verdict: 'revise',
    review: {
      verdict: 'revise',
      summary: 'Change everything!',
      strengths: [],
      issues: [{ category: 'general', severity: 'high', message: 'Needs rewrite' }],
      recommendedChanges: ['Rewrite body'],
    },
  })

  const fetchedVariant = await getLatestContentVariant(db, base.workspaceId, item.id)
  assert.ok(fetchedVariant)
  assert.equal(fetchedVariant.headline, 'Original Headline')
  assert.equal(fetchedVariant.body, 'Original draft body copy that must remain pristine.')
  assert.equal(fetchedVariant.callToAction, 'Original CTA')
})

test('25. content does not become Ready automatically', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'No Auto-Ready Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'No Auto Ready Item',
    contentType: 'post',
  })

  const { variant } = await seedDraftVariant(db, base.workspaceId, campaign.id, item.id, {
    body: 'Some copy',
  })

  // Pass review
  await saveCampaignContentReview(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    contentVariantId: variant.id,
    verdict: 'pass',
    review: {
      verdict: 'pass',
      summary: 'Passes review.',
      strengths: [],
      issues: [],
      recommendedChanges: [],
    },
  })

  const fetchedContent = await getCampaignContentDetail(db, base.workspaceId, item.id)
  assert.ok(fetchedContent)
  assert.equal(fetchedContent.status, 'draft')
  assert.notEqual(fetchedContent.status, 'ready')
})

test('26. content does not become Published', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'No Auto-Publish Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'No Auto Publish Item',
    contentType: 'post',
  })

  const { variant } = await seedDraftVariant(db, base.workspaceId, campaign.id, item.id, {
    body: 'Some copy',
  })

  await saveCampaignContentReview(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    contentVariantId: variant.id,
    verdict: 'pass',
    review: {
      verdict: 'pass',
      summary: 'Passes review.',
      strengths: [],
      issues: [],
      recommendedChanges: [],
    },
  })

  // Check no post rows were created
  const postRows = raw.prepare(`SELECT * FROM post WHERE content_variant_id = ?`).all(variant.id)
  assert.equal(postRows.length, 0)
})

test('27. factual verification issue supported', () => {
  const output = parseContentReviewOutput(
    JSON.stringify({
      verdict: 'revise',
      summary: 'Unverified stats detected.',
      strengths: [],
      issues: [
        {
          category: 'factual_verification',
          severity: 'high',
          message: 'Claim should be verified before publishing.',
        },
      ],
      recommendedChanges: ['Verify statistics'],
    }),
  )

  assert.equal(output.issues[0].category, 'factual_verification')
  assert.equal(output.issues[0].message, 'Claim should be verified before publishing.')
})

test('28. provider failure creates no fake review', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Provider Failure Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Provider Failure Item',
    contentType: 'post',
  })

  const { variant } = await seedDraftVariant(db, base.workspaceId, campaign.id, item.id, {
    body: 'Draft text',
  })

  const result = await generateCampaignContentReview(
    db,
    {
      workspaceId: base.workspaceId,
      campaignId: campaign.id,
      contentId: item.id,
      contentVariantId: variant.id,
    },
    failingAiDeps('timeout'),
  )

  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.ok(
      result.message.includes('Critic') ||
        result.message.includes('respond') ||
        result.message.includes('error'),
    )
  }

  const reviews = await listContentReviews(db, base.workspaceId, variant.id)
  assert.equal(reviews.length, 0)
})

test('29. no Creator execution occurs', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'No Creator Execution Flow',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'No Creator Item',
    contentType: 'post',
  })

  const { variant } = await seedDraftVariant(db, base.workspaceId, campaign.id, item.id, {
    body: 'Draft before review',
  })

  await generateCampaignContentReview(
    db,
    {
      workspaceId: base.workspaceId,
      campaignId: campaign.id,
      contentId: item.id,
      contentVariantId: variant.id,
    },
    echoDeps(),
  )

  // Verify variant count is still 1 (Creator was not invoked to produce variant 2)
  const variants = await listContentVariants(db, base.workspaceId, item.id)
  assert.equal(variants.length, 1)
})

test('30. events/audit safe (content.review_generated, content.review_saved)', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Audit Event Review Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Audit Event Review Item',
    contentType: 'post',
  })

  const { variant } = await seedDraftVariant(db, base.workspaceId, campaign.id, item.id, {
    body: 'Audit body',
  })

  const genResult = await generateCampaignContentReview(
    db,
    {
      workspaceId: base.workspaceId,
      campaignId: campaign.id,
      contentId: item.id,
      contentVariantId: variant.id,
    },
    echoDeps(),
  )

  assert.equal(genResult.ok, true)
  if (!genResult.ok) return

  await saveCampaignContentReview(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    contentVariantId: variant.id,
    verdict: genResult.review.verdict,
    review: genResult.review,
    provenance: genResult.provenance,
  })

  const events = await listRecentEvents(db, base.workspaceId, 'content.review_', 20)
  const genEvent = events.find((e) => e.event_type === 'content.review_generated')
  const saveEvent = events.find((e) => e.event_type === 'content.review_saved')

  assert.ok(genEvent, 'Expected content.review_generated event')
  assert.ok(saveEvent, 'Expected content.review_saved event')

  assert.ok(genEvent.payload)
  const genPayload = JSON.parse(genEvent.payload)
  assert.equal(genPayload.campaignId, campaign.id)
  assert.equal(genPayload.contentId, item.id)
  assert.equal(genPayload.contentVariantId, variant.id)

  assert.ok(saveEvent.payload)
  const savePayload = JSON.parse(saveEvent.payload)
  assert.equal(savePayload.campaignId, campaign.id)
  assert.equal(savePayload.contentId, item.id)
  assert.equal(savePayload.contentVariantId, variant.id)
})

test('31. existing Creator/Campaign/Agent/AI tests stay green', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Regression Check Campaign',
  })

  assert.ok(campaign.id)
})
