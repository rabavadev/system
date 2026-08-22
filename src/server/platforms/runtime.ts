import type { PlatformSecretResolver } from './types.ts'

/**
 * Creates a PlatformSecretResolver from an environment object or runtime context.
 *
 * Checks in order:
 * 1. Explicitly provided custom environment dictionary (for tests and isolated callers)
 * 2. Process environment variables (for local development and CLI environments)
 */
export function createEnvSecretResolver(
  customEnv?: Record<string, unknown>,
): PlatformSecretResolver {
  return {
    resolveSecret(secretRef: string): string | null {
      if (!secretRef || typeof secretRef !== 'string') {
        return null
      }
      const trimmedKey = secretRef.trim()
      if (trimmedKey.length === 0) {
        return null
      }

      // 1. Injected custom environment
      if (customEnv && typeof customEnv === 'object') {
        const val = customEnv[trimmedKey]
        if (typeof val === 'string' && val.trim().length > 0) {
          return val.trim()
        }
      }

      // 2. Process environment variables (Node / test / local dev)
      // Access via globalThis cast to avoid requiring @types/node in the tsconfig
      // (this file is server-only; it never runs in the browser)
      const nodeProcess = (globalThis as Record<string, unknown>)['process'] as
        | { env?: Record<string, string | undefined> }
        | undefined
      if (nodeProcess?.env) {
        const val = nodeProcess.env[trimmedKey]
        if (typeof val === 'string' && val.trim().length > 0) {
          return val.trim()
        }
      }

      return null
    },
  }
}
