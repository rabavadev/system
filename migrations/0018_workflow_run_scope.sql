-- 0018: Workflow Run Scope Support (H3B.2)
-- Adds generic scope_type and scope_id to workflow_run with CHECK constraint and composite index.
-- Safely backfills historical runs only when structured activeScope JSON is unambiguous.
-- Preserves all existing workflow runs, step runs, approval linkages, and foreign keys.

PRAGMA foreign_keys = OFF;

CREATE TABLE workflow_run_dg_tmp (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflow (id) ON DELETE RESTRICT,
  workflow_version_id TEXT NOT NULL REFERENCES workflow_version (id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled')),
  trigger_type TEXT NOT NULL DEFAULT 'manual' CHECK (trigger_type IN ('manual', 'schedule', 'event', 'agent')),
  input TEXT,
  output TEXT,
  error TEXT,
  context_json TEXT,
  plan_json TEXT,
  state_json TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  scope_type TEXT CHECK (scope_type IS NULL OR scope_type IN ('workspace', 'brand', 'niche', 'product', 'account', 'campaign')),
  scope_id TEXT,
  CHECK ((scope_type IS NULL AND scope_id IS NULL) OR (scope_type IS NOT NULL AND scope_id IS NOT NULL))
);

INSERT INTO workflow_run_dg_tmp (
  id, workflow_id, workflow_version_id, status, trigger_type, input, output,
  error, context_json, plan_json, state_json, started_at, finished_at, created_at, updated_at,
  scope_type, scope_id
)
SELECT
  r.id, r.workflow_id, r.workflow_version_id, r.status, r.trigger_type, r.input, r.output,
  r.error, r.context_json, r.plan_json, r.state_json, r.started_at, r.finished_at, r.created_at, r.updated_at,
  CASE
    WHEN r.context_json IS NOT NULL
      AND json_valid(r.context_json) = 1
      AND json_extract(r.context_json, '$.activeScope.type') IN ('workspace', 'brand', 'niche', 'product', 'account', 'campaign')
      AND json_extract(r.context_json, '$.activeScope.id') IS NOT NULL
      THEN json_extract(r.context_json, '$.activeScope.type')
    ELSE NULL
  END AS scope_type,
  CASE
    WHEN r.context_json IS NOT NULL
      AND json_valid(r.context_json) = 1
      AND json_extract(r.context_json, '$.activeScope.type') IN ('workspace', 'brand', 'niche', 'product', 'account', 'campaign')
      AND json_extract(r.context_json, '$.activeScope.id') IS NOT NULL
      THEN json_extract(r.context_json, '$.activeScope.id')
    ELSE NULL
  END AS scope_id
FROM workflow_run r;

DROP TABLE workflow_run;

ALTER TABLE workflow_run_dg_tmp RENAME TO workflow_run;

CREATE INDEX idx_workflow_run_workflow ON workflow_run (workflow_id, status);
CREATE INDEX idx_workflow_run_version ON workflow_run (workflow_version_id);
CREATE INDEX idx_workflow_run_scope ON workflow_run (scope_type, scope_id, created_at DESC);

PRAGMA foreign_keys = ON;
