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
