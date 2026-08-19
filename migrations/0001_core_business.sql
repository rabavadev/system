-- 0001: Core business structure
-- workspace, brand, niche, product, platform, account, account_niche,
-- platform_connection, goal
--
-- Conventions used across all migrations:
--   * IDs are TEXT UUIDs generated application-side (crypto.randomUUID).
--   * Timestamps are TEXT ISO-8601 UTC, set application-side.
--   * Business entities carry deleted_at for soft deletion; historical
--     tables (runs, observations, events, audit) do not.
--   * "Scoped references" (scope_type + scope_id) are deliberately not
--     foreign keys; see docs/database.md.

CREATE TABLE workspace (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE brand (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace (id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_brand_workspace ON brand (workspace_id);

CREATE TABLE niche (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brand (id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_niche_brand ON niche (brand_id);

CREATE TABLE product (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brand (id) ON DELETE RESTRICT,
  niche_id TEXT REFERENCES niche (id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  description TEXT,
  url TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_product_brand ON product (brand_id);
CREATE INDEX idx_product_niche ON product (niche_id);

-- Registry of platforms the app can integrate with. Rows are reference data
-- (see seed.sql); adapter_key maps to a server/platforms adapter at runtime.
CREATE TABLE platform (
  id TEXT PRIMARY KEY,
  adapter_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE account (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace (id) ON DELETE RESTRICT,
  platform_id TEXT NOT NULL REFERENCES platform (id) ON DELETE RESTRICT,
  handle TEXT NOT NULL,
  display_name TEXT,
  -- An account may primarily target one niche...
  primary_niche_id TEXT REFERENCES niche (id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'disconnected', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (platform_id, handle)
);
CREATE INDEX idx_account_workspace ON account (workspace_id);
CREATE INDEX idx_account_platform ON account (platform_id);
CREATE INDEX idx_account_primary_niche ON account (primary_niche_id);

-- ...and be associated with any number of niches over time.
CREATE TABLE account_niche (
  account_id TEXT NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  niche_id TEXT NOT NULL REFERENCES niche (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, niche_id)
);
-- PK covers account_id lookups; this covers "accounts in a niche".
CREATE INDEX idx_account_niche_niche ON account_niche (niche_id);

-- Connection/credential state for an account. Secrets themselves are NEVER
-- stored here; secret_ref points at an external secret (Workers secret name
-- or future vault key). One live connection per account.
CREATE TABLE platform_connection (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL UNIQUE REFERENCES account (id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'expired', 'error', 'disconnected')),
  secret_ref TEXT,
  scopes TEXT,
  metadata TEXT, -- JSON: platform user id, expiry hints, etc.
  connected_at TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE goal (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace (id) ON DELETE RESTRICT,
  scope_type TEXT NOT NULL DEFAULT 'workspace' CHECK (scope_type IN ('workspace', 'brand', 'product', 'campaign')),
  scope_id TEXT, -- scoped reference, integrity enforced application-side
  title TEXT NOT NULL,
  description TEXT,
  target_metric_key TEXT,
  target_value REAL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'achieved', 'abandoned')),
  due_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_goal_workspace ON goal (workspace_id);
CREATE INDEX idx_goal_scope ON goal (scope_type, scope_id);
