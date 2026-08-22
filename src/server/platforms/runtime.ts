import type { PlatformSecretResolver } from './types.ts'

const VALID_SECRET_REF_PATTERN = /^[A-Za-z0-9_]+$/
const FORBIDDEN_PROPERTY_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Validates whether a secret reference identifier is safe and syntactically valid.
 */
export function isValidSecretRef(secretRef: string): boolean {
  if (!secretRef || typeof secretRef !== 'string') {
    return false
  }
  const trimmed = secretRef.trim()
  if (trimmed.length === 0 || trimmed.length > 128) {
    return false
  }
  if (FORBIDDEN_PROPERTY_KEYS.has(trimmed)) {
    return false
  }
  return VALID_SECRET_REF_PATTERN.test(trimmed)
}

/**
 * Creates a PlatformSecretResolver from a server environment object or runtime context.
 *
 * Checks in priority order:
 * 1. Explicitly provided server runtime environment / Cloudflare binding object
 * 2. Node.js process environment variables (for local development and CLI test environments)
 *
 * NEVER exposes secret enumeration (no listSecrets/dumpEnv methods).
 */
export function createEnvSecretResolver(
  runtimeEnv?: Record<string, unknown>,
): PlatformSecretResolver {
  return {
    resolveSecret(secretRef: string): string | null {
      if (!isValidSecretRef(secretRef)) {
        return null
      }
      const trimmedKey = secretRef.trim()

      // 1. Injected server runtime environment / Cloudflare binding dictionary
      if (runtimeEnv && typeof runtimeEnv === 'object') {
        if (Object.prototype.hasOwnProperty.call(runtimeEnv, trimmedKey)) {
          const val = runtimeEnv[trimmedKey]
          if (typeof val === 'string' && val.trim().length > 0) {
            return val.trim()
          }
        }
        return null
      }

      // 2. Node.js process environment fallback (for local tests and CLI scripts)
      const nodeProcess = (globalThis as Record<string, unknown>)['process'] as
        | { env?: Record<string, string | undefined> }
        | undefined
      if (nodeProcess?.env && typeof nodeProcess.env === 'object') {
        if (Object.prototype.hasOwnProperty.call(nodeProcess.env, trimmedKey)) {
          const val = nodeProcess.env[trimmedKey]
          if (typeof val === 'string' && val.trim().length > 0) {
            return val.trim()
          }
        }
      }

      return null
    },
  }
}
