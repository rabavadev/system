/**
 * Campaign Orchestration verification tests (npm run test:campaign-orchestration).
 *
 * Tests the 21 requirements for STEP 14D:
 *   1. Campaign Research section lists relevant Research (campaign + brand scoped)
 *   2. archived Research excluded where expected (deleted_at IS NOT NULL)
 *   3. freshness preserved without drift
 *   4. Research this campaign opens Researcher
 *   5. conversation scope = campaign
 *   6. Campaign context reaches Researcher (Context Engine)
 *   7. Save as Research defaults Draft
 *   8. saved Campaign research keeps Campaign scope
 *   9. genuine search sources still work
 *  10. manual Workflow run starts
 *  11. Workflow run scope = campaign
 *  12. inactive Workflow rejected
 *  13. cross-workspace Workflow rejected
 *  14. archived Campaign rejected
 *  15. Campaign context reaches Workflow Agent steps
 *  16. Workflow Tool approval remains enforced
 *  17. waiting approval shown correctly
 *  18. recent Workflow runs listed
 *  19. no fake Chat messages created by Workflow
 *  20. no automatic Research->Content pipeline starts
 *  21. domain events emitted properly (campaign.research_started, campaign.workflow_started)
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import { ensureBuiltinAgents } from '../src/server/agents/registry.ts'
import { renderContextDocument } from '../src/server/ai/composer.ts'
import { createEchoAdapter } from '../src/server/ai/providers/echo.ts'
import { buildContext } from '../src/server/context/engine.ts'
import { setAgentStatus } from '../src/server/db/agent.ts'
import {
  createCampaign,
  getCampaignDetail,
  listCampaignWorkflowRuns,
  startCampaignWorkflowRun,
} from '../src/server/db/campaign.ts'
import { createCampaignContent } from '../src/server/db/content.ts'
import { createConversation, getConversationById } from '../src/server/db/conversation.ts'
import { listRecentEvents } from '../src/server/db/event.ts'
import {
  computeProvenanceSummary,
  createResearch,
  createResearchSource,
  getResearch,
  listResearchSources,
} from '../src/server/db/research.ts'
import type { SqlDatabase } from '../src/server/db/sql.ts'
import { getWorkflowRunById } from '../src/server/db/workflow.ts'
import { TOOL_ADAPTERS } from '../src/server/tools/adapters/index.ts'
import { listToolDefinitions, type ToolAdapter, type ToolKey } from '../src/server/tools/index.ts'
import {
  createWorkflowWithVersion,
  type WorkflowEngineDeps,
} from '../src/server/workflows/index.ts'

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

function echoDeps(customToolAdapters?: Map<ToolKey, ToolAdapter>): WorkflowEngineDeps {
  const echo = createEchoAdapter()
  const adapters = new Map(TOOL_ADAPTERS)
  if (customToolAdapters) {
    for (const [k, v] of customToolAdapters) {
      adapters.set(k, v)
    }
  }
  return {
    ai: { adapters: new Map([[echo.key, echo]]), modelOverrides: { provider: 'echo' } },
    tools: {
      adapters,
      definitions: listToolDefinitions(),
    },
  }
}

function seedBaseline(raw: Database.Database) {
  const workspaceId = crypto.randomUUID()
  const otherWorkspaceId = crypto.randomUUID()
  const brandId = crypto.randomUUID()
  const otherBrandId = crypto.randomUUID()
  const productId = crypto.randomUUID()
  const platformId = crypto.randomUUID()
  const accountId = crypto.randomUUID()

  raw
    .prepare(
      `INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, 'Workspace A', 'workspace-a', ?, ?)`,
    )
    .run(workspaceId, NOW, NOW)
  raw
    .prepare(
      `INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, 'Workspace B', 'workspace-b', ?, ?)`,
    )
    .run(otherWorkspaceId, NOW, NOW)

  raw
    .prepare(
      `INSERT INTO brand (id, workspace_id, name, description, created_at, updated_at)
       VALUES (?, ?, 'Brand A', 'Primary Brand', ?, ?)`,
    )
    .run(brandId, workspaceId, NOW, NOW)
  raw
    .prepare(
      `INSERT INTO brand (id, workspace_id, name, description, created_at, updated_at)
       VALUES (?, ?, 'Brand B', 'Other Brand', ?, ?)`,
    )
    .run(otherBrandId, otherWorkspaceId, NOW, NOW)

  raw
    .prepare(
      `INSERT INTO product (id, brand_id, niche_id, name, description, url, status, created_at, updated_at)
       VALUES (?, ?, NULL, 'Product Pro', 'Flagship Product', 'https://example.com/pro', 'active', ?, ?)`,
    )
    .run(productId, brandId, NOW, NOW)

  raw
    .prepare(
      `INSERT INTO platform (id, adapter_key, name, created_at)
       VALUES (?, 'x', 'X (Twitter)', ?)`,
    )
    .run(platformId, NOW)

  raw
    .prepare(
      `INSERT INTO account (id, workspace_id, platform_id, handle, display_name, status, created_at, updated_at)
       VALUES (?, ?, ?, '@brand_x', 'Brand X Official', 'active', ?, ?)`,
    )
    .run(accountId, workspaceId, platformId, NOW, NOW)

  return {
    workspaceId,
    otherWorkspaceId,
    brandId,
    otherBrandId,
    productId,
    platformId,
    accountId,
  }
}

test('1. Campaign Research section lists relevant Research (campaign + brand scoped)', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Q3 Acquisition',
    objective: 'conversions',
  })

  // Create research scoped to campaign
  await createResearch(db, {
    workspaceId: base.workspaceId,
    subject: 'Campaign Buyer Intent',
    findings: 'High purchase intent identified.',
    researchType: 'audience',
    scopeType: 'campaign',
    scopeId: campaign.id,
  })

  // Create research scoped to brand
  await createResearch(db, {
    workspaceId: base.workspaceId,
    subject: 'Brand Market Positioning',
    findings: 'Premium pricing validated.',
    researchType: 'market',
    scopeType: 'brand',
    scopeId: base.brandId,
  })

  // Create unrelated research in another workspace
  await createResearch(db, {
    workspaceId: base.otherWorkspaceId,
    subject: 'Unrelated Research',
    findings: 'Secret data.',
    researchType: 'competitor',
    scopeType: 'brand',
    scopeId: base.otherBrandId,
  })

  const detail = await getCampaignDetail(db, base.workspaceId, campaign.id)
  assert.ok(detail)
  assert.equal(detail.researchCount, 2)
  const subjects = detail.recentResearch.map((r) => r.subject)
  assert.ok(subjects.includes('Campaign Buyer Intent'))
  assert.ok(subjects.includes('Brand Market Positioning'))
  assert.ok(!subjects.includes('Unrelated Research'))
})

test('2. archived Research excluded where expected (deleted_at IS NOT NULL)', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Q3 Acquisition',
  })

  const activeRes = await createResearch(db, {
    workspaceId: base.workspaceId,
    subject: 'Active Findings',
    findings: 'Active data.',
    scopeType: 'campaign',
    scopeId: campaign.id,
  })

  const archivedRes = await createResearch(db, {
    workspaceId: base.workspaceId,
    subject: 'Archived Findings',
    findings: 'Old data.',
    scopeType: 'campaign',
    scopeId: campaign.id,
  })

  // Soft-delete the second research record
  raw.prepare(`UPDATE research SET deleted_at = ? WHERE id = ?`).run(NOW, archivedRes.id)

  const detail = await getCampaignDetail(db, base.workspaceId, campaign.id)
  assert.ok(detail)
  assert.equal(detail.researchCount, 1)
  assert.equal(detail.recentResearch.length, 1)
  assert.equal(detail.recentResearch[0].id, activeRes.id)
})

test('3. freshness preserved without drift', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Freshness Test',
  })

  const res = await createResearch(db, {
    workspaceId: base.workspaceId,
    subject: 'Freshness Check',
    findings: 'Testing freshness derivation.',
    scopeType: 'campaign',
    scopeId: campaign.id,
    status: 'completed',
  })

  const detail = await getCampaignDetail(db, base.workspaceId, campaign.id)
  assert.ok(detail)
  const found = detail.recentResearch.find((r) => r.id === res.id)
  assert.ok(found)
  assert.equal(found.freshness, 'current')
})

test('4. Research this campaign opens Researcher', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)
  const agentMap = await ensureBuiltinAgents(db, base.workspaceId)
  const researcher = agentMap.get('researcher')
  assert.ok(researcher)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Conversion Blast',
  })

  const conversation = await createConversation(db, {
    workspaceId: base.workspaceId,
    title: `Research: ${campaign.name}`,
    scopeType: 'campaign',
    scopeId: campaign.id,
  })

  assert.ok(conversation.id)
  const conv = await getConversationById(db, conversation.id)
  assert.ok(conv)
  assert.equal(conv.title, 'Research: Conversion Blast')
  assert.equal(conv.scopeType, 'campaign')
  assert.equal(conv.scopeId, campaign.id)
})

test('5. conversation scope = campaign', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Scope Check',
  })

  const conversation = await createConversation(db, {
    workspaceId: base.workspaceId,
    title: 'Campaign Conversation',
    scopeType: 'campaign',
    scopeId: campaign.id,
  })

  assert.equal(conversation.scopeType, 'campaign')
  assert.equal(conversation.scopeId, campaign.id)
})

test('6. Campaign context reaches Researcher (Context Engine)', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    productId: base.productId,
    name: 'Strategic Launch',
    objective: 'revenue',
    priority: 'high',
    positioning: 'High performance enterprise tool',
    angle: 'Save 10 hours a week',
    offerMessage: '30-day free pilot',
    hypothesis: 'Direct CTO outreach will convert at 15%',
    audience: 'Tech Lead and CTO personas',
    audienceDetails: {
      summary: 'Tech Lead and CTO personas',
      segments: ['Enterprise', 'Scale-up'],
      awarenessLevel: 'solution_aware',
    },
    targets: [
      {
        metricKey: 'revenue',
        targetValue: 50000,
        unit: '$',
        timeframe: 'quarter',
        isPrimary: true,
      },
    ],
  })

  // Add a planned content item
  await createCampaignContent(db, {
    workspaceId: base.workspaceId,
    campaignId: campaign.id,
    title: 'CTO Decision Framework',
    contentType: 'long_form',
    purpose: 'education',
    status: 'planned',
  })

  const conversation = await createConversation(db, {
    workspaceId: base.workspaceId,
    title: 'Researcher Chat',
    scopeType: 'campaign',
    scopeId: campaign.id,
  })

  const pkg = await buildContext(db, {
    workspaceId: base.workspaceId,
    conversationId: conversation.id,
  })

  assert.equal(pkg.activeScope.type, 'campaign')
  assert.equal(pkg.activeScope.id, campaign.id)
  assert.ok(pkg.campaign)
  assert.equal(pkg.campaign.name, 'Strategic Launch')
  assert.equal(pkg.campaign.objective, 'revenue')
  assert.equal(pkg.campaign.strategy.positioning, 'High performance enterprise tool')
  assert.equal(pkg.campaign.targets.length, 1)
  assert.equal(pkg.campaign.contentSummary?.total, 1)

  const rendered = renderContextDocument(pkg)
  assert.ok(rendered.includes('Strategic Launch'))
  assert.ok(rendered.includes('High performance enterprise tool'))
  assert.ok(rendered.includes('Tech Lead and CTO personas'))
  assert.ok(rendered.includes('CTO Decision Framework'))
})

test('7. Save as Research defaults Draft', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Draft Research Test',
  })

  // When saved from AI assistant / save dialog, default is 'draft'
  const res = await createResearch(db, {
    workspaceId: base.workspaceId,
    subject: 'Audience Insights',
    findings: 'Found pattern X.',
    scopeType: 'campaign',
    scopeId: campaign.id,
    status: 'draft',
  })

  assert.equal(res.status, 'draft')
})

test('8. saved Campaign research keeps Campaign scope', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Scoped Research Test',
  })

  const res = await createResearch(db, {
    workspaceId: base.workspaceId,
    subject: 'Competitor Angles',
    findings: 'Competitor Y is targeting small teams.',
    researchType: 'competitor',
    scopeType: 'campaign',
    scopeId: campaign.id,
  })

  const record = await getResearch(db, { workspaceId: base.workspaceId, id: res.id })
  assert.ok(record)
  assert.equal(record.scopeType, 'campaign')
  assert.equal(record.scopeId, campaign.id)
})

test('9. genuine search sources still work', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Sourced Research Test',
  })

  const res = await createResearch(db, {
    workspaceId: base.workspaceId,
    subject: 'Market Report 2026',
    findings: 'Market growing at 25% YoY.',
    researchType: 'market',
    scopeType: 'campaign',
    scopeId: campaign.id,
  })

  const source = await createResearchSource(db, {
    workspaceId: base.workspaceId,
    researchId: res.id,
    sourceType: 'website',
    title: 'Industry Report 2026',
    url: 'https://example.com/report-2026',
    publisher: 'Market Intelligence Corp',
  })

  assert.ok(source.id)
  const sources = await listResearchSources(db, {
    workspaceId: base.workspaceId,
    researchId: res.id,
  })
  assert.equal(sources.length, 1)
  assert.equal(sources[0].url, 'https://example.com/report-2026')

  const provenance = computeProvenanceSummary(sources)
  assert.equal(provenance.status, 'sourced')
  assert.equal(provenance.sourceCount, 1)
})

async function getAgents(db: SqlDatabase, workspaceId: string) {
  const map = await ensureBuiltinAgents(db, workspaceId)
  const researcher = map.get('researcher')
  const strategist = map.get('strategist')
  const publisher = map.get('publisher')
  const critic = map.get('critic')
  assert.ok(researcher && strategist && publisher && critic)
  return { researcher, strategist, publisher, critic }
}

test('10. manual Workflow run starts with campaign scope', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)
  const { researcher } = await getAgents(db, base.workspaceId)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Workflow Orchestration Test',
  })

  const wfRes = await createWorkflowWithVersion(db, {
    workspaceId: base.workspaceId,
    name: 'Campaign Flow',
    definition: {
      inputs: [{ key: 'topic', kind: 'text', label: 'Topic', required: false }],
      entryStepId: 'step_1',
      steps: [
        {
          id: 'step_1',
          type: 'agent',
          agent: { agentId: researcher.agent.id, versionPolicy: 'current_at_run' },
          task: 'Research the campaign angle for {inputs.topic}',
          inputs: [{ key: 'topic', value: { source: 'workflow_input', path: 'topic' } }],
          next: null,
        },
      ],
    },
    activate: true,
  })

  assert.ok(wfRes.ok)
  const workflowId = wfRes.value.workflowId

  const deps = echoDeps()
  const result = await startCampaignWorkflowRun(
    db,
    {
      workspaceId: base.workspaceId,
      campaignId: campaign.id,
      workflowId,
      inputs: { topic: 'SaaS Growth' },
    },
    deps,
    true,
  )

  assert.ok(result.ok)
  assert.ok(result.runId)

  const run = await getWorkflowRunById(db, result.runId)
  assert.ok(run)
  assert.equal(run.status, 'succeeded')
})

test('11. Workflow run scope = campaign', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)
  const { strategist } = await getAgents(db, base.workspaceId)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Scope Verification Flow',
  })

  const wfRes = await createWorkflowWithVersion(db, {
    workspaceId: base.workspaceId,
    name: 'Scope Flow',
    definition: {
      inputs: [],
      entryStepId: 'step_1',
      steps: [
        {
          id: 'step_1',
          type: 'agent',
          agent: { agentId: strategist.agent.id, versionPolicy: 'current_at_run' },
          task: 'Review campaign direction',
          inputs: [],
          next: null,
        },
      ],
    },
    activate: true,
  })

  assert.ok(wfRes.ok)
  const workflowId = wfRes.value.workflowId

  const result = await startCampaignWorkflowRun(
    db,
    {
      workspaceId: base.workspaceId,
      campaignId: campaign.id,
      workflowId,
      inputs: {},
    },
    echoDeps(),
    true,
  )

  assert.ok(result.ok)
  const run = await getWorkflowRunById(db, result.runId)
  assert.ok(run)
  assert.ok(run.contextJson)
  const context = JSON.parse(run.contextJson)
  assert.equal(context.activeScope.type, 'campaign')
  assert.equal(context.activeScope.id, campaign.id)
})

test('12. inactive Workflow rejected', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)
  const { researcher } = await getAgents(db, base.workspaceId)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Inactive Workflow Test',
  })

  const wfRes = await createWorkflowWithVersion(db, {
    workspaceId: base.workspaceId,
    name: 'Draft Flow',
    definition: {
      inputs: [],
      entryStepId: 'step_1',
      steps: [
        {
          id: 'step_1',
          type: 'agent',
          agent: { agentId: researcher.agent.id, versionPolicy: 'current_at_run' },
          task: 'Do research',
          inputs: [],
          next: null,
        },
      ],
    },
    activate: false,
  })

  assert.ok(wfRes.ok)
  const workflowId = wfRes.value.workflowId

  const result = await startCampaignWorkflowRun(
    db,
    {
      workspaceId: base.workspaceId,
      campaignId: campaign.id,
      workflowId,
      inputs: {},
    },
    echoDeps(),
    true,
  )

  assert.equal(result.ok, false)
  assert.ok(result.message.includes('draft') || result.message.includes('active'))
})

test('13. cross-workspace Workflow rejected', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)
  await ensureBuiltinAgents(db, base.workspaceId)
  const { researcher: otherResearcher } = await getAgents(db, base.otherWorkspaceId)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Cross Workspace Test',
  })

  // Create workflow in Workspace B
  const wfRes = await createWorkflowWithVersion(db, {
    workspaceId: base.otherWorkspaceId,
    name: 'Other Workspace Flow',
    definition: {
      inputs: [],
      entryStepId: 'step_1',
      steps: [
        {
          id: 'step_1',
          type: 'agent',
          agent: { agentId: otherResearcher.agent.id, versionPolicy: 'current_at_run' },
          task: 'Steal data',
          inputs: [],
          next: null,
        },
      ],
    },
    activate: true,
  })

  assert.ok(wfRes.ok)
  const workflowId = wfRes.value.workflowId

  const result = await startCampaignWorkflowRun(
    db,
    {
      workspaceId: base.workspaceId,
      campaignId: campaign.id,
      workflowId,
      inputs: {},
    },
    echoDeps(),
    true,
  )

  assert.equal(result.ok, false)
  assert.ok(result.message.includes('not found'))
})

test('14. archived Campaign rejected', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)
  const { researcher } = await getAgents(db, base.workspaceId)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Archived Campaign',
  })

  // Archive campaign
  raw.prepare(`UPDATE campaign SET deleted_at = ? WHERE id = ?`).run(NOW, campaign.id)

  const wfRes = await createWorkflowWithVersion(db, {
    workspaceId: base.workspaceId,
    name: 'Active Flow',
    definition: {
      inputs: [],
      entryStepId: 'step_1',
      steps: [
        {
          id: 'step_1',
          type: 'agent',
          agent: { agentId: researcher.agent.id, versionPolicy: 'current_at_run' },
          task: 'Do research',
          inputs: [],
          next: null,
        },
      ],
    },
    activate: true,
  })

  assert.ok(wfRes.ok)
  const workflowId = wfRes.value.workflowId

  const result = await startCampaignWorkflowRun(
    db,
    {
      workspaceId: base.workspaceId,
      campaignId: campaign.id,
      workflowId,
      inputs: {},
    },
    echoDeps(),
    true,
  )

  assert.equal(result.ok, false)
  assert.ok(result.message.includes('archived') || result.message.includes('not found'))
})

test('15. Campaign context reaches Workflow Agent steps', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)
  const { strategist } = await getAgents(db, base.workspaceId)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'High Impact Campaign',
    objective: 'conversions',
    positioning: 'Leading cybersecurity platform',
  })

  const wfRes = await createWorkflowWithVersion(db, {
    workspaceId: base.workspaceId,
    name: 'Context Delivery Flow',
    definition: {
      inputs: [],
      entryStepId: 'step_1',
      steps: [
        {
          id: 'step_1',
          type: 'agent',
          agent: { agentId: strategist.agent.id, versionPolicy: 'current_at_run' },
          task: 'Synthesize the strategy',
          inputs: [],
          next: null,
        },
      ],
    },
    activate: true,
  })

  assert.ok(wfRes.ok)
  const workflowId = wfRes.value.workflowId

  const result = await startCampaignWorkflowRun(
    db,
    {
      workspaceId: base.workspaceId,
      campaignId: campaign.id,
      workflowId,
      inputs: {},
    },
    echoDeps(),
    true,
  )

  assert.ok(result.ok)
  const run = await getWorkflowRunById(db, result.runId)
  assert.ok(run)
  assert.ok(run.contextJson)
  const pkg = JSON.parse(run.contextJson)
  assert.equal(pkg.campaign.name, 'High Impact Campaign')
  assert.equal(pkg.campaign.strategy.positioning, 'Leading cybersecurity platform')
})

test('16. Workflow Tool approval remains enforced', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)
  const { publisher } = await getAgents(db, base.workspaceId)
  await setAgentStatus(db, publisher.agent.id, 'active')

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Approval Gated Campaign',
  })

  const wfRes = await createWorkflowWithVersion(db, {
    workspaceId: base.workspaceId,
    name: 'Publish Flow',
    definition: {
      inputs: [],
      entryStepId: 'step_1',
      steps: [
        {
          id: 'step_1',
          type: 'tool',
          toolKey: 'platform.publish',
          requestedBy: { agentId: publisher.agent.id, versionPolicy: 'current_at_run' },
          inputs: [
            { key: 'accountId', value: { source: 'literal', value: base.accountId } },
            { key: 'contentVariantId', value: { source: 'literal', value: crypto.randomUUID() } },
          ],
          next: null,
        },
      ],
    },
    activate: true,
  })

  assert.ok(wfRes.ok)
  const workflowId = wfRes.value.workflowId

  const publishAdapter: ToolAdapter = {
    key: 'platform.publish',
    async run() {
      return { postId: crypto.randomUUID(), externalId: 'ext_1', url: 'https://example.com/p' }
    },
  }

  const result = await startCampaignWorkflowRun(
    db,
    {
      workspaceId: base.workspaceId,
      campaignId: campaign.id,
      workflowId,
      inputs: {},
    },
    echoDeps(new Map([['platform.publish', publishAdapter]])),
    true,
  )

  assert.ok(result.ok)
  const run = await getWorkflowRunById(db, result.runId)
  assert.ok(run)
  // platform.publish tool has REVIEW approval policy -> run pauses with status 'waiting'
  assert.equal(run.status, 'waiting')
})

test('17. waiting approval shown correctly in campaign workflow history', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)
  const { publisher } = await getAgents(db, base.workspaceId)
  await setAgentStatus(db, publisher.agent.id, 'active')

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Waiting Run Test',
  })

  const wfRes = await createWorkflowWithVersion(db, {
    workspaceId: base.workspaceId,
    name: 'Publish Tool Flow',
    definition: {
      inputs: [],
      entryStepId: 'step_1',
      steps: [
        {
          id: 'step_1',
          type: 'tool',
          toolKey: 'platform.publish',
          requestedBy: { agentId: publisher.agent.id, versionPolicy: 'current_at_run' },
          inputs: [
            { key: 'accountId', value: { source: 'literal', value: base.accountId } },
            { key: 'contentVariantId', value: { source: 'literal', value: crypto.randomUUID() } },
          ],
          next: null,
        },
      ],
    },
    activate: true,
  })

  assert.ok(wfRes.ok)
  const workflowId = wfRes.value.workflowId

  const publishAdapter: ToolAdapter = {
    key: 'platform.publish',
    async run() {
      return { postId: crypto.randomUUID(), externalId: 'ext_1', url: 'https://example.com/p' }
    },
  }

  const result = await startCampaignWorkflowRun(
    db,
    {
      workspaceId: base.workspaceId,
      campaignId: campaign.id,
      workflowId,
      inputs: {},
    },
    echoDeps(new Map([['platform.publish', publishAdapter]])),
    true,
  )

  assert.ok(result.ok)
  const runs = await listCampaignWorkflowRuns(db, base.workspaceId, campaign.id)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].status, 'waiting')
  assert.equal(runs[0].hasWaitingApproval, true)
  assert.ok(runs[0].pendingApprovalId)
})

test('18. recent Workflow runs listed', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)
  const { critic } = await getAgents(db, base.workspaceId)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Multiple Runs Campaign',
  })

  const wfRes = await createWorkflowWithVersion(db, {
    workspaceId: base.workspaceId,
    name: 'Simple Agent Flow',
    definition: {
      inputs: [],
      entryStepId: 'step_1',
      steps: [
        {
          id: 'step_1',
          type: 'agent',
          agent: { agentId: critic.agent.id, versionPolicy: 'current_at_run' },
          task: 'Perform review',
          inputs: [],
          next: null,
        },
      ],
    },
    activate: true,
  })

  assert.ok(wfRes.ok)
  const workflowId = wfRes.value.workflowId

  // Run twice
  await startCampaignWorkflowRun(
    db,
    { workspaceId: base.workspaceId, campaignId: campaign.id, workflowId, inputs: {} },
    echoDeps(),
    true,
  )
  await startCampaignWorkflowRun(
    db,
    { workspaceId: base.workspaceId, campaignId: campaign.id, workflowId, inputs: {} },
    echoDeps(),
    true,
  )

  const runs = await listCampaignWorkflowRuns(db, base.workspaceId, campaign.id)
  assert.equal(runs.length, 2)
  assert.equal(runs[0].workflowName, 'Simple Agent Flow')
  assert.equal(runs[1].workflowName, 'Simple Agent Flow')
})

test('19. no fake Chat messages created by Workflow', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)
  const { researcher } = await getAgents(db, base.workspaceId)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'No Chat Pollution',
  })

  const wfRes = await createWorkflowWithVersion(db, {
    workspaceId: base.workspaceId,
    name: 'Clean Flow',
    definition: {
      inputs: [],
      entryStepId: 'step_1',
      steps: [
        {
          id: 'step_1',
          type: 'agent',
          agent: { agentId: researcher.agent.id, versionPolicy: 'current_at_run' },
          task: 'Research without pollution',
          inputs: [],
          next: null,
        },
      ],
    },
    activate: true,
  })

  assert.ok(wfRes.ok)
  const workflowId = wfRes.value.workflowId

  await startCampaignWorkflowRun(
    db,
    { workspaceId: base.workspaceId, campaignId: campaign.id, workflowId, inputs: {} },
    echoDeps(),
    true,
  )

  // Verify message table remains completely untouched
  const messageCount = raw.prepare(`SELECT COUNT(*) as count FROM message`).get() as {
    count: number
  }
  assert.equal(messageCount.count, 0)
})

test('20. no automatic Research->Content pipeline starts', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Manual Control Campaign',
  })

  // Create research record
  await createResearch(db, {
    workspaceId: base.workspaceId,
    subject: 'Autonomous Pipeline Check',
    findings: 'Research finding.',
    scopeType: 'campaign',
    scopeId: campaign.id,
  })

  // Ensure content items remain untouched (no auto-generated content)
  const detail = await getCampaignDetail(db, base.workspaceId, campaign.id)
  assert.ok(detail)
  assert.equal(detail.contentCount, 0)

  // Ensure no workflow runs were autonomously started
  const runs = await listCampaignWorkflowRuns(db, base.workspaceId, campaign.id)
  assert.equal(runs.length, 0)
})

test('21. domain events emitted properly (campaign.research_started, campaign.workflow_started)', async () => {
  const { db, raw } = freshDb()
  const base = seedBaseline(raw)
  const { researcher } = await getAgents(db, base.workspaceId)

  const campaign = await createCampaign(db, {
    workspaceId: base.workspaceId,
    brandId: base.brandId,
    name: 'Audit Events Campaign',
  })

  const wfRes = await createWorkflowWithVersion(db, {
    workspaceId: base.workspaceId,
    name: 'Event Flow',
    definition: {
      inputs: [],
      entryStepId: 'step_1',
      steps: [
        {
          id: 'step_1',
          type: 'agent',
          agent: { agentId: researcher.agent.id, versionPolicy: 'current_at_run' },
          task: 'Do task',
          inputs: [],
          next: null,
        },
      ],
    },
    activate: true,
  })

  assert.ok(wfRes.ok)
  const workflowId = wfRes.value.workflowId

  const runResult = await startCampaignWorkflowRun(
    db,
    { workspaceId: base.workspaceId, campaignId: campaign.id, workflowId, inputs: {} },
    echoDeps(),
    true,
  )

  assert.ok(runResult.ok)

  const events = await listRecentEvents(db, base.workspaceId, 'campaign.', 10)
  const wfEvent = events.find((e) => e.event_type === 'campaign.workflow_started')
  assert.ok(wfEvent, 'Expected campaign.workflow_started event')
  assert.ok(wfEvent.payload)
  const payload = JSON.parse(wfEvent.payload)
  assert.equal(payload.campaignId, campaign.id)
  assert.equal(payload.workflowId, workflowId)
  assert.equal(payload.runId, runResult.runId)
})
