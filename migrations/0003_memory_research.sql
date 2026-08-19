-- 0003: Memory and research
-- memory, research, research_source
--
-- One memory table serves all classes and scopes. Freshness is represented
-- by the (last_verified_at, expires_at, status) triple rather than a single
-- column; see docs/database.md.

CREATE TABLE memory (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace (id) ON DELETE RESTRICT,
  memory_class TEXT NOT NULL CHECK (memory_class IN ('permanent_fact', 'verified_learning', 'proposed_learning', 'temporary_context')),
  content TEXT NOT NULL,
  scope_type TEXT NOT NULL DEFAULT 'workspace' CHECK (scope_type IN ('workspace', 'brand', 'niche', 'account', 'platform', 'product', 'campaign')),
  scope_id TEXT, -- scoped reference, integrity enforced application-side
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'archived', 'rejected')),
  confidence REAL CHECK (confidence BETWEEN 0 AND 1),
  source_type TEXT NOT NULL DEFAULT 'manual' CHECK (source_type IN ('user', 'agent', 'research', 'observation', 'import', 'manual')),
  source_id TEXT,
  evidence TEXT, -- JSON array of references supporting this memory
  superseded_by TEXT REFERENCES memory (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_verified_at TEXT,
  expires_at TEXT
);
CREATE INDEX idx_memory_workspace ON memory (workspace_id, memory_class, status);
CREATE INDEX idx_memory_scope ON memory (scope_type, scope_id);

CREATE TABLE research (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace (id) ON DELETE RESTRICT,
  subject TEXT NOT NULL,
  findings TEXT, -- markdown or JSON
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_progress', 'completed', 'stale', 'archived')),
  confidence REAL CHECK (confidence BETWEEN 0 AND 1),
  scope_type TEXT CHECK (scope_type IN ('workspace', 'brand', 'niche', 'account', 'platform', 'product', 'campaign')),
  scope_id TEXT, -- scoped reference, integrity enforced application-side
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_verified_at TEXT,
  expires_at TEXT,
  deleted_at TEXT
);
CREATE INDEX idx_research_workspace ON research (workspace_id, status);
CREATE INDEX idx_research_scope ON research (scope_type, scope_id);

CREATE TABLE research_source (
  id TEXT PRIMARY KEY,
  research_id TEXT NOT NULL REFERENCES research (id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('url', 'file', 'platform', 'manual', 'agent')),
  uri TEXT,
  title TEXT,
  metadata TEXT, -- JSON
  retrieved_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_research_source_research ON research_source (research_id);
