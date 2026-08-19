-- 0004: Campaigns and content lineage
-- campaign, campaign_account, content, content_variant, post
--
-- Lineage: campaign -> content (core idea) -> content_variant (per platform)
-- -> post (actual publication instance on an account).

CREATE TABLE campaign (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace (id) ON DELETE RESTRICT,
  brand_id TEXT REFERENCES brand (id) ON DELETE RESTRICT,
  product_id TEXT REFERENCES product (id) ON DELETE RESTRICT,
  goal_id TEXT REFERENCES goal (id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  audience TEXT,
  angle TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'completed', 'archived')),
  starts_at TEXT,
  ends_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_campaign_workspace ON campaign (workspace_id, status);
CREATE INDEX idx_campaign_brand ON campaign (brand_id);

-- A campaign runs across any number of accounts (and therefore platforms).
CREATE TABLE campaign_account (
  campaign_id TEXT NOT NULL REFERENCES campaign (id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES account (id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (campaign_id, account_id)
);
CREATE INDEX idx_campaign_account_account ON campaign_account (account_id);

CREATE TABLE content (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace (id) ON DELETE RESTRICT,
  campaign_id TEXT REFERENCES campaign (id) ON DELETE RESTRICT,
  product_id TEXT REFERENCES product (id) ON DELETE RESTRICT,
  title TEXT,
  brief TEXT,
  body TEXT, -- core, platform-agnostic content
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_review', 'approved', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_content_campaign ON content (campaign_id);
CREATE INDEX idx_content_workspace ON content (workspace_id, status);

CREATE TABLE content_variant (
  id TEXT PRIMARY KEY,
  content_id TEXT NOT NULL REFERENCES content (id) ON DELETE RESTRICT,
  platform_id TEXT NOT NULL REFERENCES platform (id) ON DELETE RESTRICT,
  body TEXT,
  metadata TEXT, -- JSON: platform-specific format hints
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_review', 'approved', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_content_variant_content ON content_variant (content_id);
CREATE INDEX idx_content_variant_platform ON content_variant (platform_id);

-- A post is an actual (attempted) publication of a variant via an account.
CREATE TABLE post (
  id TEXT PRIMARY KEY,
  content_variant_id TEXT NOT NULL REFERENCES content_variant (id) ON DELETE RESTRICT,
  account_id TEXT NOT NULL REFERENCES account (id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'publishing', 'published', 'failed', 'removed')),
  external_id TEXT, -- the platform's own post id, once known
  url TEXT,
  scheduled_at TEXT,
  published_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_post_variant ON post (content_variant_id);
CREATE INDEX idx_post_account ON post (account_id, status);
CREATE INDEX idx_post_external ON post (external_id);
