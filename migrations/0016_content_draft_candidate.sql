-- 0016: Content Draft Candidates (HARDENING H3A.1)
-- content_draft_candidate: Server-authoritative records for Creator-generated drafts.
-- Ensures that draft provenance (agent, version, execution, model, timestamps, hashes)
-- is established server-side and cannot be forged by the client.

CREATE TABLE content_draft_candidate (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace (id) ON DELETE RESTRICT,
  campaign_id TEXT NOT NULL REFERENCES campaign (id) ON DELETE RESTRICT,
  content_id TEXT NOT NULL REFERENCES content (id) ON DELETE RESTRICT,
  account_id TEXT NOT NULL REFERENCES account (id) ON DELETE RESTRICT,
  platform_id TEXT NOT NULL REFERENCES platform (id) ON DELETE RESTRICT,
  creator_agent_id TEXT NOT NULL REFERENCES agent (id) ON DELETE RESTRICT,
  creator_agent_version_id TEXT NOT NULL REFERENCES agent_version (id) ON DELETE RESTRICT,
  ai_execution_id TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  generated_json TEXT NOT NULL,
  generated_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  saved_at TEXT,
  saved_variant_id TEXT REFERENCES content_variant (id) ON DELETE SET NULL
);

CREATE INDEX idx_content_draft_candidate_content ON content_draft_candidate (content_id, created_at DESC);
CREATE INDEX idx_content_draft_candidate_workspace ON content_draft_candidate (workspace_id, created_at DESC);
