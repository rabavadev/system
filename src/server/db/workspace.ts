import { z } from 'zod'

import { execute, getDb, newId, nowIso, queryFirst } from '~/server/db/client'
import type { Workspace } from '~/types/domain'

interface WorkspaceRow {
  id: string
  name: string
  slug: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }
}

export const createWorkspaceInput = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase letters, numbers and dashes')
    .max(60)
    .optional(),
})
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceInput>

/** The single default workspace, if seeded. */
export async function getDefaultWorkspace(): Promise<Workspace | null> {
  const row = await queryFirst<WorkspaceRow>(
    getDb(),
    `SELECT * FROM workspace WHERE deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`,
  )
  return row ? toWorkspace(row) : null
}

export async function createWorkspace(input: CreateWorkspaceInput): Promise<Workspace> {
  const data = createWorkspaceInput.parse(input)
  const id = newId()
  const now = nowIso()
  await execute(
    getDb(),
    `INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    [id, data.name, data.slug ?? null, now, now],
  )
  return {
    id,
    name: data.name,
    slug: data.slug ?? null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  }
}
