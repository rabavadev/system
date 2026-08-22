/**
 * Normalized server-only representation of an OAuth credential set.
 * NEVER exposed to clients, browser components, API responses, or audit logs.
 */
export interface NormalizedOAuthCredential {
  accessToken: string
  refreshToken?: string | null
  tokenType?: string | null
  scopes?: string[] | string | null
  accessTokenExpiresAt?: string | null
  refreshTokenExpiresAt?: string | null
  providerUserId?: string | null
}

export interface StoredPlatformCredentialRow {
  id: string
  workspace_id: string
  account_id: string
  platform_id: string
  credential_type: string
  access_token_ciphertext: string
  access_token_iv: string
  refresh_token_ciphertext: string | null
  refresh_token_iv: string | null
  token_type: string | null
  scopes: string | null
  access_token_expires_at: string | null
  refresh_token_expires_at: string | null
  provider_user_id: string | null
  key_version: number
  created_at: string
  updated_at: string
  revoked_at: string | null
}

export interface DecryptedOAuthCredential extends NormalizedOAuthCredential {
  id: string
  workspaceId: string
  accountId: string
  platformId: string
  platformAdapterKey: string
  keyVersion: number
  createdAt: string
  updatedAt: string
}

export interface StoreOAuthCredentialInput {
  workspaceId: string
  accountId: string
  platformAdapterKey: string
  credential: NormalizedOAuthCredential
  keyVersion?: number
}

export interface ResolveOAuthCredentialInput {
  workspaceId: string
  accountId: string
  platformAdapterKey: string
}

export interface RotateOAuthCredentialInput {
  workspaceId: string
  accountId: string
  platformAdapterKey: string
  credential: NormalizedOAuthCredential
  keyVersion?: number
}

export interface RevokeOAuthCredentialInput {
  workspaceId: string
  accountId: string
  platformAdapterKey: string
  reason?: string
}

export type CredentialVaultErrorCode =
  | 'account_not_found'
  | 'account_ineligible'
  | 'platform_mismatch'
  | 'connection_inactive'
  | 'credential_not_found'
  | 'credential_vault_not_configured'
  | 'credential_corrupt'
  | 'credential_decrypt_failed'
  | 'credential_unknown_key_version'
  | 'invalid_credential'

export type ResolveOAuthCredentialResult =
  | {
      ok: true
      credential: DecryptedOAuthCredential
    }
  | {
      ok: false
      code: CredentialVaultErrorCode
      reason: string
    }

export type StoreOAuthCredentialResult =
  | {
      ok: true
      id: string
    }
  | {
      ok: false
      code: CredentialVaultErrorCode
      reason: string
    }

export type RevokeOAuthCredentialResult =
  | {
      ok: true
      revokedCount: number
    }
  | {
      ok: false
      code: CredentialVaultErrorCode
      reason: string
    }
