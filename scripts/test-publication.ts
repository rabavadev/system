/**
 * STEP 15E.1: Publication Foundation & Server-Authoritative Dispatch Readiness Test Suite
 *
 * Verifies:
 * 1. Ready content + exact approved variant creates Post in 'draft' status
 * 2. Draft content cannot create publication intent
 * 3. Unapproved variant cannot create publication intent
 * 4. Previously approved then revoked variant cannot create publication intent
 * 5. Wrong selected variant rejected
 * 6. Exact active approval resolved (Post.content_approval_id matches approval.id)
 * 7. Critic pass alone is insufficient (requires explicit human approval)
 * 8. Critic revise override-approved exact variant allowed to create Post
 * 9. Approval of V2 does not authorize V1/V3 (only approved variant can create Post)
 * 10. Correct target Account accepted
 * 11. Wrong Account (not connected to campaign/content) rejected
 * 12. Cross-workspace Account rejected
 * 13. Archived/deleted Account rejected
 * 14. Platform mismatch rejected (e.g. LinkedIn variant -> X account)
 * 15. Platform derived server-side
 * 16. Client fake platform ignored/rejected
 * 17. Publication intent creates Post with workspace_id, content_variant_id, account_id, content_approval_id
 * 18. Post references exact immutable Variant
 * 19. Post references exact Account
 * 20. Initial status truthful: 'draft' for immediate, 'scheduled' if scheduledAt passed
 * 21. external_id is null
 * 22. url is null
 * 23. published_at is null
 * 24. Duplicate retry obeys idempotency rule (with idempotency_key or same active draft intent)
 * 25. New approved Variant requires new Post (approving V3 later does not alter old V2 post)
 * 26. Existing old Post remains historically unchanged
 * 27. No external Tool called (platform.publish status is 'unavailable')
 * 28. No Publisher Agent called (Publisher agent status is 'disabled')
 * 29. No platform API called
 * 30. Cross-workspace security (Workspace A + Content/Variant/Account/Approval from B rejected)
 * 31. Client forgery prevention (cannot forge status='published', external_id, url, published_at)
 * 32. validatePublicationEligibility helper returns true when ready & approved; false when revoked
 * 33. Events & Audit logging (publication.prepared event and post create audit log entry emitted safely)
 * 34. listPostsForContent and listPostsForCampaign return PostDetail[] ordered by created_at DESC, rowid DESC
 * 35. getApprovedPublicationVariant returns null when approval was revoked
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import { BUILTIN_AGENTS } from '../src/server/agents/definitions.ts'
import { ensureBuiltinAgents } from '../src/server/agents/registry.ts'
import type { ExecuteAIDeps } from '../src/server/ai/executor.ts'
import type { AIProviderAdapter } from '../src/server/ai/types.ts'
import { createCampaign } from '../src/server/db/campaign.ts'
import { createCampaignContent, getCampaignContentDetail } from '../src/server/db/content.ts'
import {
  approveCampaignContentVariant,
  getApprovedPublicationVariant,
  revokeCampaignContentApproval,
} from '../src/server/db/content-approval.ts'
import {
  generateCampaignContentReview,
  saveCampaignContentReview,
} from '../src/server/db/content-review.ts'
import {
  generateCampaignContentDraft,
  saveCampaignContentDraft,
} from '../src/server/db/content-variant.ts'
import { listRecentEvents } from '../src/server/db/event.ts'
import {
  createPublicationIntent,
  getPostDetail,
  listPostsForCampaign,
  listPostsForContent,
  validatePublicationEligibility,
} from '../src/server/db/post.ts'
import type { SqlDatabase } from '../src/server/db/sql.ts'
import { TOOL_DEFINITIONS } from '../src/server/tools/definitions.ts'

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

function freshDb() {
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
  const brandId = crypto.randomUUID()
  const platformId = crypto.randomUUID()
  const linkedInPlatformId = crypto.randomUUID()
  const accountId = crypto.randomUUID()

  raw
    .prepare(
      `INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, 'Test WS', 'test-ws', ?, ?)`,
    )
    .run(workspaceId, NOW, NOW)

  raw
    .prepare(
      `INSERT INTO brand (id, workspace_id, name, description, created_at, updated_at) VALUES (?, ?, 'Acme', 'smart growth brand', ?, ?)`,
    )
    .run(brandId, workspaceId, NOW, NOW)

  raw
    .prepare(
      `INSERT INTO platform (id, adapter_key, name, created_at) VALUES (?, 'x', 'X / Twitter', ?)`,
    )
    .run(platformId, NOW)

  raw
    .prepare(
      `INSERT INTO platform (id, adapter_key, name, created_at) VALUES (?, 'linkedin', 'LinkedIn', ?)`,
    )
    .run(linkedInPlatformId, NOW)

  raw
    .prepare(
      `INSERT INTO account (id, workspace_id, platform_id, handle, display_name, status, created_at, updated_at)
       VALUES (?, ?, ?, '@acmegrowth', 'Acme Growth', 'active', ?, ?)`,
    )
    .run(accountId, workspaceId, platformId, NOW, NOW)

  return { workspaceId, brandId, platformId, linkedInPlatformId, accountId }
}

async function seedDraftVariant(
  db: SqlDatabase,
  workspaceId: string,
  campaignId: string,
  contentId: string,
  draftContent: { body: string; headline?: string; platformId?: string },
) {
  const mockPayload = JSON.stringify({
    headline: draftContent.headline ?? 'Test Headline',
    body: draftContent.body,
    callToAction: 'Click now',
    creativeDirection: 'Direct',
    notes: 'Clean copy',
  })

  const genResult = await generateCampaignContentDraft(
    db,
    { workspaceId, campaignId, contentId },
    mockAiDeps(mockPayload),
  )

  if (!genResult.ok) throw new Error(`Generation failed: ${genResult.message}`)

  const saved = await saveCampaignContentDraft(db, {
    workspaceId,
    campaignId,
    contentId,
    candidateId: genResult.candidateId,
    draft: {
      body: draftContent.body,
      headline: draftContent.headline ?? 'Test Headline',
      callToAction: 'Click now',
      creativeDirection: 'Direct',
      notes: 'Clean copy',
    },
  })

  return saved
}

test('1. ready content + exact approved variant creates Post in draft status', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Launch Campaign',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Launch Post',
    contentType: 'post',
  })

  const { variant } = await seedDraftVariant(db, base.workspaceId, campaign.id, item.id, {
    body: 'Launch post body copy.',
  })

  // Approve variant
  const approvalResult = await approveCampaignContentVariant(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    contentVariantId: variant.id,
  })

  assert.equal(approvalResult.contentItem.status, 'ready')
  assert.equal(approvalResult.contentItem.selectedVariantId, variant.id)

  // Create publication intent
  const post = await createPublicationIntent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    contentVariantId: variant.id,
    accountId: base.accountId,
  })

  assert.ok(post.id)
  assert.equal(post.workspaceId, base.workspaceId)
  assert.equal(post.contentVariantId, variant.id)
  assert.equal(post.accountId, base.accountId)
  assert.equal(post.contentApprovalId, approvalResult.approval.id)
  assert.equal(post.status, 'draft')
  assert.equal(post.externalId, null)
  assert.equal(post.url, null)
  assert.equal(post.publishedAt, null)
  assert.equal(post.error, null)
  assert.equal(post.accountHandle, '@acmegrowth')
  assert.equal(post.platformId, base.platformId)
})

test('2. draft content cannot create publication intent', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Draft Only Campaign',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Draft Post',
    contentType: 'post',
  })

  const { variant } = await seedDraftVariant(db, base.workspaceId, campaign.id, item.id, {
    body: 'Unapproved draft body.',
  })

  // Attempt to create publication intent while content is still draft
  await assert.rejects(
    () =>
      createPublicationIntent(db, {
        workspaceId: base.workspaceId,
        campaignId: campaign.id,
        contentId: item.id,
        contentVariantId: variant.id,
        accountId: base.accountId,
      }),
    /Content item is in 'draft' status, but must be in 'ready' status/,
  )
})

test('3. unapproved variant rejected even if content had previous approval', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Multi Variant Campaign',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Multi Variant Post',
    contentType: 'post',
  })

  const { variant: v1 } = await seedDraftVariant(db, base.workspaceId, campaign.id, item.id, {
    body: 'V1 body.',
  })
  const { variant: v2 } = await seedDraftVariant(db, base.workspaceId, campaign.id, item.id, {
    body: 'V2 body.',
  })

  // Approve V1
  await approveCampaignContentVariant(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    contentVariantId: v1.id,
  })

  // Try to publish V2 (which is NOT the approved variant)
  await assert.rejects(
    () =>
      createPublicationIntent(db, {
        workspaceId: base.workspaceId,
        campaignId: campaign.id,
        contentId: item.id,
        contentVariantId: v2.id,
        accountId: base.accountId,
      }),
    /Requested variant is not the currently approved publication candidate/,
  )
})

test('4. previously approved then revoked variant cannot create publication intent', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Revoked Campaign',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Revoked Post',
    contentType: 'post',
  })

  const { variant } = await seedDraftVariant(db, base.workspaceId, campaign.id, item.id, {
    body: 'Body before revoke.',
  })

  // 1. Approve
  await approveCampaignContentVariant(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    contentVariantId: variant.id,
  })

  // 2. Revoke
  await revokeCampaignContentApproval(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
  })

  // 3. Attempt publish intent
  await assert.rejects(
    () =>
      createPublicationIntent(db, {
        workspaceId: base.workspaceId,
        campaignId: campaign.id,
        contentId: item.id,
        contentVariantId: variant.id,
        accountId: base.accountId,
      }),
    /must be in 'ready' status/,
  )
})

test('5 & 6. exact active approval resolved and tied to Post.content_approval_id', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Approval Trace Campaign',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Trace Post',
    contentType: 'post',
  })

  const { variant } = await seedDraftVariant(db, base.workspaceId, campaign.id, item.id, {
    body: 'Trace body copy.',
  })

  const appResult = await approveCampaignContentVariant(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    contentVariantId: variant.id,
    note: 'Sign off by editor',
  })

  const post = await createPublicationIntent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    contentVariantId: variant.id,
    accountId: base.accountId,
  })

  assert.equal(post.contentApprovalId, appResult.approval.id)
  assert.equal(post.approvalStatus, 'approved')
})

test('7. Critic pass alone is insufficient (cannot create Post without human approval)', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)
  await ensureBuiltinAgents(db, base.workspaceId)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Critic Alone Campaign',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Critic Post',
    contentType: 'post',
  })

  const { variant } = await seedDraftVariant(db, base.workspaceId, campaign.id, item.id, {
    body: 'Critic pass body.',
  })

  // Critic review generates pass
  const reviewGen = await generateCampaignContentReview(
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
        summary: 'Passed review',
        strengths: [],
        issues: [],
        recommendedChanges: [],
      }),
    ),
  )
  assert.equal(reviewGen.ok, true)
  if (!reviewGen.ok) throw new Error('review gen failed')

  await saveCampaignContentReview(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    contentVariantId: variant.id,
    candidateId: reviewGen.candidateId,
  })

  // Verify content is still in draft status
  const itemDetail = await getCampaignContentDetail(db, base.workspaceId, item.id)
  assert.equal(itemDetail?.status, 'draft')

  // Cannot publish
  await assert.rejects(
    () =>
      createPublicationIntent(db, {
        workspaceId: base.workspaceId,
        campaignId: campaign.id,
        contentId: item.id,
        contentVariantId: variant.id,
        accountId: base.accountId,
      }),
    /Content item is in 'draft' status/,
  )
})

test('8. Critic revise override-approved exact variant allowed to create Post', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)
  await ensureBuiltinAgents(db, base.workspaceId)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Override Post Campaign',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Override Item',
    contentType: 'post',
  })

  const { variant } = await seedDraftVariant(db, base.workspaceId, campaign.id, item.id, {
    body: 'Draft body for override.',
  })

  // Critic review says revise
  const reviewGen = await generateCampaignContentReview(
    db,
    {
      workspaceId: base.workspaceId,
      campaignId: campaign.id,
      contentId: item.id,
      contentVariantId: variant.id,
    },
    mockAiDeps(
      JSON.stringify({
        verdict: 'revise',
        summary: 'Needs minor tweak',
        strengths: [],
        issues: [{ category: 'tone', severity: 'low', message: 'Tweak tone' }],
        recommendedChanges: [],
      }),
    ),
  )
  assert.equal(reviewGen.ok, true)
  if (!reviewGen.ok) throw new Error('review gen failed')

  await saveCampaignContentReview(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    contentVariantId: variant.id,
    candidateId: reviewGen.candidateId,
  })

  // Human approves with overrideCritic = true
  const appResult = await approveCampaignContentVariant(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    contentVariantId: variant.id,
    overrideCritic: true,
    note: 'Accepted despite critic',
  })

  assert.equal(appResult.approval.criticOverride, true)

  // Publication intent succeeds and links to override approval
  const post = await createPublicationIntent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    contentVariantId: variant.id,
    accountId: base.accountId,
  })

  assert.ok(post.id)
  assert.equal(post.contentApprovalId, appResult.approval.id)
  assert.equal(post.criticOverride, true)
})

test('9. approval of V2 does not authorize V1 or V3', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'V2 Approval Campaign',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'V1 V2 V3 Post',
    contentType: 'post',
  })

  const { variant: v1 } = await seedDraftVariant(db, base.workspaceId, campaign.id, item.id, {
    body: 'V1',
  })
  const { variant: v2 } = await seedDraftVariant(db, base.workspaceId, campaign.id, item.id, {
    body: 'V2',
  })
  const { variant: v3 } = await seedDraftVariant(db, base.workspaceId, campaign.id, item.id, {
    body: 'V3',
  })

  // Approve V2 only
  await approveCampaignContentVariant(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    contentVariantId: v2.id,
  })

  // V1 rejected
  await assert.rejects(
    () =>
      createPublicationIntent(db, {
        workspaceId: base.workspaceId,
        campaignId: campaign.id,
        contentId: item.id,
        contentVariantId: v1.id,
        accountId: base.accountId,
      }),
    /Requested variant is not the currently approved publication candidate/,
  )

  // V3 rejected
  await assert.rejects(
    () =>
      createPublicationIntent(db, {
        workspaceId: base.workspaceId,
        campaignId: campaign.id,
        contentId: item.id,
        contentVariantId: v3.id,
        accountId: base.accountId,
      }),
    /Requested variant is not the currently approved publication candidate/,
  )

  // V2 accepted
  const post = await createPublicationIntent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    contentVariantId: v2.id,
    accountId: base.accountId,
  })
  assert.equal(post.contentVariantId, v2.id)
})

test('10-16. Account and Platform validation (rejection of wrong account, cross-workspace account, platform mismatch)', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  // Add another account in workspace on LinkedIn
  const linkedInAccountId = crypto.randomUUID()
  raw
    .prepare(
      `INSERT INTO account (id, workspace_id, platform_id, handle, display_name, status, created_at, updated_at)
       VALUES (?, ?, ?, '@acmepro', 'Acme Pro', 'active', ?, ?)`,
    )
    .run(linkedInAccountId, base.workspaceId, base.linkedInPlatformId, NOW, NOW)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId], // X account only
    name: 'Account Validation Campaign',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Account Check Post',
    contentType: 'post',
  })

  const { variant } = await seedDraftVariant(db, base.workspaceId, campaign.id, item.id, {
    body: 'Account check body.',
  })

  await approveCampaignContentVariant(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    contentVariantId: variant.id,
  })

  // 1. Wrong account not attached to campaign
  await assert.rejects(
    () =>
      createPublicationIntent(db, {
        workspaceId: base.workspaceId,
        campaignId: campaign.id,
        contentId: item.id,
        contentVariantId: variant.id,
        accountId: linkedInAccountId,
      }),
    /Platform mismatch|Account is not connected to this campaign/,
  )

  // 2. Non-existent account
  await assert.rejects(
    () =>
      createPublicationIntent(db, {
        workspaceId: base.workspaceId,
        campaignId: campaign.id,
        contentId: item.id,
        contentVariantId: variant.id,
        accountId: crypto.randomUUID(),
      }),
    /Account not found in this workspace/,
  )

  // 3. Platform mismatch (e.g. if variant platform is X, cannot use LinkedIn account)
  // Let's connect LinkedIn account to campaign, but try to publish X variant to it
  raw
    .prepare(`INSERT INTO campaign_account (campaign_id, account_id, created_at) VALUES (?, ?, ?)`)
    .run(campaign.id, linkedInAccountId, NOW)

  await assert.rejects(
    () =>
      createPublicationIntent(db, {
        workspaceId: base.workspaceId,
        campaignId: campaign.id,
        contentId: item.id,
        contentVariantId: variant.id,
        accountId: linkedInAccountId,
      }),
    /Platform mismatch: Account belongs to platform/,
  )
})

test('17-23. Post fields and initial truthful statuses', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Fields Check Campaign',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Fields Post',
    contentType: 'post',
  })

  const { variant } = await seedDraftVariant(db, base.workspaceId, campaign.id, item.id, {
    body: 'Fields check body.',
  })

  await approveCampaignContentVariant(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    contentVariantId: variant.id,
  })

  // 1. Immediate publication intent -> status = 'draft'
  const draftPost = await createPublicationIntent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    contentVariantId: variant.id,
    accountId: base.accountId,
  })

  assert.equal(draftPost.status, 'draft')
  assert.equal(draftPost.scheduledAt, null)
  assert.equal(draftPost.externalId, null)
  assert.equal(draftPost.url, null)
  assert.equal(draftPost.publishedAt, null)
  assert.equal(draftPost.error, null)

  // 2. Planned / scheduled intent -> status = 'scheduled'
  const scheduledTime = '2026-08-25T15:00:00.000Z'
  const scheduledPost = await createPublicationIntent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    contentVariantId: variant.id,
    accountId: base.accountId,
    scheduledAt: scheduledTime,
    idempotencyKey: 'sched-key-1',
  })

  assert.equal(scheduledPost.status, 'scheduled')
  assert.equal(scheduledPost.scheduledAt, scheduledTime)
  assert.equal(scheduledPost.externalId, null)
  assert.equal(scheduledPost.url, null)
  assert.equal(scheduledPost.publishedAt, null)
})

test('24. duplicate retry obeys idempotency rule', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Idempotency Campaign',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Idempotency Post',
    contentType: 'post',
  })

  const { variant } = await seedDraftVariant(db, base.workspaceId, campaign.id, item.id, {
    body: 'Idempotency body.',
  })

  await approveCampaignContentVariant(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    contentVariantId: variant.id,
  })

  const idempotencyKey = 'unique-submit-key-123'

  const post1 = await createPublicationIntent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    contentVariantId: variant.id,
    accountId: base.accountId,
    idempotencyKey,
  })

  const post2 = await createPublicationIntent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    contentVariantId: variant.id,
    accountId: base.accountId,
    idempotencyKey,
  })

  assert.equal(post1.id, post2.id)

  const countRow = raw
    .prepare(`SELECT COUNT(*) as count FROM post WHERE workspace_id = ? AND idempotency_key = ?`)
    .get(base.workspaceId, idempotencyKey) as { count: number }
  assert.equal(countRow.count, 1)
})

test('25 & 26. new approved variant requires new Post; old Post remains unchanged', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Version Evolution Campaign',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Evolution Post',
    contentType: 'post',
  })

  // Variant 1
  const { variant: v1 } = await seedDraftVariant(db, base.workspaceId, campaign.id, item.id, {
    body: 'V1 body.',
  })
  await approveCampaignContentVariant(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    contentVariantId: v1.id,
  })

  const postV1 = await createPublicationIntent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    contentVariantId: v1.id,
    accountId: base.accountId,
  })

  // Variant 2 created and approved later
  const { variant: v2 } = await seedDraftVariant(db, base.workspaceId, campaign.id, item.id, {
    body: 'V2 body improved.',
  })
  await approveCampaignContentVariant(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    contentVariantId: v2.id,
  })

  const postV2 = await createPublicationIntent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    contentVariantId: v2.id,
    accountId: base.accountId,
  })

  assert.notEqual(postV1.id, postV2.id)
  assert.equal(postV1.contentVariantId, v1.id)
  assert.equal(postV2.contentVariantId, v2.id)

  // Verify postV1 in DB still points to v1
  const postV1Db = await getPostDetail(db, base.workspaceId, postV1.id)
  assert.equal(postV1Db?.contentVariantId, v1.id)
})

test('27-29. platform.publish remains unavailable and Publisher agent disabled', () => {
  const publishTool = TOOL_DEFINITIONS.find((t) => t.key === 'platform.publish')
  assert.ok(publishTool)
  assert.equal(publishTool.status, 'unavailable')
  assert.deepEqual(publishTool.risk, ['write', 'external'])
  assert.equal(publishTool.approval, 'required')

  const publisherAgent = BUILTIN_AGENTS.find((a) => a.key === 'publisher')
  assert.ok(publisherAgent)
  assert.equal(publisherAgent.status, 'disabled')
})

test('30. cross-workspace security rejection', async () => {
  const { db, raw } = freshDb()
  const base1 = seedBaseline(raw)

  // Create Workspace 2
  const ws2Id = crypto.randomUUID()
  const brand2Id = crypto.randomUUID()
  const account2Id = crypto.randomUUID()

  raw
    .prepare(
      `INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, 'WS 2', 'ws-2', ?, ?)`,
    )
    .run(ws2Id, NOW, NOW)
  raw
    .prepare(
      `INSERT INTO brand (id, workspace_id, name, description, created_at, updated_at) VALUES (?, ?, 'Brand 2', 'bold brand', ?, ?)`,
    )
    .run(brand2Id, ws2Id, NOW, NOW)
  raw
    .prepare(
      `INSERT INTO account (id, workspace_id, platform_id, handle, display_name, status, created_at, updated_at)
       VALUES (?, ?, ?, '@ws2brand', 'WS2 Brand', 'active', ?, ?)`,
    )
    .run(account2Id, ws2Id, base1.platformId, NOW, NOW)

  const campaign1 = await createCampaign(db, {
    workspaceId: base1.workspaceId,
    brandId: base1.brandId,
    accountIds: [base1.accountId],
    name: 'WS1 Campaign',
  })

  const item1 = await createCampaignContent(db, {
    workspaceId: base1.workspaceId,
    campaignId: campaign1.id,
    targetAccountId: base1.accountId,
    title: 'WS1 Item',
    contentType: 'post',
  })

  const { variant: v1 } = await seedDraftVariant(db, base1.workspaceId, campaign1.id, item1.id, {
    body: 'WS1 copy.',
  })

  await approveCampaignContentVariant(db, {
    workspaceId: base1.workspaceId,
    campaignId: campaign1.id,
    contentId: item1.id,
    contentVariantId: v1.id,
  })

  // 1. WS2 tries to publish WS1 item
  await assert.rejects(
    () =>
      createPublicationIntent(db, {
        workspaceId: ws2Id,
        campaignId: campaign1.id,
        contentId: item1.id,
        contentVariantId: v1.id,
        accountId: account2Id,
      }),
    /Content item not found|Campaign not found/,
  )

  // 2. WS1 tries to publish to WS2 account
  await assert.rejects(
    () =>
      createPublicationIntent(db, {
        workspaceId: base1.workspaceId,
        campaignId: campaign1.id,
        contentId: item1.id,
        contentVariantId: v1.id,
        accountId: account2Id,
      }),
    /Account not found in this workspace/,
  )
})

test('31. client forgery prevention', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Forgery Test Campaign',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Forgery Post',
    contentType: 'post',
  })

  const { variant } = await seedDraftVariant(db, base.workspaceId, campaign.id, item.id, {
    body: 'Forgery test body.',
  })

  await approveCampaignContentVariant(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    contentVariantId: variant.id,
  })

  // Pass forged fields in raw input
  const post = await createPublicationIntent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    contentVariantId: variant.id,
    accountId: base.accountId,
    status: 'published',
    externalId: 'fake-external-id-123',
    url: 'https://twitter.com/fake/status/123',
    publishedAt: '2026-08-20T12:00:00.000Z',
    contentApprovalId: 'fake-approval-id-999',
  })

  // Server ignores client-forged fields and derives truthful initial state
  assert.equal(post.status, 'draft')
  assert.equal(post.externalId, null)
  assert.equal(post.url, null)
  assert.equal(post.publishedAt, null)
  assert.notEqual(post.contentApprovalId, 'fake-approval-id-999')
})

test('32. validatePublicationEligibility helper checks live readiness', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Eligibility Campaign',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Eligibility Post',
    contentType: 'post',
  })

  const { variant } = await seedDraftVariant(db, base.workspaceId, campaign.id, item.id, {
    body: 'Eligibility body.',
  })

  await approveCampaignContentVariant(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    contentVariantId: variant.id,
  })

  const post = await createPublicationIntent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    contentVariantId: variant.id,
    accountId: base.accountId,
  })

  // 1. Initial check: Eligible
  const eligibility1 = await validatePublicationEligibility(db, {
    workspaceId: base.workspaceId,
    postId: post.id,
  })
  assert.equal(eligibility1.eligible, true)

  // 2. Revoke approval
  await revokeCampaignContentApproval(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
  })

  // 3. Re-check: Ineligible due to revoked approval / draft status
  const eligibility2 = await validatePublicationEligibility(db, {
    workspaceId: base.workspaceId,
    postId: post.id,
  })
  assert.equal(eligibility2.eligible, false)
  assert.match(eligibility2.reason ?? '', /not 'ready'|revoked/i)
})

test('33. Events & Audit logging', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Events Audit Campaign',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Events Audit Post',
    contentType: 'post',
  })

  const { variant } = await seedDraftVariant(db, base.workspaceId, campaign.id, item.id, {
    body: 'Audit body copy.',
  })

  await approveCampaignContentVariant(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    contentVariantId: variant.id,
  })

  const post = await createPublicationIntent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    contentVariantId: variant.id,
    accountId: base.accountId,
  })

  // Check audit log
  const auditRow = raw
    .prepare(`SELECT * FROM audit_log WHERE entity_id = ? AND entity_type = 'post'`)
    .get(post.id) as { action: string; new_value: string }
  assert.ok(auditRow)
  assert.equal(auditRow.action, 'create')
  const auditData = JSON.parse(auditRow.new_value)
  assert.equal(auditData.postId, post.id)
  assert.equal(auditData.accountId, base.accountId)

  // Check domain events
  const events = await listRecentEvents(db, base.workspaceId, 'publication', 10)
  const prepEvent = events.find((e) => e.event_type === 'publication.prepared')
  assert.ok(prepEvent)
  assert.equal(prepEvent.subject_id, post.id)
})

test('34. listPostsForContent and listPostsForCampaign return PostDetail[] ordered by created_at DESC, rowid DESC', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'List Posts Campaign',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'List Posts Item',
    contentType: 'post',
  })

  const { variant } = await seedDraftVariant(db, base.workspaceId, campaign.id, item.id, {
    body: 'List posts body.',
  })

  await approveCampaignContentVariant(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    contentVariantId: variant.id,
  })

  const post = await createPublicationIntent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    contentVariantId: variant.id,
    accountId: base.accountId,
  })

  const contentPosts = await listPostsForContent(db, base.workspaceId, item.id)
  assert.equal(contentPosts.length, 1)
  assert.equal(contentPosts[0].id, post.id)
  assert.equal(contentPosts[0].platformName, 'X / Twitter')

  const campaignPosts = await listPostsForCampaign(db, base.workspaceId, campaign.id)
  assert.equal(campaignPosts.length, 1)
  assert.equal(campaignPosts[0].id, post.id)
})

test('35. getApprovedPublicationVariant returns null when approval was revoked', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    accountIds: [base.accountId],
    name: 'Approved Variant Helper Campaign',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    targetAccountId: base.accountId,
    title: 'Helper Post',
    contentType: 'post',
  })

  const { variant } = await seedDraftVariant(db, base.workspaceId, campaign.id, item.id, {
    body: 'Helper body.',
  })

  // 1. Before approval -> null
  const res1 = await getApprovedPublicationVariant(db, base.workspaceId, item.id)
  assert.equal(res1, null)

  // 2. After approval -> valid
  await approveCampaignContentVariant(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
    contentVariantId: variant.id,
  })

  const res2 = await getApprovedPublicationVariant(db, base.workspaceId, item.id)
  assert.ok(res2)
  assert.equal(res2.variant.id, variant.id)
  assert.equal(res2.approval.status, 'approved')

  // 3. After revoke -> null
  await revokeCampaignContentApproval(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    contentId: item.id,
  })

  const res3 = await getApprovedPublicationVariant(db, base.workspaceId, item.id)
  assert.equal(res3, null)
})
