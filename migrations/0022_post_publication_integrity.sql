-- 0022: Post Publication Integrity (STEP 15E.1)
-- Links posts to workspace, explicit human editorial approval lineage, and supports idempotency.

ALTER TABLE post ADD COLUMN workspace_id TEXT REFERENCES workspace (id) ON DELETE RESTRICT;
ALTER TABLE post ADD COLUMN content_approval_id TEXT REFERENCES content_approval (id) ON DELETE RESTRICT;
ALTER TABLE post ADD COLUMN idempotency_key TEXT;

CREATE INDEX idx_post_workspace ON post (workspace_id, created_at DESC);
CREATE INDEX idx_post_approval ON post (content_approval_id);
CREATE UNIQUE INDEX idx_post_idempotency ON post (workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
