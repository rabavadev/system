import { z } from 'zod'

import { execute, getDb, newId, nowIso, queryAll, queryFirst } from '~/server/db/client'
import type { Campaign } from '~/types/domain'

interface CampaignRow {
  id: string
  workspace_id: string
  brand_id: string | null
  product_id: string | null
  goal_id: string | null
  name: string
  audience: string | null
  angle: string | null
  status: Campaign['status']
  starts_at: string | null
  ends_at: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

function toCampaign(row: CampaignRow): Campaign {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    brandId: row.brand_id,
    productId: row.product_id,
    goalId: row.goal_id,
    name: row.name,
    audience: row.audience,
    angle: row.angle,
    status: row.status,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }
}

export const createCampaignInput = z
  .object({
    workspaceId: z.uuid(),
    brandId: z.uuid().optional(),
    productId: z.uuid().optional(),
    goalId: z.uuid().optional(),
    name: z.string().trim().min(1).max(200),
    audience: z.string().trim().max(2000).optional(),
    angle: z.string().trim().max(2000).optional(),
    startsAt: z.iso.datetime({ offset: false }).optional(),
    endsAt: z.iso.datetime({ offset: false }).optional(),
  })
  .refine((data) => !data.startsAt || !data.endsAt || data.endsAt > data.startsAt, {
    message: 'endsAt must be after startsAt',
  })
export type CreateCampaignInput = z.input<typeof createCampaignInput>

export async function createCampaign(input: CreateCampaignInput): Promise<Campaign> {
  const data = createCampaignInput.parse(input)
  const id = newId()
  const now = nowIso()
  await execute(
    getDb(),
    `INSERT INTO campaign (
       id, workspace_id, brand_id, product_id, goal_id, name, audience, angle,
       status, starts_at, ends_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
    [
      id,
      data.workspaceId,
      data.brandId ?? null,
      data.productId ?? null,
      data.goalId ?? null,
      data.name,
      data.audience ?? null,
      data.angle ?? null,
      data.startsAt ?? null,
      data.endsAt ?? null,
      now,
      now,
    ],
  )

  const created = await getCampaignById(id)
  if (!created) {
    throw new Error('campaign insert did not produce a readable row')
  }
  return created
}

export async function getCampaignById(id: string): Promise<Campaign | null> {
  const row = await queryFirst<CampaignRow>(getDb(), `SELECT * FROM campaign WHERE id = ?`, [id])
  return row ? toCampaign(row) : null
}

export async function listCampaigns(workspaceId: string): Promise<Campaign[]> {
  const rows = await queryAll<CampaignRow>(
    getDb(),
    `SELECT * FROM campaign WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`,
    [workspaceId],
  )
  return rows.map(toCampaign)
}
