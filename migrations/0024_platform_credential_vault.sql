-- 0024: Secure OAuth Platform Credential Vault (STEP 15E.3C.1)
-- Stores encrypted OAuth credentials (access_token, refresh_token) for connected accounts.
-- Never stores plaintext tokens, authorization headers, or encryption master keys.

CREATE TABLE platform_credential (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace (id) ON DELETE RESTRICT,
  account_id TEXT NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  platform_id TEXT NOT NULL REFERENCES platform (id) ON DELETE RESTRICT,
  credential_type TEXT NOT NULL DEFAULT 'oauth2' CHECK (credential_type IN ('oauth2')),
  access_token_ciphertext TEXT NOT NULL,
  access_token_iv TEXT NOT NULL,
  refresh_token_ciphertext TEXT,
  refresh_token_iv TEXT,
  token_type TEXT,
  scopes TEXT,
  access_token_expires_at TEXT,
  refresh_token_expires_at TEXT,
  provider_user_id TEXT,
  key_version INTEGER NOT NULL DEFAULT 1 CHECK (key_version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX idx_platform_credential_workspace ON platform_credential (workspace_id);
CREATE INDEX idx_platform_credential_account ON platform_credential (account_id);
CREATE INDEX idx_platform_credential_platform ON platform_credential (platform_id);
CREATE UNIQUE INDEX idx_platform_credential_active_account ON platform_credential (account_id) WHERE revoked_at IS NULL;
