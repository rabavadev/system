import { z } from 'zod'

import type { MetricDefinition } from '~/types/domain'
import { IntegrityError } from './relations.ts'
import { execute, newId, nowIso, queryAll, queryFirst, type SqlDatabase } from './sql.ts'

export interface MetricDefinitionRow {
  id: string
  workspace_id: string | null
  key: string
  name: string
  description: string | null
  unit: string | null
  created_at: string
}

function toMetricDefinition(row: MetricDefinitionRow): MetricDefinition {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    key: row.key,
    name: row.name,
    description: row.description,
    unit: row.unit,
    createdAt: row.created_at,
  }
}

/**
 * The 12 canonical built-in metric definitions for the platform.
 * Stored with workspace_id = NULL in metric_definition table.
 */
export const BUILTIN_METRICS: ReadonlyArray<{
  id: string
  key: string
  name: string
  description: string
  unit: string
}> = [
  {
    id: '6c37f650-d5b6-4015-8f14-95c1e85fc23a',
    key: 'impressions',
    name: 'Impressions',
    description: 'Times content was shown.',
    unit: 'count',
  },
  {
    id: 'a3d20229-52e5-4769-a3a9-cb64d1a2e7d2',
    key: 'engagements',
    name: 'Engagements',
    description: 'Total engagement actions.',
    unit: 'count',
  },
  {
    id: 'c5faec40-f094-42cb-b73d-67b8db70d736',
    key: 'saves',
    name: 'Saves',
    description: 'Times content was saved.',
    unit: 'count',
  },
  {
    id: '72455ca8-c160-460a-8121-da2dae4c9558',
    key: 'clicks',
    name: 'Clicks',
    description: 'Clicks on content.',
    unit: 'count',
  },
  {
    id: '54895b39-c960-496f-82fb-c0a73c953e16',
    key: 'outbound_clicks',
    name: 'Outbound clicks',
    description: 'Clicks leaving the platform to a link.',
    unit: 'count',
  },
  {
    id: 'b009f533-402e-4ac2-be27-262253cf29ea',
    key: 'conversions',
    name: 'Conversions',
    description: 'Attributed conversion events.',
    unit: 'count',
  },
  {
    id: 'c37c850c-8d3a-4ae9-ac89-ce83527b4031',
    key: 'revenue',
    name: 'Revenue',
    description: 'Attributed revenue.',
    unit: 'usd',
  },
  {
    id: 'e12f4581-7489-4a92-95b1-128d9c129e01',
    key: 'orders',
    name: 'Orders',
    description: 'Total purchase orders.',
    unit: 'count',
  },
  {
    id: 'e12f4581-7489-4a92-95b1-128d9c129e02',
    key: 'conversion_rate',
    name: 'Conversion Rate',
    description: 'Conversion rate percentage.',
    unit: 'percent',
  },
  {
    id: 'e12f4581-7489-4a92-95b1-128d9c129e03',
    key: 'qualified_visits',
    name: 'Qualified Visits',
    description: 'High-intent or qualified visits.',
    unit: 'count',
  },
  {
    id: 'e12f4581-7489-4a92-95b1-128d9c129e04',
    key: 'ctr',
    name: 'Click-Through Rate',
    description: 'Click-through rate percentage.',
    unit: 'percent',
  },
  {
    id: 'e12f4581-7489-4a92-95b1-128d9c129e05',
    key: 'leads',
    name: 'Leads',
    description: 'Generated leads or signups.',
    unit: 'count',
  },
]

/**
 * Provision built-in metrics idempotently.
 */
export async function ensureBuiltinMetrics(db: SqlDatabase): Promise<void> {
  const now = '2026-08-19T00:00:00.000Z'
  for (const m of BUILTIN_METRICS) {
    await execute(
      db,
      `INSERT OR IGNORE INTO metric_definition (id, workspace_id, key, name, description, unit, created_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?)`,
      [m.id, m.key, m.name, m.description, m.unit, now],
    )
  }
}

/**
 * List all metric definitions available in a workspace:
 * includes global built-ins (workspace_id IS NULL) and workspace-owned metrics.
 */
export async function listMetricDefinitions(
  db: SqlDatabase,
  workspaceId: string,
): Promise<MetricDefinition[]> {
  await ensureBuiltinMetrics(db)
  const rows = await queryAll<MetricDefinitionRow>(
    db,
    `SELECT id, workspace_id, key, name, description, unit, created_at
     FROM metric_definition
     WHERE workspace_id IS NULL OR workspace_id = ?
     ORDER BY key ASC`,
    [workspaceId],
  )
  return rows.map(toMetricDefinition)
}

/**
 * Find a specific metric definition by key in the context of a workspace.
 */
export async function findMetricDefinitionByKey(
  db: SqlDatabase,
  workspaceId: string,
  key: string,
): Promise<MetricDefinition | null> {
  await ensureBuiltinMetrics(db)
  const row = await queryFirst<MetricDefinitionRow>(
    db,
    `SELECT id, workspace_id, key, name, description, unit, created_at
     FROM metric_definition
     WHERE key = ? AND (workspace_id IS NULL OR workspace_id = ?)`,
    [key, workspaceId],
  )
  return row ? toMetricDefinition(row) : null
}

/**
 * Validate that a metric key is present in the canonical metric_definition registry
 * for the given workspace (either as a built-in or a workspace-owned metric).
 * Throws IntegrityError if invalid or belonging to a foreign workspace.
 */
export async function validateMetricKey(
  db: SqlDatabase,
  workspaceId: string,
  key: string,
): Promise<MetricDefinition> {
  const def = await findMetricDefinitionByKey(db, workspaceId, key)
  if (!def) {
    throw new IntegrityError(
      `Invalid metric key '${key}': not found in canonical metric registry for workspace '${workspaceId}'.`,
    )
  }
  return def
}

export const createMetricDefinitionInput = z.object({
  workspaceId: z.string().uuid(),
  key: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9_]+$/, 'Metric key must be lowercase alphanumeric with underscores.'),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).nullish(),
  unit: z.string().trim().max(50).nullish(),
})

export type CreateMetricDefinitionInput = z.input<typeof createMetricDefinitionInput>

/**
 * Create a custom workspace-owned metric definition.
 */
export async function createMetricDefinition(
  db: SqlDatabase,
  rawInput: CreateMetricDefinitionInput,
): Promise<MetricDefinition> {
  const data = createMetricDefinitionInput.parse(rawInput)
  await ensureBuiltinMetrics(db)

  // Check uniqueness against built-ins and workspace metrics
  const existing = await findMetricDefinitionByKey(db, data.workspaceId, data.key)
  if (existing) {
    throw new IntegrityError(
      `Metric key '${data.key}' is already defined in ${existing.workspaceId ? 'this workspace' : 'built-in metrics'}.`,
    )
  }

  const id = newId()
  const now = nowIso()

  await execute(
    db,
    `INSERT INTO metric_definition (id, workspace_id, key, name, description, unit, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, data.workspaceId, data.key, data.name, data.description ?? null, data.unit ?? null, now],
  )

  const created = await findMetricDefinitionByKey(db, data.workspaceId, data.key)
  if (!created) {
    throw new Error('Failed to retrieve created metric definition.')
  }
  return created
}
