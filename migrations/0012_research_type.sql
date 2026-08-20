-- 0012: Research Type (STEP 12A)
-- Adds extensible research_type taxonomy to research table.
-- Supported types: market, audience, competitor, product, platform, content, general.

ALTER TABLE research ADD COLUMN research_type TEXT NOT NULL DEFAULT 'general'
  CHECK (research_type IN ('market', 'audience', 'competitor', 'product', 'platform', 'content', 'general'));

CREATE INDEX IF NOT EXISTS idx_research_type ON research (workspace_id, research_type);
