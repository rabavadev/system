import type {
  AgentExecutionType,
  CampaignObjective,
  CampaignPriority,
  ConversationScopeType,
} from '~/types/domain'

import {
  parseCampaignAudience,
  parseCampaignStrategy,
  parseCampaignTargets,
} from '../db/campaign.ts'
import {
  getContextAccount,
  getContextAgent,
  getContextAgentNames,
  getContextBrand,
  getContextCampaign,
  getContextCampaignContentPlan,
  getContextConnectionStatus,
  getContextNiche,
  getContextPlatform,
  getContextProduct,
  getContextWorkspace,
  getDefaultContextWorkspace,
  listContextAccountNiches,
  listGoalCandidates,
  listIneligibleMemories,
  listIneligibleResearch,
  listMemoryCandidates,
  listResearchCandidates,
  type ScopePair,
} from '../db/context.ts'
import { getConversationById } from '../db/conversation.ts'
import { listRecentMessages } from '../db/message.ts'
import { nowIso, type SqlDatabase } from '../db/sql.ts'
import {
  GOAL_CANDIDATE_MULTIPLIER,
  MEMORY_CANDIDATE_MULTIPLIER,
  RESEARCH_CANDIDATE_MULTIPLIER,
  resolveLimits,
  TRACE_EXCLUSION_SAMPLE,
} from './config.ts'
import { ContextError } from './errors.ts'
import { researchFreshness } from './freshness.ts'
import {
  compareGoals,
  compareMemories,
  compareResearch,
  MEMORY_AUTHORITY_LABEL,
} from './ranking.ts'
import {
  assertEntityWorkspace,
  checkAccountBrand,
  checkCampaignAlignment,
  checkNicheBrand,
  checkProductAlignment,
  decideScopeSource,
  deriveAccountBrandId,
  isAccountArchived,
  isBrandArchived,
  isCampaignArchived,
  isNicheArchived,
  isProductArchived,
  mostSpecificScope,
  type ScopedAccount,
  type ScopedBrand,
  type ScopedCampaign,
  type ScopedNiche,
  type ScopedProduct,
} from './scope.ts'
import type {
  AccountContext,
  AgentContext,
  ContextGoal,
  ContextMemory,
  ContextMessage,
  ContextPackage,
  ContextRequest,
  ContextResearch,
  ContextScopeSource,
  ContextTraceEntry,
  ConversationContext,
  PlatformContext,
  ScopeRef,
  WorkspaceContext,
} from './types.ts'

/**
 * The Context Engine. ONE shared context source for every future AI
 * execution (Chief, specialists, routers, workflows): callers describe
 * what they have (a conversation, an explicit product, a UI selection...)
 * and receive a resolved, validated, ranked, bounded, fully explained
 * ContextPackage. No provider types, no prompt strings, no secrets.
 *
 * Pipeline:
 *   1. load + validate conversation and workspace
 *   2. load explicitly referenced entities (unknown / archived / foreign
 *      workspace → typed ContextError)
 *   3. load the persisted conversation scope and the UI selection
 *   4. deterministic precedence: explicit > conversation > ui > workspace
 *   5. validate every relationship; conflicts reject, never guess
 *   6. retrieve bounded messages / memories / research / goals
 *   7. assemble the package + developer trace
 *
 * Documented edge decisions (docs/context-engine.md):
 *   - an EXPLICIT reference to an archived entity is a controlled
 *     'entity_archived' error;
 *   - a persisted conversation scope pointing at an archived/gone entity
 *     is treated as historical reference: excluded with a trace entry,
 *     resolution continues at the next precedence level;
 *   - a DERIVED parent that has since been archived (e.g. active product
 *     under an archived brand) is excluded with a trace note rather than
 *     silently loaded.
 */

type TraceAction = ContextTraceEntry['action']

class Trace {
  readonly entries: ContextTraceEntry[] = []
  add(
    action: TraceAction,
    targetType: string,
    targetId: string | null,
    label: string | null,
    reason: string,
  ): void {
    this.entries.push({ action, targetType, targetId, label, reason })
  }
}

function notFoundError(entityType: string, id: string): ContextError {
  return new ContextError('entity_not_found', `That ${entityType} could not be found.`, {
    type: entityType,
    id,
  })
}

/** Explicit reference to an archived entity: controlled error, traced. */
function archivedError(
  trace: Trace,
  entityType: string,
  id: string,
  label: string | null,
): ContextError {
  trace.add(
    'excluded',
    entityType,
    id,
    label,
    'Archived entities are not loaded into active context.',
  )
  return new ContextError(
    'entity_archived',
    `That ${entityType} is archived. Restore it before using it as context.`,
    { type: entityType, id },
  )
}

/** The resolved entity graph that drives package assembly and retrieval. */
interface ResolvedGraph {
  source: ContextScopeSource
  brand: ScopedBrand | null
  niche: ScopedNiche | null
  product: ScopedProduct | null
  account: ScopedAccount | null
  campaign: ScopedCampaign | null
}

export async function buildContext(
  db: SqlDatabase,
  request: ContextRequest,
): Promise<ContextPackage> {
  const limits = resolveLimits(request.limits)
  const now = nowIso()
  const trace = new Trace()

  /* ---- 1. Conversation ---- */
  let conversation: ConversationContext | null = null
  let conversationWorkspaceId: string | null = null
  let conversationScope: { scopeType: ConversationScopeType; scopeId: string } | null = null
  if (request.conversationId) {
    const row = await getConversationById(db, request.conversationId)
    if (!row) {
      throw notFoundError('conversation', request.conversationId)
    }
    if (row.deletedAt) {
      throw archivedError(trace, 'conversation', row.id, row.title)
    }
    conversationWorkspaceId = row.workspaceId
    conversation = {
      id: row.id,
      title: row.title,
      scopeType: row.scopeType,
      scopeId: row.scopeId,
      createdAt: row.createdAt,
    }
    if (row.scopeType && row.scopeId) {
      conversationScope = { scopeType: row.scopeType, scopeId: row.scopeId }
    }
    trace.add('included', 'conversation', row.id, row.title, 'Requested conversation.')
  }

  /* ---- 2. Workspace ---- */
  if (
    request.workspaceId &&
    conversationWorkspaceId &&
    request.workspaceId !== conversationWorkspaceId
  ) {
    throw new ContextError(
      'workspace_mismatch',
      'The conversation belongs to a different workspace.',
      { type: 'conversation', id: request.conversationId ?? '' },
    )
  }
  const workspaceCandidate = request.workspaceId ?? conversationWorkspaceId
  let workspaceRow: Awaited<ReturnType<typeof getContextWorkspace>>
  if (workspaceCandidate) {
    workspaceRow = await getContextWorkspace(db, workspaceCandidate)
    if (!workspaceRow) {
      throw notFoundError('workspace', workspaceCandidate)
    }
  } else {
    workspaceRow = await getDefaultContextWorkspace(db)
    if (!workspaceRow) {
      throw new ContextError('workspace_not_found', 'No workspace is set up yet.')
    }
  }
  if (conversationWorkspaceId && workspaceRow.id !== conversationWorkspaceId) {
    throw new ContextError(
      'workspace_mismatch',
      'The conversation belongs to a different workspace.',
      { type: 'conversation', id: request.conversationId ?? '' },
    )
  }
  if (workspaceRow.deleted_at) {
    throw archivedError(trace, 'workspace', workspaceRow.id, workspaceRow.name)
  }
  const workspaceId = workspaceRow.id
  const workspace: WorkspaceContext = {
    id: workspaceRow.id,
    name: workspaceRow.name,
    slug: workspaceRow.slug,
  }
  trace.add(
    'included',
    'workspace',
    workspaceId,
    workspace.name,
    request.workspaceId ? 'Explicitly requested.' : 'Resolved as the active workspace.',
  )

  /* ---- 3. Explicitly referenced entities ---- */
  const explicit = await loadExplicitEntities(db, trace, workspaceId, request)

  /* ---- 4. Persisted conversation scope (source 2) ---- */
  const conv = await loadConversationScope(db, trace, workspaceId, conversationScope)

  /* ---- 5. UI selection (source 3) ---- */
  let uiBrand: ScopedBrand | null = null
  if (request.uiSelection?.brandId) {
    const row = await getContextBrand(db, request.uiSelection.brandId)
    if (!row || row.workspace_id !== workspaceId || row.deleted_at) {
      trace.add(
        'excluded',
        'brand',
        request.uiSelection.brandId,
        row?.name ?? null,
        'UI-selected brand is not available in this workspace; ignoring it.',
      )
    } else {
      uiBrand = {
        id: row.id,
        workspaceId: row.workspace_id,
        name: row.name,
        description: row.description,
        deletedAt: row.deleted_at,
      }
    }
  }

  /* ---- 6. Precedence ---- */
  const hasExplicit = Boolean(
    explicit.brand || explicit.niche || explicit.product || explicit.account || explicit.campaign,
  )
  const hasConversationScope = Boolean(
    conv.brand || conv.niche || conv.product || conv.account || conv.campaign,
  )
  const source = decideScopeSource({
    hasExplicit,
    hasConversationScope,
    hasUiBrand: uiBrand !== null,
  })

  /* ---- 7. Graph resolution + validation ---- */
  let graph: ResolvedGraph
  if (source === 'explicit') {
    graph = await resolveExplicitGraph(db, trace, workspaceId, explicit, conv)
    if (uiBrand) {
      trace.add(
        'precedence',
        'brand',
        uiBrand.id,
        uiBrand.name,
        'UI-selected brand ignored: explicit request context wins.',
      )
    }
  } else if (source === 'conversation') {
    graph = await resolveConversationGraph(db, trace, workspaceId, conv)
    if (uiBrand && uiBrand.id !== graph.brand?.id) {
      trace.add(
        'precedence',
        'brand',
        uiBrand.id,
        uiBrand.name,
        'UI-selected brand ignored: the conversation has a persisted scope.',
      )
    }
  } else if (source === 'ui' && uiBrand) {
    graph = { source, brand: uiBrand, niche: null, product: null, account: null, campaign: null }
    trace.add(
      'precedence',
      'brand',
      uiBrand.id,
      uiBrand.name,
      'No explicit or conversation scope: using the UI-selected brand as contextual state.',
    )
  } else {
    graph = {
      source: 'workspace',
      brand: null,
      niche: null,
      product: null,
      account: null,
      campaign: null,
    }
    trace.add(
      'note',
      'workspace',
      workspaceId,
      workspace.name,
      'No explicit, conversation or UI scope: workspace-level context.',
    )
  }

  for (const [entity, label] of [
    [graph.brand, 'brand'],
    [graph.niche, 'niche'],
    [graph.product, 'product'],
    [graph.account, 'account'],
    [graph.campaign, 'campaign'],
  ] as const) {
    if (entity) {
      trace.add('included', label, entity.id, entityName(entity), `${source} scope resolution.`)
    }
  }

  /* ---- 8. Conversation messages ---- */
  let recentMessages: ContextMessage[] = []
  if (conversation) {
    const rows = await listRecentMessages(db, conversation.id, limits.recentMessages)
    // Resolve authoring agent names so the transcript labels WHO answered
    // (Chief, Critic, ...) instead of flattening every reply to one label.
    const agentNames = await getContextAgentNames(
      db,
      rows.map((m) => m.agentId).filter((id): id is string => id !== null),
    )
    recentMessages = rows.map((m) => ({
      id: m.id,
      senderType: m.senderType,
      agentId: m.agentId,
      agentName: m.agentId ? (agentNames.get(m.agentId) ?? null) : null,
      content: m.content,
      createdAt: m.createdAt,
    }))
    trace.add(
      'included',
      'message',
      null,
      null,
      `${recentMessages.length} most recent message(s), chronological (limit ${limits.recentMessages}).`,
    )
  }

  /* ---- 9. Platform (safe metadata only) ---- */
  let platform: PlatformContext | null = null
  if (request.platformId) {
    const row = await getContextPlatform(db, request.platformId)
    if (!row) {
      throw notFoundError('platform', request.platformId)
    }
    platform = { id: row.id, name: row.name, connectionStatus: null }
    trace.add('included', 'platform', platform.id, platform.name, 'Explicit platform reference.')
  }
  if (graph.account) {
    const accountRow = await getContextAccount(db, graph.account.id)
    if (accountRow) {
      const platformRow = await getContextPlatform(db, accountRow.platform_id)
      if (platformRow) {
        if (platform && platform.id !== platformRow.id) {
          throw new ContextError(
            'scope_conflict',
            'The requested platform does not match the account’s platform.',
            { type: 'platform', id: platform.id },
          )
        }
        platform = {
          id: platformRow.id,
          name: platformRow.name,
          connectionStatus: await getContextConnectionStatus(db, graph.account.id),
        }
        trace.add(
          'included',
          'platform',
          platform.id,
          platform.name,
          'Account platform (safe metadata only).',
        )
      }
    }
  }

  /* ---- 10. Retrieval scope set ---- */
  const scopes: ScopePair[] = [{ scopeType: 'workspace', scopeId: null }]
  if (graph.brand) scopes.push({ scopeType: 'brand', scopeId: graph.brand.id })
  if (graph.niche) scopes.push({ scopeType: 'niche', scopeId: graph.niche.id })
  if (graph.product) scopes.push({ scopeType: 'product', scopeId: graph.product.id })
  if (graph.account) {
    scopes.push({ scopeType: 'account', scopeId: graph.account.id })
    for (const n of graph.account.niches) {
      if (n.deletedAt === null && n.id !== graph.niche?.id) {
        scopes.push({ scopeType: 'niche', scopeId: n.id })
      }
    }
  }
  if (graph.campaign) scopes.push({ scopeType: 'campaign', scopeId: graph.campaign.id })
  if (platform && !scopes.some((s) => s.scopeType === 'platform' && s.scopeId === platform.id)) {
    scopes.push({ scopeType: 'platform', scopeId: platform.id })
  }

  /* ---- 11. Memories ---- */
  const memories = await resolveMemories(db, trace, workspaceId, scopes, limits.maxMemories, now)

  /* ---- 12. Research ---- */
  const research = await resolveResearch(
    db,
    trace,
    workspaceId,
    scopes,
    limits.maxResearch,
    limits.researchAgingDays,
    now,
  )

  /* ---- 13. Goals ---- */
  const goals = await resolveGoals(db, trace, workspaceId, scopes, limits.maxGoals)

  /* ---- 14. Package ---- */
  const activeScope: ScopeRef = mostSpecificScope({
    campaignId: graph.campaign?.id ?? null,
    productId: graph.product?.id ?? null,
    accountId: graph.account?.id ?? null,
    nicheId: graph.niche?.id ?? null,
    brandId: graph.brand?.id ?? null,
  })

  const account: AccountContext | null = graph.account
    ? {
        id: graph.account.id,
        handle: graph.account.handle,
        displayName: graph.account.displayName,
        status: graph.account.status as AccountContext['status'],
        nicheIds: graph.account.niches.filter((n) => n.deletedAt === null).map((n) => n.id),
        platform: platform ?? { id: '', name: 'Unknown platform', connectionStatus: null },
      }
    : null

  return {
    generatedAt: now,
    workspace,
    activeScope,
    scopeSource: graph.source,
    brand: graph.brand
      ? { id: graph.brand.id, name: graph.brand.name, description: graph.brand.description }
      : null,
    niche: graph.niche
      ? {
          id: graph.niche.id,
          brandId: graph.niche.brandId,
          name: graph.niche.name,
          description: graph.niche.description,
        }
      : null,
    product: graph.product
      ? {
          id: graph.product.id,
          brandId: graph.product.brandId,
          nicheId: graph.product.nicheId,
          name: graph.product.name,
          description: graph.product.description,
          url: graph.product.url,
          status: graph.product.status as 'draft' | 'active' | 'archived',
        }
      : null,
    account,
    platform,
    campaign: graph.campaign
      ? {
          id: graph.campaign.id,
          name: graph.campaign.name,
          status: graph.campaign.status as 'draft' | 'active' | 'paused' | 'completed' | 'archived',
          brandId: graph.campaign.brandId,
          productId: graph.campaign.productId,
          objective: (graph.campaign.objective as CampaignObjective | null) ?? null,
          priority: (graph.campaign.priority as CampaignPriority) ?? 'normal',
          audience: parseCampaignAudience({
            audience: graph.campaign.audience,
            audienceJson: graph.campaign.audienceJson,
          }),
          strategy: parseCampaignStrategy({
            positioning: graph.campaign.positioning,
            angle: graph.campaign.angle,
            offerMessage: graph.campaign.offerMessage,
            hypothesis: graph.campaign.hypothesis,
          }),
          targets: parseCampaignTargets({
            targetsJson: graph.campaign.targetsJson,
          }),
          contentSummary: await getContextCampaignContentPlan(db, graph.campaign.id),
          startsAt: graph.campaign.startsAt,
          endsAt: graph.campaign.endsAt,
        }
      : null,
    agent: explicit.agent,
    conversation,
    recentMessages,
    memories,
    research,
    goals,
    currentTask: request.task ?? null,
    metadata: {
      limits,
      counts: {
        messages: recentMessages.length,
        memories: memories.length,
        research: research.length,
        goals: goals.length,
      },
    },
    trace: {
      request: {
        workspaceId: request.workspaceId ?? null,
        conversationId: request.conversationId ?? null,
        brandId: request.brandId ?? null,
        nicheId: request.nicheId ?? null,
        productId: request.productId ?? null,
        accountId: request.accountId ?? null,
        campaignId: request.campaignId ?? null,
        agentId: request.agentId ?? null,
        platformId: request.platformId ?? null,
        uiBrandId: request.uiSelection?.brandId ?? null,
      },
      scopeSource: graph.source,
      entries: trace.entries,
    },
  }
}

/* ---- entity loading ---- */

interface ExplicitEntities {
  brand: ScopedBrand | null
  niche: ScopedNiche | null
  product: ScopedProduct | null
  account: ScopedAccount | null
  campaign: ScopedCampaign | null
  agent: AgentContext | null
}

async function loadScopedAccount(
  db: SqlDatabase,
  id: string,
): Promise<(ScopedAccount & { platformId: string }) | null> {
  const row = await getContextAccount(db, id)
  if (!row) {
    return null
  }
  const nicheRows = await listContextAccountNiches(db, row.id)
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    handle: row.handle,
    displayName: row.display_name,
    status: row.status,
    deletedAt: row.deleted_at,
    primaryNicheId: row.primary_niche_id,
    niches: nicheRows.map((n) => ({ id: n.id, brandId: n.brand_id, deletedAt: n.deleted_at })),
    platformId: row.platform_id,
  }
}

async function loadExplicitEntities(
  db: SqlDatabase,
  trace: Trace,
  workspaceId: string,
  request: ContextRequest,
): Promise<ExplicitEntities> {
  let brand: ScopedBrand | null = null
  if (request.brandId) {
    const row = await getContextBrand(db, request.brandId)
    if (!row) throw notFoundError('brand', request.brandId)
    brand = {
      id: row.id,
      workspaceId: row.workspace_id,
      name: row.name,
      description: row.description,
      deletedAt: row.deleted_at,
    }
    assertEntityWorkspace(brand.workspaceId, workspaceId, 'brand', brand.id)
    if (isBrandArchived(brand)) throw archivedError(trace, 'brand', brand.id, brand.name)
  }

  let niche: ScopedNiche | null = null
  if (request.nicheId) {
    const row = await getContextNiche(db, request.nicheId)
    if (!row) throw notFoundError('niche', request.nicheId)
    niche = {
      id: row.id,
      brandId: row.brand_id,
      name: row.name,
      description: row.description,
      deletedAt: row.deleted_at,
    }
    // Niches carry no workspace_id; the owning brand defines the boundary.
    const nicheBrand = await getContextBrand(db, row.brand_id)
    if (!nicheBrand) {
      throw notFoundError('brand', row.brand_id)
    }
    assertEntityWorkspace(nicheBrand.workspace_id, workspaceId, 'niche', niche.id)
    if (nicheBrand.deleted_at) {
      throw archivedError(trace, 'brand', nicheBrand.id, nicheBrand.name)
    }
    if (isNicheArchived(niche)) throw archivedError(trace, 'niche', niche.id, niche.name)
  }

  let product: ScopedProduct | null = null
  if (request.productId) {
    const row = await getContextProduct(db, request.productId)
    if (!row) throw notFoundError('product', request.productId)
    product = {
      id: row.id,
      brandId: row.brand_id,
      nicheId: row.niche_id,
      name: row.name,
      description: row.description,
      url: row.url,
      status: row.status,
      deletedAt: row.deleted_at,
    }
    // Products carry no workspace_id; the owning brand defines the boundary.
    const productBrand = await getContextBrand(db, row.brand_id)
    if (productBrand) {
      assertEntityWorkspace(productBrand.workspace_id, workspaceId, 'product', product.id)
    }
    if (isProductArchived(product)) throw archivedError(trace, 'product', product.id, product.name)
  }

  let account: ScopedAccount | null = null
  if (request.accountId) {
    const loaded = await loadScopedAccount(db, request.accountId)
    if (!loaded) throw notFoundError('account', request.accountId)
    account = loaded
    assertEntityWorkspace(account.workspaceId, workspaceId, 'account', account.id)
    if (isAccountArchived(account)) {
      throw archivedError(trace, 'account', account.id, account.handle)
    }
    const archivedLinks = account.niches.filter((n) => n.deletedAt !== null).length
    if (archivedLinks > 0) {
      trace.add(
        'note',
        'account',
        account.id,
        account.handle,
        `${archivedLinks} archived niche link(s) ignored.`,
      )
    }
  }

  let campaign: ScopedCampaign | null = null
  if (request.campaignId) {
    const row = await getContextCampaign(db, request.campaignId)
    if (!row) throw notFoundError('campaign', request.campaignId)
    campaign = {
      id: row.id,
      workspaceId: row.workspace_id,
      brandId: row.brand_id,
      productId: row.product_id,
      name: row.name,
      audience: row.audience,
      angle: row.angle,
      objective: row.objective,
      priority: row.priority,
      positioning: row.positioning,
      offerMessage: row.offer_message,
      hypothesis: row.hypothesis,
      audienceJson: row.audience_json,
      targetsJson: row.targets_json,
      status: row.status,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      deletedAt: row.deleted_at,
    }
    assertEntityWorkspace(campaign.workspaceId, workspaceId, 'campaign', campaign.id)
    if (isCampaignArchived(campaign)) {
      throw archivedError(trace, 'campaign', campaign.id, campaign.name)
    }
  }

  let agent: AgentContext | null = null
  if (request.agentId) {
    const row = await getContextAgent(db, request.agentId)
    if (!row) throw notFoundError('agent', request.agentId)
    assertEntityWorkspace(row.workspace_id, workspaceId, 'agent', row.id)
    if (row.status === 'archived' || row.deleted_at) {
      throw archivedError(trace, 'agent', row.id, row.name)
    }
    agent = {
      id: row.id,
      name: row.name,
      role: row.role,
      executionType: row.execution_type as AgentExecutionType,
    }
    trace.add(
      'included',
      'agent',
      agent.id,
      agent.name,
      'Structural agent identity (no execution config).',
    )
  }

  return { brand, niche, product, account, campaign, agent }
}

interface ConvEntities {
  brand: ScopedBrand | null
  niche: ScopedNiche | null
  product: ScopedProduct | null
  account: ScopedAccount | null
  campaign: ScopedCampaign | null
}

/**
 * Load the persisted conversation scope target. A missing or archived
 * target is NOT an error: the conversation keeps working, the scope is
 * treated as historical reference, and the trace explains the exclusion.
 */
async function loadConversationScope(
  db: SqlDatabase,
  trace: Trace,
  workspaceId: string,
  scope: { scopeType: ConversationScopeType; scopeId: string } | null,
): Promise<ConvEntities> {
  const empty: ConvEntities = {
    brand: null,
    niche: null,
    product: null,
    account: null,
    campaign: null,
  }
  if (!scope) {
    return empty
  }
  const { scopeType, scopeId } = scope
  const gone = (type: string) =>
    trace.add(
      'excluded',
      type,
      scopeId,
      null,
      'Conversation scope target no longer exists; ignoring the persisted scope.',
    )
  const archived = (type: string, label: string | null) =>
    trace.add(
      'excluded',
      type,
      scopeId,
      label,
      'Conversation scope target is archived; treating it as historical reference only.',
    )

  if (scopeType === 'brand') {
    const row = await getContextBrand(db, scopeId)
    if (!row) {
      gone('brand')
      return empty
    }
    if (row.workspace_id !== workspaceId) {
      throw new ContextError(
        'conversation_mismatch',
        'The conversation scope belongs to a different workspace.',
        { type: 'brand', id: scopeId },
      )
    }
    if (row.deleted_at) {
      archived('brand', row.name)
      return empty
    }
    return {
      ...empty,
      brand: {
        id: row.id,
        workspaceId: row.workspace_id,
        name: row.name,
        description: row.description,
        deletedAt: row.deleted_at,
      },
    }
  }

  if (scopeType === 'niche') {
    const row = await getContextNiche(db, scopeId)
    if (!row) {
      gone('niche')
      return empty
    }
    const brandRow = await getContextBrand(db, row.brand_id)
    if (!brandRow || brandRow.workspace_id !== workspaceId) {
      throw new ContextError(
        'conversation_mismatch',
        'The conversation scope belongs to a different workspace.',
        { type: 'niche', id: scopeId },
      )
    }
    if (row.deleted_at || brandRow.deleted_at) {
      archived('niche', row.name)
      return empty
    }
    return {
      ...empty,
      niche: {
        id: row.id,
        brandId: row.brand_id,
        name: row.name,
        description: row.description,
        deletedAt: row.deleted_at,
      },
    }
  }

  if (scopeType === 'product') {
    const row = await getContextProduct(db, scopeId)
    if (!row) {
      gone('product')
      return empty
    }
    if (row.status === 'archived' || row.deleted_at) {
      archived('product', row.name)
      return empty
    }
    return {
      ...empty,
      product: {
        id: row.id,
        brandId: row.brand_id,
        nicheId: row.niche_id,
        name: row.name,
        description: row.description,
        url: row.url,
        status: row.status,
        deletedAt: row.deleted_at,
      },
    }
  }

  if (scopeType === 'account') {
    const loaded = await loadScopedAccount(db, scopeId)
    if (!loaded) {
      gone('account')
      return empty
    }
    if (loaded.workspaceId !== workspaceId) {
      throw new ContextError(
        'conversation_mismatch',
        'The conversation scope belongs to a different workspace.',
        { type: 'account', id: scopeId },
      )
    }
    if (isAccountArchived(loaded)) {
      archived('account', loaded.handle)
      return empty
    }
    return { ...empty, account: loaded }
  }

  // campaign
  const row = await getContextCampaign(db, scopeId)
  if (!row) {
    gone('campaign')
    return empty
  }
  if (row.workspace_id !== workspaceId) {
    throw new ContextError(
      'conversation_mismatch',
      'The conversation scope belongs to a different workspace.',
      { type: 'campaign', id: scopeId },
    )
  }
  if (row.status === 'archived' || row.deleted_at) {
    archived('campaign', row.name)
    return empty
  }
  return {
    ...empty,
    campaign: {
      id: row.id,
      workspaceId: row.workspace_id,
      brandId: row.brand_id,
      productId: row.product_id,
      name: row.name,
      audience: row.audience,
      angle: row.angle,
      objective: row.objective,
      priority: row.priority,
      positioning: row.positioning,
      offerMessage: row.offer_message,
      hypothesis: row.hypothesis,
      audienceJson: row.audience_json,
      targetsJson: row.targets_json,
      status: row.status,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      deletedAt: row.deleted_at,
    },
  }
}

/* ---- graph resolution ---- */

/**
 * Explicit source: validate every pairwise relationship, derive the parent
 * chain, and prove compatibility with any persisted conversation scope.
 */
async function resolveExplicitGraph(
  db: SqlDatabase,
  trace: Trace,
  workspaceId: string,
  explicit: ExplicitEntities,
  conv: ConvEntities,
): Promise<ResolvedGraph> {
  const { brand, niche, product, account, campaign } = explicit

  // Pairwise validation.
  if (brand && niche) checkNicheBrand(niche, brand)
  if (product) checkProductAlignment(product, brand, niche)
  if (niche && account) checkAccountBrand(account, niche.brandId)
  if (brand && account) checkAccountBrand(account, brand.id)
  if (campaign) {
    checkCampaignAlignment(campaign, brand, product)
    if (!brand && niche && campaign.brandId && campaign.brandId !== niche.brandId) {
      throw new ContextError(
        'scope_conflict',
        'That campaign belongs to a different brand than the requested niche.',
        { type: 'campaign', id: campaign.id },
      )
    }
    if (!brand && account && campaign.brandId) checkAccountBrand(account, campaign.brandId)
  }

  // Derive the brand.
  let brandId = brand?.id ?? null
  if (!brandId && product) brandId = product.brandId
  if (!brandId && niche) brandId = niche.brandId
  if (!brandId && campaign?.brandId) brandId = campaign.brandId
  if (!brandId && account) brandId = deriveAccountBrandId(account)
  if (brandId && account) checkAccountBrand(account, brandId)

  // Derive the niche: explicit > product's niche > account's primary niche.
  let nicheId = niche?.id ?? null
  if (!nicheId && product?.nicheId) nicheId = product.nicheId
  if (!nicheId && account?.primaryNicheId) {
    const primary = account.niches.find((n) => n.id === account.primaryNicheId)
    if (primary && primary.deletedAt === null && (!brandId || primary.brandId === brandId)) {
      nicheId = primary.id
    }
  }

  // Derive the product from the campaign when not explicit.
  const productId = product?.id ?? campaign?.productId ?? null

  const graph: ResolvedGraph = {
    source: 'explicit',
    brand: brand,
    niche,
    product,
    account,
    campaign,
  }
  await completeGraph(db, trace, workspaceId, graph, { brandId, nicheId, productId })

  // The persisted conversation scope must agree with explicit context.
  assertConversationCompatible(graph, conv)

  if (account && !graph.brand && account.niches.some((n) => n.deletedAt === null)) {
    trace.add(
      'note',
      'account',
      account.id,
      account.handle,
      'Account niches span multiple brands; no single brand derived.',
    )
  }
  return graph
}

/** Conversation source: the persisted scope is the seed; derive its chain. */
async function resolveConversationGraph(
  db: SqlDatabase,
  trace: Trace,
  workspaceId: string,
  conv: ConvEntities,
): Promise<ResolvedGraph> {
  const graph: ResolvedGraph = {
    source: 'conversation',
    brand: conv.brand,
    niche: conv.niche,
    product: conv.product,
    account: conv.account,
    campaign: conv.campaign,
  }
  let brandId =
    conv.brand?.id ?? conv.niche?.brandId ?? conv.product?.brandId ?? conv.campaign?.brandId ?? null
  if (!brandId && conv.account) {
    brandId = deriveAccountBrandId(conv.account)
  }
  let nicheId = conv.niche?.id ?? conv.product?.nicheId ?? null
  if (!nicheId && conv.account?.primaryNicheId) {
    const primary = conv.account.niches.find((n) => n.id === conv.account?.primaryNicheId)
    if (primary && primary.deletedAt === null && (!brandId || primary.brandId === brandId)) {
      nicheId = primary.id
    }
  }
  const productId = conv.product?.id ?? conv.campaign?.productId ?? null
  await completeGraph(db, trace, workspaceId, graph, { brandId, nicheId, productId })
  return graph
}

/**
 * Fill in derived parents from the database. Derived parents that turn out
 * archived are excluded with a trace note (they were not explicitly
 * requested); a product keeps its brand even when its niche is archived.
 */
async function completeGraph(
  db: SqlDatabase,
  trace: Trace,
  workspaceId: string,
  graph: ResolvedGraph,
  wanted: { brandId: string | null; nicheId: string | null; productId: string | null },
): Promise<void> {
  if (!graph.product && wanted.productId) {
    const row = await getContextProduct(db, wanted.productId)
    if (row && row.status !== 'archived' && !row.deleted_at) {
      graph.product = {
        id: row.id,
        brandId: row.brand_id,
        nicheId: row.niche_id,
        name: row.name,
        description: row.description,
        url: row.url,
        status: row.status,
        deletedAt: row.deleted_at,
      }
      trace.add('included', 'product', row.id, row.name, 'Derived from the resolved scope.')
    } else if (row) {
      trace.add(
        'excluded',
        'product',
        row.id,
        row.name,
        'Derived product is archived; excluded from active context.',
      )
    }
  }
  if (!graph.niche && wanted.nicheId) {
    const row = await getContextNiche(db, wanted.nicheId)
    if (row && !row.deleted_at) {
      graph.niche = {
        id: row.id,
        brandId: row.brand_id,
        name: row.name,
        description: row.description,
        deletedAt: row.deleted_at,
      }
      trace.add('included', 'niche', row.id, row.name, 'Derived from the resolved scope.')
    } else if (row) {
      trace.add(
        'excluded',
        'niche',
        row.id,
        row.name,
        'Derived niche is archived; excluded from active context.',
      )
    }
  }
  const brandId = wanted.brandId ?? graph.product?.brandId ?? graph.niche?.brandId ?? null
  if (!graph.brand && brandId) {
    const row = await getContextBrand(db, brandId)
    if (row && row.workspace_id === workspaceId && !row.deleted_at) {
      graph.brand = {
        id: row.id,
        workspaceId: row.workspace_id,
        name: row.name,
        description: row.description,
        deletedAt: row.deleted_at,
      }
      trace.add(
        'included',
        'brand',
        row.id,
        row.name,
        'Derived as the parent of the resolved scope.',
      )
    } else if (row?.deleted_at) {
      trace.add(
        'excluded',
        'brand',
        row.id,
        row.name,
        'Derived parent brand is archived; excluded from active context.',
      )
    }
  }
}

/** Persisted conversation scope must not contradict explicit context. */
function assertConversationCompatible(graph: ResolvedGraph, conv: ConvEntities): void {
  const mismatch = (type: string, id: string): ContextError =>
    new ContextError(
      'conversation_mismatch',
      'The explicit context conflicts with this conversation’s persisted scope.',
      { type, id },
    )
  if (conv.brand && graph.brand && conv.brand.id !== graph.brand.id) {
    throw mismatch('brand', conv.brand.id)
  }
  if (conv.niche) {
    if (graph.niche && conv.niche.id !== graph.niche.id) {
      throw mismatch('niche', conv.niche.id)
    }
    if (graph.brand && conv.niche.brandId !== graph.brand.id) {
      throw mismatch('niche', conv.niche.id)
    }
  }
  if (conv.product) {
    if (graph.product && conv.product.id !== graph.product.id) {
      throw mismatch('product', conv.product.id)
    }
    if (graph.brand && conv.product.brandId !== graph.brand.id) {
      throw mismatch('product', conv.product.id)
    }
  }
  if (conv.account && graph.account && conv.account.id !== graph.account.id) {
    throw mismatch('account', conv.account.id)
  }
  if (conv.account && graph.brand) {
    checkAccountBrand(conv.account, graph.brand.id)
  }
  if (conv.campaign) {
    if (graph.campaign && conv.campaign.id !== graph.campaign.id) {
      throw mismatch('campaign', conv.campaign.id)
    }
    if (graph.brand && conv.campaign.brandId && conv.campaign.brandId !== graph.brand.id) {
      throw mismatch('campaign', conv.campaign.id)
    }
  }
}

/* ---- knowledge retrieval ---- */

function entityName(entity: {
  name?: string
  handle?: string | null
  displayName?: string | null
}): string | null {
  return entity.name ?? entity.displayName ?? entity.handle ?? null
}

async function resolveMemories(
  db: SqlDatabase,
  trace: Trace,
  workspaceId: string,
  scopes: ScopePair[],
  maxMemories: number,
  now: string,
): Promise<ContextMemory[]> {
  const candidates = await listMemoryCandidates(
    db,
    workspaceId,
    scopes,
    maxMemories * MEMORY_CANDIDATE_MULTIPLIER,
    now,
  )
  // Trace-only: explain why ineligible memories in scope were excluded.
  const ineligible = await listIneligibleMemories(
    db,
    workspaceId,
    scopes,
    TRACE_EXCLUSION_SAMPLE,
    now,
  )
  for (const m of ineligible) {
    if (m.status === 'superseded') {
      trace.add(
        'excluded',
        'memory',
        m.id,
        null,
        `Superseded${m.supersededBy ? ` by ${m.supersededBy}` : ''}; not authoritative.`,
      )
    } else if (m.status === 'archived' || m.status === 'rejected') {
      trace.add(
        'excluded',
        'memory',
        m.id,
        null,
        `Status '${m.status}' is excluded from active context.`,
      )
    } else {
      trace.add('excluded', 'memory', m.id, null, 'Expired memory is not authoritative.')
    }
  }
  const eligible: ContextMemory[] = []
  for (const m of candidates) {
    eligible.push({
      id: m.id,
      memoryClass: m.memoryClass,
      authority: MEMORY_AUTHORITY_LABEL[m.memoryClass],
      content: m.content,
      scopeType: m.scopeType,
      scopeId: m.scopeId,
      confidence: m.confidence,
      sourceType: m.sourceType,
      sourceId: m.sourceId,
      evidenceJson: m.evidenceJson,
      freshness: 'current',
      lastVerifiedAt: m.lastVerifiedAt,
      expiresAt: m.expiresAt,
      createdAt: m.createdAt,
    })
  }
  eligible.sort(compareMemories)
  const included = eligible.slice(0, maxMemories)
  for (const dropped of eligible.slice(maxMemories)) {
    trace.add(
      'excluded',
      'memory',
      dropped.id,
      null,
      `Over the memory limit (${maxMemories}); lower-ranked.`,
    )
  }
  for (const m of included) {
    trace.add(
      'included',
      'memory',
      m.id,
      null,
      `${m.memoryClass} scoped to ${m.scopeType}; authority '${m.authority}'.`,
    )
  }
  return included
}

async function resolveResearch(
  db: SqlDatabase,
  trace: Trace,
  workspaceId: string,
  scopes: ScopePair[],
  maxResearch: number,
  researchAgingDays: number,
  now: string,
): Promise<ContextResearch[]> {
  const candidates = await listResearchCandidates(
    db,
    workspaceId,
    scopes,
    maxResearch * RESEARCH_CANDIDATE_MULTIPLIER,
    now,
  )
  // Trace-only: explain why ineligible research in scope was excluded.
  const ineligible = await listIneligibleResearch(
    db,
    workspaceId,
    scopes,
    TRACE_EXCLUSION_SAMPLE,
    now,
  )
  for (const r of ineligible) {
    if (r.status === 'draft' || r.status === 'in_progress') {
      trace.add(
        'excluded',
        'research',
        r.id,
        r.subject,
        `Status '${r.status}' is not finished research.`,
      )
    } else {
      trace.add(
        'excluded',
        'research',
        r.id,
        r.subject,
        'Expired or archived research is not active context.',
      )
    }
  }
  const eligible: ContextResearch[] = []
  for (const r of candidates) {
    const freshness = researchFreshness(
      {
        status: r.status,
        expiresAt: r.expiresAt,
        lastVerifiedAt: r.lastVerifiedAt,
        updatedAt: r.updatedAt,
      },
      now,
      researchAgingDays,
    )
    if (freshness === 'expired') {
      continue
    }
    eligible.push({
      id: r.id,
      subject: r.subject,
      findings: r.findings,
      status: r.status,
      confidence: r.confidence,
      scopeType: r.scopeType,
      scopeId: r.scopeId,
      freshness,
      lastVerifiedAt: r.lastVerifiedAt,
      updatedAt: r.updatedAt,
      createdAt: r.createdAt,
    })
  }
  eligible.sort(compareResearch)
  const included = eligible.slice(0, maxResearch)
  for (const dropped of eligible.slice(maxResearch)) {
    trace.add(
      'excluded',
      'research',
      dropped.id,
      dropped.subject,
      `Over the research limit (${maxResearch}); lower-ranked.`,
    )
  }
  for (const r of included) {
    trace.add(
      'included',
      'research',
      r.id,
      r.subject,
      r.freshness === 'current'
        ? 'Current research in scope.'
        : `Included but marked '${r.freshness}'; not current truth.`,
    )
  }
  return included
}

async function resolveGoals(
  db: SqlDatabase,
  trace: Trace,
  workspaceId: string,
  scopes: ScopePair[],
  maxGoals: number,
): Promise<ContextGoal[]> {
  const candidates = await listGoalCandidates(
    db,
    workspaceId,
    scopes,
    maxGoals * GOAL_CANDIDATE_MULTIPLIER,
  )
  const goals: ContextGoal[] = candidates.map((g) => ({
    id: g.id,
    title: g.title,
    description: g.description,
    scopeType: g.scopeType,
    scopeId: g.scopeId,
    targetMetricKey: g.targetMetricKey,
    targetValue: g.targetValue,
    dueAt: g.dueAt,
  }))
  goals.sort(compareGoals)
  const included = goals.slice(0, maxGoals)
  for (const dropped of goals.slice(maxGoals)) {
    trace.add(
      'excluded',
      'goal',
      dropped.id,
      dropped.title,
      `Over the goal limit (${maxGoals}); lower-ranked.`,
    )
  }
  for (const g of included) {
    trace.add('included', 'goal', g.id, g.title, `Active goal scoped to ${g.scopeType}.`)
  }
  return included
}
