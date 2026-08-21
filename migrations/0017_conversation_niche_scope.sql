-- 0017: Conversation Niche Scope Support (H3B.1)
-- Widen conversation.scope_type CHECK constraint to include 'niche'.
-- Preserves all existing conversations, columns, and foreign key relationships.

PRAGMA foreign_keys = OFF;

CREATE TABLE conversation_dg_tmp (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace (id) ON DELETE RESTRICT,
  title TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  scope_type TEXT CHECK (scope_type IN ('brand', 'niche', 'product', 'account', 'campaign')),
  scope_id TEXT
);

INSERT INTO conversation_dg_tmp (id, workspace_id, title, created_at, updated_at, deleted_at, scope_type, scope_id)
  SELECT id, workspace_id, title, created_at, updated_at, deleted_at, scope_type, scope_id FROM conversation;

DROP TABLE conversation;

ALTER TABLE conversation_dg_tmp RENAME TO conversation;

CREATE INDEX idx_conversation_workspace ON conversation (workspace_id);
CREATE INDEX idx_conversation_scope ON conversation (scope_type, scope_id);

PRAGMA foreign_keys = ON;
