-- 0020: Content Approval & Publication Readiness (STEP 15D)
-- content_approval: Immutable human editorial approval history for content variants.
-- Adds selected_variant_id to content table to track the active publication candidate.

CREATE TABLE content_approval (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace (id) ON DELETE RESTRICT,
  campaign_id TEXT NOT NULL REFERENCES campaign (id) ON DELETE RESTRICT,
  content_id TEXT NOT NULL REFERENCES content (id) ON DELETE RESTRICT,
  content_variant_id TEXT NOT NULL REFERENCES content_variant (id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'revoked')),
  actor_type TEXT NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user', 'system')),
  actor_id TEXT,
  critic_override INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_content_approval_variant ON content_approval (content_variant_id, created_at DESC);
CREATE INDEX idx_content_approval_content ON content_approval (content_id, created_at DESC);
CREATE INDEX idx_content_approval_workspace ON content_approval (workspace_id, created_at DESC);

ALTER TABLE content ADD COLUMN selected_variant_id TEXT REFERENCES content_variant (id) ON DELETE SET NULL;
CREATE INDEX idx_content_selected_variant ON content (selected_variant_id);
