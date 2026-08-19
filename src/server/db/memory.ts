import { z } from 'zod'

import { execute, getDb, newId, nowIso, queryAll } from '~/server/db/client'
import type { Memory } from '~/types/domain'

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

/**
 * Write validation for memories. Mirrors the CHECK constraints in migration
 * 0003 so bad writes fail before they reach D1, with useful messages.
 */
export const createMemoryInput = z.object({
  workspaceId: z.uuid(),
  memoryClass: z.enum([
    'permanent_fact',
    'verified_learning',
    'proposed_learning',
    'temporary_context',
  ]),
  content: z.string().trim().min(1),
  scopeType: z
    .enum(['workspace', 'brand', 'niche', 'account', 'platform', 'product', 'campaign'])
    .default('workspace'),
  scopeId: z.uuid().optional(),
  confidence: z.number().min(0).max(1).optional(),
  sourceType: z
    .enum(['user', 'agent', 'research', 'observation', 'import', 'manual'])
    .default('manual'),
  sourceId: z.string().max(200).optional(),
  evidenceJson: z.string().optional(),
  expiresAt: isoDateTime.optional(),
})
export type CreateMemoryInput = z.input<typeof createMemoryInput>

export async function createMemory(input: CreateMemoryInput): Promise<Memory> {
  const data = createMemoryInput.parse(input)
  const id = newId()
  const now = nowIso()
  await execute(
    getDb(),
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
      now,
      data.expiresAt ?? null,
    ],
  )

  const created = await getMemoryById(id)
  if (!created) {
    throw new Error('memory insert did not produce a readable row')
  }
  return created
}

export async function getMemoryById(id: string): Promise<Memory | null> {
  const rows = await queryAll<MemoryRow>(getDb(), `SELECT * FROM memory WHERE id = ?`, [id])
  const row = rows[0]
  return row ? toMemory(row) : null
}

export async function listActiveMemories(
  workspaceId: string,
  scope?: { scopeType: Memory['scopeType']; scopeId: string },
): Promise<Memory[]> {
  const rows = scope
    ? await queryAll<MemoryRow>(
        getDb(),
        `SELECT * FROM memory
         WHERE workspace_id = ? AND status = 'active' AND scope_type = ? AND scope_id = ?
         ORDER BY created_at DESC`,
        [workspaceId, scope.scopeType, scope.scopeId],
      )
    : await queryAll<MemoryRow>(
        getDb(),
        `SELECT * FROM memory WHERE workspace_id = ? AND status = 'active' ORDER BY created_at DESC`,
        [workspaceId],
      )
  return rows.map(toMemory)
}
