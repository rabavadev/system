-- 0009: Workflow Engine (STEP 10)
-- The STEP 2 workflow tables were structural placeholders. STEP 10 needs
-- what they could not express:
--   * workflow_run.status 'waiting' (approval compatibility; CHECK change
--     requires a table rebuild in SQLite)
--   * per-run context snapshot, resolved run plan (frozen agent versions)
--     and resumable engine state
--   * per-step type, resolved agent version, tool execution id and the
--     branch/next-step decision for auditability
--   * workflow_version change notes (same doctrine as agent_version)
-- Historical rows are preserved by copy; nothing is hard-deleted.

ALTER TABLE workflow_version ADD COLUMN change_note TEXT;

CREATE TABLE workflow_run_new (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflow (id) ON DELETE RESTRICT,
  workflow_version_id TEXT NOT NULL REFERENCES workflow_version (id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled')),
  trigger_type TEXT NOT NULL DEFAULT 'manual' CHECK (trigger_type IN ('manual', 'schedule', 'event', 'agent')),
  input TEXT,           -- JSON: validated workflow inputs
  output TEXT,          -- JSON: mapped run output (definition.output)
  error TEXT,
  context_json TEXT,    -- JSON: safe ContextPackage snapshot from run start
  plan_json TEXT,       -- JSON: resolved agent versions + limits + entry step
  state_json TEXT,      -- JSON: engine state (next step, visit counts, counters)
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO workflow_run_new
  (id, workflow_id, workflow_version_id, status, trigger_type, input, output,
   error, started_at, finished_at, created_at, updated_at)
  SELECT id, workflow_id, workflow_version_id, status, trigger_type, input, output,
         error, started_at, finished_at, created_at, updated_at
  FROM workflow_run;
DROP TABLE workflow_run;
ALTER TABLE workflow_run_new RENAME TO workflow_run;
CREATE INDEX idx_workflow_run_workflow ON workflow_run (workflow_id, status);
CREATE INDEX idx_workflow_run_version ON workflow_run (workflow_version_id);

CREATE TABLE workflow_step_run_new (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_run (id) ON DELETE RESTRICT,
  step_key TEXT NOT NULL,
  step_type TEXT NOT NULL DEFAULT 'agent' CHECK (step_type IN ('agent', 'tool', 'condition', 'end')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'skipped')),
  attempt INTEGER NOT NULL DEFAULT 1,
  agent_version_id TEXT REFERENCES agent_version (id),
  tool_execution_id TEXT,
  input TEXT,     -- JSON: safe bound input snapshot
  output TEXT,    -- JSON: structured step output
  error TEXT,
  decision TEXT,  -- JSON: chosen branch / next step, condition evaluation
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (workflow_run_id, step_key, attempt)
);
INSERT INTO workflow_step_run_new
  (id, workflow_run_id, step_key, status, attempt, input, output, error,
   started_at, finished_at, created_at)
  SELECT id, workflow_run_id, step_key, status, attempt, input, output, error,
         started_at, finished_at, created_at
  FROM workflow_step_run;
DROP TABLE workflow_step_run;
ALTER TABLE workflow_step_run_new RENAME TO workflow_step_run;
CREATE INDEX idx_workflow_step_run_run ON workflow_step_run (workflow_run_id);
