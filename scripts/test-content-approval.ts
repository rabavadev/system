/**
 * STEP 15D: Human Final Approval & Publish Readiness Test Suite
 *
 * Verifies:
 * 1. Saved variant can be human-approved
 * 2. Unsaved candidate cannot be approved
 * 3. Exact variant ID required
 * 4. Cross-workspace variant rejected
 * 5. Wrong content/variant relationship rejected
 * 6. Browser cannot forge approvedBy
 * 7. Browser cannot forge approvedAt
 * 8. Browser cannot force published state
 * 9. Approval record server-generated
 * 10. Approval tied to exact variant
 * 11. Source variant unchanged (byte-for-byte immutable)
 * 12. Approval does not mutate content text
 * 13. Approval creates no external Tool call
 * 14. Approval creates no Publisher execution
 * 15. Approval creates no STEP 11 approval_request
 * 16. Critic pass does not auto-approve
 * 17. Critic revise does not auto-block human approval permanently
 * 18. Approve-after-revise explicit override preserved
 * 19. Variant with no Critic review can still be human-approved
 * 20. Human-edited variant can be approved
 * 21. STEP 15C revision variant can be approved
 * 22. Approval of V2 does not approve V1
 * 23. Approval of V2 does not automatically approve later V3
 * 24. New variant requires explicit approval
 * 25. Duplicate approval retry does not create duplicate active records (idempotency)
 * 26. Readiness points to exact approved variant
 * 27. Revoke/unready preserves historical approval
 * 28. Re-approval after revoke creates truthful history
 * 29. Approval events contain safe metadata only
 * 30. No secrets logged
 * 31. UI receives simple readiness state
 * 32. Workers AI not required
 * 33. No publishing test (post table empty, no external write, no publisher agent)
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import { ensureBuiltinAgents } from '../src/server/agents/registry.ts'
import type { ExecuteAIDeps } from '../src/server/ai/executor.ts'
import type { AIProviderAdapter } from '../src/server/ai/types.ts'
import { createCampaign } from '../src/server/db/campaign.ts'
import { createCampaignContent, getCampaignContentDetail } from '../src/server/db/content.ts'
import {
  approveCampaignContentVariant,
  getApprovedPublicationVariant,
  getLatestContentApproval,
  listContentApprovals,
  revokeCampaignContentApproval,
} from '../src/server/db/content-approval.ts'
import {
  generateCampaignContentReview,
  saveCampaignContentReview,
} from '../src/server/db/content-review.ts'
import {
  generateCampaignContentDraft,
  generateCampaignContentRevision,
  getLatestContentVariant,
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

function mockAiDeps(responseContent: string, providerKey = 'mock-provider'): ExecuteAIDeps {
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
    modelOverrides: { provider: providerKey },
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
       VALUES (?, ?, 'CloudSecure', 'Zero-trust cloud security', ?, ?)`,
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
      `INSERT INTO platform (id, adapter_key, name, created_at) VALUES (?, 'linkedin', 'LinkedIn', ?)`,
    )
    .run(platformId, NOW)
  raw
    .prepare(
      `INSERT INTO platform (id, adapter_key, name, created_at) VALUES (?, 'x', 'X / Twitter', ?)`,
    )
    .run(otherPlatformId, NOW)

  raw
    .prepare(
      `INSERT INTO account (id, workspace_id, platform_id, handle, display_name, status, created_at, updated_at)
       VALUES (?, ?, ?, 'cloudsecure_app', 'CloudSecure Official', 'active', ?, ?)`,
    )
    .run(accountId, workspaceId, platformId, NOW, NOW)
  raw
    .prepare(
      `INSERT INTO account (id, workspace_id, platform_id, handle, display_name, status, created_at, updated_at)
       VALUES (?, ?, ?, 'competitor_app', 'Competitor Official', 'active', ?, ?)`,
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

async function setupContentWithVariant(db: SqlDatabase, seed: ReturnType<typeof seedBaseline>) {
  await ensureBuiltinAgents(db, seed.workspaceId)

  const campaign = await createCampaign(db, {
    workspaceId: seed.workspaceId,
    name: 'Q3 Enterprise Push',
    brandId: seed.brandId,
    accountIds: [seed.accountId],
  })

  const contentItem = await createCampaignContent(db, {
    workspaceId: seed.workspaceId,
    campaignId: campaign.id,
    targetAccountId: seed.accountId,
    title: 'Zero Trust Architecture Guide',
    contentType: 'post',
    purpose: 'education',
    brief: 'Explain key principles of zero trust for cloud native teams.',
  })

  const creatorMockJson = JSON.stringify({
    headline: 'Stop Assuming Trust in Your Cloud Architecture',
    body: 'Legacy perimeters are dead. Zero Trust verifies every transaction continuously.',
    callToAction: 'Read the full guide linked in bio.',
    creativeDirection: 'Dark modern architecture diagram.',
    notes: '#ZeroTrust #CloudSecurity',
  })

  const draftResult = await generateCampaignContentDraft(
    db,
    {
      workspaceId: seed.workspaceId,
      campaignId: campaign.id,
      contentId: contentItem.id,
    },
    mockAiDeps(creatorMockJson),
  )

  assert.equal(draftResult.ok, true)
  if (!draftResult.ok) throw new Error('draft generation failed')

  const saveResult = await saveCampaignContentDraft(db, {
    workspaceId: seed.workspaceId,
    campaignId: campaign.id,
    contentId: contentItem.id,
    candidateId: draftResult.candidateId,
    draft: {
      headline: draftResult.draft.headline,
      body: draftResult.draft.body,
      callToAction: draftResult.draft.callToAction,
      creativeDirection: draftResult.draft.creativeDirection,
      notes: draftResult.draft.notes,
    },
  })

  return {
    campaign,
    contentItem,
    candidateId: draftResult.candidateId,
    variant: saveResult.variant,
  }
}

test('1. saved variant can be human-approved and marks content ready', async () => {
  const { db, raw } = freshDb()
  const seed = seedBaseline(raw)
  const { campaign, contentItem, variant } = await setupContentWithVariant(db, seed)
  const currentContent = await getCampaignContentDetail(db, seed.workspaceId, contentItem.id)
  assert.equal(currentContent?.status, 'draft')
  assert.equal(currentContent?.selectedVariantId, null)

  const result = await approveCampaignContentVariant(db, {
    workspaceId: seed.workspaceId,
    campaignId: campaign.id,
    contentId: contentItem.id,
    contentVariantId: variant.id,
    note: 'Editorial signoff complete',
  })

  assert.equal(result.approval.status, 'approved')
  assert.equal(result.approval.contentVariantId, variant.id)
  assert.equal(result.approval.criticOverride, false)
  assert.equal(result.approval.note, 'Editorial signoff complete')
  assert.equal(result.contentItem.status, 'ready')
  assert.equal(result.contentItem.selectedVariantId, variant.id)

  const reloaded = await getCampaignContentDetail(db, seed.workspaceId, contentItem.id)
  assert.equal(reloaded?.status, 'ready')
  assert.equal(reloaded?.selectedVariantId, variant.id)
})

test('2. unsaved candidate cannot be approved', async () => {
  const { db, raw } = freshDb()
  const seed = seedBaseline(raw)
  const { campaign, contentItem, candidateId } = await setupContentWithVariant(db, seed)

  await assert.rejects(
    () =>
      approveCampaignContentVariant(db, {
        workspaceId: seed.workspaceId,
        campaignId: campaign.id,
        contentId: contentItem.id,
        contentVariantId: candidateId, // Candidate ID, not a saved variant ID
      }),
    /Saved content variant not found/,
  )
})

test('3. exact variant ID required', async () => {
  const { db, raw } = freshDb()
  const seed = seedBaseline(raw)
  const { campaign, contentItem } = await setupContentWithVariant(db, seed)

  await assert.rejects(
    () =>
      approveCampaignContentVariant(db, {
        workspaceId: seed.workspaceId,
        campaignId: campaign.id,
        contentId: contentItem.id,
        contentVariantId: crypto.randomUUID(), // Non-existent variant ID
      }),
    /Saved content variant not found/,
  )
})

test('4. cross-workspace variant rejected', async () => {
  const { db, raw } = freshDb()
  const seed = seedBaseline(raw)
  const { campaign, contentItem, variant } = await setupContentWithVariant(db, seed)

  // Try approving variant in other workspace
  await assert.rejects(
    () =>
      approveCampaignContentVariant(db, {
        workspaceId: seed.otherWorkspaceId,
        campaignId: campaign.id,
        contentId: contentItem.id,
        contentVariantId: variant.id,
      }),
    /Campaign not found in this workspace/,
  )
})

test('5. wrong content/variant relationship rejected', async () => {
  const { db, raw } = freshDb()
  const seed = seedBaseline(raw)
  const { campaign, variant } = await setupContentWithVariant(db, seed)

  // Create a second content item in the same campaign
  const contentItem2 = await createCampaignContent(db, {
    workspaceId: seed.workspaceId,
    campaignId: campaign.id,
    targetAccountId: seed.accountId,
    title: 'Second content item',
    contentType: 'post',
  })

  // Try approving variant belonging to content item 1 under content item 2
  await assert.rejects(
    () =>
      approveCampaignContentVariant(db, {
        workspaceId: seed.workspaceId,
        campaignId: campaign.id,
        contentId: contentItem2.id,
        contentVariantId: variant.id,
      }),
    /Saved content variant not found or belongs to another content item/,
  )
})

test('6-8. server authoritatively manages actor, timestamp, and prevents published status forgery', async () => {
  const { db, raw } = freshDb()
  const seed = seedBaseline(raw)
  const { campaign, contentItem, variant } = await setupContentWithVariant(db, seed)

  const result = await approveCampaignContentVariant(
    db,
    {
      workspaceId: seed.workspaceId,
      campaignId: campaign.id,
      contentId: contentItem.id,
      contentVariantId: variant.id,
      // Attempting client forgery of fields not in schema or ignored:
      approvedBy: 'fake-admin-id',
      status: 'published',
    },
    '2026-08-20T12:00:00.000Z',
  )

  assert.equal(result.approval.actorType, 'user')
  assert.equal(result.approval.actorId, null) // Server-authoritative
  assert.equal(result.approval.createdAt, '2026-08-20T12:00:00.000Z')
  assert.equal(result.contentItem.status, 'ready') // NEVER published
  assert.notEqual(result.contentItem.status, 'published')
})

test('9-10. approval record server-generated and tied to exact variant', async () => {
  const { db, raw } = freshDb()
  const seed = seedBaseline(raw)
  const { campaign, contentItem, variant } = await setupContentWithVariant(db, seed)

  const result = await approveCampaignContentVariant(db, {
    workspaceId: seed.workspaceId,
    campaignId: campaign.id,
    contentId: contentItem.id,
    contentVariantId: variant.id,
  })

  assert.ok(result.approval.id)
  assert.equal(result.approval.contentVariantId, variant.id)
  assert.equal(result.approval.contentId, contentItem.id)
  assert.equal(result.approval.campaignId, campaign.id)
  assert.equal(result.approval.workspaceId, seed.workspaceId)
})

test('11-12. source variant and parent content text are unchanged (byte-for-byte immutable)', async () => {
  const { db, raw } = freshDb()
  const seed = seedBaseline(raw)
  const { campaign, contentItem, variant } = await setupContentWithVariant(db, seed)

  const variantBefore = raw
    .prepare(`SELECT * FROM content_variant WHERE id = ?`)
    .get(variant.id) as {
    body: string
    metadata: string
    created_at: string
    updated_at: string
  }
  const contentBefore = raw.prepare(`SELECT * FROM content WHERE id = ?`).get(contentItem.id) as {
    title: string
    brief: string
    body: string
  }

  await approveCampaignContentVariant(db, {
    workspaceId: seed.workspaceId,
    campaignId: campaign.id,
    contentId: contentItem.id,
    contentVariantId: variant.id,
  })

  const variantAfter = raw
    .prepare(`SELECT * FROM content_variant WHERE id = ?`)
    .get(variant.id) as {
    body: string
    metadata: string
    created_at: string
    updated_at: string
  }
  const contentAfter = raw.prepare(`SELECT * FROM content WHERE id = ?`).get(contentItem.id) as {
    title: string
    brief: string
    body: string
  }

  // Variant row is byte-for-byte identical
  assert.equal(variantAfter.body, variantBefore.body)
  assert.equal(variantAfter.metadata, variantBefore.metadata)
  assert.equal(variantAfter.created_at, variantBefore.created_at)

  // Content text fields are unchanged
  assert.equal(contentAfter.title, contentBefore.title)
  assert.equal(contentAfter.brief, contentBefore.brief)
  assert.equal(contentAfter.body, contentBefore.body)
})

test('13-15. approval creates no external Tool calls, Publisher execution, or STEP 11 approval_request', async () => {
  const { db, raw } = freshDb()
  const seed = seedBaseline(raw)
  const { campaign, contentItem, variant } = await setupContentWithVariant(db, seed)

  await approveCampaignContentVariant(db, {
    workspaceId: seed.workspaceId,
    campaignId: campaign.id,
    contentId: contentItem.id,
    contentVariantId: variant.id,
  })

  // STEP 11 approval_request table check
  const step11Approvals = raw.prepare(`SELECT COUNT(*) as count FROM approval`).get() as {
    count: number
  }
  assert.equal(step11Approvals.count, 0, 'No STEP 11 approval rows created')

  // Workflow run / publisher check
  const workflowRuns = raw.prepare(`SELECT COUNT(*) as count FROM workflow_run`).get() as {
    count: number
  }
  assert.equal(workflowRuns.count, 0, 'No workflow runs created')

  // Post table check
  const posts = raw.prepare(`SELECT COUNT(*) as count FROM post`).get() as { count: number }
  assert.equal(posts.count, 0, 'No posts created')
})

test('16. Critic pass does not auto-approve content', async () => {
  const { db, raw } = freshDb()
  const seed = seedBaseline(raw)
  const { campaign, contentItem, variant } = await setupContentWithVariant(db, seed)

  // Critic reviews variant with pass verdict
  const criticPassJson = JSON.stringify({
    verdict: 'pass',
    summary: 'Strong hook, clear value proposition, ready for audience.',
    strengths: ['Compelling hook', 'Clear architecture premise'],
    issues: [],
    recommendedChanges: [],
  })

  const reviewResult = await generateCampaignContentReview(
    db,
    {
      workspaceId: seed.workspaceId,
      campaignId: campaign.id,
      contentId: contentItem.id,
      contentVariantId: variant.id,
    },
    mockAiDeps(criticPassJson),
  )
  assert.equal(reviewResult.ok, true)
  if (!reviewResult.ok) throw new Error('review failed')

  await saveCampaignContentReview(db, {
    workspaceId: seed.workspaceId,
    campaignId: campaign.id,
    contentId: contentItem.id,
    contentVariantId: variant.id,
    candidateId: reviewResult.candidateId,
  })

  // Verify parent content is still draft and NOT approved
  const contentReloaded = await getCampaignContentDetail(db, seed.workspaceId, contentItem.id)
  assert.equal(contentReloaded?.status, 'draft', 'Content must remain draft after Critic pass')
  assert.equal(contentReloaded?.selectedVariantId, null, 'No variant selected automatically')

  const approvals = await listContentApprovals(db, seed.workspaceId, contentItem.id)
  assert.equal(approvals.length, 0, 'No approval record created automatically')
})

test('17-18. Critic revise does not permanently block human approval and records override', async () => {
  const { db, raw } = freshDb()
  const seed = seedBaseline(raw)
  const { campaign, contentItem, variant } = await setupContentWithVariant(db, seed)

  // Critic reviews variant with revise verdict
  const criticReviseJson = JSON.stringify({
    verdict: 'revise',
    summary: 'CTA could be more specific regarding cloud providers.',
    strengths: ['Great technical angle'],
    issues: [
      { category: 'call_to_action', severity: 'medium', message: 'Specify AWS/GCP context' },
    ],
    recommendedChanges: ['Add AWS reference in CTA'],
  })

  const reviewResult = await generateCampaignContentReview(
    db,
    {
      workspaceId: seed.workspaceId,
      campaignId: campaign.id,
      contentId: contentItem.id,
      contentVariantId: variant.id,
    },
    mockAiDeps(criticReviseJson),
  )
  assert.equal(reviewResult.ok, true)
  if (!reviewResult.ok) throw new Error('review failed')

  await saveCampaignContentReview(db, {
    workspaceId: seed.workspaceId,
    campaignId: campaign.id,
    contentId: contentItem.id,
    contentVariantId: variant.id,
    candidateId: reviewResult.candidateId,
  })

  // Human explicitly approves despite revise verdict
  const approveResult = await approveCampaignContentVariant(db, {
    workspaceId: seed.workspaceId,
    campaignId: campaign.id,
    contentId: contentItem.id,
    contentVariantId: variant.id,
    overrideCritic: true,
    note: 'Approved for initial awareness stage; platform specificity not needed here.',
  })

  assert.equal(approveResult.approval.status, 'approved')
  assert.equal(approveResult.approval.criticOverride, true)
  assert.equal(approveResult.approval.criticVerdict, 'revise')
  assert.equal(approveResult.contentItem.status, 'ready')
  assert.equal(approveResult.contentItem.selectedVariantId, variant.id)
})

test('19. variant with no Critic review can be human-approved', async () => {
  const { db, raw } = freshDb()
  const seed = seedBaseline(raw)
  const { campaign, contentItem, variant } = await setupContentWithVariant(db, seed)

  const result = await approveCampaignContentVariant(db, {
    workspaceId: seed.workspaceId,
    campaignId: campaign.id,
    contentId: contentItem.id,
    contentVariantId: variant.id,
  })

  assert.equal(result.approval.status, 'approved')
  assert.equal(result.approval.criticOverride, false)
  assert.equal(result.contentItem.status, 'ready')
})

test('20. human-edited variant can be approved', async () => {
  const { db, raw } = freshDb()
  const seed = seedBaseline(raw)
  await ensureBuiltinAgents(db, seed.workspaceId)

  const campaign = await createCampaign(db, {
    workspaceId: seed.workspaceId,
    name: 'Campaign 1',
    brandId: seed.brandId,
    accountIds: [seed.accountId],
  })

  const contentItem = await createCampaignContent(db, {
    workspaceId: seed.workspaceId,
    campaignId: campaign.id,
    targetAccountId: seed.accountId,
    title: 'Content A',
    contentType: 'post',
  })

  const draftResult = await generateCampaignContentDraft(
    db,
    {
      workspaceId: seed.workspaceId,
      campaignId: campaign.id,
      contentId: contentItem.id,
    },
    mockAiDeps(
      JSON.stringify({
        headline: 'Original Hook',
        body: 'Original AI body copy.',
      }),
    ),
  )
  assert.equal(draftResult.ok, true)
  if (!draftResult.ok) throw new Error('draft failed')

  // User edits body before saving
  const saveResult = await saveCampaignContentDraft(db, {
    workspaceId: seed.workspaceId,
    campaignId: campaign.id,
    contentId: contentItem.id,
    candidateId: draftResult.candidateId,
    draft: {
      headline: 'Human Polished Hook',
      body: 'Human edited body copy with customized style.',
    },
  })

  assert.equal(saveResult.variant.provenance?.humanEdited, true)

  const approveResult = await approveCampaignContentVariant(db, {
    workspaceId: seed.workspaceId,
    campaignId: campaign.id,
    contentId: contentItem.id,
    contentVariantId: saveResult.variant.id,
  })

  assert.equal(approveResult.approval.status, 'approved')
  assert.equal(approveResult.contentItem.selectedVariantId, saveResult.variant.id)
})

test('21-24. revision lineage: approval of V2 does not approve V1 and new V3 does not inherit approval', async () => {
  const { db, raw } = freshDb()
  const seed = seedBaseline(raw)
  const { campaign, contentItem, variant: variant1 } = await setupContentWithVariant(db, seed)

  // 1. Critic reviews V1 with revise
  const reviewResult = await generateCampaignContentReview(
    db,
    {
      workspaceId: seed.workspaceId,
      campaignId: campaign.id,
      contentId: contentItem.id,
      contentVariantId: variant1.id,
    },
    mockAiDeps(
      JSON.stringify({
        verdict: 'revise',
        summary: 'Improve clarity.',
        strengths: [],
        issues: [{ category: 'clarity', severity: 'medium', message: 'Unclear' }],
        recommendedChanges: ['Clarify'],
      }),
    ),
  )
  assert.equal(reviewResult.ok, true)
  if (!reviewResult.ok) throw new Error('review failed')

  const savedReview = await saveCampaignContentReview(db, {
    workspaceId: seed.workspaceId,
    campaignId: campaign.id,
    contentId: contentItem.id,
    contentVariantId: variant1.id,
    candidateId: reviewResult.candidateId,
  })

  // 2. Creator produces V2 revision
  const revisionResult = await generateCampaignContentRevision(
    db,
    {
      workspaceId: seed.workspaceId,
      campaignId: campaign.id,
      contentId: contentItem.id,
      sourceVariantId: variant1.id,
      sourceReviewId: savedReview.id,
    },
    mockAiDeps(
      JSON.stringify({
        headline: 'V2 Revised Headline',
        body: 'V2 revised body addressing Critic feedback.',
      }),
    ),
  )
  assert.equal(revisionResult.ok, true)
  if (!revisionResult.ok) throw new Error('revision failed')

  const savedVariant2 = await saveCampaignContentDraft(db, {
    workspaceId: seed.workspaceId,
    campaignId: campaign.id,
    contentId: contentItem.id,
    candidateId: revisionResult.candidateId,
    draft: {
      headline: revisionResult.draft.headline,
      body: revisionResult.draft.body,
    },
  })

  // 3. User approves V2
  const approveV2 = await approveCampaignContentVariant(db, {
    workspaceId: seed.workspaceId,
    campaignId: campaign.id,
    contentId: contentItem.id,
    contentVariantId: savedVariant2.variant.id,
  })

  assert.equal(approveV2.contentItem.selectedVariantId, savedVariant2.variant.id)

  // Verify V1 is NOT approved
  const v1Approvals = await listContentApprovals(db, seed.workspaceId, contentItem.id, variant1.id)
  assert.equal(v1Approvals.length, 0, 'V1 has no approval records')

  // 4. Later user creates and saves a new variant V3
  const v3DraftResult = await generateCampaignContentDraft(
    db,
    {
      workspaceId: seed.workspaceId,
      campaignId: campaign.id,
      contentId: contentItem.id,
    },
    mockAiDeps(
      JSON.stringify({
        headline: 'V3 Alternative Headline',
        body: 'V3 brand new experiment body.',
      }),
    ),
  )
  assert.equal(v3DraftResult.ok, true)
  if (!v3DraftResult.ok) throw new Error('v3 failed')

  const savedVariant3 = await saveCampaignContentDraft(db, {
    workspaceId: seed.workspaceId,
    campaignId: campaign.id,
    contentId: contentItem.id,
    candidateId: v3DraftResult.candidateId,
    draft: {
      headline: v3DraftResult.draft.headline,
      body: v3DraftResult.draft.body,
    },
  })

  // V3 must NOT inherit approval
  const v3Approvals = await listContentApprovals(
    db,
    seed.workspaceId,
    contentItem.id,
    savedVariant3.variant.id,
  )
  assert.equal(v3Approvals.length, 0, 'V3 does not inherit approval from V2')

  // Content still points to V2 as the approved candidate
  const contentCurrent = await getCampaignContentDetail(db, seed.workspaceId, contentItem.id)
  assert.equal(contentCurrent?.selectedVariantId, savedVariant2.variant.id)
  assert.equal(contentCurrent?.status, 'ready')

  // Listing variants correctly reflects approval on V2 only
  const variantList = await listContentVariants(db, seed.workspaceId, contentItem.id)
  const v1Detail = variantList.find((v) => v.id === variant1.id)
  const v2Detail = variantList.find((v) => v.id === savedVariant2.variant.id)
  const v3Detail = variantList.find((v) => v.id === savedVariant3.variant.id)

  assert.equal(v1Detail?.isApproved, false)
  assert.equal(v2Detail?.isApproved, true)
  assert.equal(v3Detail?.isApproved, false)
})

test('25. duplicate approval retry is idempotent', async () => {
  const { db, raw } = freshDb()
  const seed = seedBaseline(raw)
  const { campaign, contentItem, variant } = await setupContentWithVariant(db, seed)

  const first = await approveCampaignContentVariant(db, {
    workspaceId: seed.workspaceId,
    campaignId: campaign.id,
    contentId: contentItem.id,
    contentVariantId: variant.id,
  })

  const second = await approveCampaignContentVariant(db, {
    workspaceId: seed.workspaceId,
    campaignId: campaign.id,
    contentId: contentItem.id,
    contentVariantId: variant.id,
  })

  assert.equal(first.approval.id, second.approval.id)
  const count = raw.prepare(`SELECT COUNT(*) as count FROM content_approval`).get() as {
    count: number
  }
  assert.equal(count.count, 1, 'Only 1 approval record exists')
})

test('26. getApprovedPublicationVariant returns exact ready publication candidate', async () => {
  const { db, raw } = freshDb()
  const seed = seedBaseline(raw)
  const { campaign, contentItem, variant } = await setupContentWithVariant(db, seed)

  // Before approval: returns null
  const notReady = await getApprovedPublicationVariant(db, seed.workspaceId, contentItem.id)
  assert.equal(notReady, null)

  // Approve variant
  await approveCampaignContentVariant(db, {
    workspaceId: seed.workspaceId,
    campaignId: campaign.id,
    contentId: contentItem.id,
    contentVariantId: variant.id,
  })

  // After approval: returns structured publication candidate
  const ready = await getApprovedPublicationVariant(db, seed.workspaceId, contentItem.id)
  assert.ok(ready)
  assert.equal(ready.content.id, contentItem.id)
  assert.equal(ready.variant.id, variant.id)
  assert.equal(ready.approval.status, 'approved')
})

test('27-28. revoke / unready preserves history and re-approval creates truthful lineage', async () => {
  const { db, raw } = freshDb()
  const seed = seedBaseline(raw)
  const { campaign, contentItem, variant } = await setupContentWithVariant(db, seed)

  // 1. Approve
  await approveCampaignContentVariant(db, {
    workspaceId: seed.workspaceId,
    campaignId: campaign.id,
    contentId: contentItem.id,
    contentVariantId: variant.id,
  })

  // 2. Revoke
  const unreadyItem = await revokeCampaignContentApproval(db, {
    workspaceId: seed.workspaceId,
    campaignId: campaign.id,
    contentId: contentItem.id,
    note: 'Need to update statistics before publication',
  })

  assert.equal(unreadyItem.status, 'draft')
  assert.equal(unreadyItem.selectedVariantId, null)

  // Verify historical approval record is preserved + revocation record exists
  const history = await listContentApprovals(db, seed.workspaceId, contentItem.id)
  assert.equal(history.length, 2)
  assert.equal(history[0]?.status, 'revoked')
  assert.equal(history[1]?.status, 'approved')

  // 3. Re-approve
  const reApproved = await approveCampaignContentVariant(db, {
    workspaceId: seed.workspaceId,
    campaignId: campaign.id,
    contentId: contentItem.id,
    contentVariantId: variant.id,
    note: 'Statistics verified, approved again',
  })

  assert.equal(reApproved.contentItem.status, 'ready')
  assert.equal(reApproved.contentItem.selectedVariantId, variant.id)

  const updatedHistory = await listContentApprovals(db, seed.workspaceId, contentItem.id)
  assert.equal(updatedHistory.length, 3)
  assert.equal(updatedHistory[0]?.status, 'approved')
  assert.equal(updatedHistory[1]?.status, 'revoked')
  assert.equal(updatedHistory[2]?.status, 'approved')
})

test('29-30. approval and revoke events emit safe metadata only and log zero secrets', async () => {
  const { db, raw } = freshDb()
  const seed = seedBaseline(raw)
  const { campaign, contentItem, variant } = await setupContentWithVariant(db, seed)

  await approveCampaignContentVariant(db, {
    workspaceId: seed.workspaceId,
    campaignId: campaign.id,
    contentId: contentItem.id,
    contentVariantId: variant.id,
  })

  await revokeCampaignContentApproval(db, {
    workspaceId: seed.workspaceId,
    campaignId: campaign.id,
    contentId: contentItem.id,
  })

  const events = await listRecentEvents(db, seed.workspaceId, 'content.', 50)
  const approvedEvent = events.find((e) => e.event_type === 'content.variant_approved')
  const revokedEvent = events.find((e) => e.event_type === 'content.approval_revoked')

  assert.ok(approvedEvent)
  assert.ok(revokedEvent)

  const approvedPayload = JSON.parse(approvedEvent.payload ?? '{}')
  assert.equal(approvedPayload.campaignId, campaign.id)
  assert.equal(approvedPayload.contentId, contentItem.id)
  assert.equal(approvedPayload.variantId, variant.id)
  assert.equal(approvedPayload.body, undefined)
  assert.equal(approvedPayload.apiKey, undefined)

  const revokedPayload = JSON.parse(revokedEvent.payload ?? '{}')
  assert.equal(revokedPayload.contentId, contentItem.id)
  assert.equal(revokedPayload.variantId, variant.id)
  assert.equal(revokedPayload.body, undefined)
})

test('31-32. Workers AI is not required for approval or revocation', async () => {
  const { db, raw } = freshDb()
  const seed = seedBaseline(raw)
  const { campaign, contentItem, variant } = await setupContentWithVariant(db, seed)

  // Pass no AI deps, no agents running
  const approveResult = await approveCampaignContentVariant(db, {
    workspaceId: seed.workspaceId,
    campaignId: campaign.id,
    contentId: contentItem.id,
    contentVariantId: variant.id,
  })
  assert.equal(approveResult.approval.status, 'approved')

  const revokeResult = await revokeCampaignContentApproval(db, {
    workspaceId: seed.workspaceId,
    campaignId: campaign.id,
    contentId: contentItem.id,
  })
  assert.equal(revokeResult.status, 'draft')
})

test('33. No publishing test: post table is empty and no external platform write occurs', async () => {
  const { db, raw } = freshDb()
  const seed = seedBaseline(raw)
  const { campaign, contentItem, variant } = await setupContentWithVariant(db, seed)

  await approveCampaignContentVariant(db, {
    workspaceId: seed.workspaceId,
    campaignId: campaign.id,
    contentId: contentItem.id,
    contentVariantId: variant.id,
  })

  const postRows = raw.prepare(`SELECT * FROM post`).all()
  assert.equal(postRows.length, 0, 'No posts created in post table')

  const contentReloaded = await getCampaignContentDetail(db, seed.workspaceId, contentItem.id)
  assert.equal(contentReloaded?.status, 'ready')
  assert.notEqual(contentReloaded?.status, 'published')
})

test('34. revise + no override => rejected with zero side effects', async () => {
  const { db, raw } = freshDb()
  const seed = seedBaseline(raw)
  const { campaign, contentItem, variant } = await setupContentWithVariant(db, seed)

  const reviewGen = await generateCampaignContentReview(
    db,
    {
      workspaceId: seed.workspaceId,
      campaignId: campaign.id,
      contentId: contentItem.id,
      contentVariantId: variant.id,
    },
    mockAiDeps(JSON.stringify({ verdict: 'revise', summary: 'Need changes' })),
  )
  assert.equal(reviewGen.ok, true)
  if (!reviewGen.ok) throw new Error('review failed')

  await saveCampaignContentReview(db, {
    workspaceId: seed.workspaceId,
    campaignId: campaign.id,
    contentId: contentItem.id,
    contentVariantId: variant.id,
    candidateId: reviewGen.candidateId,
  })

  // Attempt approval without overrideCritic
  await assert.rejects(
    () =>
      approveCampaignContentVariant(db, {
        workspaceId: seed.workspaceId,
        campaignId: campaign.id,
        contentId: contentItem.id,
        contentVariantId: variant.id,
      }),
    /Explicit override \(overrideCritic: true\) is required to approve/,
  )

  // Verify zero side effects
  const content = await getCampaignContentDetail(db, seed.workspaceId, contentItem.id)
  assert.equal(content?.status, 'draft')
  assert.equal(content?.selectedVariantId, null)

  const approvals = await listContentApprovals(db, seed.workspaceId, contentItem.id)
  assert.equal(approvals.length, 0)
})

test('35. revise + overrideCritic=false => rejected', async () => {
  const { db, raw } = freshDb()
  const seed = seedBaseline(raw)
  const { campaign, contentItem, variant } = await setupContentWithVariant(db, seed)

  const reviewGen = await generateCampaignContentReview(
    db,
    {
      workspaceId: seed.workspaceId,
      campaignId: campaign.id,
      contentId: contentItem.id,
      contentVariantId: variant.id,
    },
    mockAiDeps(JSON.stringify({ verdict: 'revise', summary: 'Need changes' })),
  )
  assert.equal(reviewGen.ok, true)
  if (!reviewGen.ok) throw new Error('review failed')

  await saveCampaignContentReview(db, {
    workspaceId: seed.workspaceId,
    campaignId: campaign.id,
    contentId: contentItem.id,
    contentVariantId: variant.id,
    candidateId: reviewGen.candidateId,
  })

  await assert.rejects(
    () =>
      approveCampaignContentVariant(db, {
        workspaceId: seed.workspaceId,
        campaignId: campaign.id,
        contentId: contentItem.id,
        contentVariantId: variant.id,
        overrideCritic: false,
      }),
    /Explicit override \(overrideCritic: true\) is required to approve/,
  )
})

test('36. revise + note only (without overrideCritic=true) => rejected', async () => {
  const { db, raw } = freshDb()
  const seed = seedBaseline(raw)
  const { campaign, contentItem, variant } = await setupContentWithVariant(db, seed)

  const reviewGen = await generateCampaignContentReview(
    db,
    {
      workspaceId: seed.workspaceId,
      campaignId: campaign.id,
      contentId: contentItem.id,
      contentVariantId: variant.id,
    },
    mockAiDeps(JSON.stringify({ verdict: 'revise', summary: 'Need changes' })),
  )
  assert.equal(reviewGen.ok, true)
  if (!reviewGen.ok) throw new Error('review failed')

  await saveCampaignContentReview(db, {
    workspaceId: seed.workspaceId,
    campaignId: campaign.id,
    contentId: contentItem.id,
    contentVariantId: variant.id,
    candidateId: reviewGen.candidateId,
  })

  // Note provided without overrideCritic: true must be rejected
  await assert.rejects(
    () =>
      approveCampaignContentVariant(db, {
        workspaceId: seed.workspaceId,
        campaignId: campaign.id,
        contentId: contentItem.id,
        contentVariantId: variant.id,
        note: 'Documentation note explaining why, but without setting override flag',
      }),
    /Explicit override \(overrideCritic: true\) is required to approve/,
  )

  const content = await getCampaignContentDetail(db, seed.workspaceId, contentItem.id)
  assert.equal(content?.status, 'draft')
  assert.equal(content?.selectedVariantId, null)
})

test('37-38. revise + overrideCritic=true => accepted, critic_override=1 stored, and note preserved', async () => {
  const { db, raw } = freshDb()
  const seed = seedBaseline(raw)
  const { campaign, contentItem, variant } = await setupContentWithVariant(db, seed)

  const reviewGen = await generateCampaignContentReview(
    db,
    {
      workspaceId: seed.workspaceId,
      campaignId: campaign.id,
      contentId: contentItem.id,
      contentVariantId: variant.id,
    },
    mockAiDeps(JSON.stringify({ verdict: 'revise', summary: 'Need changes' })),
  )
  assert.equal(reviewGen.ok, true)
  if (!reviewGen.ok) throw new Error('review failed')

  await saveCampaignContentReview(db, {
    workspaceId: seed.workspaceId,
    campaignId: campaign.id,
    contentId: contentItem.id,
    contentVariantId: variant.id,
    candidateId: reviewGen.candidateId,
  })

  const result = await approveCampaignContentVariant(db, {
    workspaceId: seed.workspaceId,
    campaignId: campaign.id,
    contentId: contentItem.id,
    contentVariantId: variant.id,
    overrideCritic: true,
    note: 'Intentional executive override for urgent launch',
  })

  assert.equal(result.approval.status, 'approved')
  assert.equal(result.approval.criticOverride, true)
  assert.equal(result.approval.criticVerdict, 'revise')
  assert.equal(result.approval.note, 'Intentional executive override for urgent launch')
  assert.equal(result.contentItem.status, 'ready')
  assert.equal(result.contentItem.selectedVariantId, variant.id)
})
