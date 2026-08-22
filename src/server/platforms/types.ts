/**
 * Server-only interface for resolving secret bindings from Cloudflare runtime
 * environment or injected secret stores.
 */
export interface PlatformSecretResolver {
  resolveSecret(secretRef: string): Promise<string | null> | string | null
}

/**
 * Opaque server-only credential representation for platform adapters.
 * Never exposed through domain DTOs, API endpoints, or audit logs.
 */
export interface PlatformCredential {
  secretRef: string
  secretValue: string
  accountId: string
  platformAdapterKey: string
  scopes?: string | null
  metadata?: Record<string, unknown> | null
}

export type PlatformCredentialErrorCode =
  | 'account_not_found'
  | 'account_ineligible'
  | 'platform_mismatch'
  | 'connection_not_found'
  | 'connection_inactive'
  | 'secret_ref_invalid'
  | 'secret_not_configured'
  | 'not_configured'

export type ResolvePlatformCredentialResult =
  | {
      ok: true
      credential: PlatformCredential
    }
  | {
      ok: false
      code: PlatformCredentialErrorCode
      reason: string
    }

export interface ResolvePlatformCredentialInput {
  workspaceId: string
  accountId: string
  platformAdapterKey: string
}
