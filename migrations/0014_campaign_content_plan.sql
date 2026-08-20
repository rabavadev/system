-- 0014: Campaign Content Plan (STEP 14C)
-- Recreates content table to support planning lifecycle ('idea', 'planned', 'draft', 'ready', 'in_review', 'approved', 'archived')
-- and adds content_type, purpose, theme, target_account_id, planned_at.

PRAGMA foreign_keys = OFF;

CREATE TABLE content_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace (id) ON DELETE RESTRICT,
  campaign_id TEXT REFERENCES campaign (id) ON DELETE RESTRICT,
  product_id TEXT REFERENCES product (id) ON DELETE RESTRICT,
  target_account_id TEXT REFERENCES account (id) ON DELETE SET NULL,
  title TEXT,
  content_type TEXT NOT NULL DEFAULT 'post' CHECK (content_type IN ('post', 'short_form', 'long_form', 'image', 'video', 'thread', 'email', 'other')),
  purpose TEXT CHECK (purpose IS NULL OR purpose IN ('awareness', 'traffic', 'conversion', 'engagement', 'education', 'retention', 'validation')),
  theme TEXT,
  brief TEXT,
  body TEXT,
  status TEXT NOT NULL DEFAULT 'idea' CHECK (status IN ('idea', 'planned', 'draft', 'ready', 'in_review', 'approved', 'archived')),
  planned_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

INSERT INTO content_new (id, workspace_id, campaign_id, product_id, title, brief, body, status, created_at, updated_at, deleted_at)
  SELECT id, workspace_id, campaign_id, product_id, title, brief, body, status, created_at, updated_at, deleted_at FROM content;

DROP TABLE content;
ALTER TABLE content_new RENAME TO content;

CREATE INDEX idx_content_campaign ON content (campaign_id);
CREATE INDEX idx_content_workspace ON content (workspace_id, status);
CREATE INDEX idx_content_account ON content (target_account_id);
CREATE INDEX idx_content_planned_at ON content (planned_at);

PRAGMA foreign_keys = ON;
