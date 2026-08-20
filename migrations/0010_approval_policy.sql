-- 0010: Approval Policy (STEP 11A)
-- Platform-neutral approval policy configuration answering:
-- "What should happen when this kind of action is requested?"
-- Distinct from Approval Requests (which live on the approval table).
-- Precedence: Brand override > Workspace policy > Safe system default.

CREATE TABLE approval_policy (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace (id) ON DELETE RESTRICT,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('workspace', 'brand', 'account', 'platform', 'workflow')),
  scope_id TEXT NOT NULL,
  action_key TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('auto', 'review', 'blocked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, scope_type, scope_id, action_key)
);

CREATE INDEX idx_approval_policy_scope ON approval_policy (workspace_id, scope_type, scope_id);
CREATE INDEX idx_approval_policy_action ON approval_policy (workspace_id, action_key);
