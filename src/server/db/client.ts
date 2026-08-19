import { env } from 'cloudflare:workers'

import { requireBinding } from '~/server/env'

/**
 * D1 access point. All database access in the app goes through this module
 * and the repositories that use it. Routes and components never touch D1.
 */

/** The D1 database binding for this request's worker environment. */
export function getDb(): D1Database {
  return requireBinding(env, 'DB')
}

/** Generate a primary key. One ID strategy everywhere: UUID text. */
export function newId(): string {
  return crypto.randomUUID()
}

/** Canonical timestamp: ISO-8601 UTC. Never store local display time. */
export function nowIso(): string {
  return new Date().toISOString()
}

export async function queryAll<Row>(db: D1Database, sql: string, params: unknown[] = []) {
  const result = await db
    .prepare(sql)
    .bind(...params)
    .all<Row>()
  return result.results
}

export async function queryFirst<Row>(
  db: D1Database,
  sql: string,
  params: unknown[] = [],
): Promise<Row | null> {
  return db
    .prepare(sql)
    .bind(...params)
    .first<Row>()
}

export async function execute(db: D1Database, sql: string, params: unknown[] = []) {
  return db
    .prepare(sql)
    .bind(...params)
    .run()
}
