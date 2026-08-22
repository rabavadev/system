export const DEFAULT_KEY_VERSION = 1
export const AES_GCM_IV_LENGTH = 12
export const MASTER_KEY_BYTE_LENGTH = 32

export interface CredentialAadContext {
  workspaceId: string
  accountId: string
  platformAdapterKey: string
  keyVersion: number
}

export function bufferToBase64(bytes: Uint8Array): string {
  let binary = ''
  const len = bytes.byteLength
  for (let i = 0; i < len; i++) {
    const byte = bytes[i]
    if (byte !== undefined) {
      binary += String.fromCharCode(byte)
    }
  }
  return btoa(binary)
}

export function base64ToBuffer(base64Str: string): Uint8Array {
  const clean = base64Str.trim().replace(/-/g, '+').replace(/_/g, '/')
  const padLen = (4 - (clean.length % 4)) % 4
  const padded = clean + '='.repeat(padLen)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export function hexToBuffer(hexStr: string): Uint8Array {
  const clean = hexStr.trim()
  if (clean.length % 2 !== 0) {
    throw new Error('Invalid hex string length.')
  }
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < clean.length; i += 2) {
    const val = Number.parseInt(clean.slice(i, i + 2), 16)
    if (Number.isNaN(val)) {
      throw new Error('Invalid hex character.')
    }
    bytes[i / 2] = val
  }
  return bytes
}

/**
 * Parses raw master key material into a 32-byte (256-bit) buffer.
 * Supports Uint8Array, base64, base64url, and 64-character hex strings.
 */
export function parseMasterKey(rawKey: string | Uint8Array): Uint8Array {
  if (!rawKey) {
    throw new Error('credential_vault_not_configured: Master key is empty.')
  }

  let keyBytes: Uint8Array
  if (rawKey instanceof Uint8Array) {
    keyBytes = rawKey
  } else if (typeof rawKey === 'string') {
    const trimmed = rawKey.trim()
    if (trimmed.length === 0) {
      throw new Error('credential_vault_not_configured: Master key is empty.')
    }
    try {
      if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
        keyBytes = hexToBuffer(trimmed)
      } else {
        keyBytes = base64ToBuffer(trimmed)
      }
    } catch {
      throw new Error('credential_vault_not_configured: Failed to parse master key encoding.')
    }
  } else {
    throw new Error('credential_vault_not_configured: Unsupported master key type.')
  }

  if (keyBytes.byteLength !== MASTER_KEY_BYTE_LENGTH) {
    throw new Error(
      `credential_vault_not_configured: Master key must be exactly ${MASTER_KEY_BYTE_LENGTH} bytes (got ${keyBytes.byteLength}).`,
    )
  }

  return keyBytes
}

/**
 * Imports a raw 256-bit master key into a Web Crypto CryptoKey for AES-GCM.
 */
export async function importMasterKey(rawKey: string | Uint8Array): Promise<CryptoKey> {
  const keyBytes = parseMasterKey(rawKey)
  return globalThis.crypto.subtle.importKey(
    'raw',
    keyBytes as unknown as BufferSource,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * Generates a cryptographically random 256-bit symmetric key encoded in base64.
 */
export function generateMasterKey(): string {
  const bytes = new Uint8Array(MASTER_KEY_BYTE_LENGTH)
  globalThis.crypto.getRandomValues(bytes)
  return bufferToBase64(bytes)
}

/**
 * Builds deterministic Authenticated Associated Data (AAD) for AES-GCM encryption.
 * Binds the ciphertext strictly to the workspace, account, platform, and key version.
 */
export function buildCredentialAad(ctx: CredentialAadContext): Uint8Array {
  const aadString = `oauth-credential:v1\nworkspace=${ctx.workspaceId}\naccount=${ctx.accountId}\nplatform=${ctx.platformAdapterKey.toLowerCase().trim()}\nkeyVersion=${ctx.keyVersion}`
  return new TextEncoder().encode(aadString)
}

export interface EncryptedTokenResult {
  ciphertext: string
  iv: string
}

/**
 * Encrypts a plaintext secret string using AES-GCM with a fresh CSPRNG IV and server-authoritative AAD.
 */
export async function encryptToken(
  plaintext: string,
  key: CryptoKey,
  aadContext: CredentialAadContext,
): Promise<EncryptedTokenResult> {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('Plaintext token must be a non-empty string.')
  }

  const iv = new Uint8Array(AES_GCM_IV_LENGTH)
  globalThis.crypto.getRandomValues(iv)

  const plaintextBytes = new TextEncoder().encode(plaintext)
  const aad = buildCredentialAad(aadContext)

  const ciphertextBuffer = await globalThis.crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv as unknown as BufferSource,
      additionalData: aad as unknown as BufferSource,
    },
    key,
    plaintextBytes as unknown as BufferSource,
  )

  return {
    ciphertext: bufferToBase64(new Uint8Array(ciphertextBuffer)),
    iv: bufferToBase64(iv),
  }
}

/**
 * Decrypts an AES-GCM ciphertext using the given CryptoKey and server-authoritative AAD.
 * Fails closed if ciphertext, IV, key, or AAD context has been modified.
 */
export async function decryptToken(
  ciphertextBase64: string,
  ivBase64: string,
  key: CryptoKey,
  aadContext: CredentialAadContext,
): Promise<string> {
  if (!ciphertextBase64 || !ivBase64) {
    throw new Error('Ciphertext and IV are required for decryption.')
  }

  let ciphertext: Uint8Array
  let iv: Uint8Array
  try {
    ciphertext = base64ToBuffer(ciphertextBase64)
    iv = base64ToBuffer(ivBase64)
  } catch {
    throw new Error('Failed to decode base64 ciphertext or IV.')
  }

  if (iv.byteLength !== AES_GCM_IV_LENGTH) {
    throw new Error(`Invalid IV length: expected ${AES_GCM_IV_LENGTH} bytes, got ${iv.byteLength}`)
  }

  const aad = buildCredentialAad(aadContext)

  const decryptedBuffer = await globalThis.crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: iv as unknown as BufferSource,
      additionalData: aad as unknown as BufferSource,
    },
    key,
    ciphertext as unknown as BufferSource,
  )

  return new TextDecoder().decode(decryptedBuffer)
}
