-- 0002: AI system, workflows, conversations
-- agent, agent_version, workflow, workflow_version, workflow_run,
-- workflow_step_run, conversation, message

CREATE TABLE agent (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace (id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  role TEXT,
  execution_type TEXT NOT NULL DEFAULT 'direct_model' CHECK (execution_type IN ('direct_model', 'external_agent', 'router')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_agent_workspace ON agent (workspace_id);

-- Immutable configuration snapshots. Model/provider are preferences inside
-- the JSON config, resolved per run; an agent is never bound to one model.
CREATE TABLE agent_version (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agent (id) ON DELETE RESTRICT,
  version INTEGER NOT NULL,
  config TEXT NOT NULL, -- JSON: instructions, tools, provider preferences
  created_at TEXT NOT NULL,
  UNIQUE (agent_id, version)
);

-- Pointer to the active version. Added via ALTER because the tables are
-- mutually dependent; SQLite allows ADD COLUMN ... REFERENCES with NULL default.
ALTER TABLE agent ADD COLUMN current_version_id TEXT REFERENCES agent_version (id);

CREATE TABLE workflow (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace (id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'disabled', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_workflow_workspace ON workflow (workspace_id);

-- Immutable once referenced by a workflow_run (enforced application-side;
-- see docs/database.md). Historical definitions are never overwritten.
CREATE TABLE workflow_version (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflow (id) ON DELETE RESTRICT,
  version INTEGER NOT NULL,
  definition TEXT NOT NULL, -- JSON
  created_at TEXT NOT NULL,
  UNIQUE (workflow_id, version)
);

ALTER TABLE workflow ADD COLUMN current_version_id TEXT REFERENCES workflow_version (id);

CREATE TABLE workflow_run (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflow (id) ON DELETE RESTRICT,
  workflow_version_id TEXT NOT NULL REFERENCES workflow_version (id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  trigger_type TEXT NOT NULL DEFAULT 'manual' CHECK (trigger_type IN ('manual', 'schedule', 'event', 'agent')),
  input TEXT,  -- JSON
  output TEXT, -- JSON
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_workflow_run_workflow ON workflow_run (workflow_id, status);
CREATE INDEX idx_workflow_run_version ON workflow_run (workflow_version_id);

CREATE TABLE workflow_step_run (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_run (id) ON DELETE RESTRICT,
  step_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'skipped')),
  attempt INTEGER NOT NULL DEFAULT 1,
  input TEXT,  -- JSON
  output TEXT, -- JSON
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (workflow_run_id, step_key, attempt)
);
CREATE INDEX idx_workflow_step_run_run ON workflow_step_run (workflow_run_id);

CREATE TABLE conversation (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace (id) ON DELETE RESTRICT,
  title TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_conversation_workspace ON conversation (workspace_id);

-- Messages record who/what produced them. Provider/model details live in
-- provider_metadata JSON so messages are not coupled to any AI provider.
CREATE TABLE message (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversation (id) ON DELETE RESTRICT,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('user', 'agent', 'system')),
  agent_id TEXT REFERENCES agent (id) ON DELETE SET NULL,
  agent_version_id TEXT REFERENCES agent_version (id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  provider_metadata TEXT, -- JSON: provider, model, token counts, latency
  created_at TEXT NOT NULL
);
CREATE INDEX idx_message_conversation ON message (conversation_id, created_at);
CREATE INDEX idx_message_agent ON message (agent_id);
