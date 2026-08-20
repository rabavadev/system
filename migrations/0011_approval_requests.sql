-- 0011: Approval Requests (STEP 11B)
-- Concrete Approval Requests for platform-neutral actions.
-- Answers: "What exact action is waiting for approval?"
-- Includes immutable sanitized snapshots, SHA-256 fingerprints,
-- origin tracking, policy metadata, deduplication, and lifecycle decisions.

DROP TABLE IF EXISTS approval;

CREATE TABLE approval (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace (id) ON DELETE RESTRICT,
  action_key TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('user', 'chief', 'agent', 'workflow', 'tool', 'system')),
  requested_by_type TEXT NOT NULL CHECK (requested_by_type IN ('user', 'chief', 'agent', 'workflow', 'tool', 'system')),
  requested_by_id TEXT,
  subject_type TEXT,
  subject_id TEXT,
  summary TEXT NOT NULL,
  reason TEXT NOT NULL,
  resolved_mode TEXT NOT NULL CHECK (resolved_mode IN ('auto', 'review', 'blocked')),
  policy_source TEXT NOT NULL,
  risk TEXT,
  snapshot_json TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'expired')),
  expires_at TEXT,
  decision TEXT CHECK (decision IN ('approved', 'rejected', 'cancelled', 'expired')),
  decided_by_type TEXT CHECK (decided_by_type IN ('user', 'system')),
  decided_by_id TEXT,
  decision_note TEXT,
  decided_at TEXT,
  workflow_id TEXT,
  run_id TEXT,
  step_id TEXT,
  execution_id TEXT,
  conversation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_approval_workspace_status ON approval (workspace_id, status);
CREATE INDEX idx_approval_dedup ON approval (workspace_id, action_key, fingerprint, status);
CREATE INDEX idx_approval_subject ON approval (workspace_id, subject_type, subject_id);
CREATE INDEX idx_approval_execution ON approval (workspace_id, execution_id);
