const SECRET_KEY_PATTERN =
  /password|secret|token|credential|api_key|authorization|bearer|private_key|client_secret/i

/**
 * Standard synchronous SHA-256 implementation in pure TypeScript/JavaScript.
 * Platform-independent: works in Cloudflare Workers, Node.js, and browser runtimes.
 */
export function sha256Hex(ascii: string): string {
  function rightRotate(value: number, amount: number): number {
    return (value >>> amount) | (value << (32 - amount))
  }

  let i: number
  let j: number
  let result = ''

  const words: number[] = []

  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]

  const k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]

  const encoder = new TextEncoder()
  const bytes = encoder.encode(ascii)
  const byteLength = bytes.length
  const bitLength = byteLength * 8

  for (i = 0; i < byteLength; i++) {
    const currentByte = bytes[i] ?? 0
    words[i >> 2] = (words[i >> 2] ?? 0) | (currentByte << ((3 - (i % 4)) * 8))
  }
  words[byteLength >> 2] = (words[byteLength >> 2] ?? 0) | (0x80 << ((3 - (byteLength % 4)) * 8))
  words[(((byteLength + 8) >> 6) << 4) + 15] = bitLength

  for (i = 0; i < words.length; i += 16) {
    const w: number[] = []
    for (j = 0; j < 16; j++) {
      w[j] = words[i + j] ?? 0
    }
    for (j = 16; j < 64; j++) {
      const w15 = w[j - 15] ?? 0
      const w2 = w[j - 2] ?? 0
      const s0 = rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3)
      const s1 = rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10)
      w[j] = ((w[j - 16] ?? 0) + s0 + (w[j - 7] ?? 0) + s1) | 0
    }

    let a = hash[0] ?? 0
    let b = hash[1] ?? 0
    let c = hash[2] ?? 0
    let d = hash[3] ?? 0
    let e = hash[4] ?? 0
    let f = hash[5] ?? 0
    let g = hash[6] ?? 0
    let h = hash[7] ?? 0

    for (j = 0; j < 64; j++) {
      const s1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)
      const ch = (e & f) ^ (~e & g)
      const kj = k[j] ?? 0
      const wj = w[j] ?? 0
      const temp1 = (h + s1 + ch + kj + wj) | 0
      const s0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (s0 + maj) | 0

      h = g
      g = f
      f = e
      e = (d + temp1) | 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) | 0
    }

    hash[0] = ((hash[0] ?? 0) + a) | 0
    hash[1] = ((hash[1] ?? 0) + b) | 0
    hash[2] = ((hash[2] ?? 0) + c) | 0
    hash[3] = ((hash[3] ?? 0) + d) | 0
    hash[4] = ((hash[4] ?? 0) + e) | 0
    hash[5] = ((hash[5] ?? 0) + f) | 0
    hash[6] = ((hash[6] ?? 0) + g) | 0
    hash[7] = ((hash[7] ?? 0) + h) | 0
  }

  for (i = 0; i < 8; i++) {
    for (j = 3; j >= 0; j--) {
      const b = ((hash[i] ?? 0) >> (j * 8)) & 255
      result += (b < 16 ? '0' : '') + b.toString(16)
    }
  }

  return result
}

/**
 * Recursively cleans and sanitizes data to ensure no secrets, credentials,
 * or raw tokens ever enter approval snapshots or audit trails.
 */
export function sanitizeSnapshotValue(val: unknown, depth = 0): unknown {
  if (depth > 10) {
    return '[Truncated: Depth Limit]'
  }
  if (val === null || typeof val === 'undefined') {
    return null
  }
  if (typeof val === 'string') {
    // Redact if looks like a raw bearer token or key header
    if (val.length > 50 && /^(ey[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+|sk-[A-Za-z0-9]{20,})/i.test(val)) {
      return '[REDACTED_SECRET]'
    }
    return val
  }
  if (typeof val === 'number' || typeof val === 'boolean') {
    return val
  }
  if (Array.isArray(val)) {
    return val.map((item) => sanitizeSnapshotValue(item, depth + 1))
  }
  if (typeof val === 'object') {
    const cleaned: Record<string, unknown> = {}
    const keys = Object.keys(val as Record<string, unknown>).sort()
    for (const key of keys) {
      if (SECRET_KEY_PATTERN.test(key)) {
        cleaned[key] = '[REDACTED_SECRET]'
      } else {
        const propVal = (val as Record<string, unknown>)[key]
        if (
          typeof propVal !== 'undefined' &&
          typeof propVal !== 'function' &&
          typeof propVal !== 'symbol'
        ) {
          cleaned[key] = sanitizeSnapshotValue(propVal, depth + 1)
        }
      }
    }
    return cleaned
  }
  return String(val)
}

/**
 * Deterministically formats an object as canonical JSON with sorted keys
 * at every level.
 */
export function canonicalJsonStringify(val: unknown): string {
  const sanitized = sanitizeSnapshotValue(val)
  return JSON.stringify(sanitized)
}

/**
 * Creates an immutable, sanitized snapshot of proposed action parameters.
 */
export function createSafeActionSnapshot(payload: Record<string, unknown>): {
  snapshotJson: string
  sanitizedPayload: Record<string, unknown>
} {
  const sanitized = sanitizeSnapshotValue(payload) as Record<string, unknown>
  const snapshotJson = JSON.stringify(sanitized)
  return {
    snapshotJson,
    sanitizedPayload: sanitized,
  }
}

/**
 * Computes a deterministic SHA-256 fingerprint for the action key + snapshot.
 */
export function computeSnapshotFingerprint(actionKey: string, snapshotJson: string): string {
  return sha256Hex(`${actionKey}:${snapshotJson}`)
}

/**
 * Verifies that the stored snapshot JSON has not been tampered with
 * by recomputing the fingerprint.
 */
export function verifySnapshotIntegrity(
  actionKey: string,
  snapshotJson: string,
  expectedFingerprint: string,
): boolean {
  const computed = computeSnapshotFingerprint(actionKey, snapshotJson)
  return computed === expectedFingerprint
}
