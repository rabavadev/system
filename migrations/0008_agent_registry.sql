-- 0008: Agent Registry (STEP 8)
-- Built-in vs custom identity, identity-level purpose text, and per-version
-- change notes. Versioned execution configuration, model strategy and
-- capability metadata already fit in agent_version.config (JSON), so they
-- deliberately get no new columns.

-- 'builtin' identities (Chief, Researcher, ...) are protected from archive/
-- hard delete; 'custom' agents are user-created. Existing rows predate the
-- registry: only the Workspace Chief is a built-in so far.
ALTER TABLE agent ADD COLUMN origin TEXT NOT NULL DEFAULT 'custom'
  CHECK (origin IN ('builtin', 'custom'));
ALTER TABLE agent ADD COLUMN description TEXT;

UPDATE agent SET origin = 'builtin' WHERE role = 'workspace-chief';

-- Short human note attached to an immutable version ("why this version
-- exists"). Display only; never part of execution.
ALTER TABLE agent_version ADD COLUMN change_note TEXT;

CREATE INDEX idx_agent_workspace_status ON agent (workspace_id, status);
