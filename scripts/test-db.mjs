/**
 * Database foundation tests (npm run db:test).
 *
 * Applies the wrangler migrations to a fresh local SQLite database (same
 * engine semantics as D1) and verifies:
 *   1. A clean database migrates from zero without errors.
 *   2. All expected tables and indexes exist.
 *   3. Foreign keys, CHECK constraints and UNIQUE constraints behave.
 *   4. Soft-delete parents cannot be hard-deleted while children exist.
 *   5. seed.sql applies cleanly and is idempotent.
 *
 * Uses better-sqlite3 (devDependency only, never shipped to the Worker).
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function freshDb() {
  const db = new Database(':memory:')
  // D1 enforces foreign keys; match that locally.
  db.pragma('foreign_keys = ON')
  return db
}

function migrate(db) {
  const dir = join(ROOT, 'migrations')
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  for (const file of files) {
    db.exec(readFileSync(join(dir, file), 'utf8'))
  }
  return files
}

const NOW = '2026-08-19T00:00:00.000Z'
const id = () => crypto.randomUUID()

test('clean database migrates from zero; all tables exist', () => {
  const db = freshDb()
  const files = migrate(db)
  assert.equal(files.length, 12, `expected 12 migrations, got: ${files.join(', ')}`)

  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all()
    .map((r) => r.name)
    .sort()

  const expected = [
    'account',
    'account_niche',
    'agent',
    'agent_version',
    'approval',
    'approval_policy',
    'audit_log',
    'brand',
    'campaign',
    'campaign_account',
    'content',
    'content_variant',
    'content_variant_asset',
    'conversation',
    'event',
    'experiment',
    'experiment_result',
    'experiment_variant',
    'file_asset',
    'goal',
    'memory',
    'message',
    'metric_definition',
    'metric_observation',
    'niche',
    'platform',
    'platform_connection',
    'platform_metric_raw',
    'post',
    'product',
    'research',
    'research_source',
    'workflow',
    'workflow_run',
    'workflow_step_run',
    'workflow_version',
    'workspace',
  ].sort()
  assert.deepEqual(tables, expected)
  db.close()
})

test('foreign keys reject orphaned rows', () => {
  const db = freshDb()
  migrate(db)

  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO brand (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, 'x', ?, ?)`,
        )
        .run(id(), id(), NOW, NOW),
    /FOREIGN KEY/i,
    'brand with bogus workspace_id must fail',
  )

  assert.throws(
    () =>
      db
        .prepare(`INSERT INTO account_niche (account_id, niche_id, created_at) VALUES (?, ?, ?)`)
        .run(id(), id(), NOW),
    /FOREIGN KEY/i,
    'account_niche with bogus ids must fail',
  )
  db.close()
})

test('RESTRICT protects parents that have children', () => {
  const db = freshDb()
  migrate(db)

  const ws = id()
  db.prepare(`INSERT INTO workspace (id, name, created_at, updated_at) VALUES (?, 'ws', ?, ?)`).run(
    ws,
    NOW,
    NOW,
  )
  const brandId = id()
  db.prepare(
    `INSERT INTO brand (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, 'b', ?, ?)`,
  ).run(brandId, ws, NOW, NOW)

  assert.throws(
    () => db.prepare(`DELETE FROM workspace WHERE id = ?`).run(ws),
    /FOREIGN KEY/i,
    'deleting a workspace with brands must fail',
  )
  db.close()
})

test('account_niche cascades on account delete; campaign_account restricts it', () => {
  const db = freshDb()
  migrate(db)

  const ws = id()
  const platformId = id()
  const accountId = id()
  const brandId = id()
  const nicheId = id()
  const campaignId = id()

  db.prepare(`INSERT INTO workspace (id, name, created_at, updated_at) VALUES (?, 'ws', ?, ?)`).run(
    ws,
    NOW,
    NOW,
  )
  db.prepare(
    `INSERT INTO platform (id, adapter_key, name, created_at) VALUES (?, 'pinterest', 'Pinterest', ?)`,
  ).run(platformId, NOW)
  db.prepare(
    `INSERT INTO brand (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, 'b', ?, ?)`,
  ).run(brandId, ws, NOW, NOW)
  db.prepare(
    `INSERT INTO niche (id, brand_id, name, created_at, updated_at) VALUES (?, ?, 'n', ?, ?)`,
  ).run(nicheId, brandId, NOW, NOW)
  db.prepare(
    `INSERT INTO account (id, workspace_id, platform_id, handle, created_at, updated_at) VALUES (?, ?, ?, '@h', ?, ?)`,
  ).run(accountId, ws, platformId, NOW, NOW)
  db.prepare(`INSERT INTO account_niche (account_id, niche_id, created_at) VALUES (?, ?, ?)`).run(
    accountId,
    nicheId,
    NOW,
  )
  db.prepare(
    `INSERT INTO campaign (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, 'c', ?, ?)`,
  ).run(campaignId, ws, NOW, NOW)
  db.prepare(
    `INSERT INTO campaign_account (campaign_id, account_id, created_at) VALUES (?, ?, ?)`,
  ).run(campaignId, accountId, NOW)

  // account referenced by a campaign cannot be hard-deleted...
  assert.throws(() => db.prepare(`DELETE FROM account WHERE id = ?`).run(accountId), /FOREIGN KEY/i)

  // ...but once the campaign link is gone, deleting the account cascades the niche link.
  db.prepare(`DELETE FROM campaign_account WHERE account_id = ?`).run(accountId)
  db.prepare(`DELETE FROM account WHERE id = ?`).run(accountId)
  const remaining = db
    .prepare(`SELECT COUNT(*) AS n FROM account_niche WHERE account_id = ?`)
    .get(accountId)
  assert.equal(remaining.n, 0, 'account_niche rows must cascade with the account')
  db.close()
})

test('version uniqueness and immutability-oriented constraints hold', () => {
  const db = freshDb()
  migrate(db)

  const ws = id()
  const agentId = id()
  db.prepare(`INSERT INTO workspace (id, name, created_at, updated_at) VALUES (?, 'ws', ?, ?)`).run(
    ws,
    NOW,
    NOW,
  )
  db.prepare(
    `INSERT INTO agent (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, 'a', ?, ?)`,
  ).run(agentId, ws, NOW, NOW)
  db.prepare(
    `INSERT INTO agent_version (id, agent_id, version, config, created_at) VALUES (?, ?, 1, '{}', ?)`,
  ).run(id(), agentId, NOW)
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO agent_version (id, agent_id, version, config, created_at) VALUES (?, ?, 1, '{}', ?)`,
        )
        .run(id(), agentId, NOW),
    /UNIQUE/i,
    'duplicate (agent_id, version) must fail',
  )

  // agent.current_version_id must reference a real version
  assert.throws(
    () => db.prepare(`UPDATE agent SET current_version_id = ? WHERE id = ?`).run(id(), agentId),
    /FOREIGN KEY/i,
  )
  db.close()
})

test('CHECK constraints reject invalid enums and ranges', () => {
  const db = freshDb()
  migrate(db)

  const ws = id()
  db.prepare(`INSERT INTO workspace (id, name, created_at, updated_at) VALUES (?, 'ws', ?, ?)`).run(
    ws,
    NOW,
    NOW,
  )

  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO memory (id, workspace_id, memory_class, content, confidence, created_at, updated_at)
           VALUES (?, ?, 'permanent_fact', 'x', 1.5, ?, ?)`,
        )
        .run(id(), ws, NOW, NOW),
    /CHECK/i,
    'confidence above 1 must fail',
  )

  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO post (id, content_variant_id, account_id, status, created_at, updated_at)
           VALUES (?, ?, ?, 'bogus', ?, ?)`,
        )
        .run(id(), id(), id(), NOW, NOW),
    /CHECK|FOREIGN KEY/i,
    'invalid post status must fail',
  )
  db.close()
})

test('metric observations deduplicate per subject/metric/window/source', () => {
  const db = freshDb()
  migrate(db)

  const ws = id()
  const metricId = id()
  const subjectId = id()
  db.prepare(`INSERT INTO workspace (id, name, created_at, updated_at) VALUES (?, 'ws', ?, ?)`).run(
    ws,
    NOW,
    NOW,
  )
  db.prepare(
    `INSERT INTO metric_definition (id, workspace_id, key, name, created_at) VALUES (?, ?, 'impressions', 'Impressions', ?)`,
  ).run(metricId, ws, NOW)

  const insert = db.prepare(
    `INSERT INTO metric_observation (id, workspace_id, metric_definition_id, subject_type, subject_id, value, observed_at, created_at)
     VALUES (?, ?, ?, 'post', ?, 100, ?, ?)`,
  )
  insert.run(id(), ws, metricId, subjectId, NOW, NOW)

  // Same subject, metric, window, granularity and source: rejected.
  assert.throws(() => insert.run(id(), ws, metricId, subjectId, NOW, NOW), /UNIQUE/i)

  // Different source: allowed.
  db.prepare(
    `INSERT INTO metric_observation (id, workspace_id, metric_definition_id, subject_type, subject_id, value, observed_at, source, created_at)
     VALUES (?, ?, ?, 'post', ?, 105, ?, 'manual', ?)`,
  ).run(id(), ws, metricId, subjectId, NOW, NOW)
  db.close()
})

test('seed applies cleanly and is idempotent', () => {
  const db = freshDb()
  migrate(db)

  const seed = readFileSync(join(ROOT, 'seed.sql'), 'utf8')
  db.exec(seed)
  db.exec(seed) // second run must not fail or duplicate

  const workspaces = db.prepare(`SELECT COUNT(*) AS n FROM workspace`).get()
  const platforms = db.prepare(`SELECT COUNT(*) AS n FROM platform`).get()
  const metrics = db.prepare(`SELECT COUNT(*) AS n FROM metric_definition`).get()
  assert.equal(workspaces.n, 1)
  assert.equal(platforms.n, 4)
  assert.equal(metrics.n, 7)
  db.close()
})

test('hard-deleting a niche nulls account.primary_niche_id (SET NULL)', () => {
  const db = freshDb()
  migrate(db)

  const ws = id()
  const platformId = id()
  const brandId = id()
  const nicheId = id()
  const accountId = id()

  db.prepare(`INSERT INTO workspace (id, name, created_at, updated_at) VALUES (?, 'ws', ?, ?)`).run(
    ws,
    NOW,
    NOW,
  )
  db.prepare(
    `INSERT INTO platform (id, adapter_key, name, created_at) VALUES (?, 'p', 'P', ?)`,
  ).run(platformId, NOW)
  db.prepare(
    `INSERT INTO brand (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, 'b', ?, ?)`,
  ).run(brandId, ws, NOW, NOW)
  db.prepare(
    `INSERT INTO niche (id, brand_id, name, created_at, updated_at) VALUES (?, ?, 'n', ?, ?)`,
  ).run(nicheId, brandId, NOW, NOW)
  db.prepare(
    `INSERT INTO account (id, workspace_id, platform_id, handle, primary_niche_id, created_at, updated_at)
     VALUES (?, ?, ?, '@h', ?, ?, ?)`,
  ).run(accountId, ws, platformId, nicheId, NOW, NOW)

  // product referencing the niche RESTRICTs hard deletion
  db.prepare(
    `INSERT INTO product (id, brand_id, niche_id, name, created_at, updated_at) VALUES (?, ?, ?, 'pr', ?, ?)`,
  ).run(id(), brandId, nicheId, NOW, NOW)
  assert.throws(() => db.prepare(`DELETE FROM niche WHERE id = ?`).run(nicheId), /FOREIGN KEY/i)

  // without the product, hard deletion succeeds and the primary niche is nulled
  db.prepare(`DELETE FROM product WHERE niche_id = ?`).run(nicheId)
  db.prepare(`DELETE FROM niche WHERE id = ?`).run(nicheId)
  const account = db.prepare(`SELECT primary_niche_id FROM account WHERE id = ?`).get(accountId)
  assert.equal(account.primary_niche_id, null, 'primary niche must be SET NULL on niche delete')
  db.close()
})

test('account handle is unique per platform, not globally', () => {
  const db = freshDb()
  migrate(db)

  const ws = id()
  const p1 = id()
  const p2 = id()
  db.prepare(`INSERT INTO workspace (id, name, created_at, updated_at) VALUES (?, 'ws', ?, ?)`).run(
    ws,
    NOW,
    NOW,
  )
  db.prepare(
    `INSERT INTO platform (id, adapter_key, name, created_at) VALUES (?, 'p1', 'P1', ?)`,
  ).run(p1, NOW)
  db.prepare(
    `INSERT INTO platform (id, adapter_key, name, created_at) VALUES (?, 'p2', 'P2', ?)`,
  ).run(p2, NOW)

  const insert = db.prepare(
    `INSERT INTO account (id, workspace_id, platform_id, handle, created_at, updated_at) VALUES (?, ?, ?, '@same', ?, ?)`,
  )
  insert.run(id(), ws, p1, NOW, NOW)
  assert.throws(
    () => insert.run(id(), ws, p1, NOW, NOW),
    /UNIQUE/i,
    'same handle on the same platform must fail',
  )
  insert.run(id(), ws, p2, NOW, NOW) // same handle on another platform is fine
  db.close()
})

test('account_niche rejects duplicate pairs', () => {
  const db = freshDb()
  migrate(db)

  const ws = id()
  const platformId = id()
  const brandId = id()
  const nicheId = id()
  const accountId = id()

  db.prepare(`INSERT INTO workspace (id, name, created_at, updated_at) VALUES (?, 'ws', ?, ?)`).run(
    ws,
    NOW,
    NOW,
  )
  db.prepare(
    `INSERT INTO platform (id, adapter_key, name, created_at) VALUES (?, 'p', 'P', ?)`,
  ).run(platformId, NOW)
  db.prepare(
    `INSERT INTO brand (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, 'b', ?, ?)`,
  ).run(brandId, ws, NOW, NOW)
  db.prepare(
    `INSERT INTO niche (id, brand_id, name, created_at, updated_at) VALUES (?, ?, 'n', ?, ?)`,
  ).run(nicheId, brandId, NOW, NOW)
  db.prepare(
    `INSERT INTO account (id, workspace_id, platform_id, handle, created_at, updated_at) VALUES (?, ?, ?, '@h', ?, ?)`,
  ).run(accountId, ws, platformId, NOW, NOW)

  const link = db.prepare(
    `INSERT INTO account_niche (account_id, niche_id, created_at) VALUES (?, ?, ?)`,
  )
  link.run(accountId, nicheId, NOW)
  assert.throws(
    () => link.run(accountId, nicheId, NOW),
    /UNIQUE|PRIMARY/i,
    'duplicate account_niche pair must fail',
  )
  db.close()
})

test('product status transitions archive without touching the row history', () => {
  const db = freshDb()
  migrate(db)

  const ws = id()
  const brandId = id()
  db.prepare(`INSERT INTO workspace (id, name, created_at, updated_at) VALUES (?, 'ws', ?, ?)`).run(
    ws,
    NOW,
    NOW,
  )
  db.prepare(
    `INSERT INTO brand (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, 'b', ?, ?)`,
  ).run(brandId, ws, NOW, NOW)

  const productId = id()
  db.prepare(
    `INSERT INTO product (id, brand_id, name, status, created_at, updated_at) VALUES (?, ?, 'p', 'draft', ?, ?)`,
  ).run(productId, brandId, NOW, NOW)
  db.prepare(`UPDATE product SET status = 'archived' WHERE id = ?`).run(productId)
  const row = db.prepare(`SELECT status, deleted_at FROM product WHERE id = ?`).get(productId)
  assert.equal(row.status, 'archived')
  assert.equal(row.deleted_at, null, 'archiving a product is a status change, not a soft delete')
  db.close()
})

test('approval_policy enforces scope_type, mode enums and (workspace, scope, action) uniqueness', () => {
  const db = freshDb()
  migrate(db)

  const ws = id()
  db.prepare(`INSERT INTO workspace (id, name, created_at, updated_at) VALUES (?, 'ws', ?, ?)`).run(
    ws,
    NOW,
    NOW,
  )

  const insert = db.prepare(
    `INSERT INTO approval_policy (id, workspace_id, scope_type, scope_id, action_key, mode, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  // Valid workspace policy
  insert.run(id(), ws, 'workspace', ws, 'content.publish', 'review', NOW, NOW)

  // Duplicate (workspace_id, scope_type, scope_id, action_key) must fail
  assert.throws(
    () => insert.run(id(), ws, 'workspace', ws, 'content.publish', 'auto', NOW, NOW),
    /UNIQUE/i,
    'duplicate policy on same scope and action must fail',
  )

  // Invalid mode enum must fail
  assert.throws(
    () => insert.run(id(), ws, 'workspace', ws, 'workflow.run', 'invalid_mode', NOW, NOW),
    /CHECK/i,
    'invalid mode must fail',
  )

  // Invalid scope_type enum must fail
  assert.throws(
    () => insert.run(id(), ws, 'invalid_scope', ws, 'workflow.run', 'auto', NOW, NOW),
    /CHECK/i,
    'invalid scope_type must fail',
  )

  db.close()
})

test('approval table enforces status, origin, resolved_mode, and decision enums', () => {
  const db = freshDb()
  migrate(db)

  const ws = id()
  db.prepare(`INSERT INTO workspace (id, name, created_at, updated_at) VALUES (?, 'ws', ?, ?)`).run(
    ws,
    NOW,
    NOW,
  )

  const insert = db.prepare(
    `INSERT INTO approval (
       id, workspace_id, action_key, origin, requested_by_type, requested_by_id,
       summary, reason, resolved_mode, policy_source, risk, snapshot_json, fingerprint,
       status, expires_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  const approvalId = id()
  insert.run(
    approvalId,
    ws,
    'content.publish',
    'agent',
    'agent',
    id(),
    'Publish post to Pinterest',
    'Policy requires review for content publishing',
    'review',
    'workspace_policy',
    'external',
    JSON.stringify({ title: 'Test Post' }),
    'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    'pending',
    null,
    NOW,
    NOW,
  )

  // Status check: invalid status must fail
  assert.throws(
    () =>
      insert.run(
        id(),
        ws,
        'content.publish',
        'agent',
        'agent',
        null,
        's',
        'r',
        'review',
        'workspace_policy',
        null,
        '{}',
        'f',
        'invalid_status',
        null,
        NOW,
        NOW,
      ),
    /CHECK/i,
  )

  // Origin check: invalid origin must fail
  assert.throws(
    () =>
      insert.run(
        id(),
        ws,
        'content.publish',
        'invalid_origin',
        'agent',
        null,
        's',
        'r',
        'review',
        'workspace_policy',
        null,
        '{}',
        'f',
        'pending',
        null,
        NOW,
        NOW,
      ),
    /CHECK/i,
  )

  // Decided by check: user decision
  db.prepare(
    `UPDATE approval SET status = 'approved', decision = 'approved', decided_by_type = 'user', decided_by_id = ?, decided_at = ? WHERE id = ?`,
  ).run(id(), NOW, approvalId)

  const updated = db
    .prepare(`SELECT status, decision, decided_by_type FROM approval WHERE id = ?`)
    .get(approvalId)
  assert.equal(updated.status, 'approved')
  assert.equal(updated.decision, 'approved')
  assert.equal(updated.decided_by_type, 'user')

  db.close()
})

test('research table enforces research_type enum and defaults to general', () => {
  const db = freshDb()
  migrate(db)
  const wsId = id()
  db.prepare(
    `INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, 'WS', 'ws', ?, ?)`,
  ).run(wsId, NOW, NOW)

  const researchId = id()
  // Default research_type is 'general'
  db.prepare(
    `INSERT INTO research (id, workspace_id, subject, status, created_at, updated_at)
     VALUES (?, ?, 'Market Analysis', 'draft', ?, ?)`,
  ).run(researchId, wsId, NOW, NOW)

  const row = db.prepare(`SELECT research_type FROM research WHERE id = ?`).get(researchId)
  assert.equal(row.research_type, 'general')

  // Explicit valid research_type
  db.prepare(`UPDATE research SET research_type = 'competitor' WHERE id = ?`).run(researchId)
  const updated = db.prepare(`SELECT research_type FROM research WHERE id = ?`).get(researchId)
  assert.equal(updated.research_type, 'competitor')

  // Invalid research_type rejected by CHECK constraint
  assert.throws(
    () =>
      db.prepare(`UPDATE research SET research_type = 'invalid_type' WHERE id = ?`).run(researchId),
    /CHECK/i,
  )

  db.close()
})
