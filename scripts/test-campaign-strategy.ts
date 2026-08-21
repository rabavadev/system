/**
 * Campaign Strategic Definition & Success Metrics verification tests (npm run test:campaign-strategy).
 *
 * Tests the 21 requirements for STEP 14B:
 *   1. objective saved
 *   2. audience saved
 *   3. positioning saved
 *   4. angle saved
 *   5. hypothesis saved
 *   6. priority validation
 *   7. primary KPI saved
 *   8. multiple target metrics
 *   9. invalid metric rejected
 *  10. invalid target rejected
 *  11. percentage validation
 *  12. currency target preserved
 *  13. only one primary KPI
 *  14. strategy editing
 *  15. targets editing
 *  16. Campaign context contains strategy
 *  17. Campaign context contains targets
 *  18. cross-workspace update rejected
 *  19. no fake performance values created
 *  20. audit/events safe
 *  21. existing Campaign tests remain green
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import { renderContextDocument } from '../src/server/ai/composer.ts'
import { buildContext } from '../src/server/context/engine.ts'
import {
  createCampaign,
  getCampaignDetail,
  getCampaignSummaryById,
  updateCampaignStrategy,
  updateCampaignTargets,
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
  return { db: shim(raw), raw }
}

function seedWorkspace(raw: Database.Database) {
  const wsId = '11111111-1111-4111-8111-111111111111'
  const brandId = '22222222-2222-4222-8222-222222222222'
  const prodId = '33333333-3333-4333-8333-333333333333'
  const otherWsId = '99999999-9999-4999-8999-999999999999'

  raw
    .prepare(
      `INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, 'Test WS', 'test-ws', ?, ?)`,
    )
    .run(wsId, NOW, NOW)

  raw
    .prepare(
      `INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, 'Other WS', 'other-ws', ?, ?)`,
    )
    .run(otherWsId, NOW, NOW)

  raw
    .prepare(
      `INSERT INTO brand (id, workspace_id, name, description, created_at, updated_at) VALUES (?, ?, 'Acme Brand', 'Acme brand description', ?, ?)`,
    )
    .run(brandId, wsId, NOW, NOW)

  raw
    .prepare(
      `INSERT INTO product (id, brand_id, name, status, created_at, updated_at) VALUES (?, ?, 'Acme Widget', 'active', ?, ?)`,
    )
    .run(prodId, brandId, NOW, NOW)

  return { wsId, brandId, prodId, otherWsId }
}

test('1. objective saved', async () => {
  const { db, raw } = freshDb()
  const { wsId, brandId } = seedWorkspace(raw)

  const campaign = await createCampaign(db, {
    workspaceId: wsId,
    brandId,
    name: 'Revenue Drive Campaign',
    objective: 'revenue',
  })

  assert.equal(campaign.objective, 'revenue')

  const detail = await getCampaignDetail(db, wsId, campaign.id)
  assert.equal(detail?.objective, 'revenue')
})

test('2. audience saved', async () => {
  const { db, raw } = freshDb()
  const { wsId, brandId } = seedWorkspace(raw)

  const campaign = await createCampaign(db, {
    workspaceId: wsId,
    brandId,
    name: 'Audience Target Campaign',
    audienceDetails: {
      summary: 'Product managers working remotely',
      problem: 'Struggling to track async team updates',
      awarenessLevel: 'problem_aware',
      geography: 'North America & Europe',
      notes: 'High adoption on Slack',
    },
  })

  const detail = await getCampaignDetail(db, wsId, campaign.id)
  assert.equal(detail?.audienceDetails.summary, 'Product managers working remotely')
  assert.equal(detail?.audienceDetails.problem, 'Struggling to track async team updates')
  assert.equal(detail?.audienceDetails.awarenessLevel, 'problem_aware')
  assert.equal(detail?.audienceDetails.geography, 'North America & Europe')
  assert.equal(detail?.audienceDetails.notes, 'High adoption on Slack')
})

test('3. positioning saved', async () => {
  const { db, raw } = freshDb()
  const { wsId, brandId } = seedWorkspace(raw)

  const campaign = await createCampaign(db, {
    workspaceId: wsId,
    brandId,
    name: 'Positioning Campaign',
    positioning: 'The only async tracker built directly into Slack',
  })

  assert.equal(campaign.positioning, 'The only async tracker built directly into Slack')
  const detail = await getCampaignDetail(db, wsId, campaign.id)
  assert.equal(detail?.strategy.positioning, 'The only async tracker built directly into Slack')
})

test('4. angle saved', async () => {
  const { db, raw } = freshDb()
  const { wsId, brandId } = seedWorkspace(raw)

  const campaign = await createCampaign(db, {
    workspaceId: wsId,
    brandId,
    name: 'Angle Campaign',
    angle: 'Stop doing 30-minute daily standups',
  })

  assert.equal(campaign.angle, 'Stop doing 30-minute daily standups')
  const detail = await getCampaignDetail(db, wsId, campaign.id)
  assert.equal(detail?.strategy.coreAngle, 'Stop doing 30-minute daily standups')
})

test('5. hypothesis saved', async () => {
  const { db, raw } = freshDb()
  const { wsId, brandId } = seedWorkspace(raw)

  const campaign = await createCampaign(db, {
    workspaceId: wsId,
    brandId,
    name: 'Hypothesis Campaign',
    hypothesis: 'Emphasizing meeting fatigue will convert 3x better than feature highlights',
  })

  assert.equal(
    campaign.hypothesis,
    'Emphasizing meeting fatigue will convert 3x better than feature highlights',
  )
  const detail = await getCampaignDetail(db, wsId, campaign.id)
  assert.equal(
    detail?.strategy.hypothesis,
    'Emphasizing meeting fatigue will convert 3x better than feature highlights',
  )
})

test('6. priority validation', async () => {
  const { db, raw } = freshDb()
  const { wsId, brandId } = seedWorkspace(raw)

  // Default is normal
  const normalCamp = await createCampaign(db, {
    workspaceId: wsId,
    brandId,
    name: 'Default Priority',
  })
  assert.equal(normalCamp.priority, 'normal')

  // Explicit high and low
  const highCamp = await createCampaign(db, {
    workspaceId: wsId,
    brandId,
    name: 'High Priority',
    priority: 'high',
  })
  assert.equal(highCamp.priority, 'high')

  const lowCamp = await createCampaign(db, {
    workspaceId: wsId,
    brandId,
    name: 'Low Priority',
    priority: 'low',
  })
  assert.equal(lowCamp.priority, 'low')

  // Invalid priority rejected
  await assert.rejects(
    async () =>
      createCampaign(db, {
        workspaceId: wsId,
        brandId,
        name: 'Bad Priority',
        // @ts-expect-error test invalid enum
        priority: 'urgent_critical',
      }),
    /invalid_enum_value|invalid/i,
  )
})

test('7. primary KPI saved', async () => {
  const { db, raw } = freshDb()
  const { wsId, brandId } = seedWorkspace(raw)

  const campaign = await createCampaign(db, {
    workspaceId: wsId,
    brandId,
    name: 'Primary KPI Campaign',
    targets: [
      {
        metricKey: 'revenue',
        targetValue: 5000,
        unit: 'USD',
        isPrimary: true,
      },
    ],
  })

  const detail = await getCampaignDetail(db, wsId, campaign.id)
  assert.ok(detail?.primaryTarget)
  assert.equal(detail.primaryTarget.metricKey, 'revenue')
  assert.equal(detail.primaryTarget.targetValue, 5000)
  assert.equal(detail.primaryTarget.unit, 'USD')
  assert.equal(detail.primaryTarget.isPrimary, true)
})

test('8. multiple target metrics', async () => {
  const { db, raw } = freshDb()
  const { wsId, brandId } = seedWorkspace(raw)

  const campaign = await createCampaign(db, {
    workspaceId: wsId,
    brandId,
    name: 'Multi-Target Campaign',
    targets: [
      {
        metricKey: 'revenue',
        targetValue: 10000,
        unit: 'USD',
        isPrimary: true,
        orderIndex: 0,
      },
      {
        metricKey: 'conversion_rate',
        targetValue: 3.5,
        unit: '%',
        isPrimary: false,
        orderIndex: 1,
      },
      {
        metricKey: 'qualified_visits',
        targetValue: 15000,
        unit: 'visits',
        isPrimary: false,
        orderIndex: 2,
      },
    ],
  })

  const detail = await getCampaignDetail(db, wsId, campaign.id)
  assert.equal(detail?.targets.length, 3)
  assert.equal(detail?.primaryTarget?.metricKey, 'revenue')
  assert.equal(detail?.supportingTargets.length, 2)
  assert.equal(detail?.supportingTargets[0]?.metricKey, 'conversion_rate')
  assert.equal(detail?.supportingTargets[1]?.metricKey, 'qualified_visits')
})

test('9. invalid metric rejected', async () => {
  const { db, raw } = freshDb()
  const { wsId, brandId } = seedWorkspace(raw)

  await assert.rejects(
    async () =>
      createCampaign(db, {
        workspaceId: wsId,
        brandId,
        name: 'Invalid Metric Campaign',
        targets: [
          {
            // @ts-expect-error test unsupported metric
            metricKey: 'pinterest_super_clicks',
            targetValue: 100,
            isPrimary: true,
          },
        ],
      }),
    /invalid_enum_value|invalid/i,
  )
})

test('10. invalid target rejected', async () => {
  const { db, raw } = freshDb()
  const { wsId, brandId } = seedWorkspace(raw)

  await assert.rejects(
    async () =>
      createCampaign(db, {
        workspaceId: wsId,
        brandId,
        name: 'Negative Target Campaign',
        targets: [
          {
            metricKey: 'revenue',
            targetValue: -500,
            isPrimary: true,
          },
        ],
      }),
    /Target value must be non-negative/i,
  )
})

test('11. percentage validation', async () => {
  const { db, raw } = freshDb()
  const { wsId, brandId } = seedWorkspace(raw)

  // Valid percentages
  const valid = await createCampaign(db, {
    workspaceId: wsId,
    brandId,
    name: 'Valid Percent Campaign',
    targets: [
      {
        metricKey: 'conversion_rate',
        targetValue: 4.2,
        isPrimary: true,
      },
    ],
  })
  assert.ok(valid.id)

  // Reject > 100%
  await assert.rejects(
    async () =>
      createCampaign(db, {
        workspaceId: wsId,
        brandId,
        name: 'Over 100% Campaign',
        targets: [
          {
            metricKey: 'ctr',
            targetValue: 150,
            isPrimary: true,
          },
        ],
      }),
    /Percentage metrics must be between 0 and 100/i,
  )
})

test('12. currency target preserved', async () => {
  const { db, raw } = freshDb()
  const { wsId, brandId } = seedWorkspace(raw)

  const campaign = await createCampaign(db, {
    workspaceId: wsId,
    brandId,
    name: 'Euro Campaign',
    targets: [
      {
        metricKey: 'revenue',
        targetValue: 12000,
        unit: 'EUR',
        isPrimary: true,
      },
    ],
  })

  const detail = await getCampaignDetail(db, wsId, campaign.id)
  assert.equal(detail?.primaryTarget?.unit, 'EUR')
})

test('13. only one primary KPI', async () => {
  const { db, raw } = freshDb()
  const { wsId, brandId } = seedWorkspace(raw)

  await assert.rejects(
    async () =>
      createCampaign(db, {
        workspaceId: wsId,
        brandId,
        name: 'Two Primaries Campaign',
        targets: [
          {
            metricKey: 'revenue',
            targetValue: 1000,
            isPrimary: true,
          },
          {
            metricKey: 'conversions',
            targetValue: 50,
            isPrimary: true,
          },
        ],
      }),
    /Exactly one target must be marked as Primary KPI/i,
  )
})

test('14. strategy editing', async () => {
  const { db, raw } = freshDb()
  const { wsId, brandId } = seedWorkspace(raw)

  const campaign = await createCampaign(db, {
    workspaceId: wsId,
    brandId,
    name: 'Editable Strategy Campaign',
    objective: 'awareness',
    priority: 'normal',
  })

  const updated = await updateCampaignStrategy(db, {
    workspaceId: wsId,
    id: campaign.id,
    objective: 'conversions',
    priority: 'high',
    positioning: 'Updated positioning hook',
    angle: 'Updated creative angle',
    offerMessage: '20% off annual plan',
    hypothesis: 'New annual offer drives higher ACV',
    audience: {
      summary: 'Tech team leads',
      problem: 'Tool fragmentation',
      awarenessLevel: 'solution_aware',
      geography: 'Global',
    },
  })

  assert.equal(updated.objective, 'conversions')
  assert.equal(updated.priority, 'high')
  assert.equal(updated.strategy.positioning, 'Updated positioning hook')
  assert.equal(updated.strategy.coreAngle, 'Updated creative angle')
  assert.equal(updated.strategy.offerMessage, '20% off annual plan')
  assert.equal(updated.strategy.hypothesis, 'New annual offer drives higher ACV')
  assert.equal(updated.audienceDetails.summary, 'Tech team leads')
  assert.equal(updated.audienceDetails.problem, 'Tool fragmentation')
})

test('15. targets editing', async () => {
  const { db, raw } = freshDb()
  const { wsId, brandId } = seedWorkspace(raw)

  const campaign = await createCampaign(db, {
    workspaceId: wsId,
    brandId,
    name: 'Editable Targets Campaign',
    targets: [
      {
        metricKey: 'clicks',
        targetValue: 500,
        isPrimary: true,
      },
    ],
  })

  const updated = await updateCampaignTargets(db, {
    workspaceId: wsId,
    id: campaign.id,
    targets: [
      {
        metricKey: 'revenue',
        targetValue: 2500,
        unit: 'USD',
        isPrimary: true,
      },
      {
        metricKey: 'orders',
        targetValue: 50,
        unit: 'orders',
        isPrimary: false,
      },
    ],
  })

  assert.equal(updated.targets.length, 2)
  assert.equal(updated.primaryTarget?.metricKey, 'revenue')
  assert.equal(updated.primaryTarget?.targetValue, 2500)
  assert.equal(updated.supportingTargets[0]?.metricKey, 'orders')
})

test('16. Campaign context contains strategy', async () => {
  const { db, raw } = freshDb()
  const { wsId, brandId } = seedWorkspace(raw)

  const campaign = await createCampaign(db, {
    workspaceId: wsId,
    brandId,
    name: 'Context Strategy Campaign',
    objective: 'revenue',
    priority: 'high',
    positioning: 'Zero-config growth stack',
    angle: 'Stop stitching 10 marketing tools together',
    hypothesis: 'Consolidation angle outperforms feature breakdown',
    audienceDetails: {
      summary: 'Bootstrapped founders',
      problem: 'Overwhelmed by SaaS subscriptions',
      awarenessLevel: 'product_aware',
    },
  })

  const pkg = await buildContext(db, {
    workspaceId: wsId,
    campaignId: campaign.id,
  })

  assert.ok(pkg.campaign)
  assert.equal(pkg.campaign.name, 'Context Strategy Campaign')
  assert.equal(pkg.campaign.objective, 'revenue')
  assert.equal(pkg.campaign.priority, 'high')
  assert.equal(pkg.campaign.strategy.positioning, 'Zero-config growth stack')
  assert.equal(pkg.campaign.strategy.coreAngle, 'Stop stitching 10 marketing tools together')
  assert.equal(
    pkg.campaign.strategy.hypothesis,
    'Consolidation angle outperforms feature breakdown',
  )
  assert.equal(pkg.campaign.audience.summary, 'Bootstrapped founders')
  assert.equal(pkg.campaign.audience.problem, 'Overwhelmed by SaaS subscriptions')
})

test('17. Campaign context contains targets', async () => {
  const { db, raw } = freshDb()
  const { wsId, brandId } = seedWorkspace(raw)

  const campaign = await createCampaign(db, {
    workspaceId: wsId,
    brandId,
    name: 'Context Targets Campaign',
    objective: 'conversions',
    targets: [
      {
        metricKey: 'revenue',
        targetValue: 8000,
        unit: 'USD',
        isPrimary: true,
      },
      {
        metricKey: 'conversion_rate',
        targetValue: 2.8,
        unit: '%',
        isPrimary: false,
      },
    ],
  })

  const pkg = await buildContext(db, {
    workspaceId: wsId,
    campaignId: campaign.id,
  })

  assert.ok(pkg.campaign)
  assert.equal(pkg.campaign.targets.length, 2)
  assert.equal(pkg.campaign.targets[0].metricKey, 'revenue')
  assert.equal(pkg.campaign.targets[0].targetValue, 8000)

  // Verify prompt composer document rendering
  const doc = renderContextDocument(pkg)
  assert.ok(doc.includes('Name: Context Targets Campaign'))
  assert.equal(doc.includes('Primary Objective: conversions'), true)
  assert.equal(doc.includes('revenue: target 8000 USD [Primary KPI]'), true)
  assert.equal(doc.includes('conversion_rate: target 2.8 %'), true)
})

test('18. cross-workspace update rejected', async () => {
  const { db, raw } = freshDb()
  const { wsId, brandId, otherWsId } = seedWorkspace(raw)

  const campaign = await createCampaign(db, {
    workspaceId: wsId,
    brandId,
    name: 'Secure Campaign',
  })

  await assert.rejects(
    async () =>
      updateCampaignStrategy(db, {
        workspaceId: otherWsId,
        id: campaign.id,
        objective: 'revenue',
      }),
    /campaign_not_found|not found|cross_workspace_forbidden/i,
  )

  await assert.rejects(
    async () =>
      updateCampaignTargets(db, {
        workspaceId: otherWsId,
        id: campaign.id,
        targets: [
          {
            metricKey: 'revenue',
            targetValue: 1000,
            isPrimary: true,
          },
        ],
      }),
    /campaign_not_found|not found|cross_workspace_forbidden/i,
  )
})

test('19. no fake performance values created', async () => {
  const { db, raw } = freshDb()
  const { wsId, brandId } = seedWorkspace(raw)

  const campaign = await createCampaign(db, {
    workspaceId: wsId,
    brandId,
    name: 'Honest Metrics Campaign',
    targets: [
      {
        metricKey: 'revenue',
        targetValue: 5000,
        unit: 'USD',
        isPrimary: true,
      },
    ],
  })

  // Verify metric_observation table has 0 rows for this campaign
  const obs = raw
    .prepare(`SELECT COUNT(*) AS n FROM metric_observation WHERE subject_id = ?`)
    .get(campaign.id) as { n: number }
  assert.equal(obs.n, 0)
})

test('20. audit/events safe', async () => {
  const { db, raw } = freshDb()
  const { wsId, brandId } = seedWorkspace(raw)

  const campaign = await createCampaign(db, {
    workspaceId: wsId,
    brandId,
    name: 'Audited Campaign',
    objective: 'revenue',
    priority: 'high',
  })

  await updateCampaignStrategy(db, {
    workspaceId: wsId,
    id: campaign.id,
    objective: 'leads',
    positioning: 'Updated positioning',
  })

  await updateCampaignTargets(db, {
    workspaceId: wsId,
    id: campaign.id,
    targets: [
      {
        metricKey: 'leads',
        targetValue: 200,
        isPrimary: true,
      },
    ],
  })

  const auditRows = raw
    .prepare(`SELECT * FROM audit_log WHERE entity_id = ? ORDER BY created_at ASC`)
    .all(campaign.id) as Array<{ action: string; new_value_json: string }>

  assert.ok(auditRows.length >= 3)
  assert.equal(auditRows[0].action, 'create')
  assert.equal(auditRows[1].action, 'update')
  assert.equal(auditRows[2].action, 'update')

  const eventRows = raw
    .prepare(`SELECT * FROM event WHERE workspace_id = ? ORDER BY occurred_at ASC`)
    .all(wsId) as Array<{ event_type: string }>

  const eventTypes = eventRows.map((e) => e.event_type)
  assert.ok(eventTypes.includes('campaign.created'))
  assert.ok(eventTypes.includes('campaign.strategy_updated'))
  assert.ok(eventTypes.includes('campaign.targets_updated'))
})

test('21. existing Campaign tests remain green', async () => {
  const { db, raw } = freshDb()
  const { wsId, brandId, prodId } = seedWorkspace(raw)

  // Verify normal 14A creation and summary still work with default strategy & priority
  const c = await createCampaign(db, {
    workspaceId: wsId,
    brandId,
    productId: prodId,
    name: 'Regression Check Campaign',
  })

  assert.ok(c.id)
  assert.equal(c.priority, 'normal')
  assert.equal(c.objective, null)

  const summary = await getCampaignSummaryById(db, c.id)
  assert.equal(summary?.name, 'Regression Check Campaign')
  assert.equal(summary?.productName, 'Acme Widget')
})

test('22. all 12 required built-in metrics resolve from canonical metric_definition registry', async () => {
  const { db, raw } = freshDb()
  const { wsId, brandId } = seedWorkspace(raw)

  const REQUIRED_BUILTINS = [
    'revenue',
    'conversions',
    'orders',
    'conversion_rate',
    'qualified_visits',
    'clicks',
    'outbound_clicks',
    'ctr',
    'leads',
    'saves',
    'engagements',
    'impressions',
  ]

  const { listMetricDefinitions } = await import('../src/server/db/metric.ts')
  const defs = await listMetricDefinitions(db, wsId)
  const keys = defs.map((d) => d.key)

  for (const b of REQUIRED_BUILTINS) {
    assert.ok(
      keys.includes(b),
      `expected built-in '${b}' to be present in metric_definition registry`,
    )
  }

  // Create campaign using a less common built-in like 'saves' or 'leads'
  const c = await createCampaign(db, {
    workspaceId: wsId,
    brandId,
    name: 'Saves Campaign',
    targets: [{ metricKey: 'saves', targetValue: 500, isPrimary: true }],
  })
  assert.ok(c.id)
})

test('23. custom workspace-owned metric is accepted in campaign targets', async () => {
  const { db, raw } = freshDb()
  const { wsId, brandId } = seedWorkspace(raw)

  const { createMetricDefinition } = await import('../src/server/db/metric.ts')
  await createMetricDefinition(db, {
    workspaceId: wsId,
    key: 'custom_mql',
    name: 'Marketing Qualified Leads',
    description: 'Custom internal MQL metric',
    unit: 'leads',
  })

  const campaign = await createCampaign(db, {
    workspaceId: wsId,
    brandId,
    name: 'Custom Metric Campaign',
    targets: [{ metricKey: 'custom_mql', targetValue: 120, isPrimary: true }],
  })

  assert.ok(campaign.id)
  const detail = await getCampaignDetail(db, wsId, campaign.id)
  assert.equal(detail?.primaryTarget?.metricKey, 'custom_mql')
})

test('24. custom metric from another workspace is rejected', async () => {
  const { db, raw } = freshDb()
  const { wsId, brandId, otherWsId } = seedWorkspace(raw)

  const { createMetricDefinition } = await import('../src/server/db/metric.ts')
  await createMetricDefinition(db, {
    workspaceId: otherWsId,
    key: 'secret_other_metric',
    name: 'Other WS Metric',
    unit: 'count',
  })

  // Attempting to use otherWsId's metric from wsId must be rejected
  await assert.rejects(
    async () =>
      createCampaign(db, {
        workspaceId: wsId,
        brandId,
        name: 'Foreign Metric Campaign',
        targets: [{ metricKey: 'secret_other_metric', targetValue: 50, isPrimary: true }],
      }),
    /Invalid metric key|not found in canonical metric registry/i,
  )
})

test('25. updateCampaignTargets validates against metric_definition registry server-side', async () => {
  const { db, raw } = freshDb()
  const { wsId, brandId } = seedWorkspace(raw)

  const campaign = await createCampaign(db, {
    workspaceId: wsId,
    brandId,
    name: 'Target Validation Campaign',
    targets: [{ metricKey: 'revenue', targetValue: 1000, isPrimary: true }],
  })

  await assert.rejects(
    async () =>
      updateCampaignTargets(db, {
        workspaceId: wsId,
        id: campaign.id,
        targets: [{ metricKey: 'unregistered_fake_metric', targetValue: 10, isPrimary: true }],
      }),
    /Invalid metric key|not found in canonical metric registry/i,
  )
})
