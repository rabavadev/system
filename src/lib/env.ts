/**
 * Client-safe environment access.
 *
 * Only `VITE_*` variables are exposed to the browser bundle. Server-only
 * configuration lives in `~/server/env` and must never be imported here.
 */

interface ClientEnv {
  appEnv: 'development' | 'staging' | 'production'
}

function readAppEnv(): ClientEnv['appEnv'] {
  // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket access
  const value = import.meta.env['VITE_APP_ENV']
  if (value === 'staging' || value === 'production') {
    return value
  }
  return 'development'
}

export const clientEnv: ClientEnv = {
  appEnv: readAppEnv(),
}
