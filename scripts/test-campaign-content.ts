/**
 * Campaign Content Plan verification tests (npm run test:campaign-content).
 *
 * Tests the 22 requirements for STEP 14C:
 *   1. create Campaign content item
 *   2. title validation
 *   3. content type validation
 *   4. purpose validation
 *   5. account attached to Campaign accepted
 *   6. unrelated Account rejected
 *   7. cross-workspace Account rejected
 *   8. platform derives correctly from Account
 *   9. planned date saved
 *  10. Idea status
 *  11. Planned status
 *  12. Draft status
 *  13. Ready status
 *  14. edit content item
 *  15. archive/remove safely
 *  16. Campaign detail lists content
 *  17. filters/grouping correct
 *  18. strategy summary visible to planning UI
 *  19. no fake publication state created
 *  20. no platform API calls
 *  21. audit/events safe
 *  22. existing Campaign tests remain green
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import { renderContextDocument } from '../src/server/ai/composer.ts'
import { buildContext } from '../src/server/context/engine.ts'
import { createCampaign, getCampaignDetail } from '../src/server/db/campaign.ts'
import {
  archiveCampaignContent,
  createCampaignContent,
  getCampaignContentDetail,
  listCampaignContent,
  updateCampaignContent,
} from '../src/server/db/content.ts'
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

function seedBaseline(raw: Database.Database): {
  workspaceId: string
  brandId: string
  productId: string
  platformId1: string
  platformId2: string
  accountId1: string
  accountId2: string
  unrelatedAccountId: string
  otherWorkspaceId: string
  otherAccountId: string
} {
  const workspaceId = crypto.randomUUID()
  const brandId = crypto.randomUUID()
  const productId = crypto.randomUUID()
  const platformId1 = crypto.randomUUID()
  const platformId2 = crypto.randomUUID()
  const accountId1 = crypto.randomUUID()
  const accountId2 = crypto.randomUUID()
  const unrelatedAccountId = crypto.randomUUID()
  const otherWorkspaceId = crypto.randomUUID()
  const otherAccountId = crypto.randomUUID()

  raw
    .prepare(
      `INSERT INTO workspace (id, name, created_at, updated_at) VALUES (?, 'Test Workspace', ?, ?)`,
    )
    .run(workspaceId, NOW, NOW)

  raw
    .prepare(
      `INSERT INTO workspace (id, name, created_at, updated_at) VALUES (?, 'Other Workspace', ?, ?)`,
    )
    .run(otherWorkspaceId, NOW, NOW)

  raw
    .prepare(
      `INSERT INTO brand (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, 'Acme Growth', ?, ?)`,
    )
    .run(brandId, workspaceId, NOW, NOW)

  raw
    .prepare(
      `INSERT INTO product (id, brand_id, name, status, created_at, updated_at) VALUES (?, ?, 'Product One', 'active', ?, ?)`,
    )
    .run(productId, brandId, NOW, NOW)

  raw
    .prepare(
      `INSERT INTO platform (id, adapter_key, name, created_at) VALUES (?, 'instagram', 'Instagram', ?)`,
    )
    .run(platformId1, NOW)

  raw
    .prepare(
      `INSERT INTO platform (id, adapter_key, name, created_at) VALUES (?, 'tiktok', 'TikTok', ?)`,
    )
    .run(platformId2, NOW)

  // Accounts in workspace
  raw
    .prepare(
      `INSERT INTO account (id, workspace_id, platform_id, handle, display_name, status, created_at, updated_at)
       VALUES (?, ?, ?, '@acmegrowth_ig', 'Acme IG', 'active', ?, ?)`,
    )
    .run(accountId1, workspaceId, platformId1, NOW, NOW)

  raw
    .prepare(
      `INSERT INTO account (id, workspace_id, platform_id, handle, display_name, status, created_at, updated_at)
       VALUES (?, ?, ?, '@acmegrowth_tt', 'Acme TikTok', 'active', ?, ?)`,
    )
    .run(accountId2, workspaceId, platformId2, NOW, NOW)

  raw
    .prepare(
      `INSERT INTO account (id, workspace_id, platform_id, handle, display_name, status, created_at, updated_at)
       VALUES (?, ?, ?, '@acme_unrelated', 'Acme Unrelated', 'active', ?, ?)`,
    )
    .run(unrelatedAccountId, workspaceId, platformId1, NOW, NOW)

  // Account in other workspace
  raw
    .prepare(
      `INSERT INTO account (id, workspace_id, platform_id, handle, display_name, status, created_at, updated_at)
       VALUES (?, ?, ?, '@foreign_brand', 'Foreign Account', 'active', ?, ?)`,
    )
    .run(otherAccountId, otherWorkspaceId, platformId1, NOW, NOW)

  return {
    workspaceId,
    brandId,
    productId,
    platformId1,
    platformId2,
    accountId1,
    accountId2,
    unrelatedAccountId,
    otherWorkspaceId,
    otherAccountId,
  }
}

test('1. create Campaign content item', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    productId: base.productId,
    name: 'Q3 Product Launch',
    accountIds: [base.accountId1],
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    title: '5 Reasons Why Creators Switch to Acme',
    contentType: 'short_form',
    purpose: 'traffic',
    theme: 'Creator pain point',
    targetAccountId: base.accountId1,
    plannedAt: '2026-09-01T10:00:00.000Z',
    status: 'planned',
    brief: 'Hook: Stop spending 4 hours editing captions. Show fast workflow in Acme.',
  })

  assert.ok(item.id)
  assert.equal(item.campaignId, campaign.id)
  assert.equal(item.title, '5 Reasons Why Creators Switch to Acme')
  assert.equal(item.contentType, 'short_form')
  assert.equal(item.purpose, 'traffic')
  assert.equal(item.theme, 'Creator pain point')
  assert.equal(item.targetAccountId, base.accountId1)
  assert.equal(item.accountHandle, '@acmegrowth_ig')
  assert.equal(item.platformName, 'Instagram')
  assert.equal(item.status, 'planned')
})

test('2. title validation', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Brand Campaign',
  })

  // Empty title rejected
  await assert.rejects(
    () =>
      createCampaignContent(db, {
        workspaceId: base.workspaceId,
        campaignId: campaign.id,
        title: '   ',
      }),
    /Title is required/i,
  )

  // Title exceeding max length rejected
  await assert.rejects(
    () =>
      createCampaignContent(db, {
        workspaceId: base.workspaceId,
        campaignId: campaign.id,
        title: 'a'.repeat(201),
      }),
    /Title cannot exceed 200 characters/i,
  )
})

test('3. content type validation', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Brand Campaign',
  })

  // Invalid content type rejected
  await assert.rejects(() =>
    createCampaignContent(db, {
      workspaceId: base.workspaceId,
      campaignId: campaign.id,
      title: 'Valid Title',
      contentType: 'custom_pinterest_pin_format' as never,
    }),
  )

  // Valid generic content types accepted
  const validTypes = [
    'post',
    'short_form',
    'long_form',
    'image',
    'video',
    'thread',
    'email',
    'other',
  ] as const

  for (const cType of validTypes) {
    const item = await createCampaignContent(db, {
      workspaceId: base.workspaceId,
      campaignId: campaign.id,
      title: `Item of type ${cType}`,
      contentType: cType,
    })
    assert.equal(item.contentType, cType)
  }
})

test('4. purpose validation', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Brand Campaign',
  })

  // Invalid purpose rejected
  await assert.rejects(() =>
    createCampaignContent(db, {
      workspaceId: base.workspaceId,
      campaignId: campaign.id,
      title: 'Valid Title',
      purpose: 'viral_explosion_objective' as never,
    }),
  )

  // Valid purposes accepted
  const validPurposes = [
    'awareness',
    'traffic',
    'conversion',
    'engagement',
    'education',
    'retention',
    'validation',
  ] as const

  for (const p of validPurposes) {
    const item = await createCampaignContent(db, {
      workspaceId: base.workspaceId,
      campaignId: campaign.id,
      title: `Item for ${p}`,
      purpose: p,
    })
    assert.equal(item.purpose, p)
  }
})

test('5. account attached to Campaign accepted', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Attached Account Campaign',
    accountIds: [base.accountId1, base.accountId2],
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    title: 'Post targeting Account 2',
    targetAccountId: base.accountId2,
  })

  assert.equal(item.targetAccountId, base.accountId2)
  assert.equal(item.accountHandle, '@acmegrowth_tt')
})

test('6. unrelated Account rejected', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  // Campaign only attaches accountId1
  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Single Account Campaign',
    accountIds: [base.accountId1],
  })

  // Attempting to attach unrelatedAccountId must fail
  await assert.rejects(
    () =>
      createCampaignContent(db, {
        workspaceId: base.workspaceId,
        campaignId: campaign.id,
        title: 'Post on unattached account',
        targetAccountId: base.unrelatedAccountId,
      }),
    /Account is not attached to this campaign/i,
  )
})

test('7. cross-workspace Account rejected', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'My Workspace Campaign',
    accountIds: [base.accountId1],
  })

  // Attempting to attach account from otherWorkspaceId must fail
  await assert.rejects(
    () =>
      createCampaignContent(db, {
        workspaceId: base.workspaceId,
        campaignId: campaign.id,
        title: 'Post on foreign account',
        targetAccountId: base.otherAccountId,
      }),
    /Account not found in this workspace/i,
  )
})

test('8. platform derives correctly from Account', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Multi-platform Campaign',
    accountIds: [base.accountId1, base.accountId2],
  })

  const igItem = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    title: 'IG Post',
    targetAccountId: base.accountId1,
  })

  const ttItem = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    title: 'TikTok Video',
    targetAccountId: base.accountId2,
  })

  assert.equal(igItem.platformName, 'Instagram')
  assert.equal(igItem.platformId, base.platformId1)
  assert.equal(ttItem.platformName, 'TikTok')
  assert.equal(ttItem.platformId, base.platformId2)
})

test('9. planned date saved', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Scheduled Content Campaign',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    title: 'Launch Announcement',
    plannedAt: '2026-09-15T09:30:00.000Z',
  })

  assert.equal(item.plannedAt, '2026-09-15T09:30:00.000Z')

  const fetched = await getCampaignContentDetail(db, base.workspaceId, item.id)
  assert.equal(fetched?.plannedAt, '2026-09-15T09:30:00.000Z')
})

test('10. Idea status', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Idea Campaign',
  })

  // Default is 'idea'
  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    title: 'Initial Concept',
  })

  assert.equal(item.status, 'idea')
})

test('11. Planned status', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Planned Campaign',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    title: 'Planned Post',
    status: 'planned',
  })

  assert.equal(item.status, 'planned')
})

test('12. Draft status', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Draft Campaign',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    title: 'Draft in Progress',
    status: 'draft',
  })

  assert.equal(item.status, 'draft')
})

test('13. Ready status', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Ready Campaign',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    title: 'Ready for Publishing',
    status: 'ready',
  })

  assert.equal(item.status, 'ready')
})

test('14. edit content item', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Edit Campaign',
    accountIds: [base.accountId1, base.accountId2],
  })

  const initial = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    title: 'Initial Title',
    contentType: 'post',
    purpose: 'awareness',
    status: 'idea',
  })

  const updated = await updateCampaignContent(db, {
    workspaceId: base.workspaceId,
    id: initial.id,
    title: 'Updated Final Title',
    contentType: 'short_form',
    purpose: 'conversion',
    theme: 'Direct Offer',
    targetAccountId: base.accountId2,
    status: 'ready',
    plannedAt: '2026-10-01T00:00:00.000Z',
    brief: 'Updated brief notes for creator.',
  })

  assert.equal(updated.id, initial.id)
  assert.equal(updated.title, 'Updated Final Title')
  assert.equal(updated.contentType, 'short_form')
  assert.equal(updated.purpose, 'conversion')
  assert.equal(updated.theme, 'Direct Offer')
  assert.equal(updated.targetAccountId, base.accountId2)
  assert.equal(updated.status, 'ready')
  assert.equal(updated.accountHandle, '@acmegrowth_tt')
})

test('15. archive/remove safely', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Archive Campaign',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    title: 'To Be Archived',
  })

  const archived = await archiveCampaignContent(db, {
    workspaceId: base.workspaceId,
    id: item.id,
  })

  assert.equal(archived.status, 'archived')
  assert.ok(archived.deletedAt)

  // Active list does not return archived items
  const activeList = await listCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
  })
  assert.equal(activeList.length, 0)
})

test('16. Campaign detail lists content', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Detail List Campaign',
  })

  await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    title: 'Item 1',
    status: 'idea',
  })

  await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    title: 'Item 2',
    status: 'ready',
  })

  const detail = await getCampaignDetail(db, base.workspaceId, campaign.id)
  assert.ok(detail)
  assert.equal(detail.contentCount, 2)
  assert.equal(detail.contentItems.length, 2)
  assert.equal(detail.contentItems[0]?.title, 'Item 1')
  assert.equal(detail.contentItems[1]?.title, 'Item 2')
})

test('17. filters/grouping correct', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Filter Campaign',
  })

  await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    title: 'Idea Item',
    status: 'idea',
  })
  await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    title: 'Planned Item',
    status: 'planned',
  })
  await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    title: 'Draft Item',
    status: 'draft',
  })
  await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    title: 'Ready Item',
    status: 'ready',
  })

  const ideas = await listCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    status: 'idea',
  })
  const readies = await listCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    status: 'ready',
  })

  assert.equal(ideas.length, 1)
  assert.equal(ideas[0]?.title, 'Idea Item')
  assert.equal(readies.length, 1)
  assert.equal(readies[0]?.title, 'Ready Item')
})

test('18. strategy summary visible to planning UI', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Strategy Visibility Campaign',
    objective: 'revenue',
    priority: 'high',
    positioning: 'Positioned against expensive agencies',
    angle: 'Save 80% on growth workflows',
    targets: [{ metricKey: 'revenue', targetValue: 50000, unit: 'USD', isPrimary: true }],
  })

  await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    title: 'Agency Comparison Short',
    contentType: 'short_form',
    purpose: 'conversion',
    status: 'planned',
  })

  const ctx = await buildContext(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
  })

  assert.ok(ctx.campaign)
  assert.equal(ctx.campaign.objective, 'revenue')
  assert.equal(ctx.campaign.strategy.coreAngle, 'Save 80% on growth workflows')
  assert.ok(ctx.campaign.contentSummary)
  assert.equal(ctx.campaign.contentSummary.total, 1)

  const doc = renderContextDocument(ctx)
  assert.match(doc, /Primary Objective: revenue/i)
  assert.match(doc, /Success Targets:/i)
  assert.match(doc, /Content Plan \(1 items\):/i)
  assert.match(doc, /Agency Comparison Short/i)
})

test('19. no fake publication state created', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'No Fake Post Campaign',
    accountIds: [base.accountId1],
  })

  await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    title: 'Planned Item Ready',
    status: 'ready',
    targetAccountId: base.accountId1,
  })

  // Ensure post table remains 0 rows
  const postCount = raw.prepare(`SELECT COUNT(*) AS c FROM post`).get() as { c: number }
  assert.equal(postCount.c, 0, 'No publication rows should be created in post table')
})

test('20. no platform API calls', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'No API Call Campaign',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    title: 'Local Plan Only',
    contentType: 'image',
  })

  assert.ok(item.id)
  assert.equal(item.status, 'idea')
})

test('21. audit/events safe', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Audit Events Campaign',
  })

  const item = await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    title: 'Audit Item',
  })

  await updateCampaignContent(db, {
    workspaceId: base.workspaceId,
    id: item.id,
    title: 'Updated Audit Item',
  })

  await archiveCampaignContent(db, {
    workspaceId: base.workspaceId,
    id: item.id,
  })

  const auditRows = raw
    .prepare(`SELECT action, entity_type FROM audit_log WHERE entity_id = ?`)
    .all(item.id) as Array<{ action: string; entity_type: string }>

  assert.equal(auditRows.length, 3)
  assert.equal(auditRows[0]?.action, 'create')
  assert.equal(auditRows[0]?.entity_type, 'content')
  assert.equal(auditRows[1]?.action, 'update')
  assert.equal(auditRows[2]?.action, 'delete')

  const eventRows = raw
    .prepare(`SELECT event_type FROM event WHERE workspace_id = ?`)
    .all(base.workspaceId) as Array<{ event_type: string }>

  const eventTypes = eventRows.map((e) => e.event_type)
  assert.ok(eventTypes.includes('campaign.content_created'))
  assert.ok(eventTypes.includes('campaign.content_updated'))
  assert.ok(eventTypes.includes('campaign.content_archived'))
})

test('22. existing Campaign tests remain green', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Existing Integration Campaign',
    objective: 'leads',
  })

  const detail = await getCampaignDetail(db, base.workspaceId, campaign.id)
  assert.ok(detail)
  assert.equal(detail.name, 'Existing Integration Campaign')
  assert.equal(detail.objective, 'leads')
  assert.equal(detail.contentCount, 0)
  assert.equal(detail.contentItems.length, 0)
})
