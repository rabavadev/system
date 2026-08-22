import type { SafePlatformConnection } from '~/types/domain.ts'
import type { SqlDatabase } from '../../../../db/sql.ts'
import type { XHttpTransport } from '../types.ts'

export const X_OAUTH_COOKIE_NAME = 'gw_x_oauth_state'
export const X_OAUTH_DEFAULT_SCOPES = [
  'tweet.read',
  'tweet.write',
  'users.read',
  'offline.access',
] as const

export const X_AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize'
export const X_TOKEN_URL = 'https://api.x.com/2/oauth2/token'
export const X_USERS_ME_URL = 'https://api.x.com/2/users/me'

export interface PkcePair {
  codeVerifier: string
  codeChallenge: string
  codeChallengeMethod: 'S256'
}

/**
 * Server-only OAuth transaction state stored inside an encrypted, authenticated HttpOnly cookie.
 * NEVER exposed to client JavaScript or stored in plaintext.
 */
export interface OAuthTransactionState {
  state: string
  codeVerifier: string
  workspaceId: string
  accountId: string
  platformAdapterKey: string
  issuedAt: string
  expiresAt: string
}

export type XOAuthErrorCode =
  | 'oauth_not_configured'
  | 'not_configured'
  | 'account_not_found'
  | 'account_ineligible'
  | 'platform_mismatch'
  | 'invalid_oauth_state'
  | 'oauth_state_expired'
  | 'connection_cancelled'
  | 'connection_inactive'
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'provider_error'
  | 'timeout'
  | 'network_error'
  | 'account_identity_mismatch'
  | 'vault_storage_failed'
  | 'invalid_kek'
  | 'storage_error'
  | 'revocation_failed'
  | 'ambiguous_external_result'
  | 'credential_not_found'
  | 'credential_vault_not_configured'
  | 'credential_corrupt'
  | 'credential_decrypt_failed'
  | 'credential_unknown_key_version'
  | 'invalid_credential'
  | 'unsupported_content'

export interface XOAuthConfiguration {
  clientId: string
  redirectUri: string
  stateKek: string
  credentialKek?: string | undefined
}

export interface XOAuthStartOptions {
  accountId: string
  workspaceId: string
  db?: SqlDatabase | undefined
  env?: Record<string, unknown> | undefined
  config?: Partial<XOAuthConfiguration> | undefined
}

export type XOAuthStartResult =
  | {
      ok: true
      url: string
      cookieValue: string
      state: string
      expiresAt: string
    }
  | {
      ok: false
      code: XOAuthErrorCode
      reason: string
    }

export interface XOAuthCallbackOptions {
  state?: string | null | undefined
  code?: string | null | undefined
  error?: string | null | undefined
  errorDescription?: string | null | undefined
  cookieValue?: string | null | undefined
  workspaceId: string
  db?: SqlDatabase | undefined
  env?: Record<string, unknown> | undefined
  config?: Partial<XOAuthConfiguration> | undefined
  transport?: XHttpTransport | undefined
}

export type XOAuthCallbackResult =
  | {
      ok: true
      accountId: string
      providerUserId: string
      username: string
      connection: SafePlatformConnection
      clearCookie: boolean
    }
  | {
      ok: false
      code: XOAuthErrorCode
      reason: string
      clearCookie: boolean
    }

export interface XOAuthTokenResponse {
  token_type?: string
  expires_in?: number
  access_token: string
  scope?: string
  refresh_token?: string
}

export interface XOAuthErrorPayload {
  error?: string
  error_description?: string
}
