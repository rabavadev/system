import { z } from 'zod'

import type { Memory, MemoryClass, MemoryScopeType } from '~/types/domain'

import {
  assertMemoryClassRules,
  assertMemoryTransition,
  assertSupersessionAllowed,
  evidenceSummary,
  memoryFreshness,
} from '../memory/rules.ts'
import { writeAuditLog } from './audit.ts'
import { emitEventSafe } from './event.ts'
import { execute, newId, nowIso, queryAll, queryFirst, type SqlDatabase } from './sql.ts'

/**
 * Memory repository. Structural SqlDatabase only (no cloudflare:workers),
 * so lifecycle and scope-integrity behavior run under plain node tests.
 *
 * Scope references are validated application-side here, matching the
 * database doctrine: never trust a client-supplied id, never let a scoped
 * memory point at an archived or foreign-workspace entity.
 */

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

const isoDateTime = z.iso.datetime({ offset: false })
const memoryClassSchema = z.enum([
  'permanent_fact',
  'verified_learning',
  'proposed_learning',
  'temporary_context',
])
const memoryScopeSchema = z.enum([
  'workspace',
  'brand',
  'niche',
  'account',
  'platform',
  'product',
  'campaign',
])
const memoryStatusSchema = z.enum(['active', 'superseded', 'archived', 'rejected'])

const scopeFields = {
  scopeType: memoryScopeSchema.default('workspace'),
  scopeId: z.uuid().nullable().optional(),
}

function validateScopePair(data: { scopeType: MemoryScopeType; scopeId?: string | null }): void {
  if (data.scopeType === 'workspace' && data.scopeId) {
    throw new Error('Workspace memory cannot point at another item.')
  }
  if (data.scopeType !== 'workspace' && !data.scopeId) {
    throw new Error('Choose what this memory applies to.')
  }
}

/** Create input. Unknown/trusted fields (status, supersededBy...) reject. */
export const createMemoryInput = z
  .object({
    workspaceId: z.uuid(),
    memoryClass: memoryClassSchema,
    content: z.string().trim().min(1, 'Write the memory first.').max(4000),
    ...scopeFields,
    confidence: z.number().min(0).max(1).nullable().optional(),
    sourceType: z
      .enum(['user', 'agent', 'research', 'observation', 'import', 'manual'])
      .default('manual'),
    sourceId: z.string().trim().max(200).nullable().optional(),
    evidenceJson: z.string().max(8000).nullable().optional(),
    expiresAt: isoDateTime.nullable().optional(),
    expectedBrandId: z.uuid().nullable().optional(),
    expectedNicheId: z.uuid().nullable().optional(),
    expectedProductId: z.uuid().nullable().optional(),
  })
  .strict()
export type CreateMemoryInput = z.input<typeof createMemoryInput>

export const updateMemoryInput = z
  .object({
    id: z.uuid(),
    content: z.string().trim().min(1, 'Write the memory first.').max(4000),
    ...scopeFields,
    confidence: z.number().min(0).max(1).nullable().optional(),
    evidenceJson: z.string().max(8000).nullable().optional(),
    expiresAt: isoDateTime.nullable().optional(),
    expectedBrandId: z.uuid().nullable().optional(),
    expectedNicheId: z.uuid().nullable().optional(),
    expectedProductId: z.uuid().nullable().optional(),
  })
  .strict()
export type UpdateMemoryInput = z.input<typeof updateMemoryInput>

export const verifyMemoryInput = z
  .object({
    id: z.uuid(),
    confidence: z.number().min(0).max(1),
    evidenceJson: z.string().min(1, 'Add evidence before verifying this.').max(8000),
  })
  .strict()
export type VerifyMemoryInput = z.input<typeof verifyMemoryInput>

export const memoryListFiltersInput = z
  .object({
    memoryClass: memoryClassSchema.optional(),
    status: memoryStatusSchema.optional(),
    freshness: z.enum(['current', 'expired']).optional(),
    scopeType: memoryScopeSchema.optional(),
    scopeId: z.uuid().optional(),
    brandId: z.uuid().optional(),
    nicheId: z.uuid().optional(),
    productId: z.uuid().optional(),
    accountId: z.uuid().optional(),
    platformId: z.uuid().optional(),
    query: z.string().trim().max(200).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict()
export type MemoryListFiltersInput = z.input<typeof memoryListFiltersInput>

export interface MemoryScopeDescriptor {
  scopeType: MemoryScopeType
  scopeId: string | null
  label: string
  path: string
  workspaceId: string | null
  brandId: string | null
  nicheId: string | null
  productId: string | null
  accountId: string | null
  platformId: string | null
  campaignId: string | null
  archived: boolean
}

function scopeError(message = 'That item is not available for this memory.'): Error {
  return new Error(message)
}

async function requireExpectedBrand(
  db: SqlDatabase,
  workspaceId: string,
  expectedBrandId: string | null | undefined,
): Promise<void> {
  if (!expectedBrandId) return
  const row = await queryFirst<{ id: string; deleted_at: string | null }>(
    db,
    `SELECT id, deleted_at FROM brand WHERE id = ? AND workspace_id = ?`,
    [expectedBrandId, workspaceId],
  )
  if (!row || row.deleted_at) {
    throw scopeError('The selected brand is not available in this workspace.')
  }
}

/**
 * Validate a scope target and optional relationship context server-side.
 * `expectedBrandId`/`expectedNicheId`/`expectedProductId` are consistency
 * checks only; the stored scope remains the existing single scoped reference.
 */
export async function validateMemoryScope(
  db: SqlDatabase,
  workspaceId: string,
  scopeType: MemoryScopeType,
  scopeId: string | null,
  expected: {
    brandId?: string | null | undefined
    nicheId?: string | null | undefined
    productId?: string | null | undefined
  } = {},
): Promise<MemoryScopeDescriptor> {
  validateScopePair({ scopeType, scopeId })
  await requireExpectedBrand(db, workspaceId, expected.brandId)

  if (scopeType === 'workspace') {
    const workspace = await queryFirst<{ id: string; name: string; deleted_at: string | null }>(
      db,
      `SELECT id, name, deleted_at FROM workspace WHERE id = ?`,
      [workspaceId],
    )
    if (!workspace || workspace.deleted_at) throw scopeError('Workspace is not available.')
    return {
      scopeType,
      scopeId: null,
      label: 'Workspace',
      path: workspace.name,
      workspaceId,
      brandId: null,
      nicheId: null,
      productId: null,
      accountId: null,
      platformId: null,
      campaignId: null,
      archived: false,
    }
  }

  if (scopeType === 'platform') {
    const row = await queryFirst<{ id: string; name: string }>(
      db,
      `SELECT id, name FROM platform WHERE id = ?`,
      [scopeId],
    )
    if (!row) throw scopeError('That platform is not available.')
    return {
      scopeType,
      scopeId,
      label: row.name,
      path: row.name,
      workspaceId: null,
      brandId: null,
      nicheId: null,
      productId: null,
      accountId: null,
      platformId: row.id,
      campaignId: null,
      archived: false,
    }
  }

  if (scopeType === 'brand') {
    const row = await queryFirst<{ id: string; name: string; deleted_at: string | null }>(
      db,
      `SELECT id, name, deleted_at FROM brand WHERE id = ? AND workspace_id = ?`,
      [scopeId, workspaceId],
    )
    if (!row) throw scopeError('That brand is not available in this workspace.')
    if (row.deleted_at) throw scopeError('That brand is archived. Restore it first.')
    if (expected.brandId && expected.brandId !== row.id) {
      throw scopeError('That brand does not match the selected context.')
    }
    return {
      scopeType,
      scopeId,
      label: row.name,
      path: row.name,
      workspaceId,
      brandId: row.id,
      nicheId: null,
      productId: null,
      accountId: null,
      platformId: null,
      campaignId: null,
      archived: false,
    }
  }

  if (scopeType === 'niche') {
    const row = await queryFirst<{
      id: string
      name: string
      brand_id: string
      brand_name: string
      workspace_id: string
      deleted_at: string | null
      brand_deleted_at: string | null
    }>(
      db,
      `SELECT n.id, n.name, n.brand_id, b.name AS brand_name, b.workspace_id,
              n.deleted_at, b.deleted_at AS brand_deleted_at
       FROM niche n JOIN brand b ON b.id = n.brand_id
       WHERE n.id = ?`,
      [scopeId],
    )
    if (!row || row.workspace_id !== workspaceId) {
      throw scopeError('That niche is not available in this workspace.')
    }
    if (row.deleted_at || row.brand_deleted_at) {
      throw scopeError('That niche is archived. Restore it first.')
    }
    if (expected.brandId && expected.brandId !== row.brand_id) {
      throw scopeError('That niche belongs to a different brand.')
    }
    return {
      scopeType,
      scopeId,
      label: row.name,
      path: `${row.brand_name} / ${row.name}`,
      workspaceId,
      brandId: row.brand_id,
      nicheId: row.id,
      productId: null,
      accountId: null,
      platformId: null,
      campaignId: null,
      archived: false,
    }
  }

  if (scopeType === 'product') {
    const row = await queryFirst<{
      id: string
      name: string
      brand_id: string
      niche_id: string | null
      brand_name: string
      niche_name: string | null
      workspace_id: string
      status: string
      deleted_at: string | null
      brand_deleted_at: string | null
    }>(
      db,
      `SELECT p.id, p.name, p.brand_id, p.niche_id, p.status, p.deleted_at,
              b.name AS brand_name, b.workspace_id, b.deleted_at AS brand_deleted_at,
              n.name AS niche_name
       FROM product p
       JOIN brand b ON b.id = p.brand_id
       LEFT JOIN niche n ON n.id = p.niche_id
       WHERE p.id = ?`,
      [scopeId],
    )
    if (!row || row.workspace_id !== workspaceId) {
      throw scopeError('That product is not available in this workspace.')
    }
    if (row.status === 'archived' || row.deleted_at || row.brand_deleted_at) {
      throw scopeError('That product is archived. Restore it first.')
    }
    if (expected.brandId && expected.brandId !== row.brand_id) {
      throw scopeError('That product belongs to a different brand.')
    }
    if (expected.nicheId && row.niche_id !== expected.nicheId) {
      throw scopeError('That product belongs to a different niche.')
    }
    return {
      scopeType,
      scopeId,
      label: row.name,
      path: row.niche_name
        ? `${row.brand_name} / ${row.niche_name} / ${row.name}`
        : `${row.brand_name} / ${row.name}`,
      workspaceId,
      brandId: row.brand_id,
      nicheId: row.niche_id,
      productId: row.id,
      accountId: null,
      platformId: null,
      campaignId: null,
      archived: false,
    }
  }

  if (scopeType === 'account') {
    const row = await queryFirst<{
      id: string
      handle: string
      display_name: string | null
      platform_id: string
      platform_name: string
      workspace_id: string
      status: string
      deleted_at: string | null
    }>(
      db,
      `SELECT a.id, a.handle, a.display_name, a.platform_id, a.workspace_id, a.status, a.deleted_at,
              p.name AS platform_name
       FROM account a JOIN platform p ON p.id = a.platform_id
       WHERE a.id = ?`,
      [scopeId],
    )
    if (!row || row.workspace_id !== workspaceId) {
      throw scopeError('That account is not available in this workspace.')
    }
    if (row.status === 'archived' || row.deleted_at) {
      throw scopeError('That account is archived. Restore it first.')
    }
    if (expected.brandId) {
      const linked = await queryFirst<{ id: string }>(
        db,
        `SELECT an.account_id AS id
         FROM account_niche an
         JOIN niche n ON n.id = an.niche_id AND n.deleted_at IS NULL
         WHERE an.account_id = ? AND n.brand_id = ?
         LIMIT 1`,
        [row.id, expected.brandId],
      )
      const anyActive = await queryFirst<{ id: string }>(
        db,
        `SELECT an.account_id AS id
         FROM account_niche an
         JOIN niche n ON n.id = an.niche_id AND n.deleted_at IS NULL
         WHERE an.account_id = ?
         LIMIT 1`,
        [row.id],
      )
      if (anyActive && !linked) {
        throw scopeError('That account is not associated with the selected brand.')
      }
    }
    const label = row.display_name ?? row.handle
    return {
      scopeType,
      scopeId,
      label,
      path: `${label} / ${row.platform_name}`,
      workspaceId,
      brandId: expected.brandId ?? null,
      nicheId: null,
      productId: null,
      accountId: row.id,
      platformId: row.platform_id,
      campaignId: null,
      archived: false,
    }
  }

  const row = await queryFirst<{
    id: string
    name: string
    brand_id: string | null
    product_id: string | null
    workspace_id: string
    status: string
    deleted_at: string | null
  }>(
    db,
    `SELECT id, name, brand_id, product_id, workspace_id, status, deleted_at
     FROM campaign WHERE id = ?`,
    [scopeId],
  )
  if (!row || row.workspace_id !== workspaceId) {
    throw scopeError('That campaign is not available in this workspace.')
  }
  if (row.status === 'archived' || row.deleted_at) {
    throw scopeError('That campaign is archived. Restore it first.')
  }
  if (expected.brandId && row.brand_id && row.brand_id !== expected.brandId) {
    throw scopeError('That campaign belongs to a different brand.')
  }
  if (expected.productId && row.product_id !== expected.productId) {
    throw scopeError('That campaign belongs to a different product.')
  }
  return {
    scopeType: 'campaign',
    scopeId,
    label: row.name,
    path: row.name,
    workspaceId,
    brandId: row.brand_id,
    nicheId: null,
    productId: row.product_id,
    accountId: null,
    platformId: null,
    campaignId: row.id,
    archived: false,
  }
}

/* ---- List/detail read models ---- */

export interface MemorySummary extends Memory {
  scopeLabel: string
  scopePath: string
  scopeArchived: boolean
  freshness: 'current' | 'expired' | 'inactive'
  evidenceText: string | null
  supersededByContent: string | null
  replacesContent: string | null
}

interface MemorySummaryRow extends MemoryRow {
  scope_label: string | null
  scope_path: string | null
  scope_archived: number
  superseded_by_content: string | null
  replaces_content: string | null
}

const SUMMARY_SELECT = `
  SELECT m.*,
    CASE m.scope_type
      WHEN 'workspace' THEN 'Workspace'
      WHEN 'brand' THEN COALESCE((SELECT b.name FROM brand b WHERE b.id = m.scope_id), 'Missing brand')
      WHEN 'niche' THEN COALESCE((SELECT n.name FROM niche n WHERE n.id = m.scope_id), 'Missing niche')
      WHEN 'account' THEN COALESCE((SELECT COALESCE(a.display_name, a.handle) FROM account a WHERE a.id = m.scope_id), 'Missing account')
      WHEN 'platform' THEN COALESCE((SELECT p.name FROM platform p WHERE p.id = m.scope_id), 'Missing platform')
      WHEN 'product' THEN COALESCE((SELECT p.name FROM product p WHERE p.id = m.scope_id), 'Missing product')
      WHEN 'campaign' THEN COALESCE((SELECT c.name FROM campaign c WHERE c.id = m.scope_id), 'Missing campaign')
      ELSE 'Unknown scope'
    END AS scope_label,
    CASE m.scope_type
      WHEN 'workspace' THEN (SELECT w.name FROM workspace w WHERE w.id = m.workspace_id)
      WHEN 'brand' THEN (SELECT b.name FROM brand b WHERE b.id = m.scope_id)
      WHEN 'niche' THEN (SELECT b.name || ' / ' || n.name FROM niche n JOIN brand b ON b.id = n.brand_id WHERE n.id = m.scope_id)
      WHEN 'account' THEN (SELECT COALESCE(a.display_name, a.handle) || ' / ' || p.name FROM account a JOIN platform p ON p.id = a.platform_id WHERE a.id = m.scope_id)
      WHEN 'platform' THEN (SELECT p.name FROM platform p WHERE p.id = m.scope_id)
      WHEN 'product' THEN (
        SELECT b.name || COALESCE(' / ' || n.name, '') || ' / ' || p.name
        FROM product p JOIN brand b ON b.id = p.brand_id LEFT JOIN niche n ON n.id = p.niche_id
        WHERE p.id = m.scope_id
      )
      WHEN 'campaign' THEN (SELECT c.name FROM campaign c WHERE c.id = m.scope_id)
      ELSE NULL
    END AS scope_path,
    CASE m.scope_type
      WHEN 'brand' THEN COALESCE((SELECT b.deleted_at IS NOT NULL FROM brand b WHERE b.id = m.scope_id), 1)
      WHEN 'niche' THEN COALESCE((SELECT n.deleted_at IS NOT NULL OR b.deleted_at IS NOT NULL FROM niche n JOIN brand b ON b.id = n.brand_id WHERE n.id = m.scope_id), 1)
      WHEN 'account' THEN COALESCE((SELECT a.status = 'archived' OR a.deleted_at IS NOT NULL FROM account a WHERE a.id = m.scope_id), 1)
      WHEN 'product' THEN COALESCE((SELECT p.status = 'archived' OR p.deleted_at IS NOT NULL OR b.deleted_at IS NOT NULL FROM product p JOIN brand b ON b.id = p.brand_id WHERE p.id = m.scope_id), 1)
      WHEN 'campaign' THEN COALESCE((SELECT c.status = 'archived' OR c.deleted_at IS NOT NULL FROM campaign c WHERE c.id = m.scope_id), 1)
      ELSE 0
    END AS scope_archived,
    (SELECT r.content FROM memory r WHERE r.id = m.superseded_by) AS superseded_by_content,
    (SELECT old.content FROM memory old WHERE old.superseded_by = m.id ORDER BY old.updated_at DESC, old.id ASC LIMIT 1) AS replaces_content
  FROM memory m
`

function toSummary(row: MemorySummaryRow, now: string): MemorySummary {
  const memory = toMemory(row)
  return {
    ...memory,
    scopeLabel: row.scope_label ?? 'Unknown scope',
    scopePath: row.scope_path ?? row.scope_label ?? 'Unknown scope',
    scopeArchived: row.scope_archived === 1,
    freshness: memoryFreshness(memory, now),
    evidenceText: evidenceSummary(memory.evidenceJson),
    supersededByContent: row.superseded_by_content,
    replacesContent: row.replaces_content,
  }
}

function addFilter(where: string[], params: unknown[], clause: string, values: unknown[]): void {
  where.push(clause)
  params.push(...values)
}

/** List memories with simple, deterministic filters. */
export async function listMemories(
  db: SqlDatabase,
  workspaceId: string,
  filters: MemoryListFiltersInput = {},
): Promise<MemorySummary[]> {
  const data = memoryListFiltersInput.parse(filters)
  const now = nowIso()
  const where = ['m.workspace_id = ?']
  const params: unknown[] = [workspaceId]

  if (data.memoryClass) addFilter(where, params, 'm.memory_class = ?', [data.memoryClass])
  if (data.status) addFilter(where, params, 'm.status = ?', [data.status])
  if (data.freshness === 'current') {
    addFilter(where, params, `m.status = 'active' AND (m.expires_at IS NULL OR m.expires_at > ?)`, [
      now,
    ])
  }
  if (data.freshness === 'expired') {
    addFilter(
      where,
      params,
      `m.status = 'active' AND m.expires_at IS NOT NULL AND m.expires_at <= ?`,
      [now],
    )
  }
  if (data.scopeType) addFilter(where, params, 'm.scope_type = ?', [data.scopeType])
  if (data.scopeId) addFilter(where, params, 'm.scope_id = ?', [data.scopeId])
  if (data.query) {
    addFilter(where, params, 'LOWER(m.content) LIKE ?', [`%${data.query.toLowerCase()}%`])
  }
  if (data.brandId) {
    addFilter(
      where,
      params,
      `(
        (m.scope_type = 'brand' AND m.scope_id = ?)
        OR (m.scope_type = 'niche' AND EXISTS (SELECT 1 FROM niche n WHERE n.id = m.scope_id AND n.brand_id = ?))
        OR (m.scope_type = 'product' AND EXISTS (SELECT 1 FROM product p WHERE p.id = m.scope_id AND p.brand_id = ?))
        OR (m.scope_type = 'account' AND EXISTS (
          SELECT 1 FROM account_niche an JOIN niche n ON n.id = an.niche_id AND n.deleted_at IS NULL
          WHERE an.account_id = m.scope_id AND n.brand_id = ?
        ))
        OR (m.scope_type = 'campaign' AND EXISTS (SELECT 1 FROM campaign c WHERE c.id = m.scope_id AND c.brand_id = ?))
      )`,
      [data.brandId, data.brandId, data.brandId, data.brandId, data.brandId],
    )
  }
  if (data.nicheId) {
    addFilter(
      where,
      params,
      `(
        (m.scope_type = 'niche' AND m.scope_id = ?)
        OR (m.scope_type = 'product' AND EXISTS (SELECT 1 FROM product p WHERE p.id = m.scope_id AND p.niche_id = ?))
        OR (m.scope_type = 'account' AND EXISTS (SELECT 1 FROM account_niche an WHERE an.account_id = m.scope_id AND an.niche_id = ?))
        OR (m.scope_type = 'campaign' AND EXISTS (
          SELECT 1 FROM campaign c JOIN product p ON p.id = c.product_id
          WHERE c.id = m.scope_id AND p.niche_id = ?
        ))
      )`,
      [data.nicheId, data.nicheId, data.nicheId, data.nicheId],
    )
  }
  if (data.productId) {
    addFilter(
      where,
      params,
      `(
        (m.scope_type = 'product' AND m.scope_id = ?)
        OR (m.scope_type = 'campaign' AND EXISTS (SELECT 1 FROM campaign c WHERE c.id = m.scope_id AND c.product_id = ?))
      )`,
      [data.productId, data.productId],
    )
  }
  if (data.accountId) {
    addFilter(
      where,
      params,
      `(
        (m.scope_type = 'account' AND m.scope_id = ?)
        OR (m.scope_type = 'campaign' AND EXISTS (
          SELECT 1 FROM campaign_account ca WHERE ca.campaign_id = m.scope_id AND ca.account_id = ?
        ))
      )`,
      [data.accountId, data.accountId],
    )
  }
  if (data.platformId) {
    addFilter(
      where,
      params,
      `(
        (m.scope_type = 'platform' AND m.scope_id = ?)
        OR (m.scope_type = 'account' AND EXISTS (SELECT 1 FROM account a WHERE a.id = m.scope_id AND a.platform_id = ?))
      )`,
      [data.platformId, data.platformId],
    )
  }

  const limit = data.limit ?? 200
  const rows = await queryAll<MemorySummaryRow>(
    db,
    `${SUMMARY_SELECT}
     WHERE ${where.join(' AND ')}
     ORDER BY m.created_at DESC, m.id ASC
     LIMIT ?`,
    [...params, limit],
  )
  return rows.map((row) => toSummary(row, now))
}

export async function getMemoryById(db: SqlDatabase, id: string): Promise<Memory | null> {
  const row = await queryFirst<MemoryRow>(db, `SELECT * FROM memory WHERE id = ?`, [id])
  return row ? toMemory(row) : null
}

export async function getMemorySummaryById(
  db: SqlDatabase,
  id: string,
): Promise<MemorySummary | null> {
  const row = await queryFirst<MemorySummaryRow>(db, `${SUMMARY_SELECT} WHERE m.id = ?`, [id])
  return row ? toSummary(row, nowIso()) : null
}

function snapshot(memory: Memory | null): string | null {
  return memory ? JSON.stringify(memory) : null
}

async function auditMemory(
  db: SqlDatabase,
  action: 'create' | 'update' | 'delete' | 'restore',
  before: Memory | null,
  after: Memory | null,
): Promise<void> {
  const memory = after ?? before
  if (!memory) return
  await writeAuditLog(db, {
    workspaceId: memory.workspaceId,
    actorType: 'user',
    action,
    entityType: 'memory',
    entityId: memory.id,
    previousValueJson: snapshot(before),
    newValueJson: snapshot(after),
  })
}

async function emitMemoryEvent(
  db: SqlDatabase,
  eventType: string,
  memory: Memory,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await emitEventSafe(db, {
    workspaceId: memory.workspaceId,
    eventType,
    actorType: 'user',
    subjectType: 'memory',
    subjectId: memory.id,
    payloadJson: JSON.stringify({
      memoryClass: memory.memoryClass,
      scopeType: memory.scopeType,
      status: memory.status,
      ...payload,
    }),
  })
}

function classRulesFor(data: {
  memoryClass: MemoryClass
  confidence?: number | null | undefined
  evidenceJson?: string | null | undefined
  expiresAt?: string | null | undefined
}): void {
  assertMemoryClassRules({
    memoryClass: data.memoryClass,
    confidence: data.confidence ?? null,
    evidenceJson: data.evidenceJson ?? null,
    expiresAt: data.expiresAt ?? null,
  })
}

/** Create memory after scope and class validation. */
export async function createMemory(
  db: SqlDatabase,
  input: CreateMemoryInput,
  options?: { id?: string },
): Promise<Memory> {
  const data = createMemoryInput.parse(input)
  await validateMemoryScope(db, data.workspaceId, data.scopeType, data.scopeId ?? null, {
    brandId: data.expectedBrandId,
    nicheId: data.expectedNicheId,
    productId: data.expectedProductId,
  })
  classRulesFor(data)

  const id = options?.id ?? newId()
  const now = nowIso()
  const lastVerifiedAt =
    data.memoryClass === 'verified_learning' || data.memoryClass === 'permanent_fact' ? now : null
  await execute(
    db,
    `INSERT INTO memory (
       id, workspace_id, memory_class, content, scope_type, scope_id,
       status, confidence, source_type, source_id, evidence,
       created_at, updated_at, last_verified_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.workspaceId,
      data.memoryClass,
      data.content,
      data.scopeType,
      data.scopeId ?? null,
      data.confidence ?? null,
      data.sourceType,
      data.sourceId ?? null,
      data.evidenceJson ?? null,
      now,
      now,
      lastVerifiedAt,
      data.expiresAt ?? null,
    ],
  )
  const created = await getMemoryById(db, id)
  if (!created) throw new Error('Memory could not be saved.')
  await auditMemory(db, 'create', null, created)
  await emitMemoryEvent(db, 'memory.created', created)
  return created
}

/** Edit an active memory. The audit log preserves the previous version. */
export async function updateMemory(db: SqlDatabase, input: UpdateMemoryInput): Promise<Memory> {
  const data = updateMemoryInput.parse(input)
  const existing = await getMemoryById(db, data.id)
  if (!existing) throw new Error('Memory not found.')
  if (existing.status !== 'active') {
    throw new Error('Only current memory can be edited.')
  }
  await validateMemoryScope(db, existing.workspaceId, data.scopeType, data.scopeId ?? null, {
    brandId: data.expectedBrandId,
    nicheId: data.expectedNicheId,
    productId: data.expectedProductId,
  })
  const nextConfidence = data.confidence !== undefined ? data.confidence : existing.confidence
  const nextEvidence = data.evidenceJson !== undefined ? data.evidenceJson : existing.evidenceJson
  const nextExpiresAt = data.expiresAt !== undefined ? data.expiresAt : existing.expiresAt
  classRulesFor({
    memoryClass: existing.memoryClass,
    confidence: nextConfidence,
    evidenceJson: nextEvidence,
    expiresAt: nextExpiresAt,
  })
  await execute(
    db,
    `UPDATE memory
     SET content = ?, scope_type = ?, scope_id = ?, confidence = ?, evidence = ?, expires_at = ?, updated_at = ?
     WHERE id = ?`,
    [
      data.content,
      data.scopeType,
      data.scopeId ?? null,
      nextConfidence,
      nextEvidence,
      nextExpiresAt,
      nowIso(),
      data.id,
    ],
  )
  const updated = await getMemoryById(db, data.id)
  if (!updated) throw new Error('Memory could not be updated.')
  await auditMemory(db, 'update', existing, updated)
  await emitMemoryEvent(db, 'memory.updated', updated)
  return updated
}

export async function archiveMemory(db: SqlDatabase, id: string): Promise<Memory> {
  const existing = await getMemoryById(db, id)
  if (!existing) throw new Error('Memory not found.')
  assertMemoryTransition(existing, 'archive', nowIso())
  if (existing.status === 'archived') return existing
  await execute(db, `UPDATE memory SET status = 'archived', updated_at = ? WHERE id = ?`, [
    nowIso(),
    id,
  ])
  const updated = await getMemoryById(db, id)
  if (!updated) throw new Error('Memory could not be archived.')
  await auditMemory(db, 'delete', existing, updated)
  await emitMemoryEvent(db, 'memory.archived', updated)
  return updated
}

export async function restoreMemory(db: SqlDatabase, id: string): Promise<Memory> {
  const existing = await getMemoryById(db, id)
  if (!existing) throw new Error('Memory not found.')
  assertMemoryTransition(existing, 'restore', nowIso())
  await execute(db, `UPDATE memory SET status = 'active', updated_at = ? WHERE id = ?`, [
    nowIso(),
    id,
  ])
  const updated = await getMemoryById(db, id)
  if (!updated) throw new Error('Memory could not be restored.')
  await auditMemory(db, 'restore', existing, updated)
  await emitMemoryEvent(db, 'memory.restored', updated)
  return updated
}

/** Proposed learning → verified learning, with evidence and confidence. */
export async function verifyMemory(db: SqlDatabase, input: VerifyMemoryInput): Promise<Memory> {
  const data = verifyMemoryInput.parse(input)
  const existing = await getMemoryById(db, data.id)
  if (!existing) throw new Error('Memory not found.')
  const now = nowIso()
  assertMemoryTransition(existing, 'verify', now)
  assertMemoryClassRules({
    memoryClass: 'verified_learning',
    confidence: data.confidence,
    evidenceJson: data.evidenceJson,
    expiresAt: existing.expiresAt,
  })
  await execute(
    db,
    `UPDATE memory
     SET memory_class = 'verified_learning', confidence = ?, evidence = ?,
         last_verified_at = ?, updated_at = ?
     WHERE id = ?`,
    [data.confidence, data.evidenceJson, now, now, data.id],
  )
  const updated = await getMemoryById(db, data.id)
  if (!updated) throw new Error('Memory could not be verified.')
  await auditMemory(db, 'update', existing, updated)
  await emitMemoryEvent(db, 'memory.verified', updated)
  return updated
}

/** Reject a proposed learning without deleting its history. */
export async function rejectMemory(db: SqlDatabase, id: string): Promise<Memory> {
  const existing = await getMemoryById(db, id)
  if (!existing) throw new Error('Memory not found.')
  assertMemoryTransition(existing, 'reject', nowIso())
  await execute(db, `UPDATE memory SET status = 'rejected', updated_at = ? WHERE id = ?`, [
    nowIso(),
    id,
  ])
  const updated = await getMemoryById(db, id)
  if (!updated) throw new Error('Memory could not be rejected.')
  await auditMemory(db, 'update', existing, updated)
  await emitMemoryEvent(db, 'memory.rejected', updated)
  return updated
}

/** Link an existing active replacement. Exposed for tests and future flows. */
export async function markMemorySuperseded(
  db: SqlDatabase,
  memoryId: string,
  replacementId: string,
): Promise<Memory> {
  const existing = await getMemoryById(db, memoryId)
  const replacement = await getMemoryById(db, replacementId)
  if (!existing || !replacement) throw new Error('Memory not found.')
  if (existing.workspaceId !== replacement.workspaceId) {
    throw new Error('A memory can only be replaced within the same workspace.')
  }
  assertSupersessionAllowed(existing, replacementId, nowIso())
  if (replacement.status !== 'active') {
    throw new Error('The replacement must be current.')
  }
  if (replacement.memoryClass !== existing.memoryClass) {
    throw new Error('The replacement must keep the same memory type.')
  }
  await execute(
    db,
    `UPDATE memory SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?`,
    [replacementId, nowIso(), memoryId],
  )
  const updated = await getMemoryById(db, memoryId)
  if (!updated) throw new Error('Memory could not be replaced.')
  await auditMemory(db, 'update', existing, updated)
  await emitMemoryEvent(db, 'memory.superseded', updated, { replacementId })
  return updated
}

/** Create replacement + mark the old memory superseded, preserving history. */
export async function supersedeMemory(
  db: SqlDatabase,
  memoryId: string,
  replacement: CreateMemoryInput,
): Promise<{ previous: Memory; replacement: Memory }> {
  const existing = await getMemoryById(db, memoryId)
  if (!existing) throw new Error('Memory not found.')
  if (replacement.memoryClass !== existing.memoryClass) {
    throw new Error('The replacement must keep the same memory type.')
  }
  const replacementId = newId()
  assertSupersessionAllowed(existing, replacementId, nowIso())
  const created = await createMemory(db, replacement, { id: replacementId })
  const previous = await markMemorySuperseded(db, memoryId, created.id)
  return { previous, replacement: created }
}

/** Back-compat helper for older callers; superseded by listMemories. */
export async function listActiveMemories(
  db: SqlDatabase,
  workspaceId: string,
  scope?: { scopeType: Memory['scopeType']; scopeId: string },
): Promise<Memory[]> {
  const rows = await listMemories(db, workspaceId, {
    status: 'active',
    ...(scope ? { scopeType: scope.scopeType, scopeId: scope.scopeId } : {}),
  })
  return rows.filter((memory) => memory.freshness === 'current')
}
