-- 0005: Experiments and analytics
-- experiment, experiment_variant, experiment_result,
-- metric_definition, metric_observation, platform_metric_raw
--
-- Analytics are two-lane: metric_observation holds normalized internal
-- metrics; platform_metric_raw preserves platform-native metrics verbatim.
-- Not every platform exposes the same metrics, so both lanes key metrics
-- by TEXT, not by a fixed column set.

CREATE TABLE experiment (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace (id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  hypothesis TEXT,
  variable TEXT,           -- the single variable being tested
  primary_metric_key TEXT, -- normalized metric key deciding the outcome
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'running', 'concluded', 'cancelled')),
  confidence REAL CHECK (confidence BETWEEN 0 AND 1),
  result_summary TEXT,
  starts_at TEXT,
  ends_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_experiment_workspace ON experiment (workspace_id, status);

CREATE TABLE experiment_variant (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiment (id) ON DELETE CASCADE,
  key TEXT NOT NULL, -- 'control', 'a', 'b', ...
  is_control INTEGER NOT NULL DEFAULT 0 CHECK (is_control IN (0, 1)),
  description TEXT,
  subject_type TEXT, -- scoped reference to what this variant uses, e.g. a content_variant
  subject_id TEXT,
  config TEXT, -- JSON
  created_at TEXT NOT NULL,
  UNIQUE (experiment_id, key)
);
CREATE INDEX idx_experiment_variant_experiment ON experiment_variant (experiment_id);

CREATE TABLE experiment_result (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiment (id) ON DELETE CASCADE,
  variant_id TEXT REFERENCES experiment_variant (id) ON DELETE CASCADE,
  metric_key TEXT NOT NULL,
  value REAL NOT NULL,
  sample_size INTEGER,
  observed_at TEXT NOT NULL,
  metadata TEXT, -- JSON
  created_at TEXT NOT NULL
);
CREATE INDEX idx_experiment_result_experiment ON experiment_result (experiment_id);

-- workspace_id NULL means a built-in normalized metric shared by all
-- workspaces; a workspace can also define its own.
CREATE TABLE metric_definition (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspace (id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  unit TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, key)
);
-- Built-in rows share key space; enforce uniqueness of built-in keys too.
CREATE UNIQUE INDEX idx_metric_definition_builtin_key ON metric_definition (key) WHERE workspace_id IS NULL;

CREATE TABLE metric_observation (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace (id) ON DELETE RESTRICT,
  metric_definition_id TEXT NOT NULL REFERENCES metric_definition (id) ON DELETE RESTRICT,
  subject_type TEXT NOT NULL, -- 'post', 'account', 'campaign', 'content', 'product', ...
  subject_id TEXT NOT NULL,   -- scoped reference, integrity enforced application-side
  value REAL NOT NULL,
  granularity TEXT NOT NULL DEFAULT 'total' CHECK (granularity IN ('total', 'day', 'hour')),
  observed_at TEXT NOT NULL,  -- the time window this value describes (UTC)
  source TEXT NOT NULL DEFAULT 'platform_sync' CHECK (source IN ('platform_sync', 'manual', 'derived')),
  metadata TEXT, -- JSON
  created_at TEXT NOT NULL
);
CREATE INDEX idx_metric_observation_subject ON metric_observation (subject_type, subject_id, metric_definition_id, observed_at);
CREATE INDEX idx_metric_observation_workspace ON metric_observation (workspace_id, observed_at);
-- Idempotent sync: one observation per subject/metric/window/source. Adding
-- this after data accumulates would require a dedup migration, so it exists
-- from day one.
CREATE UNIQUE INDEX idx_metric_observation_dedup ON metric_observation (
  subject_type, subject_id, metric_definition_id, granularity, observed_at, source
);

-- Raw platform metrics, preserved as delivered. metric_key is the
-- platform-native name; payload keeps the full response when useful.
CREATE TABLE platform_metric_raw (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id) ON DELETE RESTRICT,
  subject_type TEXT NOT NULL, -- platform's object type, e.g. 'account', 'post'
  subject_external_id TEXT,   -- platform's id for that object
  metric_key TEXT NOT NULL,
  value REAL,
  payload TEXT, -- JSON: raw response
  observed_at TEXT NOT NULL,
  pulled_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_platform_metric_raw_account ON platform_metric_raw (account_id, metric_key, observed_at);
