import type { CloudflareBindings } from '~/types/env'

/**
 * Server-side environment boundary.
 *
 * Cloudflare bindings (env vars, and later D1/R2/Queues/Workflows/AI Gateway)
 * enter the application here. Server code receives the bindings object and
 * reads through this module instead of assuming globals, keeping adapters
 * testable and the surface explicit.
 *
 * Server-only: never import this module from client code.
 */
export function requireBinding<K extends keyof CloudflareBindings>(
  env: CloudflareBindings,
  key: K,
): NonNullable<CloudflareBindings[K]> {
  const value = env[key]
  if (value === undefined) {
    throw new Error(`Missing Cloudflare binding: ${String(key)}`)
  }
  return value as NonNullable<CloudflareBindings[K]>
}
