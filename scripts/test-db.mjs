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
  assert.equal(files.length, 26, `expected 26 migrations, got: ${files.join(', ')}`)

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
    'content_approval',
    'content_draft_candidate',
    'content_review',
    'content_review_candidate',
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
    'platform_credential',
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

test('conversation table enforces scope_type enum including niche', () => {
  const db = freshDb()
  migrate(db)
  const wsId = id()
  db.prepare(
    `INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, 'WS', 'ws', ?, ?)`,
  ).run(wsId, NOW, NOW)

  const convId = id()
  const nicheId = id()
  // Valid niche scope_type
  db.prepare(
    `INSERT INTO conversation (id, workspace_id, title, scope_type, scope_id, created_at, updated_at)
     VALUES (?, ?, 'Niche Chat', 'niche', ?, ?, ?)`,
  ).run(convId, wsId, nicheId, NOW, NOW)

  const row = db.prepare(`SELECT scope_type, scope_id FROM conversation WHERE id = ?`).get(convId)
  assert.equal(row.scope_type, 'niche')
  assert.equal(row.scope_id, nicheId)

  // Other valid scope types
  for (const st of ['brand', 'product', 'account', 'campaign']) {
    db.prepare(`UPDATE conversation SET scope_type = ? WHERE id = ?`).run(st, convId)
    const u = db.prepare(`SELECT scope_type FROM conversation WHERE id = ?`).get(convId)
    assert.equal(u.scope_type, st)
  }

  // Invalid scope_type rejected by CHECK constraint
  assert.throws(
    () =>
      db.prepare(`UPDATE conversation SET scope_type = 'invalid_scope' WHERE id = ?`).run(convId),
    /CHECK/i,
  )

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
          `INSERT INTO post (id, workspace_id, content_variant_id, account_id, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'bogus', ?, ?)`,
        )
        .run(id(), ws, id(), id(), NOW, NOW),
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
  assert.equal(metrics.n, 12)
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

test('workflow_run table enforces scope_type enum, pair invariant, and has scope index', () => {
  const db = freshDb()
  migrate(db)
  const wsId = id()
  db.prepare(
    `INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, 'WS', 'ws', ?, ?)`,
  ).run(wsId, NOW, NOW)

  const wfId = id()
  db.prepare(
    `INSERT INTO workflow (id, workspace_id, name, status, created_at, updated_at)
     VALUES (?, ?, 'WF', 'active', ?, ?)`,
  ).run(wfId, wsId, NOW, NOW)

  const wfVerId = id()
  db.prepare(
    `INSERT INTO workflow_version (id, workflow_id, version, definition, created_at)
     VALUES (?, ?, 1, '{}', ?)`,
  ).run(wfVerId, wfId, NOW)

  // 1. Both NULL is allowed
  const run1Id = id()
  db.prepare(
    `INSERT INTO workflow_run (id, workflow_id, workflow_version_id, status, created_at, updated_at, scope_type, scope_id)
     VALUES (?, ?, ?, 'running', ?, ?, NULL, NULL)`,
  ).run(run1Id, wfId, wfVerId, NOW, NOW)

  const row1 = db.prepare(`SELECT scope_type, scope_id FROM workflow_run WHERE id = ?`).get(run1Id)
  assert.equal(row1.scope_type, null)
  assert.equal(row1.scope_id, null)

  // 2. Both valid non-NULL is allowed for all valid scope types
  const validScopes = ['workspace', 'brand', 'niche', 'product', 'account', 'campaign']
  for (const sType of validScopes) {
    const rId = id()
    const targetId = id()
    db.prepare(
      `INSERT INTO workflow_run (id, workflow_id, workflow_version_id, status, created_at, updated_at, scope_type, scope_id)
       VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`,
    ).run(rId, wfId, wfVerId, NOW, NOW, sType, targetId)
    const rRow = db.prepare(`SELECT scope_type, scope_id FROM workflow_run WHERE id = ?`).get(rId)
    assert.equal(rRow.scope_type, sType)
    assert.equal(rRow.scope_id, targetId)
  }

  // 3. Invalid scope_type rejected by CHECK constraint
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO workflow_run (id, workflow_id, workflow_version_id, status, created_at, updated_at, scope_type, scope_id)
         VALUES (?, ?, ?, 'running', ?, ?, 'invalid_scope', ?)`,
        )
        .run(id(), wfId, wfVerId, NOW, NOW, id()),
    /CHECK/i,
  )

  // 4. Pair invariant: scope_type set but scope_id NULL rejected
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO workflow_run (id, workflow_id, workflow_version_id, status, created_at, updated_at, scope_type, scope_id)
         VALUES (?, ?, ?, 'running', ?, ?, 'campaign', NULL)`,
        )
        .run(id(), wfId, wfVerId, NOW, NOW),
    /CHECK/i,
  )

  // 5. Pair invariant: scope_id set but scope_type NULL rejected
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO workflow_run (id, workflow_id, workflow_version_id, status, created_at, updated_at, scope_type, scope_id)
         VALUES (?, ?, ?, 'running', ?, ?, NULL, ?)`,
        )
        .run(id(), wfId, wfVerId, NOW, NOW, id()),
    /CHECK/i,
  )

  // 6. Verify composite index exists
  const indexes = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'workflow_run'`)
    .all()
    .map((r) => r.name)
  assert.ok(
    indexes.includes('idx_workflow_run_scope'),
    `expected idx_workflow_run_scope index to exist, got: ${indexes.join(', ')}`,
  )

  db.close()
})

test('migration 0018 safely backfills unambiguous structured activeScope and leaves ambiguous runs NULL', () => {
  const db = freshDb()
  // Migrate up to 0017
  const dir = join(ROOT, 'migrations')
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  for (const file of files) {
    if (file === '0018_workflow_run_scope.sql') break
    db.exec(readFileSync(join(dir, file), 'utf8'))
  }

  const wsId = id()
  db.prepare(
    `INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, 'WS', 'ws', ?, ?)`,
  ).run(wsId, NOW, NOW)

  const brandId = id()
  db.prepare(
    `INSERT INTO brand (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, 'Brand', ?, ?)`,
  ).run(brandId, wsId, NOW, NOW)

  const campaignId = id()
  db.prepare(
    `INSERT INTO campaign (id, workspace_id, brand_id, name, created_at, updated_at) VALUES (?, ?, ?, 'Campaign', ?, ?)`,
  ).run(campaignId, wsId, brandId, NOW, NOW)

  const wfId = id()
  db.prepare(
    `INSERT INTO workflow (id, workspace_id, name, status, created_at, updated_at) VALUES (?, ?, 'WF', 'active', ?, ?)`,
  ).run(wfId, wsId, NOW, NOW)

  const wfVerId = id()
  db.prepare(
    `INSERT INTO workflow_version (id, workflow_id, version, definition, created_at) VALUES (?, ?, 1, '{}', ?)`,
  ).run(wfVerId, wfId, NOW)

  // 1. Unambiguous structured activeScope campaign run
  const structuredRunId = id()
  const structuredContext = JSON.stringify({
    activeScope: { type: 'campaign', id: campaignId },
    campaign: { id: campaignId, name: 'Campaign' },
  })
  db.prepare(
    `INSERT INTO workflow_run (id, workflow_id, workflow_version_id, status, context_json, created_at, updated_at)
     VALUES (?, ?, ?, 'succeeded', ?, ?, ?)`,
  ).run(structuredRunId, wfId, wfVerId, structuredContext, NOW, NOW)

  // 2. Ambiguous run: free text or non-activeScope JSON
  const ambiguousRunId = id()
  const ambiguousContext = JSON.stringify({
    notes: `This task mentions campaign ${campaignId} in free text`,
  })
  db.prepare(
    `INSERT INTO workflow_run (id, workflow_id, workflow_version_id, status, context_json, created_at, updated_at)
     VALUES (?, ?, ?, 'succeeded', ?, ?, ?)`,
  ).run(ambiguousRunId, wfId, wfVerId, ambiguousContext, NOW, NOW)

  // 3. Unscoped run: NULL context_json
  const unscopedRunId = id()
  db.prepare(
    `INSERT INTO workflow_run (id, workflow_id, workflow_version_id, status, context_json, created_at, updated_at)
     VALUES (?, ?, ?, 'succeeded', NULL, ?, ?)`,
  ).run(unscopedRunId, wfId, wfVerId, NOW, NOW)

  // Apply migration 0018
  db.exec(readFileSync(join(dir, '0018_workflow_run_scope.sql'), 'utf8'))

  // Verify backfilled results
  const row1 = db
    .prepare(`SELECT scope_type, scope_id FROM workflow_run WHERE id = ?`)
    .get(structuredRunId)
  assert.equal(row1.scope_type, 'campaign')
  assert.equal(row1.scope_id, campaignId)

  const row2 = db
    .prepare(`SELECT scope_type, scope_id FROM workflow_run WHERE id = ?`)
    .get(ambiguousRunId)
  assert.equal(row2.scope_type, null)
  assert.equal(row2.scope_id, null)

  const row3 = db
    .prepare(`SELECT scope_type, scope_id FROM workflow_run WHERE id = ?`)
    .get(unscopedRunId)
  assert.equal(row3.scope_type, null)
  assert.equal(row3.scope_id, null)

  db.close()
})

test('migration 0019 adds source_variant_id and source_review_id to content_draft_candidate', () => {
  const db = freshDb()
  migrate(db)

  const columns = db
    .prepare(`PRAGMA table_info(content_draft_candidate)`)
    .all()
    .map((c) => c.name)

  assert.ok(
    columns.includes('source_variant_id'),
    `expected source_variant_id column in content_draft_candidate, got: ${columns.join(', ')}`,
  )
  assert.ok(
    columns.includes('source_review_id'),
    `expected source_review_id column in content_draft_candidate, got: ${columns.join(', ')}`,
  )

  const indexes = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'content_draft_candidate'`,
    )
    .all()
    .map((r) => r.name)

  assert.ok(
    indexes.includes('idx_content_draft_candidate_source_variant'),
    `expected idx_content_draft_candidate_source_variant index, got: ${indexes.join(', ')}`,
  )
  assert.ok(
    indexes.includes('idx_content_draft_candidate_source_review'),
    `expected idx_content_draft_candidate_source_review index, got: ${indexes.join(', ')}`,
  )

  db.close()
})

test('migration 0020 creates content_approval table and adds selected_variant_id to content', () => {
  const db = freshDb()
  migrate(db)

  const approvalCols = db
    .prepare(`PRAGMA table_info(content_approval)`)
    .all()
    .map((c) => c.name)

  assert.ok(approvalCols.includes('id'), 'content_approval should have id')
  assert.ok(approvalCols.includes('workspace_id'), 'content_approval should have workspace_id')
  assert.ok(approvalCols.includes('campaign_id'), 'content_approval should have campaign_id')
  assert.ok(approvalCols.includes('content_id'), 'content_approval should have content_id')
  assert.ok(
    approvalCols.includes('content_variant_id'),
    'content_approval should have content_variant_id',
  )
  assert.ok(approvalCols.includes('status'), 'content_approval should have status')
  assert.ok(approvalCols.includes('actor_type'), 'content_approval should have actor_type')
  assert.ok(approvalCols.includes('actor_id'), 'content_approval should have actor_id')
  assert.ok(
    approvalCols.includes('critic_override'),
    'content_approval should have critic_override',
  )
  assert.ok(approvalCols.includes('note'), 'content_approval should have note')
  assert.ok(approvalCols.includes('created_at'), 'content_approval should have created_at')

  const contentCols = db
    .prepare(`PRAGMA table_info(content)`)
    .all()
    .map((c) => c.name)

  assert.ok(
    contentCols.includes('selected_variant_id'),
    `expected selected_variant_id in content table, got: ${contentCols.join(', ')}`,
  )

  const contentIndexes = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'content'`)
    .all()
    .map((r) => r.name)

  assert.ok(
    contentIndexes.includes('idx_content_selected_variant'),
    `expected idx_content_selected_variant index, got: ${contentIndexes.join(', ')}`,
  )

  const approvalIndexes = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'content_approval'`,
    )
    .all()
    .map((r) => r.name)

  assert.ok(
    approvalIndexes.includes('idx_content_approval_variant'),
    `expected idx_content_approval_variant index, got: ${approvalIndexes.join(', ')}`,
  )

  db.close()
})

test('migration 0021 creates content_review_candidate table and indexes', () => {
  const db = freshDb()
  migrate(db)

  const candidateCols = db
    .prepare(`PRAGMA table_info(content_review_candidate)`)
    .all()
    .map((c) => c.name)

  assert.ok(candidateCols.includes('id'), 'content_review_candidate should have id')
  assert.ok(
    candidateCols.includes('workspace_id'),
    'content_review_candidate should have workspace_id',
  )
  assert.ok(
    candidateCols.includes('campaign_id'),
    'content_review_candidate should have campaign_id',
  )
  assert.ok(candidateCols.includes('content_id'), 'content_review_candidate should have content_id')
  assert.ok(
    candidateCols.includes('content_variant_id'),
    'content_review_candidate should have content_variant_id',
  )
  assert.ok(
    candidateCols.includes('critic_agent_id'),
    'content_review_candidate should have critic_agent_id',
  )
  assert.ok(
    candidateCols.includes('critic_agent_version_id'),
    'content_review_candidate should have critic_agent_version_id',
  )
  assert.ok(
    candidateCols.includes('ai_execution_id'),
    'content_review_candidate should have ai_execution_id',
  )
  assert.ok(candidateCols.includes('provider'), 'content_review_candidate should have provider')
  assert.ok(candidateCols.includes('model'), 'content_review_candidate should have model')
  assert.ok(candidateCols.includes('verdict'), 'content_review_candidate should have verdict')
  assert.ok(
    candidateCols.includes('review_json'),
    'content_review_candidate should have review_json',
  )
  assert.ok(
    candidateCols.includes('review_hash'),
    'content_review_candidate should have review_hash',
  )
  assert.ok(candidateCols.includes('created_at'), 'content_review_candidate should have created_at')
  assert.ok(candidateCols.includes('saved_at'), 'content_review_candidate should have saved_at')
  assert.ok(
    candidateCols.includes('saved_review_id'),
    'content_review_candidate should have saved_review_id',
  )

  const candidateIndexes = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'content_review_candidate'`,
    )
    .all()
    .map((r) => r.name)

  assert.ok(
    candidateIndexes.includes('idx_content_review_candidate_variant'),
    `expected idx_content_review_candidate_variant index, got: ${candidateIndexes.join(', ')}`,
  )
  assert.ok(
    candidateIndexes.includes('idx_content_review_candidate_content'),
    `expected idx_content_review_candidate_content index, got: ${candidateIndexes.join(', ')}`,
  )
  assert.ok(
    candidateIndexes.includes('idx_content_review_candidate_workspace'),
    `expected idx_content_review_candidate_workspace index, got: ${candidateIndexes.join(', ')}`,
  )

  db.close()
})

test('migration 0022 adds workspace_id, content_approval_id, and idempotency_key to post table', () => {
  const db = freshDb()
  migrate(db)

  const postCols = db
    .prepare(`PRAGMA table_info(post)`)
    .all()
    .map((r) => r.name)

  assert.ok(postCols.includes('workspace_id'), 'post should have workspace_id')
  assert.ok(postCols.includes('content_approval_id'), 'post should have content_approval_id')
  assert.ok(postCols.includes('idempotency_key'), 'post should have idempotency_key')

  const postIndexes = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'post'`)
    .all()
    .map((r) => r.name)

  assert.ok(
    postIndexes.includes('idx_post_workspace'),
    `expected idx_post_workspace index, got: ${postIndexes.join(', ')}`,
  )
  assert.ok(
    postIndexes.includes('idx_post_approval'),
    `expected idx_post_approval index, got: ${postIndexes.join(', ')}`,
  )
  assert.ok(
    postIndexes.includes('idx_post_idempotency'),
    `expected idx_post_idempotency index, got: ${postIndexes.join(', ')}`,
  )

  db.close()
})

test('migration 0023 enforces NOT NULL workspace_id, active intent unique index, and backfills legacy posts', () => {
  const db = freshDb()
  const dir = join(ROOT, 'migrations')

  // Apply migrations 0001 through 0022
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  for (const file of files) {
    if (file.startsWith('0023_')) break
    db.exec(readFileSync(join(dir, file), 'utf8'))
  }

  // Create Workspace A and Workspace B
  const wsA = id()
  const wsB = id()
  db.prepare(
    `INSERT INTO workspace (id, name, created_at, updated_at) VALUES (?, 'WS A', ?, ?)`,
  ).run(wsA, NOW, NOW)
  db.prepare(
    `INSERT INTO workspace (id, name, created_at, updated_at) VALUES (?, 'WS B', ?, ?)`,
  ).run(wsB, NOW, NOW)

  const brandB = id()
  db.prepare(
    `INSERT INTO brand (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, 'Brand B', ?, ?)`,
  ).run(brandB, wsB, NOW, NOW)

  const platform = id()
  db.prepare(
    `INSERT INTO platform (id, adapter_key, name, created_at) VALUES (?, 'linkedin', 'LinkedIn', ?)`,
  ).run(platform, NOW)

  const accountB = id()
  db.prepare(
    `INSERT INTO account (id, workspace_id, platform_id, handle, status, created_at, updated_at) VALUES (?, ?, ?, 'b_handle', 'active', ?, ?)`,
  ).run(accountB, wsB, platform, NOW, NOW)

  const contentB = id()
  db.prepare(
    `INSERT INTO content (id, workspace_id, title, status, created_at, updated_at) VALUES (?, ?, 'Content B', 'ready', ?, ?)`,
  ).run(contentB, wsB, NOW, NOW)

  const variantB = id()
  db.prepare(
    `INSERT INTO content_variant (id, content_id, platform_id, body, status, created_at, updated_at) VALUES (?, ?, ?, 'Variant B body', 'approved', ?, ?)`,
  ).run(variantB, contentB, platform, NOW, NOW)

  // Insert a pre-0023 style post with workspace_id NULL
  const legacyPostId = id()
  db.prepare(`
    INSERT INTO post (id, workspace_id, content_variant_id, account_id, status, created_at, updated_at)
    VALUES (?, NULL, ?, ?, 'draft', ?, ?)
  `).run(legacyPostId, variantB, accountB, NOW, NOW)

  // Now apply migration 0023
  db.exec(readFileSync(join(dir, '0023_post_publication_guard_integrity.sql'), 'utf8'))

  // 1. Verify table info: workspace_id is NOT NULL
  const postTableInfo = db.prepare(`PRAGMA table_info(post)`).all()
  const wsCol = postTableInfo.find((r) => r.name === 'workspace_id')
  assert.ok(wsCol, 'workspace_id column must exist')
  assert.equal(wsCol.notnull, 1, 'workspace_id must be NOT NULL (notnull = 1)')

  // 2. Verify deterministic backfill: post.workspace_id became wsB
  const postRow = db.prepare(`SELECT * FROM post WHERE id = ?`).get(legacyPostId)
  assert.ok(postRow, 'legacy post must exist')
  assert.equal(
    postRow.workspace_id,
    wsB,
    'legacy post workspace_id must be deterministically backfilled to wsB',
  )

  // 3. Verify active intent unique index
  const indexes = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'post'`)
    .all()
    .map((r) => r.name)
  assert.ok(
    indexes.includes('idx_post_active_intent'),
    `expected idx_post_active_intent, got: ${indexes.join(', ')}`,
  )

  // 4. Verify foreign key check passes
  const fkCheck = db.prepare(`PRAGMA foreign_key_check`).all()
  assert.equal(fkCheck.length, 0, `foreign key check failed: ${JSON.stringify(fkCheck)}`)

  db.close()
})

test('migration 0024 creates platform_credential table and enforces active account uniqueness', () => {
  const db = freshDb()
  migrate(db)

  const ws = id()
  const platform = id()
  const account = id()

  db.prepare(`INSERT INTO workspace (id, name, created_at, updated_at) VALUES (?, 'ws', ?, ?)`).run(
    ws,
    NOW,
    NOW,
  )
  db.prepare(
    `INSERT INTO platform (id, adapter_key, name, created_at) VALUES (?, 'x', 'X', ?)`,
  ).run(platform, NOW)
  db.prepare(
    `INSERT INTO account (id, workspace_id, platform_id, handle, created_at, updated_at) VALUES (?, ?, ?, '@handle', ?, ?)`,
  ).run(account, ws, platform, NOW, NOW)

  const cred1 = id()
  const cred2 = id()

  // First active credential insert succeeds
  db.prepare(`
    INSERT INTO platform_credential (
      id, workspace_id, account_id, platform_id, credential_type,
      access_token_ciphertext, access_token_iv, key_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'oauth2', 'cipher1', 'iv1', 1, ?, ?)
  `).run(cred1, ws, account, platform, NOW, NOW)

  // Second active credential insert for same account fails due to unique active index
  assert.throws(
    () =>
      db
        .prepare(`
        INSERT INTO platform_credential (
          id, workspace_id, account_id, platform_id, credential_type,
          access_token_ciphertext, access_token_iv, key_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'oauth2', 'cipher2', 'iv2', 1, ?, ?)
      `)
        .run(cred2, ws, account, platform, NOW, NOW),
    /UNIQUE/i,
    'Second active credential for same account must violate unique active index',
  )

  // Once first is revoked, second insert succeeds
  db.prepare(`UPDATE platform_credential SET revoked_at = ? WHERE id = ?`).run(NOW, cred1)

  db.prepare(`
    INSERT INTO platform_credential (
      id, workspace_id, account_id, platform_id, credential_type,
      access_token_ciphertext, access_token_iv, key_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'oauth2', 'cipher2', 'iv2', 1, ?, ?)
  `).run(cred2, ws, account, platform, NOW, NOW)

  const count = db
    .prepare(`SELECT COUNT(*) AS n FROM platform_credential WHERE account_id = ?`)
    .get(account)
  assert.equal(count.n, 2)

  const activeCount = db
    .prepare(
      `SELECT COUNT(*) AS n FROM platform_credential WHERE account_id = ? AND revoked_at IS NULL`,
    )
    .get(account)
  assert.equal(activeCount.n, 1)

  db.close()
})

test('migration 0025 adds refresh_locked_until column to platform_credential', () => {
  const db = freshDb()
  migrate(db)

  const columns = db
    .prepare(`PRAGMA table_info(platform_credential)`)
    .all()
    .map((c) => c.name)

  assert.ok(
    columns.includes('refresh_locked_until'),
    'platform_credential table must contain refresh_locked_until column',
  )

  const ws = id()
  const account = id()
  const platform = id()
  const credId = id()

  db.prepare(`INSERT INTO workspace (id, name, created_at, updated_at) VALUES (?, 'WS', ?, ?)`).run(
    ws,
    NOW,
    NOW,
  )
  db.prepare(
    `INSERT INTO platform (id, name, adapter_key, created_at) VALUES (?, 'X', 'x', ?)`,
  ).run(platform, NOW)
  db.prepare(
    `INSERT INTO account (id, workspace_id, platform_id, handle, status, created_at, updated_at) VALUES (?, ?, ?, 'handle', 'active', ?, ?)`,
  ).run(account, ws, platform, NOW, NOW)

  const lockTime = '2026-08-19T00:00:30.000Z'
  db.prepare(`
    INSERT INTO platform_credential (
      id, workspace_id, account_id, platform_id, credential_type,
      access_token_ciphertext, access_token_iv, key_version,
      refresh_locked_until, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'oauth2', 'cipher', 'iv', 1, ?, ?, ?)
  `).run(credId, ws, account, platform, lockTime, NOW, NOW)

  const row = db
    .prepare(`SELECT refresh_locked_until FROM platform_credential WHERE id = ?`)
    .get(credId)
  assert.equal(row.refresh_locked_until, lockTime)

  db.close()
})

test('migration 0026 adds refresh_claim_id column to platform_credential', () => {
  const db = freshDb()
  migrate(db)

  const columns = db
    .prepare(`PRAGMA table_info(platform_credential)`)
    .all()
    .map((c) => c.name)

  assert.ok(
    columns.includes('refresh_claim_id'),
    'platform_credential table must contain refresh_claim_id column',
  )

  const ws = id()
  const account = id()
  const platform = id()
  const credId = id()

  db.prepare(`INSERT INTO workspace (id, name, created_at, updated_at) VALUES (?, 'WS', ?, ?)`).run(
    ws,
    NOW,
    NOW,
  )
  db.prepare(
    `INSERT INTO platform (id, name, adapter_key, created_at) VALUES (?, 'X', 'x', ?)`,
  ).run(platform, NOW)
  db.prepare(
    `INSERT INTO account (id, workspace_id, platform_id, handle, status, created_at, updated_at) VALUES (?, ?, ?, 'handle', 'active', ?, ?)`,
  ).run(account, ws, platform, NOW, NOW)

  const claimId = 'claim-uuid-test'
  db.prepare(`
    INSERT INTO platform_credential (
      id, workspace_id, account_id, platform_id, credential_type,
      access_token_ciphertext, access_token_iv, key_version,
      refresh_claim_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'oauth2', 'cipher', 'iv', 1, ?, ?, ?)
  `).run(credId, ws, account, platform, claimId, NOW, NOW)

  const row = db
    .prepare(`SELECT refresh_claim_id FROM platform_credential WHERE id = ?`)
    .get(credId)
  assert.equal(row.refresh_claim_id, claimId)

  db.close()
})
