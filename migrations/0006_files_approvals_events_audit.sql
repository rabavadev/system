-- 0006: Files, approvals, events, audit
-- file_asset, content_variant_asset, approval, event, audit_log

-- Metadata only; binaries live in R2 (or elsewhere) under storage_key.
CREATE TABLE file_asset (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace (id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'document', 'other')),
  name TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER,
  storage_backend TEXT NOT NULL DEFAULT 'none' CHECK (storage_backend IN ('none', 'r2', 'external')),
  storage_key TEXT,
  source TEXT NOT NULL DEFAULT 'upload' CHECK (source IN ('upload', 'generated', 'imported')),
  metadata TEXT, -- JSON: dimensions, duration, alt text, ...
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_file_asset_workspace ON file_asset (workspace_id, kind);

CREATE TABLE content_variant_asset (
  content_variant_id TEXT NOT NULL REFERENCES content_variant (id) ON DELETE CASCADE,
  file_asset_id TEXT NOT NULL REFERENCES file_asset (id) ON DELETE RESTRICT,
  role TEXT NOT NULL DEFAULT 'asset',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (content_variant_id, file_asset_id, role)
);
CREATE INDEX idx_content_variant_asset_file ON content_variant_asset (file_asset_id);

CREATE TABLE approval (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace (id) ON DELETE RESTRICT,
  action_type TEXT NOT NULL, -- 'publish_content', 'save_memory', 'create_workflow', 'modify_workflow', 'destructive_action', extensible
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL, -- scoped reference, integrity enforced application-side
  payload TEXT,             -- JSON: proposed change snapshot
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  decision_note TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_approval_workspace_status ON approval (workspace_id, status);
CREATE INDEX idx_approval_subject ON approval (subject_type, subject_id);

-- Generic domain event log. No event bus yet; this is the durable record
-- later engines (workflows, analytics rollups) will consume.
CREATE TABLE event (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspace (id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL, -- 'post.published', 'analytics.updated', 'workflow.failed', ...
  actor_type TEXT NOT NULL DEFAULT 'system' CHECK (actor_type IN ('user', 'agent', 'workflow', 'system')),
  actor_id TEXT,
  subject_type TEXT,
  subject_id TEXT,
  payload TEXT, -- JSON
  occurred_at TEXT NOT NULL
);
CREATE INDEX idx_event_type_time ON event (event_type, occurred_at);
CREATE INDEX idx_event_subject ON event (subject_type, subject_id);
CREATE INDEX idx_event_workspace ON event (workspace_id, occurred_at);

-- Mutation audit trail. Secrets must never be written into previous/new
-- values; see docs/database.md.
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspace (id) ON DELETE RESTRICT,
  actor_type TEXT NOT NULL DEFAULT 'system' CHECK (actor_type IN ('user', 'agent', 'workflow', 'system')),
  actor_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'restore')),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  previous_value TEXT, -- JSON
  new_value TEXT,      -- JSON
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_entity ON audit_log (entity_type, entity_id, created_at);
CREATE INDEX idx_audit_workspace ON audit_log (workspace_id, created_at);
