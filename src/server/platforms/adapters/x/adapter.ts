import { XApiClient, type XXClientOptions } from './client.ts'
import type { XPublishResult, XPublishTextInput } from './types.ts'

/**
 * Checks if a secret_ref identifier is explicitly bound to the X provider namespace.
 * Requires the prefix 'X_' (case-insensitive).
 */
export function isXBoundSecretRef(secretRef: string): boolean {
  if (!secretRef || typeof secretRef !== 'string') return false
  return secretRef.trim().toUpperCase().startsWith('X_')
}

export class XPublishingAdapter {
  private readonly client: XApiClient

  constructor(options?: XXClientOptions) {
    this.client = new XApiClient(options)
  }

  /**
   * Publishes a text-only Tweet to X behind the verified approval and credential boundary.
   *
   * Lifecycle:
   * 1. Validates X-bound secret reference
   * 2. Validates text payload (non-empty string)
   * 3. Verifies authenticated identity against target account (/2/users/me)
   * 4. Dispatches POST /2/tweets (exactly one call)
   * 5. Returns normalized success or safe error
   */
  async publishText(input: XPublishTextInput): Promise<XPublishResult> {
    const { text, expectedAccountHandle, trustedProviderUserId, credential } = input

    // 1. Validate X-bound secret reference
    if (!isXBoundSecretRef(credential.secretRef)) {
      return {
        ok: false,
        code: 'not_configured',
        message: `Secret reference '${credential.secretRef}' is not an explicitly authorized X provider binding (expected X_ prefix).`,
      }
    }

    // 2. Validate text content
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return {
        ok: false,
        code: 'invalid_request',
        message: 'Published content text must be a non-empty string.',
      }
    }

    // 3. Authenticated Identity Verification (/2/users/me)
    const userRes = await this.client.getAuthenticatedUser(credential.secretValue)
    if (!userRes.ok) {
      return userRes
    }

    const authUser = userRes.data
    const cleanExpectedHandle = expectedAccountHandle.replace(/^@/, '').trim().toLowerCase()
    const cleanAuthUsername = authUser.username.replace(/^@/, '').trim().toLowerCase()

    // Determine metadata trusted provider ID if present
    const meta = credential.metadata
    // biome-ignore lint/complexity/useLiteralKeys: required by tsconfig noPropertyAccessFromIndexSignature
    const providerUserId = meta?.['providerUserId']
    // biome-ignore lint/complexity/useLiteralKeys: required by tsconfig noPropertyAccessFromIndexSignature
    const xUserId = meta?.['xUserId']
    // biome-ignore lint/complexity/useLiteralKeys: required by tsconfig noPropertyAccessFromIndexSignature
    const userId = meta?.['userId']

    const metadataTrustedId =
      typeof providerUserId === 'string'
        ? providerUserId
        : typeof xUserId === 'string'
          ? xUserId
          : typeof userId === 'string'
            ? userId
            : trustedProviderUserId

    let identityMatched = false

    if (metadataTrustedId && metadataTrustedId.trim().length > 0) {
      if (authUser.id === metadataTrustedId.trim()) {
        identityMatched = true
      }
    } else {
      // Compare normalized handle
      if (cleanAuthUsername === cleanExpectedHandle) {
        identityMatched = true
      }
    }

    if (!identityMatched) {
      return {
        ok: false,
        code: 'account_identity_mismatch',
        message: `Authenticated X user (@${authUser.username}, ID: ${authUser.id}) does not match target account (@${expectedAccountHandle}).`,
      }
    }

    // 4. Create Tweet (POST /2/tweets)
    const tweetRes = await this.client.createTweet(credential.secretValue, text)
    if (!tweetRes.ok) {
      return tweetRes
    }

    const successResult: XPublishResult = {
      ok: true,
      externalId: tweetRes.data.id,
      url: null,
      text,
    }
    if (tweetRes.rateLimit) {
      successResult.rateLimit = tweetRes.rateLimit
    }

    return successResult
  }
}
