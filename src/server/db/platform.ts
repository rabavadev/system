import {
  type ConnectionStatus,
  type Platform,
  type PlatformConnection,
  type SafePlatformConnection,
  toSafePlatformConnection,
} from '../../types/domain.ts'
import { isValidSecretRef } from '../platforms/runtime.ts'
import { execute, newId, nowIso, queryAll, queryFirst, type SqlDatabase } from './sql.ts'

export interface PlatformRow {
  id: string
  adapter_key: string
  name: string
  created_at: string
}

export interface PlatformConnectionRow {
  id: string
  account_id: string
  status: ConnectionStatus
  secret_ref: string | null
  scopes: string | null
  metadata: string | null
  connected_at: string | null
  last_synced_at: string | null
  created_at: string
  updated_at: string
}

export function toPlatform(row: PlatformRow): Platform {
  return {
    id: row.id,
    adapterKey: row.adapter_key,
    name: row.name,
    createdAt: row.created_at,
  }
}

export function toPlatformConnection(row: PlatformConnectionRow): PlatformConnection {
  return {
    id: row.id,
    accountId: row.account_id,
    status: row.status,
    secretRef: row.secret_ref,
    scopes: row.scopes,
    metadataJson: row.metadata,
    connectedAt: row.connected_at,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * The platform registry is seeded reference data. Accounts pick a platform
 * from this list; no platform API is involved.
 */
export async function listPlatforms(db?: SqlDatabase): Promise<Platform[]> {
  let database = db
  if (!database) {
    const { getDb } = await import('./client.ts')
    database = getDb()
  }
  const rows = await queryAll<PlatformRow>(database, `SELECT * FROM platform ORDER BY name ASC`)
  return rows.map(toPlatform)
}

export async function getPlatformById(
  db: SqlDatabase,
  platformId: string,
): Promise<Platform | null> {
  const row = await queryFirst<PlatformRow>(db, `SELECT * FROM platform WHERE id = ?`, [platformId])
  return row ? toPlatform(row) : null
}

export async function getPlatformByAdapterKey(
  db: SqlDatabase,
  adapterKey: string,
): Promise<Platform | null> {
  const row = await queryFirst<PlatformRow>(db, `SELECT * FROM platform WHERE adapter_key = ?`, [
    adapterKey,
  ])
  return row ? toPlatform(row) : null
}

export async function getPlatformConnectionForAccount(
  db: SqlDatabase,
  accountId: string,
): Promise<PlatformConnection | null> {
  const row = await queryFirst<PlatformConnectionRow>(
    db,
    `SELECT * FROM platform_connection WHERE account_id = ?`,
    [accountId],
  )
  return row ? toPlatformConnection(row) : null
}

export async function getSafePlatformConnectionForAccount(
  db: SqlDatabase,
  accountId: string,
): Promise<SafePlatformConnection | null> {
  const conn = await getPlatformConnectionForAccount(db, accountId)
  return conn ? toSafePlatformConnection(conn) : null
}

export interface UpsertPlatformConnectionInput {
  accountId: string
  status?: ConnectionStatus
  secretRef?: string | null
  scopes?: string | null
  metadata?: string | null
}

export async function upsertPlatformConnection(
  db: SqlDatabase,
  input: UpsertPlatformConnectionInput,
): Promise<PlatformConnection> {
  // Validate secret_ref format if supplied
  if (input.secretRef !== undefined && input.secretRef !== null) {
    const trimmedRef = input.secretRef.trim()
    if (!isValidSecretRef(trimmedRef)) {
      throw new Error(`Invalid secret_ref identifier: '${input.secretRef}'`)
    }
  }

  // Validate metadata does not contain raw secret tokens / authorization headers
  if (input.metadata !== undefined && input.metadata !== null) {
    const lower = input.metadata.toLowerCase()
    if (
      lower.includes('"authorization"') ||
      lower.includes('bearer ') ||
      lower.includes('"accesstoken"') ||
      lower.includes('"refreshtoken"') ||
      lower.includes('"clientsecret"')
    ) {
      throw new Error('Platform connection metadata must not contain secret tokens or credentials.')
    }
  }

  const existing = await queryFirst<PlatformConnectionRow>(
    db,
    `SELECT * FROM platform_connection WHERE account_id = ?`,
    [input.accountId],
  )
  const now = nowIso()
  if (existing) {
    await execute(
      db,
      `UPDATE platform_connection
       SET status = COALESCE(?, status),
           secret_ref = CASE WHEN ? = 1 THEN ? ELSE secret_ref END,
           scopes = CASE WHEN ? = 1 THEN ? ELSE scopes END,
           metadata = CASE WHEN ? = 1 THEN ? ELSE metadata END,
           updated_at = ?
       WHERE account_id = ?`,
      [
        input.status ?? null,
        input.secretRef !== undefined ? 1 : 0,
        input.secretRef !== undefined ? input.secretRef : null,
        input.scopes !== undefined ? 1 : 0,
        input.scopes !== undefined ? input.scopes : null,
        input.metadata !== undefined ? 1 : 0,
        input.metadata !== undefined ? input.metadata : null,
        now,
        input.accountId,
      ],
    )
  } else {
    const id = newId()
    await execute(
      db,
      `INSERT INTO platform_connection (id, account_id, status, secret_ref, scopes, metadata, connected_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.accountId,
        input.status ?? 'connected',
        input.secretRef ?? null,
        input.scopes ?? null,
        input.metadata ?? null,
        now,
        now,
        now,
      ],
    )
  }
  const updated = await getPlatformConnectionForAccount(db, input.accountId)
  if (!updated) {
    throw new Error('Failed to load platform connection after upsert.')
  }
  return updated
}
