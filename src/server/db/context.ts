import type { ConnectionStatus, Goal, Memory, Research } from '~/types/domain'

import { queryAll, queryFirst, type SqlDatabase } from './sql.ts'

/**
 * Context retrieval repository: the focused read queries the Context
 * Engine (src/server/context) needs. Kept in `server/db` so raw SQL stays
 * out of the engine, and db-first (structural SqlDatabase, no
 * `cloudflare:workers` import) so the whole context pipeline is testable
 * under plain node — the pattern STEP 4 introduced for conversation.ts.
 *
 * These are read-only queries. Row shapes below map to safe domain types;
 * secret-bearing columns (platform_connection.secret_ref, metadata) are
 * never selected.
 */

export interface ContextWorkspaceRow {
  id: string
  name: string
  slug: string | null
  deleted_at: string | null
}

export interface ContextBrandRow {
  id: string
  workspace_id: string
  name: string
  description: string | null
  deleted_at: string | null
}

export interface ContextNicheRow {
  id: string
  brand_id: string
  name: string
  description: string | null
  deleted_at: string | null
}

export interface ContextProductRow {
  id: string
  brand_id: string
  niche_id: string | null
  name: string
  description: string | null
  url: string | null
  status: string
  deleted_at: string | null
}

export interface ContextAccountRow {
  id: string
  workspace_id: string
  platform_id: string
  handle: string
  display_name: string | null
  primary_niche_id: string | null
  status: string
  deleted_at: string | null
}

export interface ContextCampaignRow {
  id: string
  workspace_id: string
  brand_id: string | null
  product_id: string | null
  name: string
  status: string
  starts_at: string | null
  ends_at: string | null
  deleted_at: string | null
}

export interface ContextPlatformRow {
  id: string
  name: string
}

export interface ContextAgentRow {
  id: string
  workspace_id: string
  name: string
  role: string | null
  execution_type: string
  status: string
  deleted_at: string | null
}

export interface ContextAccountNicheRow {
  id: string
  brand_id: string
  name: string
  description: string | null
  deleted_at: string | null
}

export async function getContextWorkspace(
  db: SqlDatabase,
  id: string,
): Promise<ContextWorkspaceRow | null> {
  return queryFirst<ContextWorkspaceRow>(
    db,
    `SELECT id, name, slug, deleted_at FROM workspace WHERE id = ?`,
    [id],
  )
}

export async function getDefaultContextWorkspace(
  db: SqlDatabase,
): Promise<ContextWorkspaceRow | null> {
  return queryFirst<ContextWorkspaceRow>(
    db,
    `SELECT id, name, slug, deleted_at FROM workspace
     WHERE deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`,
  )
}

export async function getContextBrand(
  db: SqlDatabase,
  id: string,
): Promise<ContextBrandRow | null> {
  return queryFirst<ContextBrandRow>(
    db,
    `SELECT id, workspace_id, name, description, deleted_at FROM brand WHERE id = ?`,
    [id],
  )
}

export async function getContextNiche(
  db: SqlDatabase,
  id: string,
): Promise<ContextNicheRow | null> {
  return queryFirst<ContextNicheRow>(
    db,
    `SELECT id, brand_id, name, description, deleted_at FROM niche WHERE id = ?`,
    [id],
  )
}

export async function getContextProduct(
  db: SqlDatabase,
  id: string,
): Promise<ContextProductRow | null> {
  return queryFirst<ContextProductRow>(
    db,
    `SELECT id, brand_id, niche_id, name, description, url, status, deleted_at
     FROM product WHERE id = ?`,
    [id],
  )
}

export async function getContextAccount(
  db: SqlDatabase,
  id: string,
): Promise<ContextAccountRow | null> {
  return queryFirst<ContextAccountRow>(
    db,
    `SELECT id, workspace_id, platform_id, handle, display_name, primary_niche_id, status, deleted_at
     FROM account WHERE id = ?`,
    [id],
  )
}

export async function getContextCampaign(
  db: SqlDatabase,
  id: string,
): Promise<ContextCampaignRow | null> {
  return queryFirst<ContextCampaignRow>(
    db,
    `SELECT id, workspace_id, brand_id, product_id, name, status, starts_at, ends_at, deleted_at
     FROM campaign WHERE id = ?`,
    [id],
  )
}

export async function getContextPlatform(
  db: SqlDatabase,
  id: string,
): Promise<ContextPlatformRow | null> {
  return queryFirst<ContextPlatformRow>(db, `SELECT id, name FROM platform WHERE id = ?`, [id])
}

export async function getContextAgent(
  db: SqlDatabase,
  id: string,
): Promise<ContextAgentRow | null> {
  return queryFirst<ContextAgentRow>(
    db,
    `SELECT id, workspace_id, name, role, execution_type, status, deleted_at
     FROM agent WHERE id = ?`,
    [id],
  )
}

/** All niches associated with an account (including archived link targets). */
export async function listContextAccountNiches(
  db: SqlDatabase,
  accountId: string,
): Promise<ContextAccountNicheRow[]> {
  return queryAll<ContextAccountNicheRow>(
    db,
    `SELECT n.id, n.brand_id, n.name, n.description, n.deleted_at
     FROM account_niche an JOIN niche n ON n.id = an.niche_id
     WHERE an.account_id = ?
     ORDER BY n.created_at ASC`,
    [accountId],
  )
}

/**
 * Safe connection state for an account. Only the status is read — never
 * secret_ref, scopes or metadata.
 */
export async function getContextConnectionStatus(
  db: SqlDatabase,
  accountId: string,
): Promise<ConnectionStatus | null> {
  const row = await queryFirst<{ status: ConnectionStatus }>(
    db,
    `SELECT status FROM platform_connection WHERE account_id = ?`,
    [accountId],
  )
  return row ? row.status : null
}

/* ---- Scoped knowledge candidates ---- */

/** A scope pair for memory/research/goal retrieval. Null id = workspace-wide. */
export interface ScopePair {
  scopeType: string
  scopeId: string | null
}

/**
 * Build a parameterized `(scope_type, scope_id)` OR clause. Values are
 * always bound, never interpolated.
 */
function scopeWhere(
  scopes: ScopePair[],
  options?: { nullScopeTypeMeansWorkspace?: boolean },
): { clause: string; params: unknown[] } {
  const clauses: string[] = []
  const params: unknown[] = []
  for (const scope of scopes) {
    if (scope.scopeId === null) {
      // Research allows scope_type NULL for workspace-level rows.
      clauses.push(
        options?.nullScopeTypeMeansWorkspace && scope.scopeType === 'workspace'
          ? `(scope_type = ? OR scope_type IS NULL)`
          : `(scope_type = ?)`,
      )
      params.push(scope.scopeType)
    } else {
      clauses.push(`(scope_type = ? AND scope_id = ?)`)
      params.push(scope.scopeType, scope.scopeId)
    }
  }
  return { clause: clauses.join(' OR '), params }
}

interface MemoryRow {
  id: string
  workspace_id: string
  memory_class: Memory['memoryClass']
  content: string
  scope_type: Memory['scopeType']
  scope_id: string | null
  status: Memory['status']
  confidence: number | null
  source_type: Memory['sourceType']
  source_id: string | null
  evidence: string | null
  superseded_by: string | null
  created_at: string
  updated_at: string
  last_verified_at: string | null
  expires_at: string | null
}

function toMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    memoryClass: row.memory_class,
    content: row.content,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    status: row.status,
    confidence: row.confidence,
    sourceType: row.source_type,
    sourceId: row.source_id,
    evidenceJson: row.evidence,
    supersededBy: row.superseded_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastVerifiedAt: row.last_verified_at,
    expiresAt: row.expires_at,
  }
}

/**
 * Candidate pre-ordering mirrors the specificity ladder in
 * src/server/context/ranking.ts (the pure ranking module stays the final
 * authority). Ordering candidates specificity-first means the bounded
 * over-fetch cannot starve narrow-scope knowledge in favor of recent
 * broad-scope noise.
 */
const SPECIFICITY_CASE = `CASE scope_type
  WHEN 'campaign' THEN 70 WHEN 'product' THEN 60 WHEN 'account' THEN 55
  WHEN 'niche' THEN 50 WHEN 'brand' THEN 40 WHEN 'platform' THEN 30
  ELSE 10 END`

/**
 * Eligible memory candidates for the given scopes: status 'active' and not
 * expired. Hard validity exclusions happen here (in SQL) so a pile of dead
 * memories can never starve live ones out of the bounded candidate pool;
 * final ranking happens in pure code. Bounded by `limit`.
 */
export async function listMemoryCandidates(
  db: SqlDatabase,
  workspaceId: string,
  scopes: ScopePair[],
  limit: number,
  now: string,
): Promise<Memory[]> {
  const { clause, params } = scopeWhere(scopes)
  const rows = await queryAll<MemoryRow>(
    db,
    `SELECT * FROM memory
     WHERE workspace_id = ? AND status = 'active'
       AND (expires_at IS NULL OR expires_at > ?)
       AND (${clause})
     ORDER BY ${SPECIFICITY_CASE} DESC, created_at DESC, id ASC
     LIMIT ?`,
    [workspaceId, now, ...params, limit],
  )
  return rows.map(toMemory)
}

/**
 * Ineligible memories (superseded/archived/rejected/expired) in the same
 * scopes, fetched ONLY so the trace can explain their exclusion. Bounded
 * separately by `limit`; never enters the context package.
 */
export async function listIneligibleMemories(
  db: SqlDatabase,
  workspaceId: string,
  scopes: ScopePair[],
  limit: number,
  now: string,
): Promise<Memory[]> {
  const { clause, params } = scopeWhere(scopes)
  const rows = await queryAll<MemoryRow>(
    db,
    `SELECT * FROM memory
     WHERE workspace_id = ? AND (${clause})
       AND (status != 'active' OR (expires_at IS NOT NULL AND expires_at <= ?))
     ORDER BY created_at DESC, id ASC
     LIMIT ?`,
    [workspaceId, ...params, now, limit],
  )
  return rows.map(toMemory)
}

interface ResearchRow {
  id: string
  workspace_id: string
  subject: string
  findings: string | null
  status: Research['status']
  confidence: number | null
  scope_type: Research['scopeType']
  scope_id: string | null
  created_at: string
  updated_at: string
  last_verified_at: string | null
  expires_at: string | null
}

function toResearch(row: ResearchRow): Research {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    subject: row.subject,
    findings: row.findings,
    status: row.status,
    confidence: row.confidence,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastVerifiedAt: row.last_verified_at,
    expiresAt: row.expires_at,
    deletedAt: null,
  }
}

/**
 * Eligible research candidates for the given scopes: finished work
 * ('completed' or explicitly 'stale') that is not soft-deleted, archived
 * or expired. Hard exclusions happen in SQL so dead research cannot starve
 * current work out of the bounded candidate pool. Bounded by `limit`.
 * Research with NULL scope_type is workspace-level.
 */
export async function listResearchCandidates(
  db: SqlDatabase,
  workspaceId: string,
  scopes: ScopePair[],
  limit: number,
  now: string,
): Promise<Research[]> {
  const { clause, params } = scopeWhere(scopes, { nullScopeTypeMeansWorkspace: true })
  const rows = await queryAll<ResearchRow>(
    db,
    `SELECT id, workspace_id, subject, findings, status, confidence, scope_type, scope_id,
            created_at, updated_at, last_verified_at, expires_at
     FROM research
     WHERE workspace_id = ? AND deleted_at IS NULL
       AND status IN ('completed', 'stale')
       AND (expires_at IS NULL OR expires_at > ?)
       AND (${clause})
     ORDER BY ${SPECIFICITY_CASE} DESC, updated_at DESC, id ASC
     LIMIT ?`,
    [workspaceId, now, ...params, limit],
  )
  return rows.map(toResearch)
}

/**
 * Ineligible research (draft/in_progress/archived/expired) in the same
 * scopes, fetched ONLY so the trace can explain exclusions. Bounded
 * separately by `limit`; never enters the context package.
 */
export async function listIneligibleResearch(
  db: SqlDatabase,
  workspaceId: string,
  scopes: ScopePair[],
  limit: number,
  now: string,
): Promise<Research[]> {
  const { clause, params } = scopeWhere(scopes, { nullScopeTypeMeansWorkspace: true })
  const rows = await queryAll<ResearchRow>(
    db,
    `SELECT id, workspace_id, subject, findings, status, confidence, scope_type, scope_id,
            created_at, updated_at, last_verified_at, expires_at
     FROM research
     WHERE workspace_id = ? AND deleted_at IS NULL AND (${clause})
       AND (status NOT IN ('completed', 'stale')
            OR (expires_at IS NOT NULL AND expires_at <= ?))
     ORDER BY updated_at DESC, id ASC
     LIMIT ?`,
    [workspaceId, ...params, now, limit],
  )
  return rows.map(toResearch)
}

interface GoalRow {
  id: string
  workspace_id: string
  scope_type: Goal['scopeType']
  scope_id: string | null
  title: string
  description: string | null
  target_metric_key: string | null
  target_value: number | null
  status: Goal['status']
  due_at: string | null
  created_at: string
  updated_at: string
}

function toGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    title: row.title,
    description: row.description,
    targetMetricKey: row.target_metric_key,
    targetValue: row.target_value,
    status: row.status,
    dueAt: row.due_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: null,
  }
}

/** Active, non-deleted goals for the given scopes. Bounded by `limit`. */
export async function listGoalCandidates(
  db: SqlDatabase,
  workspaceId: string,
  scopes: ScopePair[],
  limit: number,
): Promise<Goal[]> {
  const goalScopes = scopes.filter(
    (s) =>
      s.scopeType === 'workspace' ||
      s.scopeType === 'brand' ||
      s.scopeType === 'product' ||
      s.scopeType === 'campaign',
  )
  if (goalScopes.length === 0) {
    return []
  }
  const { clause, params } = scopeWhere(goalScopes)
  const rows = await queryAll<GoalRow>(
    db,
    `SELECT id, workspace_id, scope_type, scope_id, title, description,
            target_metric_key, target_value, status, due_at, created_at, updated_at
     FROM goal
     WHERE workspace_id = ? AND status = 'active' AND deleted_at IS NULL AND (${clause})
     ORDER BY created_at DESC, id ASC
     LIMIT ?`,
    [workspaceId, ...params, limit],
  )
  return rows.map(toGoal)
}
