/**
 * Campaign Workspace and Lifecycle verification tests (npm run test:campaigns).
 *
 * Tests the 20 requirements for STEP 14A:
 *   1. create Campaign
 *   2. default Draft status
 *   3. Campaign requires valid Brand
 *   4. optional Product works
 *   5. cross-brand Product rejected
 *   6. multiple Accounts work
 *   7. invalid Account rejected
 *   8. cross-workspace Account rejected
 *   9. duplicate Campaign Account membership handled
 *  10. edit Campaign
 *  11. activate
 *  12. pause
 *  13. complete
 *  14. archive
 *  15. restore where supported
 *  16. Campaign filters
 *  17. Campaign scope resolves through Context Engine
 *  18. Campaign context does not leak cross-brand data
 *  19. audit/events safe
 *  20. existing systems remain green
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import { buildContext } from '../src/server/context/engine.ts'
import {
  activateCampaign,
  archiveCampaign,
  completeCampaign,
  createCampaign,
  getCampaignDetail,
  listArchivedCampaigns,
  listCampaignAccounts,
  listCampaigns,
  pauseCampaign,
  restoreCampaign,
  updateCampaign,
} from '../src/server/db/campaign.ts'
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
  const db = shim(raw)
  return { db, raw }
}

function setupFixture(raw: Database.Database) {
  const ws1 = crypto.randomUUID()
  const ws2 = crypto.randomUUID()

  // Workspaces
  raw
    .prepare(
      `INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, 'Growth Workspace', 'growth-ws', ?, ?)`,
    )
    .run(ws1, NOW, NOW)
  raw
    .prepare(
      `INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, 'Other Workspace', 'other-ws', ?, ?)`,
    )
    .run(ws2, NOW, NOW)

  // Platforms
  const platform1 = crypto.randomUUID()
  const platform2 = crypto.randomUUID()
  raw
    .prepare(
      `INSERT INTO platform (id, adapter_key, name, created_at) VALUES (?, 'x', 'Twitter / X', ?)`,
    )
    .run(platform1, NOW)
  raw
    .prepare(
      `INSERT INTO platform (id, adapter_key, name, created_at) VALUES (?, 'linkedin', 'LinkedIn', ?)`,
    )
    .run(platform2, NOW)

  // Brands
  const brand1 = crypto.randomUUID()
  const brand2 = crypto.randomUUID() // in ws1
  const brandForeign = crypto.randomUUID() // in ws2
  raw
    .prepare(
      `INSERT INTO brand (id, workspace_id, name, description, created_at, updated_at) VALUES (?, ?, 'SheetLab', 'Templates', ?, ?)`,
    )
    .run(brand1, ws1, NOW, NOW)
  raw
    .prepare(
      `INSERT INTO brand (id, workspace_id, name, description, created_at, updated_at) VALUES (?, ?, 'DocFlow', 'Documents', ?, ?)`,
    )
    .run(brand2, ws1, NOW, NOW)
  raw
    .prepare(
      `INSERT INTO brand (id, workspace_id, name, description, created_at, updated_at) VALUES (?, ?, 'ForeignBrand', 'Other', ?, ?)`,
    )
    .run(brandForeign, ws2, NOW, NOW)

  // Products
  const product1 = crypto.randomUUID() // under brand1
  const product2 = crypto.randomUUID() // under brand2
  raw
    .prepare(
      `INSERT INTO product (id, brand_id, name, status, created_at, updated_at) VALUES (?, ?, 'Budget Planner', 'active', ?, ?)`,
    )
    .run(product1, brand1, NOW, NOW)
  raw
    .prepare(
      `INSERT INTO product (id, brand_id, name, status, created_at, updated_at) VALUES (?, ?, 'Doc Assistant', 'active', ?, ?)`,
    )
    .run(product2, brand2, NOW, NOW)

  // Accounts
  const account1 = crypto.randomUUID() // in ws1
  const account2 = crypto.randomUUID() // in ws1
  const accountForeign = crypto.randomUUID() // in ws2
  raw
    .prepare(
      `INSERT INTO account (id, workspace_id, platform_id, handle, display_name, status, created_at, updated_at)
       VALUES (?, ?, ?, '@sheetlab_hq', 'SheetLab Official', 'active', ?, ?)`,
    )
    .run(account1, ws1, platform1, NOW, NOW)
  raw
    .prepare(
      `INSERT INTO account (id, workspace_id, platform_id, handle, display_name, status, created_at, updated_at)
       VALUES (?, ?, ?, '@sheetlab_growth', 'SheetLab Growth', 'active', ?, ?)`,
    )
    .run(account2, ws1, platform2, NOW, NOW)
  raw
    .prepare(
      `INSERT INTO account (id, workspace_id, platform_id, handle, display_name, status, created_at, updated_at)
       VALUES (?, ?, ?, '@foreign_handle', 'Foreign Official', 'active', ?, ?)`,
    )
    .run(accountForeign, ws2, platform1, NOW, NOW)

  return {
    ws1,
    ws2,
    brand1,
    brand2,
    brandForeign,
    product1,
    product2,
    account1,
    account2,
    accountForeign,
  }
}

test('1. create Campaign with core fields', async () => {
  const { db, raw } = freshDb()
  const { ws1, brand1, product1, account1, account2 } = setupFixture(raw)

  const created = await createCampaign(db, {
    workspaceId: ws1,
    brandId: brand1,
    productId: product1,
    name: 'Q3 Product Launch',
    angle: 'Highlight setup speed and formula automation.',
    audience: 'Finance teams and accountants',
    startsAt: '2026-09-01T00:00:00.000Z',
    endsAt: '2026-09-30T23:59:59.999Z',
    accountIds: [account1, account2],
  })

  assert.ok(created.id)
  assert.equal(created.name, 'Q3 Product Launch')
  assert.equal(created.workspaceId, ws1)
  assert.equal(created.brandId, brand1)
  assert.equal(created.brandName, 'SheetLab')
  assert.equal(created.productId, product1)
  assert.equal(created.productName, 'Budget Planner')
  assert.equal(created.angle, 'Highlight setup speed and formula automation.')
  assert.equal(created.accountCount, 2)
})

test('2. default Draft status on creation', async () => {
  const { db, raw } = freshDb()
  const { ws1, brand1 } = setupFixture(raw)

  const created = await createCampaign(db, {
    workspaceId: ws1,
    brandId: brand1,
    name: 'Draft Campaign',
  })

  assert.equal(created.status, 'draft')
})

test('3. Campaign requires valid Brand and rejects missing/foreign brand', async () => {
  const { db, raw } = freshDb()
  const { ws1, brandForeign } = setupFixture(raw)

  // Missing brand
  await assert.rejects(
    () =>
      createCampaign(db, {
        workspaceId: ws1,
        brandId: crypto.randomUUID(),
        name: 'No Brand Campaign',
      }),
    /Brand not found in this workspace/,
  )

  // Foreign workspace brand
  await assert.rejects(
    () =>
      createCampaign(db, {
        workspaceId: ws1,
        brandId: brandForeign,
        name: 'Foreign Brand Campaign',
      }),
    /Brand not found in this workspace/,
  )
})

test('4. optional Product works (brand-level campaign without product)', async () => {
  const { db, raw } = freshDb()
  const { ws1, brand1 } = setupFixture(raw)

  const created = await createCampaign(db, {
    workspaceId: ws1,
    brandId: brand1,
    name: 'Brand Awareness Push',
  })

  assert.equal(created.productId, null)
  assert.equal(created.productName, null)
})

test('5. cross-brand Product rejected', async () => {
  const { db, raw } = freshDb()
  const { ws1, brand1, product2 } = setupFixture(raw) // product2 belongs to brand2

  await assert.rejects(
    () =>
      createCampaign(db, {
        workspaceId: ws1,
        brandId: brand1,
        productId: product2,
        name: 'Mismatched Campaign',
      }),
    /That product belongs to a different brand/,
  )
})

test('6. multiple Accounts work and link to campaign', async () => {
  const { db, raw } = freshDb()
  const { ws1, brand1, account1, account2 } = setupFixture(raw)

  const created = await createCampaign(db, {
    workspaceId: ws1,
    brandId: brand1,
    name: 'Multi Account Campaign',
    accountIds: [account1, account2],
  })

  const accounts = await listCampaignAccounts(db, created.id)
  assert.equal(accounts.length, 2)
  const handles = accounts.map((a) => a.handle).sort()
  assert.deepEqual(handles, ['@sheetlab_growth', '@sheetlab_hq'])
})

test('7. invalid Account rejected', async () => {
  const { db, raw } = freshDb()
  const { ws1, brand1 } = setupFixture(raw)

  await assert.rejects(
    () =>
      createCampaign(db, {
        workspaceId: ws1,
        brandId: brand1,
        name: 'Bad Account Campaign',
        accountIds: [crypto.randomUUID()],
      }),
    /Account not found in this workspace/,
  )
})

test('8. cross-workspace Account rejected', async () => {
  const { db, raw } = freshDb()
  const { ws1, brand1, accountForeign } = setupFixture(raw)

  await assert.rejects(
    () =>
      createCampaign(db, {
        workspaceId: ws1,
        brandId: brand1,
        name: 'Foreign Account Campaign',
        accountIds: [accountForeign],
      }),
    /Account not found in this workspace/,
  )
})

test('9. duplicate Campaign Account membership handled cleanly', async () => {
  const { db, raw } = freshDb()
  const { ws1, brand1, account1 } = setupFixture(raw)

  const created = await createCampaign(db, {
    workspaceId: ws1,
    brandId: brand1,
    name: 'Dedup Accounts Campaign',
    accountIds: [account1, account1, account1],
  })

  const accounts = await listCampaignAccounts(db, created.id)
  assert.equal(accounts.length, 1)
})

test('10. edit Campaign updates fields and synchronizes accounts', async () => {
  const { db, raw } = freshDb()
  const { ws1, brand1, account1, account2 } = setupFixture(raw)

  const created = await createCampaign(db, {
    workspaceId: ws1,
    brandId: brand1,
    name: 'Original Name',
    accountIds: [account1],
  })

  const updated = await updateCampaign(db, {
    id: created.id,
    name: 'Updated Name',
    angle: 'New Strategy',
    accountIds: [account2],
  })

  assert.equal(updated.name, 'Updated Name')
  assert.equal(updated.angle, 'New Strategy')

  const accounts = await listCampaignAccounts(db, created.id)
  assert.equal(accounts.length, 1)
  assert.equal(accounts[0].id, account2)
})

test('11. activate Campaign transitions status to active', async () => {
  const { db, raw } = freshDb()
  const { ws1, brand1 } = setupFixture(raw)

  const created = await createCampaign(db, {
    workspaceId: ws1,
    brandId: brand1,
    name: 'To Activate',
  })
  assert.equal(created.status, 'draft')

  const activated = await activateCampaign(db, { workspaceId: ws1, id: created.id })
  assert.equal(activated.status, 'active')
})

test('12. pause Campaign transitions status to paused', async () => {
  const { db, raw } = freshDb()
  const { ws1, brand1 } = setupFixture(raw)

  const created = await createCampaign(db, { workspaceId: ws1, brandId: brand1, name: 'To Pause' })
  await activateCampaign(db, { workspaceId: ws1, id: created.id })

  const paused = await pauseCampaign(db, { workspaceId: ws1, id: created.id })
  assert.equal(paused.status, 'paused')
})

test('13. complete Campaign transitions status to completed', async () => {
  const { db, raw } = freshDb()
  const { ws1, brand1 } = setupFixture(raw)

  const created = await createCampaign(db, {
    workspaceId: ws1,
    brandId: brand1,
    name: 'To Complete',
  })
  const completed = await completeCampaign(db, { workspaceId: ws1, id: created.id })
  assert.equal(completed.status, 'completed')
})

test('14. archive Campaign soft-deletes and sets archived status', async () => {
  const { db, raw } = freshDb()
  const { ws1, brand1 } = setupFixture(raw)

  const created = await createCampaign(db, {
    workspaceId: ws1,
    brandId: brand1,
    name: 'To Archive',
  })
  const archived = await archiveCampaign(db, { workspaceId: ws1, id: created.id })

  assert.equal(archived.status, 'archived')
  assert.ok(archived.deletedAt)

  // Hidden from active list
  const activeList = await listCampaigns(db, { workspaceId: ws1 })
  assert.equal(activeList.length, 0)

  // Visible in archived list
  const archivedList = await listArchivedCampaigns(db, ws1)
  assert.equal(archivedList.length, 1)
})

test('15. restore Campaign restores archived campaign to draft', async () => {
  const { db, raw } = freshDb()
  const { ws1, brand1 } = setupFixture(raw)

  const created = await createCampaign(db, {
    workspaceId: ws1,
    brandId: brand1,
    name: 'To Restore',
  })
  await archiveCampaign(db, { workspaceId: ws1, id: created.id })

  const restored = await restoreCampaign(db, { workspaceId: ws1, id: created.id })
  assert.equal(restored.status, 'draft')
  assert.equal(restored.deletedAt, null)

  const activeList = await listCampaigns(db, { workspaceId: ws1 })
  assert.equal(activeList.length, 1)
})

test('16. Campaign filters by brand, product, and status work deterministically', async () => {
  const { db, raw } = freshDb()
  const { ws1, brand1, brand2, product1, product2 } = setupFixture(raw)

  await createCampaign(db, {
    workspaceId: ws1,
    brandId: brand1,
    productId: product1,
    name: 'B1 Active',
    status: 'active',
  })
  await createCampaign(db, {
    workspaceId: ws1,
    brandId: brand1,
    name: 'B1 Draft',
    status: 'draft',
  })
  await createCampaign(db, {
    workspaceId: ws1,
    brandId: brand2,
    productId: product2,
    name: 'B2 Active',
    status: 'active',
  })

  // Filter by brand
  const b1Campaigns = await listCampaigns(db, { workspaceId: ws1, brandId: brand1 })
  assert.equal(b1Campaigns.length, 2)

  // Filter by brand + status
  const b1Drafts = await listCampaigns(db, {
    workspaceId: ws1,
    brandId: brand1,
    status: 'draft',
  })
  assert.equal(b1Drafts.length, 1)
  assert.equal(b1Drafts[0].name, 'B1 Draft')

  // Filter by product
  const p1Campaigns = await listCampaigns(db, { workspaceId: ws1, productId: product1 })
  assert.equal(p1Campaigns.length, 1)
  assert.equal(p1Campaigns[0].name, 'B1 Active')
})

test('17. Campaign scope resolves through Context Engine', async () => {
  const { db, raw } = freshDb()
  const { ws1, brand1, product1, account1 } = setupFixture(raw)

  const campaign = await createCampaign(db, {
    workspaceId: ws1,
    brandId: brand1,
    productId: product1,
    name: 'Engine Context Campaign',
    accountIds: [account1],
  })

  const pkg = await buildContext(db, {
    workspaceId: ws1,
    campaignId: campaign.id,
  })

  assert.ok(pkg)
  assert.equal(pkg.workspace.id, ws1)
  assert.equal(pkg.brand?.id, brand1)
  assert.equal(pkg.brand?.name, 'SheetLab')
  assert.equal(pkg.product?.id, product1)
  assert.equal(pkg.product?.name, 'Budget Planner')
})

test('18. Campaign context does not leak cross-brand data', async () => {
  const { db, raw } = freshDb()
  const { ws1, brand1, brand2 } = setupFixture(raw)

  // Memory under Brand 1
  raw
    .prepare(
      `INSERT INTO memory (id, workspace_id, memory_class, content, scope_type, scope_id, status, created_at, updated_at)
       VALUES (?, ?, 'permanent_fact', 'Brand 1 Private Strategy', 'brand', ?, 'active', ?, ?)`,
    )
    .run(crypto.randomUUID(), ws1, brand1, NOW, NOW)

  // Memory under Brand 2
  raw
    .prepare(
      `INSERT INTO memory (id, workspace_id, memory_class, content, scope_type, scope_id, status, created_at, updated_at)
       VALUES (?, ?, 'permanent_fact', 'Brand 2 Secret Note', 'brand', ?, 'active', ?, ?)`,
    )
    .run(crypto.randomUUID(), ws1, brand2, NOW, NOW)

  // Campaign under Brand 1
  const campaign = await createCampaign(db, {
    workspaceId: ws1,
    brandId: brand1,
    name: 'Brand 1 Campaign',
  })

  const pkg = await buildContext(db, {
    workspaceId: ws1,
    campaignId: campaign.id,
  })

  const contents = pkg.memories.map((m) => m.content)
  assert.ok(contents.includes('Brand 1 Private Strategy'))
  assert.ok(
    !contents.includes('Brand 2 Secret Note'),
    'Cross-brand memory must not leak into context',
  )
})

test('19. audit log and domain events emitted safely on campaign lifecycle', async () => {
  const { db, raw } = freshDb()
  const { ws1, brand1 } = setupFixture(raw)

  const created = await createCampaign(db, {
    workspaceId: ws1,
    brandId: brand1,
    name: 'Audit Events Campaign',
  })

  await activateCampaign(db, { workspaceId: ws1, id: created.id })
  await pauseCampaign(db, { workspaceId: ws1, id: created.id })

  // Check audit_log
  const auditRows = raw
    .prepare(`SELECT * FROM audit_log WHERE entity_id = ? ORDER BY created_at ASC`)
    .all(created.id) as Array<{ action: string; entity_type: string }>
  assert.ok(auditRows.length >= 3)
  assert.equal(auditRows[0].action, 'create')
  assert.equal(auditRows[1].action, 'update')
  assert.equal(auditRows[2].action, 'update')

  // Check event table
  const eventRows = raw
    .prepare(`SELECT * FROM event WHERE subject_id = ? ORDER BY occurred_at ASC`)
    .all(created.id) as Array<{ event_type: string }>
  assert.ok(eventRows.some((e) => e.event_type === 'campaign.created'))
  assert.ok(eventRows.some((e) => e.event_type === 'campaign.activated'))
  assert.ok(eventRows.some((e) => e.event_type === 'campaign.paused'))
})

test('20. getCampaignDetail returns structured details, accounts, and research count', async () => {
  const { db, raw } = freshDb()
  const { ws1, brand1, product1, account1 } = setupFixture(raw)

  const campaign = await createCampaign(db, {
    workspaceId: ws1,
    brandId: brand1,
    productId: product1,
    name: 'Full Detail Campaign',
    accountIds: [account1],
  })

  // Insert research scoped to brand
  raw
    .prepare(
      `INSERT INTO research (id, workspace_id, subject, findings, research_type, status, scope_type, scope_id, created_at, updated_at)
       VALUES (?, ?, 'Campaign Market Research', 'Valuable findings', 'market', 'completed', 'brand', ?, ?, ?)`,
    )
    .run(crypto.randomUUID(), ws1, brand1, NOW, NOW)

  const detail = await getCampaignDetail(db, ws1, campaign.id)
  assert.ok(detail)
  assert.equal(detail.name, 'Full Detail Campaign')
  assert.equal(detail.brandName, 'SheetLab')
  assert.equal(detail.productName, 'Budget Planner')
  assert.equal(detail.accounts.length, 1)
  assert.equal(detail.accounts[0].handle, '@sheetlab_hq')
  assert.equal(detail.researchCount, 1)
  assert.equal(detail.recentResearch[0].subject, 'Campaign Market Research')
})
