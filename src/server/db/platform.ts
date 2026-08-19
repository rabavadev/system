import { getDb, queryAll } from '~/server/db/client'
import type { Platform } from '~/types/domain'

interface PlatformRow {
  id: string
  adapter_key: string
  name: string
  created_at: string
}

function toPlatform(row: PlatformRow): Platform {
  return {
    id: row.id,
    adapterKey: row.adapter_key,
    name: row.name,
    createdAt: row.created_at,
  }
}

/**
 * The platform registry is seeded reference data. Accounts pick a platform
 * from this list; no platform API is involved.
 */
export async function listPlatforms(): Promise<Platform[]> {
  const rows = await queryAll<PlatformRow>(getDb(), `SELECT * FROM platform ORDER BY name ASC`)
  return rows.map(toPlatform)
}
