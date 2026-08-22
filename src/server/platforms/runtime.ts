import type { PlatformSecretResolver } from './types.ts'

const VALID_SECRET_REF_PATTERN = /^[A-Za-z0-9_]+$/
const FORBIDDEN_PROPERTY_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Non-platform runtime bindings that must NEVER be reachable through platform secret resolution.
 */
export const RESERVED_RUNTIME_BINDINGS = new Set([
  'DB',
  'AI',
  'ASSETS',
  'BRAVE_SEARCH_API_KEY',
  'CLOUDFLARE_API_TOKEN',
  'DATABASE_URL',
  'SESSION_SECRET',
  'NODE_ENV',
  'VECTORIZE',
  'KV',
  'R2',
  'QUEUE',
])

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
  if (RESERVED_RUNTIME_BINDINGS.has(trimmed.toUpperCase())) {
    return false
  }
  return VALID_SECRET_REF_PATTERN.test(trimmed)
}

/**
 * Validates whether a secret reference identifier is strictly authorized for a given platform adapter.
 * Enforces positive allowlist pattern matching (e.g. PLATFORM_X_* or X_* for X adapter).
 */
export function isAdapterAuthorizedSecretRef(
  platformAdapterKey: string,
  secretRef: string,
): boolean {
  if (!isValidSecretRef(secretRef)) {
    return false
  }
  const upperRef = secretRef.toUpperCase().trim()
  if (RESERVED_RUNTIME_BINDINGS.has(upperRef)) {
    return false
  }

  const adapter = platformAdapterKey.toUpperCase().trim()
  const allowedPrefixes = [`PLATFORM_${adapter}_`, `${adapter}_`]
  if (adapter === 'X') {
    allowedPrefixes.push('PLATFORM_TWITTER_', 'TWITTER_')
  }

  return allowedPrefixes.some((prefix) => upperRef.startsWith(prefix))
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
        if (Object.hasOwn(runtimeEnv, trimmedKey)) {
          const val = runtimeEnv[trimmedKey]
          if (typeof val === 'string' && val.trim().length > 0) {
            return val.trim()
          }
        }
        return null
      }

      // 2. Node.js process environment fallback (for local tests and CLI scripts)
      // biome-ignore lint/complexity/useLiteralKeys: required by tsconfig noPropertyAccessFromIndexSignature
      const nodeProcess = (globalThis as Record<string, unknown>)['process'] as
        | { env?: Record<string, string | undefined> }
        | undefined
      if (nodeProcess?.env && typeof nodeProcess.env === 'object') {
        if (Object.hasOwn(nodeProcess.env, trimmedKey)) {
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
