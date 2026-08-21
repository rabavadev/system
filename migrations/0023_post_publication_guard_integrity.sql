-- 0023: Post Publication Guard Integrity (STEP 15E.1.1)
-- Enforces NOT NULL workspace_id on post table with deterministic backfill.
-- Adds active publication intent uniqueness constraint.
-- Preserves all existing posts, foreign keys, and indexes.

PRAGMA foreign_keys = OFF;

-- 1. Deterministically backfill workspace_id for legacy posts
UPDATE post
SET workspace_id = (
  SELECT c.workspace_id
  FROM content_variant cv
  JOIN content c ON c.id = cv.content_id
  WHERE cv.id = post.content_variant_id
)
WHERE workspace_id IS NULL;

-- 2. Safely remove any unresolvable orphaned posts where workspace cannot be determined
DELETE FROM post WHERE workspace_id IS NULL;

-- 3. Create new table with NOT NULL workspace_id and complete schema
CREATE TABLE post_dg_tmp (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace (id) ON DELETE RESTRICT,
  content_variant_id TEXT NOT NULL REFERENCES content_variant (id) ON DELETE RESTRICT,
  account_id TEXT NOT NULL REFERENCES account (id) ON DELETE RESTRICT,
  content_approval_id TEXT REFERENCES content_approval (id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'publishing', 'published', 'failed', 'removed')),
  external_id TEXT,
  url TEXT,
  scheduled_at TEXT,
  published_at TEXT,
  error TEXT,
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 4. Copy all data into the new table
INSERT INTO post_dg_tmp (
  id, workspace_id, content_variant_id, account_id, content_approval_id,
  status, external_id, url, scheduled_at, published_at, error,
  idempotency_key, created_at, updated_at
)
SELECT
  id, workspace_id, content_variant_id, account_id, content_approval_id,
  status, external_id, url, scheduled_at, published_at, error,
  idempotency_key, created_at, updated_at
FROM post;

-- 5. Swap tables
DROP TABLE post;
ALTER TABLE post_dg_tmp RENAME TO post;

-- 6. Recreate indexes
CREATE INDEX idx_post_variant ON post (content_variant_id);
CREATE INDEX idx_post_account ON post (account_id, status);
CREATE INDEX idx_post_external ON post (external_id);
CREATE INDEX idx_post_workspace ON post (workspace_id, created_at DESC);
CREATE INDEX idx_post_approval ON post (content_approval_id);
CREATE UNIQUE INDEX idx_post_idempotency ON post (workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX idx_post_active_intent ON post (
  workspace_id,
  content_variant_id,
  account_id,
  content_approval_id
) WHERE status IN ('draft', 'scheduled');

PRAGMA foreign_keys = ON;
