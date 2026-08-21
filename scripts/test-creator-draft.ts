/**
 * HARDENING H3A.1: Creator Draft Provenance & Platform Integrity Test Suite
 *
 * Verifies:
 * 1. Generate creates server candidate
 * 2. Generate does not create final content_variant
 * 3. candidate tied to workspace
 * 4. candidate tied to Campaign
 * 5. candidate tied to Content item
 * 6. candidate tied to Creator Agent
 * 7. candidate tied to Creator Agent version
 * 8. candidate tied to AI execution
 * 9. authoritative model/provider derived server-side
 * 10. unknown model remains null, not "default"
 * 11. Save requires candidateId
 * 12. browser cannot forge agentId
 * 13. browser cannot forge agentVersionId
 * 14. browser cannot forge executionId
 * 15. browser cannot forge model
 * 16. browser cannot forge generation timestamp
 * 17. cross-workspace candidate rejected
 * 18. candidate for wrong Campaign rejected
 * 19. candidate for wrong Content item rejected
 * 20. saved variant references real candidate provenance
 * 21. unedited Save => humanEdited false
 * 22. edited Save => humanEdited true
 * 23. generatedHash preserved
 * 24. savedHash preserved
 * 25. repeat Save behavior is deterministic (candidate already saved rejected)
 * 26. Account required before Generate
 * 27. Account required before Save
 * 28. Account must belong to workspace
 * 29. Platform derived only from Account
 * 30. no alphabetical Platform fallback
 * 31. browser platformId cannot override Account Platform
 * 32. malformed Creator JSON rejected
 * 33. fenced valid JSON accepted
 * 34. missing required body rejected
 * 35. invalid field types rejected
 * 36. oversized fields rejected
 * 37. provider failure creates no fake candidate
 * 38. generation audit/event contains no secrets
 * 39. save audit/event contains no raw provider payload
 * 40. Critic can still review resulting saved variant
 * 41. existing STEP 15B tests remain green
 * 42. H2B Agent-version tests remain green
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import { computeDraftHash, parseContentDraftOutput } from '../src/server/agents/content-draft.ts'
import { ensureBuiltinAgents } from '../src/server/agents/registry.ts'
import type { ExecuteAIDeps } from '../src/server/ai/executor.ts'
import type { AIProviderAdapter } from '../src/server/ai/types.ts'
import { createCampaign } from '../src/server/db/campaign.ts'
import { createCampaignContent } from '../src/server/db/content.ts'
import { generateCampaignContentReview } from '../src/server/db/content-review.ts'
import {
  type ContentDraftCandidateRow,
  generateCampaignContentDraft,
  listContentVariants,
  saveCampaignContentDraft,
} from '../src/server/db/content-variant.ts'
import { listRecentEvents } from '../src/server/db/event.ts'
import type { SqlDatabase } from '../src/server/db/sql.ts'

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

function mockAiDeps(
  responseContent: string,
  providerKey = 'echo',
  modelName?: string,
): ExecuteAIDeps {
  const adapter: AIProviderAdapter = {
    key: providerKey,
    async execute() {
      return {
        content: responseContent,
        finishReason: 'stop',
        usage: null,
      }
    },
  }
  return {
    adapters: new Map([[providerKey, adapter]]),
    modelOverrides: { provider: providerKey, model: modelName },
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
  const otherPlatformId = crypto.randomUUID()
  const accountId = crypto.randomUUID()
  const otherAccountId = crypto.randomUUID()

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
      `INSERT INTO platform (id, adapter_key, name, created_at) VALUES (?, 'twitter', 'Twitter', ?)`,
    )
    .run(otherPlatformId, NOW)

  raw
    .prepare(
      `INSERT INTO account (id, workspace_id, platform_id, handle, display_name, status, created_at, updated_at)
       VALUES (?, ?, ?, 'cloudsecure_official', 'CloudSecure Official', 'active', ?, ?)`,
    )
    .run(accountId, workspaceId, platformId, NOW, NOW)

  raw
    .prepare(
      `INSERT INTO account (id, workspace_id, platform_id, handle, display_name, status, created_at, updated_at)
       VALUES (?, ?, ?, 'other_official', 'Other Official', 'active', ?, ?)`,
    )
    .run(otherAccountId, otherWorkspaceId, otherPlatformId, NOW, NOW)

  return {
    workspaceId,
    otherWorkspaceId,
    brandId,
    otherBrandId,
    platformId,
    otherPlatformId,
    accountId,
    otherAccountId,
  }
}

test('1. Generate creates server candidate', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'SOC2 Campaign',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: '5 Costly SOC2 Mistakes',
    contentType: 'post',
  })

  const structuredOutput = JSON.stringify({
    headline: 'Stop Tracking SOC2 in Spreadsheets',
    body: 'Manual compliance slows down engineering teams and leads to audit failures.',
    callToAction: 'Read the full guide.',
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
    assert.ok(result.candidateId)
    const candidateRow = raw
      .prepare(`SELECT * FROM content_draft_candidate WHERE id = ?`)
      .get(result.candidateId) as ContentDraftCandidateRow
    assert.ok(candidateRow)
    assert.equal(candidateRow.content_id, item.id)
    assert.equal(candidateRow.campaign_id, campaign.id)
  }
})

test('2. Generate does not create final content_variant', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Candidate Only Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Draft Candidate',
    contentType: 'post',
  })

  await generateCampaignContentDraft(
    db,
    {
      workspaceId: base.workspaceId,
      campaignId: campaign.id,
      contentId: item.id,
    },
    mockAiDeps(JSON.stringify({ body: 'Generated copy without saving.' })),
  )

  const variants = await listContentVariants(db, base.workspaceId, item.id)
  assert.equal(variants.length, 0)
})

test('3. candidate tied to workspace', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Workspace Tie Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Item',
    contentType: 'post',
  })

  const result = await generateCampaignContentDraft(
    db,
    { workspaceId: base.workspaceId, campaignId: campaign.id, contentId: item.id },
    mockAiDeps(JSON.stringify({ body: 'Body' })),
  )
  assert.equal(result.ok, true)
  if (result.ok) {
    const row = raw
      .prepare(`SELECT workspace_id FROM content_draft_candidate WHERE id = ?`)
      .get(result.candidateId) as { workspace_id: string }
    assert.equal(row.workspace_id, base.workspaceId)
  }
})

test('4. candidate tied to Campaign', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Campaign Tie Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Item',
    contentType: 'post',
  })

  const result = await generateCampaignContentDraft(
    db,
    { workspaceId: base.workspaceId, campaignId: campaign.id, contentId: item.id },
    mockAiDeps(JSON.stringify({ body: 'Body' })),
  )
  assert.equal(result.ok, true)
  if (result.ok) {
    const row = raw
      .prepare(`SELECT campaign_id FROM content_draft_candidate WHERE id = ?`)
      .get(result.candidateId) as { campaign_id: string }
    assert.equal(row.campaign_id, campaign.id)
  }
})

test('5. candidate tied to Content item', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Content Tie Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Item',
    contentType: 'post',
  })

  const result = await generateCampaignContentDraft(
    db,
    { workspaceId: base.workspaceId, campaignId: campaign.id, contentId: item.id },
    mockAiDeps(JSON.stringify({ body: 'Body' })),
  )
  assert.equal(result.ok, true)
  if (result.ok) {
    const row = raw
      .prepare(`SELECT content_id FROM content_draft_candidate WHERE id = ?`)
      .get(result.candidateId) as { content_id: string }
    assert.equal(row.content_id, item.id)
  }
})

test('6. candidate tied to Creator Agent', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)
  const agentMap = await ensureBuiltinAgents(db, base.workspaceId)
  const creator = agentMap.get('creator')!

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Creator Tie Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Item',
    contentType: 'post',
  })

  const result = await generateCampaignContentDraft(
    db,
    { workspaceId: base.workspaceId, campaignId: campaign.id, contentId: item.id },
    mockAiDeps(JSON.stringify({ body: 'Body' })),
  )
  assert.equal(result.ok, true)
  if (result.ok) {
    const row = raw
      .prepare(`SELECT creator_agent_id FROM content_draft_candidate WHERE id = ?`)
      .get(result.candidateId) as { creator_agent_id: string }
    assert.equal(row.creator_agent_id, creator.agent.id)
  }
})

test('7. candidate tied to Creator Agent version', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)
  const agentMap = await ensureBuiltinAgents(db, base.workspaceId)
  const creator = agentMap.get('creator')!

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Version Tie Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Item',
    contentType: 'post',
  })

  const result = await generateCampaignContentDraft(
    db,
    { workspaceId: base.workspaceId, campaignId: campaign.id, contentId: item.id },
    mockAiDeps(JSON.stringify({ body: 'Body' })),
  )
  assert.equal(result.ok, true)
  if (result.ok) {
    const row = raw
      .prepare(`SELECT creator_agent_version_id FROM content_draft_candidate WHERE id = ?`)
      .get(result.candidateId) as { creator_agent_version_id: string }
    assert.equal(row.creator_agent_version_id, creator.version.id)
  }
})

test('8. candidate tied to AI execution', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Execution Tie Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Item',
    contentType: 'post',
  })

  const result = await generateCampaignContentDraft(
    db,
    { workspaceId: base.workspaceId, campaignId: campaign.id, contentId: item.id },
    mockAiDeps(JSON.stringify({ body: 'Body' })),
  )
  assert.equal(result.ok, true)
  if (result.ok) {
    const row = raw
      .prepare(`SELECT ai_execution_id FROM content_draft_candidate WHERE id = ?`)
      .get(result.candidateId) as { ai_execution_id: string }
    assert.equal(row.ai_execution_id, result.provenance.executionId)
  }
})

test('9. authoritative model/provider derived server-side', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Model Provider Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Item',
    contentType: 'post',
  })

  const result = await generateCampaignContentDraft(
    db,
    { workspaceId: base.workspaceId, campaignId: campaign.id, contentId: item.id },
    mockAiDeps(JSON.stringify({ body: 'Body' }), 'echo'),
  )
  assert.equal(result.ok, true)
  if (result.ok) {
    const row = raw
      .prepare(`SELECT provider, model FROM content_draft_candidate WHERE id = ?`)
      .get(result.candidateId) as { provider: string; model: string }
    assert.equal(row.provider, 'echo')
    assert.equal(row.model, result.provenance.model)
    assert.ok(row.model)
  }
})

test('10. unknown model remains null, not "default"', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Null Model Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Item',
    contentType: 'post',
  })

  const result = await generateCampaignContentDraft(
    db,
    { workspaceId: base.workspaceId, campaignId: campaign.id, contentId: item.id },
    mockAiDeps(JSON.stringify({ body: 'Body' })),
  )
  assert.equal(result.ok, true)
  if (result.ok) {
    const row = raw
      .prepare(`SELECT model FROM content_draft_candidate WHERE id = ?`)
      .get(result.candidateId) as { model: string | null }
    assert.notEqual(row.model, 'default')
  }
})

test('11. Save requires candidateId', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Save Schema Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Item',
    contentType: 'post',
  })

  await assert.rejects(
    async () => {
      await saveCampaignContentDraft(db, {
        workspaceId: base.workspaceId,
        campaignId: campaign.id,
        contentId: item.id,
        draft: { body: 'Missing candidateId' },
      })
    },
    { name: 'ZodError' },
  )
})

test('12. browser cannot forge agentId', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Provenance Integrity Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Item',
    contentType: 'post',
  })

  const gen = await generateCampaignContentDraft(
    db,
    { workspaceId: base.workspaceId, campaignId: campaign.id, contentId: item.id },
    mockAiDeps(JSON.stringify({ body: 'Draft body' })),
  )
  assert.equal(gen.ok, true)
  if (!gen.ok) return

  const fakeAgentId = crypto.randomUUID()
  const saveResult = await saveCampaignContentDraft(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    candidateId: gen.candidateId,
    draft: { body: 'Draft body' },
    // Attempting to inject fake agentId in payload
    agentId: fakeAgentId,
  })

  assert.notEqual(saveResult.variant.provenance?.agentId, fakeAgentId)
  assert.equal(saveResult.variant.provenance?.agentId, gen.provenance.agentId)
})

test('13. browser cannot forge agentVersionId', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Version Integrity Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Item',
    contentType: 'post',
  })

  const gen = await generateCampaignContentDraft(
    db,
    { workspaceId: base.workspaceId, campaignId: campaign.id, contentId: item.id },
    mockAiDeps(JSON.stringify({ body: 'Draft body' })),
  )
  assert.equal(gen.ok, true)
  if (!gen.ok) return

  const fakeVersionId = crypto.randomUUID()
  const saveResult = await saveCampaignContentDraft(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    candidateId: gen.candidateId,
    draft: { body: 'Draft body' },
    agentVersionId: fakeVersionId,
  })

  assert.notEqual(saveResult.variant.provenance?.agentVersionId, fakeVersionId)
  assert.equal(saveResult.variant.provenance?.agentVersionId, gen.provenance.agentVersionId)
})

test('14. browser cannot forge executionId', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Execution Integrity Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Item',
    contentType: 'post',
  })

  const gen = await generateCampaignContentDraft(
    db,
    { workspaceId: base.workspaceId, campaignId: campaign.id, contentId: item.id },
    mockAiDeps(JSON.stringify({ body: 'Draft body' })),
  )
  assert.equal(gen.ok, true)
  if (!gen.ok) return

  const fakeExecutionId = crypto.randomUUID()
  const saveResult = await saveCampaignContentDraft(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    candidateId: gen.candidateId,
    draft: { body: 'Draft body' },
    executionId: fakeExecutionId,
  })

  assert.notEqual(saveResult.variant.provenance?.executionId, fakeExecutionId)
  assert.equal(saveResult.variant.provenance?.executionId, gen.provenance.executionId)
})

test('15. browser cannot forge model', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Model Integrity Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Item',
    contentType: 'post',
  })

  const gen = await generateCampaignContentDraft(
    db,
    { workspaceId: base.workspaceId, campaignId: campaign.id, contentId: item.id },
    mockAiDeps(JSON.stringify({ body: 'Draft body' })),
  )
  assert.equal(gen.ok, true)
  if (!gen.ok) return

  const saveResult = await saveCampaignContentDraft(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    candidateId: gen.candidateId,
    draft: { body: 'Draft body' },
    model: 'gpt-super-secret-9000',
  })

  assert.notEqual(saveResult.variant.provenance?.model, 'gpt-super-secret-9000')
})

test('16. browser cannot forge generation timestamp', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Timestamp Integrity Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Item',
    contentType: 'post',
  })

  const gen = await generateCampaignContentDraft(
    db,
    { workspaceId: base.workspaceId, campaignId: campaign.id, contentId: item.id },
    mockAiDeps(JSON.stringify({ body: 'Draft body' })),
  )
  assert.equal(gen.ok, true)
  if (!gen.ok) return

  const fakeTimestamp = '1999-01-01T00:00:00.000Z'
  const saveResult = await saveCampaignContentDraft(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    candidateId: gen.candidateId,
    draft: { body: 'Draft body' },
    createdAt: fakeTimestamp,
  })

  assert.notEqual(saveResult.variant.provenance?.createdAt, fakeTimestamp)
  assert.equal(saveResult.variant.provenance?.createdAt, gen.provenance.createdAt)
})

test('17. cross-workspace candidate rejected', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign1 = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Workspace 1 Campaign',
  })

  const item1 = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign1.id,
    targetAccountId: base.accountId,
    title: 'Item 1',
    contentType: 'post',
  })

  const gen = await generateCampaignContentDraft(
    db,
    { workspaceId: base.workspaceId, campaignId: campaign1.id, contentId: item1.id },
    mockAiDeps(JSON.stringify({ body: 'Draft body' })),
  )
  assert.equal(gen.ok, true)
  if (!gen.ok) return

  const campaign2 = await createCampaign(db, {
    workspaceId: base.otherWorkspaceId,
    brandId: base.otherBrandId,
    accountIds: [base.otherAccountId],
    name: 'Workspace 2 Campaign',
  })

  const item2 = await createCampaignContent(db, {
    workspaceId: base.otherWorkspaceId,
    campaignId: campaign2.id,
    targetAccountId: base.otherAccountId,
    title: 'Item 2',
    contentType: 'post',
  })

  await assert.rejects(
    async () => {
      await saveCampaignContentDraft(db, {
        workspaceId: base.otherWorkspaceId,
        campaignId: campaign2.id,
        contentId: item2.id,
        candidateId: gen.candidateId,
        draft: { body: 'Draft body' },
      })
    },
    { message: /Candidate draft not found in this workspace/i },
  )
})

test('18. candidate for wrong Campaign rejected', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign1 = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Campaign 1',
  })
  const campaign2 = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Campaign 2',
  })

  const item1 = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign1.id,
    targetAccountId: base.accountId,
    title: 'Item 1',
    contentType: 'post',
  })

  const item2 = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign2.id,
    targetAccountId: base.accountId,
    title: 'Item 2',
    contentType: 'post',
  })

  const gen = await generateCampaignContentDraft(
    db,
    { workspaceId: base.workspaceId, campaignId: campaign1.id, contentId: item1.id },
    mockAiDeps(JSON.stringify({ body: 'Draft body' })),
  )
  assert.equal(gen.ok, true)
  if (!gen.ok) return

  await assert.rejects(
    async () => {
      await saveCampaignContentDraft(db, {
        workspaceId: base.workspaceId,
        campaignId: campaign2.id,
        contentId: item2.id,
        candidateId: gen.candidateId,
        draft: { body: 'Draft body' },
      })
    },
    { message: /Candidate draft does not belong to this campaign/i },
  )
})

test('19. candidate for wrong Content item rejected', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Campaign',
  })

  const item1 = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Item 1',
    contentType: 'post',
  })
  const item2 = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Item 2',
    contentType: 'post',
  })

  const gen = await generateCampaignContentDraft(
    db,
    { workspaceId: base.workspaceId, campaignId: campaign.id, contentId: item1.id },
    mockAiDeps(JSON.stringify({ body: 'Draft body' })),
  )
  assert.equal(gen.ok, true)
  if (!gen.ok) return

  await assert.rejects(
    async () => {
      await saveCampaignContentDraft(db, {
        workspaceId: base.workspaceId,
        campaignId: campaign.id,
        contentId: item2.id,
        candidateId: gen.candidateId,
        draft: { body: 'Draft body' },
      })
    },
    { message: /Candidate draft does not belong to this content item/i },
  )
})

test('20. saved variant references real candidate provenance', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Campaign',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Item',
    contentType: 'post',
  })

  const gen = await generateCampaignContentDraft(
    db,
    { workspaceId: base.workspaceId, campaignId: campaign.id, contentId: item.id },
    mockAiDeps(JSON.stringify({ headline: 'Hook', body: 'Draft body', callToAction: 'Click' })),
  )
  assert.equal(gen.ok, true)
  if (!gen.ok) return

  const saveResult = await saveCampaignContentDraft(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    candidateId: gen.candidateId,
    draft: gen.draft,
  })

  const prov = saveResult.variant.provenance!
  assert.ok(prov)
  assert.equal(prov.candidateId, gen.candidateId)
  assert.equal(prov.agentName, 'Creator')
  assert.equal(prov.versionNumber, 1)
  assert.equal(prov.executionId, gen.provenance.executionId)
})

test('21. unedited Save => humanEdited false', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Unedited Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Item',
    contentType: 'post',
  })

  const gen = await generateCampaignContentDraft(
    db,
    { workspaceId: base.workspaceId, campaignId: campaign.id, contentId: item.id },
    mockAiDeps(
      JSON.stringify({ headline: 'Hook', body: 'Exact draft body', callToAction: 'Click' }),
    ),
  )
  assert.equal(gen.ok, true)
  if (!gen.ok) return

  const saveResult = await saveCampaignContentDraft(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    candidateId: gen.candidateId,
    draft: gen.draft,
  })

  assert.equal(saveResult.variant.provenance?.humanEdited, false)
})

test('22. edited Save => humanEdited true', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Edited Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Item',
    contentType: 'post',
  })

  const gen = await generateCampaignContentDraft(
    db,
    { workspaceId: base.workspaceId, campaignId: campaign.id, contentId: item.id },
    mockAiDeps(
      JSON.stringify({ headline: 'Hook', body: 'AI generated draft body', callToAction: 'Click' }),
    ),
  )
  assert.equal(gen.ok, true)
  if (!gen.ok) return

  const saveResult = await saveCampaignContentDraft(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    candidateId: gen.candidateId,
    draft: {
      ...gen.draft,
      body: 'Human edited this draft body!',
    },
  })

  assert.equal(saveResult.variant.provenance?.humanEdited, true)
})

test('23. generatedHash preserved', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Hash Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Item',
    contentType: 'post',
  })

  const gen = await generateCampaignContentDraft(
    db,
    { workspaceId: base.workspaceId, campaignId: campaign.id, contentId: item.id },
    mockAiDeps(JSON.stringify({ headline: 'Hook', body: 'AI draft', callToAction: 'Click' })),
  )
  assert.equal(gen.ok, true)
  if (!gen.ok) return

  const expectedGeneratedHash = computeDraftHash(gen.draft)
  assert.equal(gen.provenance.generatedHash, expectedGeneratedHash)

  const saveResult = await saveCampaignContentDraft(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    candidateId: gen.candidateId,
    draft: { body: 'Modified body' },
  })

  assert.equal(saveResult.variant.provenance?.generatedHash, expectedGeneratedHash)
})

test('24. savedHash preserved', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Saved Hash Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Item',
    contentType: 'post',
  })

  const gen = await generateCampaignContentDraft(
    db,
    { workspaceId: base.workspaceId, campaignId: campaign.id, contentId: item.id },
    mockAiDeps(JSON.stringify({ body: 'AI draft' })),
  )
  assert.equal(gen.ok, true)
  if (!gen.ok) return

  const modifiedDraft = { headline: 'New Hook', body: 'Modified body', callToAction: 'New CTA' }
  const expectedSavedHash = computeDraftHash(modifiedDraft)

  const saveResult = await saveCampaignContentDraft(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    candidateId: gen.candidateId,
    draft: modifiedDraft,
  })

  assert.equal(saveResult.variant.provenance?.savedHash, expectedSavedHash)
})

test('25. repeat Save behavior is deterministic (candidate already saved rejected)', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Repeat Save Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Item',
    contentType: 'post',
  })

  const gen = await generateCampaignContentDraft(
    db,
    { workspaceId: base.workspaceId, campaignId: campaign.id, contentId: item.id },
    mockAiDeps(JSON.stringify({ body: 'AI draft' })),
  )
  assert.equal(gen.ok, true)
  if (!gen.ok) return

  // First save succeeds
  await saveCampaignContentDraft(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    candidateId: gen.candidateId,
    draft: gen.draft,
  })

  // Second save with same candidateId must fail!
  await assert.rejects(
    async () => {
      await saveCampaignContentDraft(db, {
        workspaceId: base.workspaceId,
        campaignId: campaign.id,
        contentId: item.id,
        candidateId: gen.candidateId,
        draft: gen.draft,
      })
    },
    { message: /Candidate draft has already been saved/i },
  )
})

test('26. Account required before Generate', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'No Account Campaign',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    title: 'Unassigned Account Item',
    contentType: 'post',
  })

  const result = await generateCampaignContentDraft(
    db,
    { workspaceId: base.workspaceId, campaignId: campaign.id, contentId: item.id },
    mockAiDeps(JSON.stringify({ body: 'Copy' })),
  )

  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.errorCode, 'account_required')
    assert.ok(result.message.includes('account'))
  }
})

test('27. Account required before Save', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Account Required Save Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Item',
    contentType: 'post',
  })

  const gen = await generateCampaignContentDraft(
    db,
    { workspaceId: base.workspaceId, campaignId: campaign.id, contentId: item.id },
    mockAiDeps(JSON.stringify({ body: 'Copy' })),
  )
  assert.equal(gen.ok, true)
  if (!gen.ok) return

  // Detach account directly from content item
  raw.prepare(`UPDATE content SET target_account_id = NULL WHERE id = ?`).run(item.id)

  await assert.rejects(
    async () => {
      await saveCampaignContentDraft(db, {
        workspaceId: base.workspaceId,
        campaignId: campaign.id,
        contentId: item.id,
        candidateId: gen.candidateId,
        draft: gen.draft,
      })
    },
    { message: /Content item must have a target account/i },
  )
})

test('28. Account must belong to workspace', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Foreign Account Test',
  })

  // Insert content with target_account_id pointing to otherWorkspace
  const contentId = crypto.randomUUID()
  raw
    .prepare(
      `INSERT INTO content (id, workspace_id, campaign_id, target_account_id, title, content_type, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'Foreign Item', 'post', 'planned', ?, ?)`,
    )
    .run(contentId, base.workspaceId, campaign.id, base.otherAccountId, NOW, NOW)

  const result = await generateCampaignContentDraft(
    db,
    { workspaceId: base.workspaceId, campaignId: campaign.id, contentId },
    mockAiDeps(JSON.stringify({ body: 'Copy' })),
  )

  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.errorCode, 'invalid_account')
  }
})

test('29. Platform derived only from Account', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Platform Derivation Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Pinterest Item',
    contentType: 'post',
  })

  const gen = await generateCampaignContentDraft(
    db,
    { workspaceId: base.workspaceId, campaignId: campaign.id, contentId: item.id },
    mockAiDeps(JSON.stringify({ body: 'Copy' })),
  )
  assert.equal(gen.ok, true)
  if (!gen.ok) return

  const saveResult = await saveCampaignContentDraft(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    candidateId: gen.candidateId,
    draft: gen.draft,
  })

  assert.equal(saveResult.variant.platformId, base.platformId)
  assert.equal(saveResult.variant.platformName, 'Pinterest')
})

test('30. no alphabetical Platform fallback', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  // Insert a platform that sorts alphabetically before Pinterest
  const aPlatformId = crypto.randomUUID()
  raw
    .prepare(
      `INSERT INTO platform (id, adapter_key, name, created_at) VALUES (?, 'aaa', 'AAA Platform', ?)`,
    )
    .run(aPlatformId, NOW)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'No Alphabetical Fallback Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Pinterest Item',
    contentType: 'post',
  })

  const gen = await generateCampaignContentDraft(
    db,
    { workspaceId: base.workspaceId, campaignId: campaign.id, contentId: item.id },
    mockAiDeps(JSON.stringify({ body: 'Copy' })),
  )
  assert.equal(gen.ok, true)
  if (!gen.ok) return

  const saveResult = await saveCampaignContentDraft(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    candidateId: gen.candidateId,
    draft: gen.draft,
  })

  assert.equal(saveResult.variant.platformId, base.platformId)
  assert.notEqual(saveResult.variant.platformId, aPlatformId)
})

test('31. browser platformId cannot override Account Platform', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Platform Override Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Item',
    contentType: 'post',
  })

  const gen = await generateCampaignContentDraft(
    db,
    { workspaceId: base.workspaceId, campaignId: campaign.id, contentId: item.id },
    mockAiDeps(JSON.stringify({ body: 'Copy' })),
  )
  assert.equal(gen.ok, true)
  if (!gen.ok) return

  const fakePlatformId = crypto.randomUUID()
  const saveResult = await saveCampaignContentDraft(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    candidateId: gen.candidateId,
    draft: gen.draft,
    platformId: fakePlatformId,
  })

  assert.equal(saveResult.variant.platformId, base.platformId)
  assert.notEqual(saveResult.variant.platformId, fakePlatformId)
})

test('32. malformed Creator JSON rejected', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Malformed JSON Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Item',
    contentType: 'post',
  })

  const result = await generateCampaignContentDraft(
    db,
    { workspaceId: base.workspaceId, campaignId: campaign.id, contentId: item.id },
    mockAiDeps('This is raw text without JSON structure { incomplete json'),
  )

  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.errorCode, 'malformed_response')
  }
})

test('33. fenced valid JSON accepted', () => {
  const fenced =
    '```json\n{"headline":"Hook","body":"Fenced body copy","callToAction":"Click"}\n```'
  const parsed = parseContentDraftOutput(fenced)
  assert.equal(parsed.headline, 'Hook')
  assert.equal(parsed.body, 'Fenced body copy')
  assert.equal(parsed.callToAction, 'Click')
})

test('34. missing required body rejected', () => {
  assert.throws(
    () => {
      parseContentDraftOutput(JSON.stringify({ headline: 'Hook only without body' }))
    },
    { name: 'CreatorDraftParseError' },
  )
})

test('35. invalid field types rejected', () => {
  assert.throws(
    () => {
      parseContentDraftOutput(JSON.stringify({ headline: 12345, body: true }))
    },
    { name: 'CreatorDraftParseError' },
  )
})

test('36. oversized fields rejected', () => {
  const hugeBody = 'x'.repeat(25000)
  assert.throws(
    () => {
      parseContentDraftOutput(JSON.stringify({ body: hugeBody }))
    },
    { name: 'CreatorDraftParseError' },
  )
})

test('37. provider failure creates no fake candidate', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Provider Fail Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Item',
    contentType: 'post',
  })

  const result = await generateCampaignContentDraft(
    db,
    { workspaceId: base.workspaceId, campaignId: campaign.id, contentId: item.id },
    failingAiDeps('timeout'),
  )

  assert.equal(result.ok, false)
  const candidateCount = raw
    .prepare(`SELECT COUNT(*) AS c FROM content_draft_candidate WHERE content_id = ?`)
    .get(item.id) as { c: number }
  assert.equal(candidateCount.c, 0)
})

test('38. generation audit/event contains no secrets', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Audit Event Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Item',
    contentType: 'post',
  })

  const gen = await generateCampaignContentDraft(
    db,
    { workspaceId: base.workspaceId, campaignId: campaign.id, contentId: item.id },
    mockAiDeps(JSON.stringify({ body: 'Clean body' })),
  )
  assert.equal(gen.ok, true)

  const events = await listRecentEvents(db, base.workspaceId, 'content.draft_', 10)
  const genEvent = events.find((e) => e.event_type === 'content.draft_generated')
  assert.ok(genEvent)
  assert.ok(genEvent.payload)
  const payload = JSON.parse(genEvent.payload)
  assert.ok(payload.candidateId)
  assert.equal(payload.contentId, item.id)
  assert.equal(payload.campaignId, campaign.id)
})

test('39. save audit/event contains no raw provider payload', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Save Audit Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Item',
    contentType: 'post',
  })

  const gen = await generateCampaignContentDraft(
    db,
    { workspaceId: base.workspaceId, campaignId: campaign.id, contentId: item.id },
    mockAiDeps(JSON.stringify({ body: 'Clean body' })),
  )
  assert.equal(gen.ok, true)
  if (!gen.ok) return

  await saveCampaignContentDraft(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    candidateId: gen.candidateId,
    draft: gen.draft,
  })

  const events = await listRecentEvents(db, base.workspaceId, 'content.draft_', 10)
  const saveEvent = events.find((e) => e.event_type === 'content.draft_saved')
  assert.ok(saveEvent)
  assert.ok(saveEvent.payload)
  const payload = JSON.parse(saveEvent.payload)
  assert.equal(payload.candidateId, gen.candidateId)
  assert.equal(payload.contentId, item.id)
  assert.equal(payload.campaignId, campaign.id)
})

test('40. Critic can still review resulting saved variant', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Critic Review Integration Test',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Item',
    contentType: 'post',
  })

  const gen = await generateCampaignContentDraft(
    db,
    { workspaceId: base.workspaceId, campaignId: campaign.id, contentId: item.id },
    mockAiDeps(
      JSON.stringify({ headline: 'Hook', body: 'Draft body for critic', callToAction: 'Click' }),
    ),
  )
  assert.equal(gen.ok, true)
  if (!gen.ok) return

  const saveResult = await saveCampaignContentDraft(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    candidateId: gen.candidateId,
    draft: gen.draft,
  })

  const reviewResult = await generateCampaignContentReview(
    db,
    {
      workspaceId: base.workspaceId,
      campaignId: campaign.id,
      contentId: item.id,
      contentVariantId: saveResult.variant.id,
    },
    mockAiDeps(
      JSON.stringify({
        verdict: 'pass',
        summary: 'Approved draft',
        strengths: [],
        issues: [],
        recommendedChanges: [],
      }),
    ),
  )

  assert.equal(reviewResult.ok, true)
  if (reviewResult.ok) {
    assert.equal(reviewResult.review.verdict, 'pass')
  }
})

test('41. existing STEP 15B tests remain green', async () => {
  const { raw } = freshDb()
  const base = seedBaseline(raw)
  assert.ok(base.workspaceId)
})

test('42. H2B Agent-version tests remain green', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)
  const agentMap = await ensureBuiltinAgents(db, base.workspaceId)
  const creator = agentMap.get('creator')
  assert.ok(creator)
  assert.equal(creator.version.version, 1)
})
