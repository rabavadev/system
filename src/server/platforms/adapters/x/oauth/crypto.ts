import { base64ToBuffer, bufferToBase64, importMasterKey } from '../../../credentials/crypto.ts'
import type { OAuthTransactionState, PkcePair } from './types.ts'

export const OAUTH_STATE_IV_LENGTH = 12
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000 // 10 minutes

/**
 * Encodes a Uint8Array into a URL-safe Base64 string without padding.
 */
export function bufferToBase64Url(bytes: Uint8Array): string {
  return bufferToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Decodes a URL-safe Base64 string (with or without padding) into a Uint8Array.
 */
export function base64UrlToBuffer(base64UrlStr: string): Uint8Array {
  return base64ToBuffer(base64UrlStr)
}

/**
 * Generates a cryptographically random PKCE code_verifier and corresponding SHA-256 S256 code_challenge.
 */
export async function generatePkcePair(): Promise<PkcePair> {
  const verifierBytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(verifierBytes)
  const codeVerifier = bufferToBase64Url(verifierBytes)

  const asciiBytes = new TextEncoder().encode(codeVerifier)
  const hashBuffer = await globalThis.crypto.subtle.digest(
    'SHA-256',
    asciiBytes as unknown as BufferSource,
  )
  const codeChallenge = bufferToBase64Url(new Uint8Array(hashBuffer))

  return {
    codeVerifier,
    codeChallenge,
    codeChallengeMethod: 'S256',
  }
}

/**
 * Generates a cryptographically random state parameter for CSRF protection.
 */
export function generateOAuthState(): string {
  const stateBytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(stateBytes)
  return bufferToBase64Url(stateBytes)
}

/**
 * Builds deterministic Authenticated Associated Data (AAD) for OAuth transaction cookie encryption.
 */
export function buildOAuthStateAad(ctx: {
  workspaceId: string
  platformAdapterKey: string
}): Uint8Array {
  const aadString = `oauth-state:v1\nworkspace=${ctx.workspaceId}\nplatform=${ctx.platformAdapterKey.toLowerCase().trim()}`
  return new TextEncoder().encode(aadString)
}

/**
 * Encrypts an OAuth transaction state into a secure URL-safe compact token.
 * Formatted as: `${base64Url(iv)}.${base64Url(ciphertext)}`
 */
export async function encryptOAuthTransaction(
  state: OAuthTransactionState,
  rawKey: string | Uint8Array,
): Promise<string> {
  const key = await importMasterKey(rawKey)
  const iv = new Uint8Array(OAUTH_STATE_IV_LENGTH)
  globalThis.crypto.getRandomValues(iv)

  const aad = buildOAuthStateAad({
    workspaceId: state.workspaceId,
    platformAdapterKey: state.platformAdapterKey,
  })

  const plaintextBytes = new TextEncoder().encode(JSON.stringify(state))
  const ciphertextBuffer = await globalThis.crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv as unknown as BufferSource,
      additionalData: aad as unknown as BufferSource,
    },
    key,
    plaintextBytes as unknown as BufferSource,
  )

  const ivStr = bufferToBase64Url(iv)
  const ciphertextStr = bufferToBase64Url(new Uint8Array(ciphertextBuffer))
  return `${ivStr}.${ciphertextStr}`
}

/**
 * Decrypts and authenticates an OAuth transaction state token.
 * Fails closed (returns null) on tampered data, wrong key, AAD mismatch, or expired timestamp.
 */
export async function decryptOAuthTransaction(
  token: string,
  rawKey: string | Uint8Array,
  context: {
    workspaceId: string
    platformAdapterKey: string
  },
): Promise<OAuthTransactionState | null> {
  if (!token || typeof token !== 'string') {
    return null
  }

  const parts = token.trim().split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null
  }

  try {
    const key = await importMasterKey(rawKey)
    const iv = base64UrlToBuffer(parts[0])
    const ciphertext = base64UrlToBuffer(parts[1])

    if (iv.byteLength !== OAUTH_STATE_IV_LENGTH) {
      return null
    }

    const aad = buildOAuthStateAad(context)

    const decryptedBuffer = await globalThis.crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv as unknown as BufferSource,
        additionalData: aad as unknown as BufferSource,
      },
      key,
      ciphertext as unknown as BufferSource,
    )

    const jsonStr = new TextDecoder().decode(decryptedBuffer)
    const parsed = JSON.parse(jsonStr) as OAuthTransactionState

    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.state !== 'string' ||
      typeof parsed.codeVerifier !== 'string' ||
      typeof parsed.workspaceId !== 'string' ||
      typeof parsed.accountId !== 'string' ||
      typeof parsed.platformAdapterKey !== 'string' ||
      typeof parsed.expiresAt !== 'string'
    ) {
      return null
    }

    // Tenant and context consistency checks
    if (
      parsed.workspaceId !== context.workspaceId ||
      parsed.platformAdapterKey.toLowerCase().trim() !==
        context.platformAdapterKey.toLowerCase().trim()
    ) {
      return null
    }

    // Expiration check
    const expiresAtMs = Date.parse(parsed.expiresAt)
    if (Number.isNaN(expiresAtMs) || Date.now() > expiresAtMs) {
      return null
    }

    return parsed
  } catch {
    return null
  }
}

/**
 * Timing-safe string comparison to protect against timing attacks on state / token validation.
 */
export function constantTimeCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false
  }

  const aLen = a.length
  const bLen = b.length
  let result = aLen === bLen ? 0 : 1

  const maxLen = Math.max(aLen, bLen)
  for (let i = 0; i < maxLen; i++) {
    const charA = i < aLen ? a.charCodeAt(i) : 0
    const charB = i < bLen ? b.charCodeAt(i) : 0
    result |= charA ^ charB
  }

  return result === 0
}
