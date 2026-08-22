import type { SqlDatabase } from '../db/sql.ts'
import { getPlatformById, getPlatformConnectionForAccount } from '../db/platform.ts'
import type {
  PlatformCredential,
  PlatformSecretResolver,
  ResolvePlatformCredentialInput,
  ResolvePlatformCredentialResult,
} from './types.ts'

interface AccountLookupRow {
  id: string
  workspace_id: string
  platform_id: string
  handle: string
  display_name: string | null
  status: string
  deleted_at: string | null
}

/**
 * Server-authoritative platform credential resolver.
 *
 * Enforces:
 * 1. Workspace tenant isolation
 * 2. Active account lifecycle checks
 * 3. Platform adapter key matching
 * 4. Active connected connection state
 * 5. Secure runtime secret resolution from secret_ref
 *
 * Secrets are never stored in D1 and never returned through public domain DTOs.
 */
export async function resolvePlatformCredential(
  db: SqlDatabase,
  input: ResolvePlatformCredentialInput,
  secretResolver?: PlatformSecretResolver,
): Promise<ResolvePlatformCredentialResult> {
  // 1. Load Account server-side
  const accountRows = (await db
    .prepare(
      `SELECT id, workspace_id, platform_id, handle, display_name, status, deleted_at
       FROM account
       WHERE id = ?`,
    )
    .bind(input.accountId)
    .all<AccountLookupRow>())?.results

  const account = accountRows && accountRows.length > 0 ? accountRows[0] : null

  if (!account || account.workspace_id !== input.workspaceId) {
    return {
      ok: false,
      code: 'account_not_found',
      reason: 'Account not found in this workspace.',
    }
  }

  if (account.deleted_at !== null) {
    return {
      ok: false,
      code: 'account_ineligible',
      reason: 'Account has been deleted.',
    }
  }

  if (account.status !== 'active') {
    return {
      ok: false,
      code: 'account_ineligible',
      reason: `Account is ${account.status}. Must be active to resolve credentials.`,
    }
  }

  // 2. Load and verify Platform
  const platform = await getPlatformById(db, account.platform_id)
  if (!platform) {
    return {
      ok: false,
      code: 'platform_mismatch',
      reason: 'Account platform record not found.',
    }
  }

  if (platform.adapterKey !== input.platformAdapterKey) {
    return {
      ok: false,
      code: 'platform_mismatch',
      reason: `Account platform '${platform.adapterKey}' does not match requested platform '${input.platformAdapterKey}'.`,
    }
  }

  // 3. Load active Platform Connection
  const connection = await getPlatformConnectionForAccount(db, account.id)
  if (!connection) {
    return {
      ok: false,
      code: 'not_configured',
      reason: 'No platform connection configured for this account.',
    }
  }

  if (connection.status !== 'connected') {
    return {
      ok: false,
      code: 'connection_inactive',
      reason: `Platform connection is ${connection.status}. Must be connected to resolve credentials.`,
    }
  }

  if (!connection.secretRef || connection.secretRef.trim().length === 0) {
    return {
      ok: false,
      code: 'not_configured',
      reason: 'Platform connection has no secret_ref configured.',
    }
  }

  // 4. Resolve external secret binding
  if (!secretResolver) {
    return {
      ok: false,
      code: 'not_configured',
      reason: `No secret resolver provided and runtime secret binding '${connection.secretRef}' cannot be resolved.`,
    }
  }

  const secretValue = await secretResolver.resolveSecret(connection.secretRef.trim())
  if (!secretValue || typeof secretValue !== 'string' || secretValue.trim().length === 0) {
    return {
      ok: false,
      code: 'not_configured',
      reason: `Secret binding '${connection.secretRef}' is not configured in runtime environment.`,
    }
  }

  // 5. Parse safe metadata JSON if present
  let parsedMetadata: Record<string, unknown> | null = null
  if (connection.metadataJson && connection.metadataJson.trim().length > 0) {
    try {
      const parsed = JSON.parse(connection.metadataJson)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        parsedMetadata = parsed as Record<string, unknown>
      }
    } catch {
      parsedMetadata = null
    }
  }

  const credential: PlatformCredential = {
    secretRef: connection.secretRef.trim(),
    secretValue: secretValue.trim(),
    accountId: account.id,
    platformAdapterKey: platform.adapterKey,
    scopes: connection.scopes ?? null,
    metadata: parsedMetadata,
  }

  return {
    ok: true,
    credential,
  }
}
