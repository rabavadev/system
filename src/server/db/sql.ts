/**
 * Pure SQL helpers: no `cloudflare:workers` import, so repositories built on
 * these can be unit-tested outside the Worker (better-sqlite3 satisfies
 * SqlDatabase structurally). `client.ts` re-exports these plus `getDb()`.
 *
 * The structural interface matches the D1 prepared-statement shape:
 * prepare(sql).bind(...params) → all()/first()/run().
 */

export interface SqlBoundStatement {
  all<Row>(): Promise<{ results: Row[] }>
  first<Row>(): Promise<Row | null>
  run(): Promise<unknown>
}

export interface SqlStatement {
  bind(...params: unknown[]): SqlBoundStatement
}

export interface SqlDatabase {
  prepare(sql: string): SqlStatement
  batch?(statements: SqlBoundStatement[]): Promise<unknown[]>
}

export interface BatchStatementSpec {
  sql: string
  params?: unknown[]
}

/** Generate a primary key. One ID strategy everywhere: UUID text. */
export function newId(): string {
  return crypto.randomUUID()
}

/** Canonical timestamp: ISO-8601 UTC. Never store local display time. */
export function nowIso(): string {
  return new Date().toISOString()
}

export async function queryAll<Row>(db: SqlDatabase, sql: string, params: unknown[] = []) {
  const result = await db
    .prepare(sql)
    .bind(...params)
    .all<Row>()
  return result.results
}

export async function queryFirst<Row>(
  db: SqlDatabase,
  sql: string,
  params: unknown[] = [],
): Promise<Row | null> {
  return db
    .prepare(sql)
    .bind(...params)
    .first<Row>()
}

export async function execute(db: SqlDatabase, sql: string, params: unknown[] = []) {
  return db
    .prepare(sql)
    .bind(...params)
    .run()
}

/**
 * Executes an array of parameterized statements atomically in a single transaction.
 *
 * In production Cloudflare D1: delegates to `db.batch(...)` which executes statements in a single atomic transaction.
 * In local SQLite tests / fallbacks: executes statements inside an immediate transaction (`BEGIN IMMEDIATE ... COMMIT / ROLLBACK`).
 */
export async function executeBatch(db: SqlDatabase, specs: BatchStatementSpec[]): Promise<void> {
  if (specs.length === 0) return

  if (typeof db.batch === 'function') {
    const boundStatements = specs.map((s) => db.prepare(s.sql).bind(...(s.params ?? [])))
    await db.batch(boundStatements)
    return
  }

  await execute(db, 'BEGIN IMMEDIATE')
  try {
    for (const spec of specs) {
      await execute(db, spec.sql, spec.params ?? [])
    }
    await execute(db, 'COMMIT')
  } catch (error) {
    try {
      await execute(db, 'ROLLBACK')
    } catch {
      // ignore rollback failure if transaction was already aborted
    }
    throw error
  }
}

/**
 * Executes a function within a transactional boundary (BEGIN IMMEDIATE ... COMMIT / ROLLBACK).
 * Rolls back and rethrows if any error occurs within the callback.
 */
export async function withTransaction<T>(db: SqlDatabase, fn: () => Promise<T>): Promise<T> {
  await execute(db, 'BEGIN IMMEDIATE')
  try {
    const result = await fn()
    await execute(db, 'COMMIT')
    return result
  } catch (error) {
    try {
      await execute(db, 'ROLLBACK')
    } catch {
      // ignore rollback failure if transaction was already aborted
    }
    throw error
  }
}
