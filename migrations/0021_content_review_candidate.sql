-- 0021: Content Review Candidates (HARDENING P1)
-- content_review_candidate: Server-authoritative records for Critic-generated editorial reviews.
-- Ensures that review provenance (agent, version, execution, model, timestamps, hashes, verdict)
-- is established server-side and cannot be forged or altered by the client before persistence.

CREATE TABLE content_review_candidate (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace (id) ON DELETE RESTRICT,
  campaign_id TEXT NOT NULL REFERENCES campaign (id) ON DELETE RESTRICT,
  content_id TEXT NOT NULL REFERENCES content (id) ON DELETE RESTRICT,
  content_variant_id TEXT NOT NULL REFERENCES content_variant (id) ON DELETE RESTRICT,
  critic_agent_id TEXT NOT NULL REFERENCES agent (id) ON DELETE RESTRICT,
  critic_agent_version_id TEXT NOT NULL REFERENCES agent_version (id) ON DELETE RESTRICT,
  ai_execution_id TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'revise')),
  review_json TEXT NOT NULL,
  review_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  saved_at TEXT,
  saved_review_id TEXT REFERENCES content_review (id) ON DELETE SET NULL
);

CREATE INDEX idx_content_review_candidate_variant ON content_review_candidate (content_variant_id, created_at DESC);
CREATE INDEX idx_content_review_candidate_content ON content_review_candidate (content_id, created_at DESC);
CREATE INDEX idx_content_review_candidate_workspace ON content_review_candidate (workspace_id, created_at DESC);
