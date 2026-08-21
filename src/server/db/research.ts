import { z } from 'zod'
import { researchFreshness } from '../context/freshness.ts'
import type { Freshness } from '../context/types.ts'
import { writeAuditLog } from './audit.ts'
import { emitEventSafe } from './event.ts'
import { execute, newId, nowIso, queryAll, queryFirst, type SqlDatabase } from './sql.ts'

export const RESEARCH_TYPES = [
  'market',
  'audience',
  'competitor',
  'product',
  'platform',
  'content',
  'general',
] as const
export type ResearchType = (typeof RESEARCH_TYPES)[number]

export const RESEARCH_STATUSES = ['draft', 'in_progress', 'completed', 'stale', 'archived'] as const
export type ResearchStatus = (typeof RESEARCH_STATUSES)[number]

export const RESEARCH_SCOPE_TYPES = [
  'workspace',
  'brand',
  'niche',
  'account',
  'platform',
  'product',
  'campaign',
] as const
export type ResearchScopeType = (typeof RESEARCH_SCOPE_TYPES)[number]

export const RESEARCH_SOURCE_TYPES = [
  'website',
  'report',
  'marketplace',
  'social',
  'internal_data',
  'user_provided',
  'other',
] as const
export type ResearchSourceType = (typeof RESEARCH_SOURCE_TYPES)[number]

export interface ResearchRow {
  id: string
  workspace_id: string
  subject: string
  findings: string | null
  research_type: string
  status: string
  confidence: number | null
  scope_type: string | null
  scope_id: string | null
  created_at: string
  updated_at: string
  last_verified_at: string | null
  expires_at: string | null
  deleted_at: string | null
}

export interface ResearchRecord {
  id: string
  workspaceId: string
  subject: string
  findings: string | null
  researchType: ResearchType
  status: ResearchStatus
  confidence: number | null
  scopeType: ResearchScopeType | null
  scopeId: string | null
  createdAt: string
  updatedAt: string
  lastVerifiedAt: string | null
  expiresAt: string | null
  deletedAt: string | null
}

export interface ResearchSourceRow {
  id: string
  research_id: string
  source_type: string
  uri: string | null
  title: string | null
  metadata: string | null
  retrieved_at: string | null
  created_at: string
}

export interface ResearchSourceMetadata {
  sourceType?: ResearchSourceType
  publisher?: string | null
  publishedAt?: string | null
  note?: string | null
  confidence?: number | null
}

export interface ResearchSourceRecord {
  id: string
  researchId: string
  sourceType: ResearchSourceType
  title: string
  url: string | null
  publisher: string | null
  publishedAt: string | null
  retrievedAt: string | null
  note: string | null
  confidence: number | null
  createdAt: string
}

export type ProvenanceStatus = 'sourced' | 'partially_sourced' | 'user_entered'

export interface ProvenanceSummary {
  status: ProvenanceStatus
  label: string
  description: string
  sourceCount: number
  hasExternalUrls: boolean
}

export class ResearchScopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ResearchScopeError'
  }
}

export class ResearchSourceValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ResearchSourceValidationError'
  }
}

/**
 * Validates that a source URL uses an allowed protocol (http/https) and is well-formed.
 * Rejects javascript:, file:, data:, etc.
 */
export function validateSourceUrl(rawUrl?: string | null): string | null {
  if (!rawUrl || rawUrl.trim() === '') {
    return null
  }
  const trimmed = rawUrl.trim()
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ResearchSourceValidationError(
        `Invalid URL protocol '${parsed.protocol}'. Only http:// and https:// URLs are allowed.`,
      )
    }
    return parsed.href
  } catch (err) {
    if (err instanceof ResearchSourceValidationError) {
      throw err
    }
    throw new ResearchSourceValidationError(
      `Invalid URL '${trimmed}'. Must be a valid HTTP or HTTPS URL.`,
    )
  }
}

/**
 * Normalizes a source URL for safe comparison and deduplication.
 */
export function normalizeSourceUrl(rawUrl?: string | null): string | null {
  const validated = validateSourceUrl(rawUrl)
  if (!validated) return null
  try {
    const parsed = new URL(validated)
    parsed.hostname = parsed.hostname.toLowerCase()
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1)
    }
    return parsed.href
  } catch {
    return validated
  }
}

/**
 * Computes a standardized provenance summary from a list of research sources.
 */
export function computeProvenanceSummary(sources: ResearchSourceRecord[]): ProvenanceSummary {
  const count = sources.length
  if (count === 0) {
    return {
      status: 'user_entered',
      label: 'User-Entered',
      description: 'No external sources attached. Entered directly without external provenance.',
      sourceCount: 0,
      hasExternalUrls: false,
    }
  }

  const hasExternalUrls = sources.some((s) => Boolean(s.url))
  const isOnlyUserProvided = sources.every((s) => s.sourceType === 'user_provided' && !s.url)

  if (isOnlyUserProvided) {
    return {
      status: 'user_entered',
      label: 'User-Provided',
      description: 'Documented via user notes without external URL or publisher verification.',
      sourceCount: count,
      hasExternalUrls: false,
    }
  }

  // Check how many external sources have concrete provenance (URL or publisher)
  const fullyAttestedSources = sources.filter((s) => Boolean(s.url) || Boolean(s.publisher))

  if (fullyAttestedSources.length === count) {
    return {
      status: 'sourced',
      label: 'Sourced',
      description: `Backed by ${count} verified citation${count > 1 ? 's' : ''}.`,
      sourceCount: count,
      hasExternalUrls,
    }
  }

  if (fullyAttestedSources.length > 0) {
    return {
      status: 'partially_sourced',
      label: 'Partially Sourced',
      description: `Backed by ${count} citation${count > 1 ? 's' : ''} (${fullyAttestedSources.length} with verified URL/publisher).`,
      sourceCount: count,
      hasExternalUrls,
    }
  }

  return {
    status: 'partially_sourced',
    label: 'Partially Sourced',
    description: `Backed by ${count} citation${count > 1 ? 's' : ''} with partial metadata.`,
    sourceCount: count,
    hasExternalUrls,
  }
}

function toDbSourceType(type: ResearchSourceType, hasUrl: boolean): string {
  switch (type) {
    case 'website':
    case 'marketplace':
      return hasUrl ? 'url' : 'manual'
    case 'social':
      return 'platform'
    case 'report':
      return 'file'
    default:
      return hasUrl ? 'url' : 'manual'
  }
}

function mapSourceRow(row: ResearchSourceRow): ResearchSourceRecord {
  let meta: ResearchSourceMetadata = {}
  if (row.metadata) {
    try {
      meta = JSON.parse(row.metadata) as ResearchSourceMetadata
    } catch {
      meta = {}
    }
  }

  let sourceType: ResearchSourceType = 'other'
  if (meta.sourceType && RESEARCH_SOURCE_TYPES.includes(meta.sourceType)) {
    sourceType = meta.sourceType
  } else if (row.source_type === 'url') {
    sourceType = 'website'
  } else if (row.source_type === 'platform') {
    sourceType = 'social'
  } else if (row.source_type === 'file') {
    sourceType = 'report'
  } else if (row.source_type === 'manual') {
    sourceType = 'user_provided'
  }

  return {
    id: row.id,
    researchId: row.research_id,
    sourceType,
    title: row.title ?? 'Untitled Source',
    url: row.uri ?? null,
    publisher: meta.publisher ?? null,
    publishedAt: meta.publishedAt ?? null,
    retrievedAt: row.retrieved_at ?? null,
    note: meta.note ?? null,
    confidence: meta.confidence ?? null,
    createdAt: row.created_at,
  }
}

function mapRow(row: ResearchRow): ResearchRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    subject: row.subject,
    findings: row.findings,
    researchType: (RESEARCH_TYPES.includes(row.research_type as ResearchType)
      ? row.research_type
      : 'general') as ResearchType,
    status: row.status as ResearchStatus,
    confidence: row.confidence,
    scopeType: (row.scope_type as ResearchScopeType) ?? null,
    scopeId: row.scope_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastVerifiedAt: row.last_verified_at,
    expiresAt: row.expires_at,
    deletedAt: row.deleted_at,
  }
}

/**
 * Validates scope ownership and active status for a research record.
 */
export async function validateResearchScope(
  db: SqlDatabase,
  workspaceId: string,
  scopeType?: string | null,
  scopeId?: string | null,
): Promise<void> {
  if (!scopeType || scopeType === 'workspace') {
    if (scopeId && scopeId !== workspaceId) {
      throw new ResearchScopeError('Workspace scopeId must match the workspace ID.')
    }
    return
  }

  if (!scopeId) {
    throw new ResearchScopeError(`scopeId is required when scopeType is '${scopeType}'.`)
  }

  if (scopeType === 'brand') {
    const brand = await queryFirst<{ id: string; deleted_at: string | null }>(
      db,
      `SELECT id, deleted_at FROM brand WHERE id = ? AND workspace_id = ?`,
      [scopeId, workspaceId],
    )
    if (!brand) {
      throw new ResearchScopeError(`Brand ${scopeId} not found in workspace ${workspaceId}.`)
    }
    if (brand.deleted_at !== null) {
      throw new ResearchScopeError(`Brand ${scopeId} is archived.`)
    }
    return
  }

  if (scopeType === 'niche') {
    const niche = await queryFirst<{ id: string; deleted_at: string | null }>(
      db,
      `SELECT n.id, n.deleted_at
       FROM niche n
       JOIN brand b ON n.brand_id = b.id
       WHERE n.id = ? AND b.workspace_id = ? AND b.deleted_at IS NULL`,
      [scopeId, workspaceId],
    )
    if (!niche) {
      throw new ResearchScopeError(`Niche ${scopeId} not found in workspace ${workspaceId}.`)
    }
    if (niche.deleted_at !== null) {
      throw new ResearchScopeError(`Niche ${scopeId} is archived.`)
    }
    return
  }

  if (scopeType === 'product') {
    const product = await queryFirst<{ id: string; status: string }>(
      db,
      `SELECT p.id, p.status
       FROM product p
       JOIN brand b ON p.brand_id = b.id
       WHERE p.id = ? AND b.workspace_id = ? AND b.deleted_at IS NULL`,
      [scopeId, workspaceId],
    )
    if (!product) {
      throw new ResearchScopeError(`Product ${scopeId} not found in workspace ${workspaceId}.`)
    }
    if (product.status === 'archived') {
      throw new ResearchScopeError(`Product ${scopeId} is archived.`)
    }
    return
  }

  if (scopeType === 'account') {
    const account = await queryFirst<{ id: string; deleted_at: string | null }>(
      db,
      `SELECT id, deleted_at FROM account WHERE id = ? AND workspace_id = ?`,
      [scopeId, workspaceId],
    )
    if (!account) {
      throw new ResearchScopeError(`Account ${scopeId} not found in workspace ${workspaceId}.`)
    }
    if (account.deleted_at !== null) {
      throw new ResearchScopeError(`Account ${scopeId} is archived.`)
    }
    return
  }

  if (scopeType === 'platform') {
    const platform = await queryFirst<{ id: string }>(db, `SELECT id FROM platform WHERE id = ?`, [
      scopeId,
    ])
    if (!platform) {
      throw new ResearchScopeError(`Platform '${scopeId}' not found.`)
    }
    return
  }

  if (scopeType === 'campaign') {
    const campaign = await queryFirst<{ id: string; deleted_at: string | null }>(
      db,
      `SELECT id, deleted_at FROM campaign WHERE id = ? AND workspace_id = ?`,
      [scopeId, workspaceId],
    )
    if (!campaign) {
      throw new ResearchScopeError(`Campaign ${scopeId} not found in workspace ${workspaceId}.`)
    }
    if (campaign.deleted_at !== null) {
      throw new ResearchScopeError(`Campaign ${scopeId} is archived.`)
    }
    return
  }

  throw new ResearchScopeError(`Unsupported scope type '${scopeType}'.`)
}

export interface ResearchProvenance {
  originType: 'researcher' | 'manual' | 'import'
  sourceMessageId: string | null
  conversationId: string | null
  agentId: string | null
  agentName: string | null
  agentVersionId: string | null
  versionNumber: number | null
  executionId: string | null
  provider: string | null
  model: string | null
  generatedAt: string | null
  savedAt: string
  webSearchUsed: boolean
  sourceCount: number
  derivedFromResearchIds: string[] | null
}

export const researchOriginSchema = z.object({
  originType: z.enum(['manual', 'researcher', 'import']).optional(),
  sourceMessageId: z.string().uuid().nullable().optional(),
  messageId: z.string().uuid().nullable().optional(),
  conversationId: z.string().uuid().nullable().optional(),
  agentId: z.string().uuid().nullable().optional(),
  agentName: z.string().nullable().optional(),
  agentVersionId: z.string().uuid().nullable().optional(),
  versionNumber: z.number().int().nullable().optional(),
  executionId: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  generatedAt: z.string().nullable().optional(),
  createdAt: z.string().nullable().optional(),
  derivedFromResearchIds: z.array(z.string().uuid()).optional(),
  webSearchUsed: z.boolean().optional(),
  sourceUrls: z.array(z.string()).optional(),
  searchProvider: z.string().nullable().optional(),
  toolCallId: z.string().nullable().optional(),
})
export type ResearchOrigin = z.infer<typeof researchOriginSchema>

export const RESEARCH_ANALYSIS_MODES = [
  'compare',
  'synthesize',
  'patterns',
  'contradictions',
] as const
export type ResearchAnalysisMode = (typeof RESEARCH_ANALYSIS_MODES)[number]

export const MIN_RESEARCH_ANALYSIS_SELECTION = 2
export const MAX_RESEARCH_ANALYSIS_SELECTION = 10

export class ResearchAnalysisValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ResearchAnalysisValidationError'
  }
}

export interface SelectedResearchItem {
  id: string
  subject: string
  findings: string | null
  researchType: ResearchType
  status: ResearchStatus
  scopeType: ResearchScopeType | null
  scopeId: string | null
  scopeLabel?: string
  freshness: Freshness
  provenance: ProvenanceSummary
  sources: ResearchSourceRecord[]
  createdAt: string
  updatedAt: string
}

/**
 * Validates a multi-research selection for analysis:
 * - Count between MIN (2) and MAX (10)
 * - No duplicate IDs
 * - Exists in the workspace and not deleted
 * - Not archived
 * - Not expired
 */
export async function validateResearchSelection(
  db: SqlDatabase,
  input: {
    workspaceId: string
    researchIds: string[]
    now?: string
    agingDays?: number
  },
): Promise<SelectedResearchItem[]> {
  const { workspaceId, researchIds, now = nowIso(), agingDays = 90 } = input

  if (!Array.isArray(researchIds)) {
    throw new ResearchAnalysisValidationError('researchIds must be an array of IDs.')
  }

  // Duplicate check
  const uniqueIds = Array.from(new Set(researchIds))
  if (uniqueIds.length !== researchIds.length) {
    throw new ResearchAnalysisValidationError(
      'Duplicate research IDs are not allowed in selection.',
    )
  }

  // Bounds check (2 to 10)
  if (
    uniqueIds.length < MIN_RESEARCH_ANALYSIS_SELECTION ||
    uniqueIds.length > MAX_RESEARCH_ANALYSIS_SELECTION
  ) {
    throw new ResearchAnalysisValidationError(
      `Please select between ${MIN_RESEARCH_ANALYSIS_SELECTION} and ${MAX_RESEARCH_ANALYSIS_SELECTION} research records (got ${uniqueIds.length}).`,
    )
  }

  const items: SelectedResearchItem[] = []

  for (const id of researchIds) {
    const row = await queryFirst<ResearchRow>(
      db,
      `SELECT id, workspace_id, subject, findings, research_type, status, confidence, scope_type, scope_id, created_at, updated_at, last_verified_at, expires_at, deleted_at
       FROM research
       WHERE id = ? AND workspace_id = ?`,
      [id, workspaceId],
    )

    if (!row) {
      throw new ResearchAnalysisValidationError(
        `Research record '${id}' not found or belongs to another workspace.`,
      )
    }

    if (row.status === 'archived' || row.deleted_at !== null) {
      throw new ResearchAnalysisValidationError(
        `Archived research '${row.subject}' cannot be selected for analysis.`,
      )
    }

    const freshness = researchFreshness(
      {
        status: row.status,
        expiresAt: row.expires_at,
        lastVerifiedAt: row.last_verified_at,
        updatedAt: row.updated_at,
      },
      now,
      agingDays,
    )

    if (freshness === 'expired') {
      throw new ResearchAnalysisValidationError(
        `Expired research '${row.subject}' cannot be selected for analysis.`,
      )
    }

    // Load sources and compute provenance
    const sourceRows = await queryAll<ResearchSourceRow>(
      db,
      `SELECT rs.id, rs.research_id, rs.source_type, rs.uri, rs.title, rs.metadata, rs.retrieved_at, rs.created_at
       FROM research_source rs
       JOIN research r ON r.id = rs.research_id
       WHERE rs.research_id = ? AND r.workspace_id = ?
       ORDER BY rs.created_at ASC`,
      [id, workspaceId],
    )
    const sources = sourceRows.map(mapSourceRow)
    const provenance = computeProvenanceSummary(sources)
    const record = mapRow(row)

    items.push({
      id: record.id,
      subject: record.subject,
      findings: record.findings,
      researchType: record.researchType,
      status: record.status,
      scopeType: record.scopeType,
      scopeId: record.scopeId,
      freshness,
      provenance,
      sources,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    })
  }

  return items
}

/**
 * Composes a structured, provider-neutral task prompt for the Researcher Agent
 * analyzing multiple research records.
 */
export function composeResearchAnalysisTask(input: {
  mode: ResearchAnalysisMode
  selectedResearch: SelectedResearchItem[]
}): string {
  const { mode, selectedResearch } = input

  let modeDirective = ''
  let expectedStructure = ''

  switch (mode) {
    case 'compare':
      modeDirective =
        'Compare the following research records, highlighting agreements, differences, contradictions, and evidence gaps.'
      expectedStructure = `### Expected Output Structure:
- **Summary**: High-level comparative overview of the topics.
- **Agreements**: Findings, trends, and data points supported across multiple records.
- **Differences**: Specific topics, nuances, or facets covered in some records but not others.
- **Contradictions**: Direct disagreements, divergent conclusions, or conflicting claims.
- **Evidence Gaps**: Unverified assumptions, missing data points, or unbacked findings.
- **Recommended Next Questions**: Key questions to investigate further.`
      break

    case 'synthesize':
      modeDirective =
        'Synthesize the following research records into a unified findings summary, clearly distinguishing facts, interpretations, and hypotheses.'
      expectedStructure = `### Expected Output Structure:
- **Strongest Supported Conclusions**: Core insights with high evidence backing across records.
- **Repeated Patterns**: Common themes and recurring findings.
- **Weak or Conflicting Evidence**: Areas with lower confidence, thin sourcing, or conflicting observations.
- **Gaps & Unknowns**: Missing information required to complete the picture.
- **Strategic Implications**: What these synthesized findings suggest for next steps.
*Note: Explicitly separate Facts (verified observations), Interpretations (reasoned deductions), and Hypotheses (untested assumptions).*`
      break

    case 'patterns':
      modeDirective =
        'Analyze the following research records to identify shared patterns, recurring themes, and cross-cutting findings.'
      expectedStructure = `### Expected Output Structure:
- **Core Recurring Patterns**: Themes and findings that appear across multiple records.
- **Cross-Scope Overlaps**: Connections across different products, brands, audiences, or niches.
- **Context & Conditions**: Under what circumstances these patterns hold true.
- **Limitations**: Note that observed patterns represent qualitative workspace synthesis, not statistically proven claims.`
      break

    case 'contradictions':
      modeDirective =
        'Analyze the following research records specifically to identify contradictions, conflicting claims, and discrepancies between them.'
      expectedStructure = `### Expected Output Structure:
- **Identified Contradictions**: Explicit discrepancies (e.g. Record A states X while Record B states Y).
- **Possible Explanations**: Analysis of differences in record dates/freshness, scopes, target audiences, or source methodology.
- **Decision Impact**: How these contradictions affect current plans or strategy.
- **Resolution Steps**: Concrete questions or checks needed to resolve the discrepancies without arbitrarily assuming one record is correct.`
      break
  }

  const formattedRecords = selectedResearch
    .map((item, idx) => {
      const scopeText = item.scopeLabel || item.scopeType || 'Workspace'
      const sourcesText =
        item.sources.length > 0
          ? item.sources
              .map(
                (s) =>
                  `  - ${s.title}${s.publisher ? ` (Publisher: ${s.publisher})` : ''}${s.url ? ` [${s.url}]` : ''}`,
              )
              .join('\n')
          : '  - No external sources recorded'

      return `#### [Record ${idx + 1}] ${item.subject}
- **Type**: ${item.researchType}
- **Scope**: ${scopeText}
- **Freshness**: ${item.freshness}
- **Provenance**: ${item.provenance.label} (${item.provenance.description})
- **Findings**:
${item.findings?.trim() || '(No findings content recorded)'}
- **Recorded Sources**:
${sourcesText}`
    })
    .join('\n\n')

  return `## Task: Research ${mode.charAt(0).toUpperCase() + mode.slice(1)} Analysis

${modeDirective}

${expectedStructure}

---

### Selected Research Records (${selectedResearch.length} items):

${formattedRecords}

---

### Analysis Guidelines:
1. Base your analysis exclusively on the findings and recorded sources provided in the records above and existing workspace context.
2. Do not claim to have browsed the live internet or searched fresh web pages.
3. Be honest about freshness: point out when underlying records are aging or stale.
4. Do not fabricate citations or external validations.`
}

/**
 * Deterministically derives a sensible Research title from finding content.
 * Looks for leading markdown headers or the first clean line, capped at 100 chars.
 * Never performs an external or AI call.
 */
export function deriveResearchTitle(content: string): string {
  if (!content?.trim()) return 'Researcher Finding'
  const lines = content.trim().split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    // Strip markdown headers (#, ##), bold (**), bullet markers (-, *)
    const clean = trimmed
      .replace(/^#+\s*/, '')
      .replace(/^[-*•]\s*/, '')
      .replace(/\*+/g, '')
      .trim()
    if (clean.length > 3) {
      return clean.length > 100 ? `${clean.slice(0, 97)}…` : clean
    }
  }
  return 'Researcher Finding'
}

export const createResearchInput = z.object({
  workspaceId: z.string().uuid(),
  subject: z.string().trim().min(1, 'Subject is required').max(500),
  findings: z.string().nullable().optional(),
  researchType: z.enum(RESEARCH_TYPES).default('general'),
  status: z.enum(RESEARCH_STATUSES).default('completed'),
  confidence: z.number().min(0).max(1).nullable().optional(),
  scopeType: z.enum(RESEARCH_SCOPE_TYPES).nullable().optional(),
  scopeId: z.string().nullable().optional(),
  lastVerifiedAt: z.string().nullable().optional(),
  expiresAt: z.string().nullable().optional(),
  sourceMessageId: z.string().uuid().nullable().optional(),
  origin: researchOriginSchema.optional(),
  selectedSourceIndices: z.array(z.number().int().min(0)).optional(),
  actor: z
    .object({
      actorType: z.enum(['user', 'agent', 'workflow', 'system']).default('user'),
      actorId: z.string().nullable().optional(),
    })
    .optional(),
})
export type CreateResearchInput = z.input<typeof createResearchInput>

export const updateResearchInput = z.object({
  workspaceId: z.string().uuid(),
  id: z.string().uuid(),
  subject: z.string().trim().min(1).max(500).optional(),
  findings: z.string().nullable().optional(),
  researchType: z.enum(RESEARCH_TYPES).optional(),
  status: z.enum(RESEARCH_STATUSES).optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  scopeType: z.enum(RESEARCH_SCOPE_TYPES).nullable().optional(),
  scopeId: z.string().nullable().optional(),
  lastVerifiedAt: z.string().nullable().optional(),
  expiresAt: z.string().nullable().optional(),
  actor: z
    .object({
      actorType: z.enum(['user', 'agent', 'workflow', 'system']).default('user'),
      actorId: z.string().nullable().optional(),
    })
    .optional(),
})
export type UpdateResearchInput = z.input<typeof updateResearchInput>

/**
 * Retrieves a single research record by ID within workspace.
 */
export async function getResearch(
  db: SqlDatabase,
  query: {
    workspaceId: string
    id: string
    includeArchived?: boolean
  },
): Promise<ResearchRecord | null> {
  const sql = query.includeArchived
    ? `SELECT id, workspace_id, subject, findings, research_type, status, confidence, scope_type, scope_id, created_at, updated_at, last_verified_at, expires_at, deleted_at
       FROM research
       WHERE id = ? AND workspace_id = ?`
    : `SELECT id, workspace_id, subject, findings, research_type, status, confidence, scope_type, scope_id, created_at, updated_at, last_verified_at, expires_at, deleted_at
       FROM research
       WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`

  const row = await queryFirst<ResearchRow>(db, sql, [query.id, query.workspaceId])
  return row ? mapRow(row) : null
}

/**
 * Lists research records for a workspace with flexible filters.
 */
export async function listResearch(
  db: SqlDatabase,
  query: {
    workspaceId: string
    scopeType?: string | null
    scopeId?: string | null
    researchType?: string | null
    status?: string | null
    search?: string | null
    includeArchived?: boolean
    limit?: number
    offset?: number
  },
): Promise<ResearchRecord[]> {
  const clauses: string[] = ['workspace_id = ?']
  const params: unknown[] = [query.workspaceId]

  if (!query.includeArchived) {
    clauses.push('deleted_at IS NULL')
  }

  if (query.status) {
    clauses.push('status = ?')
    params.push(query.status)
  }

  if (query.researchType) {
    clauses.push('research_type = ?')
    params.push(query.researchType)
  }

  if (query.scopeType) {
    clauses.push('scope_type = ?')
    params.push(query.scopeType)
  }

  if (query.scopeId) {
    clauses.push('scope_id = ?')
    params.push(query.scopeId)
  }

  if (query.search) {
    clauses.push('(subject LIKE ? OR findings LIKE ?)')
    const pattern = `%${query.search}%`
    params.push(pattern, pattern)
  }

  const limit = Math.min(query.limit ?? 50, 100)
  const offset = query.offset ?? 0

  const sql = `SELECT id, workspace_id, subject, findings, research_type, status, confidence, scope_type, scope_id, created_at, updated_at, last_verified_at, expires_at, deleted_at
               FROM research
               WHERE ${clauses.join(' AND ')}
               ORDER BY created_at DESC
               LIMIT ? OFFSET ?`

  params.push(limit, offset)

  const rows = await queryAll<ResearchRow>(db, sql, params)
  return rows.map(mapRow)
}

/**
 * Creates a new research record after validating scope.
 */
export async function createResearch(
  db: SqlDatabase,
  input: CreateResearchInput,
): Promise<ResearchRecord> {
  const data = createResearchInput.parse(input)
  const now = nowIso()

  // Validate scope integrity
  await validateResearchScope(db, data.workspaceId, data.scopeType, data.scopeId)

  const targetMessageId =
    data.sourceMessageId ?? data.origin?.sourceMessageId ?? data.origin?.messageId ?? null

  let safeOrigin: ResearchProvenance
  let importedSourcesCount = 0
  const chosenSources: Array<{
    title: string
    url: string
    publisher: string | null
    publishedAt: string | null
    retrievedAt: string | null
    note: string | null
  }> = []

  if (targetMessageId) {
    // Reload exact source message joined with conversation to verify workspace
    const messageRow = await queryFirst<{
      id: string
      conversation_id: string
      sender_type: string
      agent_id: string | null
      agent_version_id: string | null
      content: string
      provider_metadata: string | null
      created_at: string
      workspace_id: string
    }>(
      db,
      `SELECT m.id, m.conversation_id, m.sender_type, m.agent_id, m.agent_version_id,
              m.content, m.provider_metadata, m.created_at, c.workspace_id
       FROM message m
       JOIN conversation c ON c.id = m.conversation_id
       WHERE m.id = ?`,
      [targetMessageId],
    )

    if (!messageRow) {
      throw new ResearchSourceValidationError(`Source message '${targetMessageId}' not found.`)
    }

    if (messageRow.workspace_id !== data.workspaceId) {
      throw new ResearchSourceValidationError(
        `Source message '${targetMessageId}' belongs to another workspace.`,
      )
    }

    if (data.origin?.conversationId && messageRow.conversation_id !== data.origin.conversationId) {
      throw new ResearchSourceValidationError('Origin message conversation mismatch.')
    }

    if (messageRow.sender_type !== 'agent') {
      throw new ResearchSourceValidationError(
        'Only assistant messages from Researcher can provide research findings.',
      )
    }

    if (!messageRow.agent_id) {
      throw new ResearchSourceValidationError('Source message has no agent identifier.')
    }

    const agentRow = await queryFirst<{
      id: string
      name: string
      role: string
      workspace_id: string
      status: string
    }>(db, `SELECT id, name, role, workspace_id, status FROM agent WHERE id = ?`, [
      messageRow.agent_id,
    ])

    if (!agentRow || agentRow.workspace_id !== data.workspaceId) {
      throw new ResearchSourceValidationError('Agent for source message not found in workspace.')
    }

    if (agentRow.role !== 'researcher' && agentRow.name.toLowerCase() !== 'researcher') {
      throw new ResearchSourceValidationError(
        `Only messages from the Researcher agent can provide research findings (got '${agentRow.name}' with role '${agentRow.role}').`,
      )
    }

    if (!messageRow.agent_version_id) {
      throw new ResearchSourceValidationError('Source message has no agent version reference.')
    }

    const versionRow = await queryFirst<{
      id: string
      agent_id: string
      version: number
    }>(db, `SELECT id, agent_id, version FROM agent_version WHERE id = ? AND agent_id = ?`, [
      messageRow.agent_version_id,
      agentRow.id,
    ])

    if (!versionRow) {
      throw new ResearchSourceValidationError('Invalid agent version for source message.')
    }

    let executionId: string | null = null
    let provider: string | null = null
    let model: string | null = null
    let messageSources: Array<{
      title?: unknown
      url?: unknown
      publisher?: unknown
      publishedAt?: unknown
      retrievedAt?: unknown
      snippet?: unknown
      note?: unknown
    }> = []
    let hasSuccessfulWebSearch = false

    if (messageRow.provider_metadata) {
      try {
        const parsedMeta = JSON.parse(messageRow.provider_metadata)
        if (typeof parsedMeta === 'object' && parsedMeta !== null) {
          if (typeof parsedMeta.executionId === 'string' && parsedMeta.executionId.trim() !== '') {
            executionId = parsedMeta.executionId
          }
          if (typeof parsedMeta.provider === 'string' && parsedMeta.provider.trim() !== '') {
            provider = parsedMeta.provider
          }
          if (typeof parsedMeta.model === 'string' && parsedMeta.model.trim() !== '') {
            model = parsedMeta.model
          }
          if (Array.isArray(parsedMeta.sources)) {
            messageSources = parsedMeta.sources
          }
          if (Array.isArray(parsedMeta.toolCalls)) {
            hasSuccessfulWebSearch = parsedMeta.toolCalls.some(
              (tc: { toolKey?: unknown; toolName?: unknown; status?: unknown }) =>
                tc &&
                (tc.toolKey === 'web.search' || tc.toolName === 'web.search') &&
                tc.status === 'succeeded',
            )
          } else if (Array.isArray(parsedMeta.sources) && parsedMeta.sources.length > 0) {
            hasSuccessfulWebSearch = true
          }
        }
      } catch {
        // Malformed provider metadata
      }
    }

    // Extract genuine search sources if requested and valid
    if (
      hasSuccessfulWebSearch &&
      data.selectedSourceIndices &&
      data.selectedSourceIndices.length > 0 &&
      messageSources.length > 0
    ) {
      for (const idx of data.selectedSourceIndices) {
        const item = messageSources[idx]
        if (
          item &&
          typeof item === 'object' &&
          typeof item.url === 'string' &&
          item.url.trim() !== '' &&
          typeof item.title === 'string' &&
          item.title.trim() !== ''
        ) {
          const snippet = typeof item.snippet === 'string' ? item.snippet.trim() : null
          const itemNote = typeof item.note === 'string' ? item.note.trim() : null
          const note = snippet ? `Search snippet: ${snippet.slice(0, 500)}` : itemNote
          chosenSources.push({
            title: item.title.trim(),
            url: item.url.trim(),
            publisher: typeof item.publisher === 'string' ? item.publisher.trim() || null : null,
            publishedAt: typeof item.publishedAt === 'string' ? item.publishedAt : null,
            retrievedAt: typeof item.retrievedAt === 'string' ? item.retrievedAt : null,
            note,
          })
        }
      }
    }

    const webSearchUsed = Boolean(
      (hasSuccessfulWebSearch && messageSources.length > 0) || chosenSources.length > 0,
    )

    safeOrigin = {
      originType: 'researcher',
      sourceMessageId: messageRow.id,
      conversationId: messageRow.conversation_id,
      agentId: agentRow.id,
      agentName: agentRow.name,
      agentVersionId: versionRow.id,
      versionNumber: versionRow.version,
      executionId,
      provider,
      model,
      generatedAt: messageRow.created_at,
      savedAt: now,
      webSearchUsed,
      sourceCount: 0,
      derivedFromResearchIds: data.origin?.derivedFromResearchIds ?? null,
    }
  } else {
    // Manual research creation
    if (data.selectedSourceIndices && data.selectedSourceIndices.length > 0) {
      throw new ResearchSourceValidationError(
        'Origin message is required to import web search sources.',
      )
    }

    safeOrigin = {
      originType: 'manual',
      sourceMessageId: null,
      conversationId: null,
      agentId: null,
      agentName: null,
      agentVersionId: null,
      versionNumber: null,
      executionId: null,
      provider: null,
      model: null,
      generatedAt: null,
      savedAt: now,
      webSearchUsed: false,
      sourceCount: 0,
      derivedFromResearchIds: data.origin?.derivedFromResearchIds ?? null,
    }
  }

  const id = newId()
  const deletedAt = data.status === 'archived' ? now : null

  await execute(
    db,
    `INSERT INTO research (
       id, workspace_id, subject, findings, research_type, status, confidence,
       scope_type, scope_id, created_at, updated_at, last_verified_at, expires_at, deleted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.workspaceId,
      data.subject,
      data.findings ?? null,
      data.researchType,
      data.status,
      data.confidence ?? null,
      data.scopeType ?? null,
      data.scopeId ?? null,
      now,
      now,
      data.lastVerifiedAt ?? null,
      data.expiresAt ?? null,
      deletedAt,
    ],
  )

  // Insert genuine sources if any
  if (chosenSources.length > 0) {
    const seenUrls = new Set<string>()
    for (const s of chosenSources) {
      const validUrl = validateSourceUrl(s.url)
      if (!validUrl) continue
      const norm = normalizeSourceUrl(validUrl)
      if (!norm || seenUrls.has(norm)) continue
      seenUrls.add(norm)

      const sourceId = newId()
      const metaObj: ResearchSourceMetadata = {
        sourceType: 'website',
        publisher: s.publisher || null,
        publishedAt: s.publishedAt || null,
        note: s.note || null,
        confidence: null,
      }

      await execute(
        db,
        `INSERT INTO research_source (
           id, research_id, source_type, uri, title, metadata, retrieved_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sourceId,
          id,
          'url',
          validUrl,
          s.title.slice(0, 500),
          JSON.stringify(metaObj),
          s.retrievedAt ?? now,
          now,
        ],
      )

      importedSourcesCount++

      await writeAuditLog(db, {
        workspaceId: data.workspaceId,
        actorType: data.actor?.actorType ?? 'user',
        actorId: data.actor?.actorId ?? null,
        action: 'create',
        entityType: 'research_source',
        entityId: sourceId,
        previousValueJson: null,
        newValueJson: JSON.stringify({
          researchId: id,
          sourceType: 'website',
          title: s.title.slice(0, 500),
          url: validUrl,
          publisher: s.publisher || null,
        }),
      })

      await emitEventSafe(db, {
        workspaceId: data.workspaceId,
        eventType: 'research.source_added',
        actorType: data.actor?.actorType ?? 'user',
        actorId: data.actor?.actorId ?? null,
        subjectType: 'research_source',
        subjectId: sourceId,
        payloadJson: JSON.stringify({
          researchId: id,
          sourceType: 'website',
          title: s.title.slice(0, 500),
          url: validUrl,
          publisher: s.publisher || null,
        }),
      })
    }
  }

  safeOrigin.sourceCount = importedSourcesCount

  const record: ResearchRecord = {
    id,
    workspaceId: data.workspaceId,
    subject: data.subject,
    findings: data.findings ?? null,
    researchType: data.researchType,
    status: data.status,
    confidence: data.confidence ?? null,
    scopeType: data.scopeType ?? null,
    scopeId: data.scopeId ?? null,
    createdAt: now,
    updatedAt: now,
    lastVerifiedAt: data.lastVerifiedAt ?? null,
    expiresAt: data.expiresAt ?? null,
    deletedAt,
  }

  await writeAuditLog(db, {
    workspaceId: data.workspaceId,
    actorType: data.actor?.actorType ?? 'user',
    actorId: data.actor?.actorId ?? null,
    action: 'create',
    entityType: 'research',
    entityId: id,
    previousValueJson: null,
    newValueJson: JSON.stringify({
      subject: record.subject,
      researchType: record.researchType,
      status: record.status,
      scopeType: record.scopeType,
      scopeId: record.scopeId,
      origin: safeOrigin,
    }),
  })

  await emitEventSafe(db, {
    workspaceId: data.workspaceId,
    eventType: 'research.created',
    actorType: data.actor?.actorType ?? 'user',
    actorId: data.actor?.actorId ?? null,
    subjectType: 'research',
    subjectId: id,
    payloadJson: JSON.stringify({
      subject: record.subject,
      researchType: record.researchType,
      status: record.status,
      scopeType: record.scopeType,
      scopeId: record.scopeId,
      origin: safeOrigin,
    }),
  })

  if (safeOrigin.derivedFromResearchIds && safeOrigin.derivedFromResearchIds.length > 0) {
    await emitEventSafe(db, {
      workspaceId: data.workspaceId,
      eventType: 'research.analysis_saved',
      actorType: data.actor?.actorType ?? 'user',
      actorId: data.actor?.actorId ?? null,
      subjectType: 'research',
      subjectId: id,
      payloadJson: JSON.stringify({
        subject: record.subject,
        researchType: record.researchType,
        status: record.status,
        scopeType: record.scopeType,
        scopeId: record.scopeId,
        derivedFromResearchIds: safeOrigin.derivedFromResearchIds,
        origin: safeOrigin,
      }),
    })
  }

  return record
}

/**
 * Updates an existing research record.
 */
export async function updateResearch(
  db: SqlDatabase,
  input: UpdateResearchInput,
): Promise<ResearchRecord> {
  const data = updateResearchInput.parse(input)
  const existing = await getResearch(db, {
    workspaceId: data.workspaceId,
    id: data.id,
    includeArchived: true,
  })

  if (!existing) {
    throw new Error(`Research record ${data.id} not found in workspace ${data.workspaceId}.`)
  }

  const targetScopeType = data.scopeType !== undefined ? data.scopeType : existing.scopeType
  const targetScopeId = data.scopeId !== undefined ? data.scopeId : existing.scopeId

  if (data.scopeType !== undefined || data.scopeId !== undefined) {
    await validateResearchScope(db, data.workspaceId, targetScopeType, targetScopeId)
  }

  const now = nowIso()
  const subject = data.subject ?? existing.subject
  const findings = data.findings !== undefined ? data.findings : existing.findings
  const researchType = data.researchType ?? existing.researchType
  const status = data.status ?? existing.status
  const confidence = data.confidence !== undefined ? data.confidence : existing.confidence
  const lastVerifiedAt =
    data.lastVerifiedAt !== undefined ? data.lastVerifiedAt : existing.lastVerifiedAt
  const expiresAt = data.expiresAt !== undefined ? data.expiresAt : existing.expiresAt
  const deletedAt = status === 'archived' ? (existing.deletedAt ?? now) : null

  await execute(
    db,
    `UPDATE research
     SET subject = ?, findings = ?, research_type = ?, status = ?, confidence = ?,
         scope_type = ?, scope_id = ?, updated_at = ?, last_verified_at = ?, expires_at = ?, deleted_at = ?
     WHERE id = ? AND workspace_id = ?`,
    [
      subject,
      findings,
      researchType,
      status,
      confidence,
      targetScopeType,
      targetScopeId,
      now,
      lastVerifiedAt,
      expiresAt,
      deletedAt,
      data.id,
      data.workspaceId,
    ],
  )

  const updated: ResearchRecord = {
    id: data.id,
    workspaceId: data.workspaceId,
    subject,
    findings,
    researchType,
    status,
    confidence,
    scopeType: targetScopeType,
    scopeId: targetScopeId,
    createdAt: existing.createdAt,
    updatedAt: now,
    lastVerifiedAt,
    expiresAt,
    deletedAt,
  }

  await writeAuditLog(db, {
    workspaceId: data.workspaceId,
    actorType: data.actor?.actorType ?? 'user',
    actorId: data.actor?.actorId ?? null,
    action: 'update',
    entityType: 'research',
    entityId: data.id,
    previousValueJson: JSON.stringify({
      subject: existing.subject,
      researchType: existing.researchType,
      status: existing.status,
    }),
    newValueJson: JSON.stringify({
      subject: updated.subject,
      researchType: updated.researchType,
      status: updated.status,
    }),
  })

  await emitEventSafe(db, {
    workspaceId: data.workspaceId,
    eventType: 'research.updated',
    actorType: data.actor?.actorType ?? 'user',
    actorId: data.actor?.actorId ?? null,
    subjectType: 'research',
    subjectId: data.id,
    payloadJson: JSON.stringify({
      subject: updated.subject,
      researchType: updated.researchType,
      status: updated.status,
    }),
  })

  return updated
}

/**
 * Archives a research record (soft-delete).
 */
export async function archiveResearch(
  db: SqlDatabase,
  input: {
    workspaceId: string
    id: string
    actor?: { actorType: 'user' | 'agent' | 'workflow' | 'system'; actorId?: string | null }
  },
): Promise<ResearchRecord> {
  const existing = await getResearch(db, {
    workspaceId: input.workspaceId,
    id: input.id,
    includeArchived: true,
  })
  if (!existing) {
    throw new Error(`Research record ${input.id} not found in workspace ${input.workspaceId}.`)
  }

  const now = nowIso()
  await execute(
    db,
    `UPDATE research
     SET status = 'archived', deleted_at = ?, updated_at = ?
     WHERE id = ? AND workspace_id = ?`,
    [now, now, input.id, input.workspaceId],
  )

  const record: ResearchRecord = {
    ...existing,
    status: 'archived',
    deletedAt: now,
    updatedAt: now,
  }

  await writeAuditLog(db, {
    workspaceId: input.workspaceId,
    actorType: input.actor?.actorType ?? 'user',
    actorId: input.actor?.actorId ?? null,
    action: 'delete',
    entityType: 'research',
    entityId: input.id,
    previousValueJson: JSON.stringify({ status: existing.status }),
    newValueJson: JSON.stringify({ status: 'archived', deletedAt: now }),
  })

  await emitEventSafe(db, {
    workspaceId: input.workspaceId,
    eventType: 'research.archived',
    actorType: input.actor?.actorType ?? 'user',
    actorId: input.actor?.actorId ?? null,
    subjectType: 'research',
    subjectId: input.id,
    payloadJson: JSON.stringify({ status: 'archived' }),
  })

  return record
}

/**
 * Restores an archived research record.
 */
export async function restoreResearch(
  db: SqlDatabase,
  input: {
    workspaceId: string
    id: string
    actor?: { actorType: 'user' | 'agent' | 'workflow' | 'system'; actorId?: string | null }
  },
): Promise<ResearchRecord> {
  const existing = await getResearch(db, {
    workspaceId: input.workspaceId,
    id: input.id,
    includeArchived: true,
  })
  if (!existing) {
    throw new Error(`Research record ${input.id} not found in workspace ${input.workspaceId}.`)
  }

  const now = nowIso()
  await execute(
    db,
    `UPDATE research
     SET status = 'completed', deleted_at = NULL, updated_at = ?
     WHERE id = ? AND workspace_id = ?`,
    [now, input.id, input.workspaceId],
  )

  const record: ResearchRecord = {
    ...existing,
    status: 'completed',
    deletedAt: null,
    updatedAt: now,
  }

  await writeAuditLog(db, {
    workspaceId: input.workspaceId,
    actorType: input.actor?.actorType ?? 'user',
    actorId: input.actor?.actorId ?? null,
    action: 'restore',
    entityType: 'research',
    entityId: input.id,
    previousValueJson: JSON.stringify({ status: existing.status, deletedAt: existing.deletedAt }),
    newValueJson: JSON.stringify({ status: 'completed', deletedAt: null }),
  })

  await emitEventSafe(db, {
    workspaceId: input.workspaceId,
    eventType: 'research.restored',
    actorType: input.actor?.actorType ?? 'user',
    actorId: input.actor?.actorId ?? null,
    subjectType: 'research',
    subjectId: input.id,
    payloadJson: JSON.stringify({ status: 'completed' }),
  })

  return record
}

/* ==========================================================================
   RESEARCH SOURCES & PROVENANCE CRUD (STEP 12B)
   ========================================================================== */

export const createResearchSourceInput = z.object({
  workspaceId: z.string().uuid(),
  researchId: z.string().uuid(),
  sourceType: z.enum(RESEARCH_SOURCE_TYPES).default('website'),
  title: z.string().trim().min(1, 'Title is required').max(500),
  url: z.string().nullable().optional(),
  publisher: z.string().trim().nullable().optional(),
  publishedAt: z.string().nullable().optional(),
  retrievedAt: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  actor: z
    .object({
      actorType: z.enum(['user', 'agent', 'workflow', 'system']).default('user'),
      actorId: z.string().nullable().optional(),
    })
    .optional(),
})
export type CreateResearchSourceInput = z.input<typeof createResearchSourceInput>

export const updateResearchSourceInput = z.object({
  workspaceId: z.string().uuid(),
  researchId: z.string().uuid(),
  id: z.string().uuid(),
  sourceType: z.enum(RESEARCH_SOURCE_TYPES).optional(),
  title: z.string().trim().min(1, 'Title is required').max(500).optional(),
  url: z.string().nullable().optional(),
  publisher: z.string().trim().nullable().optional(),
  publishedAt: z.string().nullable().optional(),
  retrievedAt: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  actor: z
    .object({
      actorType: z.enum(['user', 'agent', 'workflow', 'system']).default('user'),
      actorId: z.string().nullable().optional(),
    })
    .optional(),
})
export type UpdateResearchSourceInput = z.input<typeof updateResearchSourceInput>

/**
 * Lists all sources for a research record in a workspace.
 */
export async function listResearchSources(
  db: SqlDatabase,
  query: {
    workspaceId: string
    researchId: string
  },
): Promise<ResearchSourceRecord[]> {
  const research = await getResearch(db, {
    workspaceId: query.workspaceId,
    id: query.researchId,
    includeArchived: true,
  })
  if (!research) {
    throw new Error(
      `Research record ${query.researchId} not found in workspace ${query.workspaceId}.`,
    )
  }

  const rows = await queryAll<ResearchSourceRow>(
    db,
    `SELECT id, research_id, source_type, uri, title, metadata, retrieved_at, created_at
     FROM research_source
     WHERE research_id = ?
     ORDER BY created_at ASC, id ASC`,
    [query.researchId],
  )
  return rows.map(mapSourceRow)
}

/**
 * Retrieves a single research source by ID within a research record and workspace.
 */
export async function getResearchSource(
  db: SqlDatabase,
  query: {
    workspaceId: string
    researchId: string
    id: string
  },
): Promise<ResearchSourceRecord | null> {
  const research = await getResearch(db, {
    workspaceId: query.workspaceId,
    id: query.researchId,
    includeArchived: true,
  })
  if (!research) {
    return null
  }

  const row = await queryFirst<ResearchSourceRow>(
    db,
    `SELECT id, research_id, source_type, uri, title, metadata, retrieved_at, created_at
     FROM research_source
     WHERE id = ? AND research_id = ?`,
    [query.id, query.researchId],
  )
  return row ? mapSourceRow(row) : null
}

/**
 * Creates a new research source for a research record.
 */
export async function createResearchSource(
  db: SqlDatabase,
  input: CreateResearchSourceInput,
): Promise<ResearchSourceRecord> {
  const data = createResearchSourceInput.parse(input)
  const research = await getResearch(db, {
    workspaceId: data.workspaceId,
    id: data.researchId,
    includeArchived: true,
  })
  if (!research) {
    throw new Error(
      `Research record ${data.researchId} not found in workspace ${data.workspaceId}.`,
    )
  }

  const validUrl = validateSourceUrl(data.url)
  const id = newId()
  const now = nowIso()

  const dbSourceType = toDbSourceType(data.sourceType, Boolean(validUrl))
  const metadata: ResearchSourceMetadata = {
    sourceType: data.sourceType,
    publisher: data.publisher?.trim() || null,
    publishedAt: data.publishedAt ?? null,
    note: data.note?.trim() || null,
    confidence: data.confidence ?? null,
  }

  await execute(
    db,
    `INSERT INTO research_source (
       id, research_id, source_type, uri, title, metadata, retrieved_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.researchId,
      dbSourceType,
      validUrl,
      data.title,
      JSON.stringify(metadata),
      data.retrievedAt ?? null,
      now,
    ],
  )

  const record: ResearchSourceRecord = {
    id,
    researchId: data.researchId,
    sourceType: data.sourceType,
    title: data.title,
    url: validUrl,
    publisher: metadata.publisher ?? null,
    publishedAt: metadata.publishedAt ?? null,
    retrievedAt: data.retrievedAt ?? null,
    note: metadata.note ?? null,
    confidence: metadata.confidence ?? null,
    createdAt: now,
  }

  await writeAuditLog(db, {
    workspaceId: data.workspaceId,
    actorType: data.actor?.actorType ?? 'user',
    actorId: data.actor?.actorId ?? null,
    action: 'create',
    entityType: 'research_source',
    entityId: id,
    previousValueJson: null,
    newValueJson: JSON.stringify({
      researchId: data.researchId,
      sourceType: record.sourceType,
      title: record.title,
      url: record.url,
      publisher: record.publisher,
      publishedAt: record.publishedAt,
      retrievedAt: record.retrievedAt,
    }),
  })

  await emitEventSafe(db, {
    workspaceId: data.workspaceId,
    eventType: 'research.source_added',
    actorType: data.actor?.actorType ?? 'user',
    actorId: data.actor?.actorId ?? null,
    subjectType: 'research',
    subjectId: data.researchId,
    payloadJson: JSON.stringify({
      sourceId: id,
      researchId: data.researchId,
      sourceType: record.sourceType,
      title: record.title,
      url: record.url,
    }),
  })

  return record
}

/**
 * Updates an existing research source.
 */
export async function updateResearchSource(
  db: SqlDatabase,
  input: UpdateResearchSourceInput,
): Promise<ResearchSourceRecord> {
  const data = updateResearchSourceInput.parse(input)
  const existing = await getResearchSource(db, {
    workspaceId: data.workspaceId,
    researchId: data.researchId,
    id: data.id,
  })
  if (!existing) {
    throw new Error(
      `Research source ${data.id} not found on research ${data.researchId} in workspace ${data.workspaceId}.`,
    )
  }

  const validUrl = data.url !== undefined ? validateSourceUrl(data.url) : existing.url
  const title = data.title ?? existing.title
  const sourceType = data.sourceType ?? existing.sourceType
  const publisher =
    data.publisher !== undefined ? data.publisher?.trim() || null : existing.publisher
  const publishedAt = data.publishedAt !== undefined ? data.publishedAt : existing.publishedAt
  const retrievedAt = data.retrievedAt !== undefined ? data.retrievedAt : existing.retrievedAt
  const note = data.note !== undefined ? data.note?.trim() || null : existing.note
  const confidence = data.confidence !== undefined ? data.confidence : existing.confidence

  const dbSourceType = toDbSourceType(sourceType, Boolean(validUrl))
  const metadata: ResearchSourceMetadata = {
    sourceType,
    publisher,
    publishedAt,
    note,
    confidence,
  }

  await execute(
    db,
    `UPDATE research_source
     SET source_type = ?, uri = ?, title = ?, metadata = ?, retrieved_at = ?
     WHERE id = ? AND research_id = ?`,
    [
      dbSourceType,
      validUrl,
      title,
      JSON.stringify(metadata),
      retrievedAt,
      data.id,
      data.researchId,
    ],
  )

  const updated: ResearchSourceRecord = {
    id: data.id,
    researchId: data.researchId,
    sourceType,
    title,
    url: validUrl,
    publisher,
    publishedAt,
    retrievedAt,
    note,
    confidence,
    createdAt: existing.createdAt,
  }

  await writeAuditLog(db, {
    workspaceId: data.workspaceId,
    actorType: data.actor?.actorType ?? 'user',
    actorId: data.actor?.actorId ?? null,
    action: 'update',
    entityType: 'research_source',
    entityId: data.id,
    previousValueJson: JSON.stringify({
      sourceType: existing.sourceType,
      title: existing.title,
      url: existing.url,
      publisher: existing.publisher,
      publishedAt: existing.publishedAt,
      retrievedAt: existing.retrievedAt,
    }),
    newValueJson: JSON.stringify({
      sourceType: updated.sourceType,
      title: updated.title,
      url: updated.url,
      publisher: updated.publisher,
      publishedAt: updated.publishedAt,
      retrievedAt: updated.retrievedAt,
    }),
  })

  await emitEventSafe(db, {
    workspaceId: data.workspaceId,
    eventType: 'research.source_updated',
    actorType: data.actor?.actorType ?? 'user',
    actorId: data.actor?.actorId ?? null,
    subjectType: 'research',
    subjectId: data.researchId,
    payloadJson: JSON.stringify({
      sourceId: data.id,
      researchId: data.researchId,
      sourceType: updated.sourceType,
      title: updated.title,
      url: updated.url,
    }),
  })

  return updated
}

/**
 * Removes a research source from a research record.
 */
export async function removeResearchSource(
  db: SqlDatabase,
  input: {
    workspaceId: string
    researchId: string
    id: string
    actor?: { actorType: 'user' | 'agent' | 'workflow' | 'system'; actorId?: string | null }
  },
): Promise<{ id: string; researchId: string }> {
  const existing = await getResearchSource(db, {
    workspaceId: input.workspaceId,
    researchId: input.researchId,
    id: input.id,
  })
  if (!existing) {
    throw new Error(
      `Research source ${input.id} not found on research ${input.researchId} in workspace ${input.workspaceId}.`,
    )
  }

  await execute(db, `DELETE FROM research_source WHERE id = ? AND research_id = ?`, [
    input.id,
    input.researchId,
  ])

  await writeAuditLog(db, {
    workspaceId: input.workspaceId,
    actorType: input.actor?.actorType ?? 'user',
    actorId: input.actor?.actorId ?? null,
    action: 'delete',
    entityType: 'research_source',
    entityId: input.id,
    previousValueJson: JSON.stringify({
      researchId: existing.researchId,
      sourceType: existing.sourceType,
      title: existing.title,
      url: existing.url,
      publisher: existing.publisher,
      publishedAt: existing.publishedAt,
      retrievedAt: existing.retrievedAt,
    }),
    newValueJson: null,
  })

  await emitEventSafe(db, {
    workspaceId: input.workspaceId,
    eventType: 'research.source_removed',
    actorType: input.actor?.actorType ?? 'user',
    actorId: input.actor?.actorId ?? null,
    subjectType: 'research',
    subjectId: input.researchId,
    payloadJson: JSON.stringify({
      sourceId: input.id,
      researchId: input.researchId,
      title: existing.title,
    }),
  })

  return { id: input.id, researchId: input.researchId }
}
