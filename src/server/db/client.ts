import { env } from 'cloudflare:workers'

import { requireBinding } from '~/server/env'

/**
 * D1 access point. All database access in the app goes through this module
 * and the repositories that use it. Routes and components never touch D1.
 *
 * The SQL helpers live in `./sql` (no `cloudflare:workers` import) so
 * repositories can be tested outside the Worker; they are re-exported here
 * so existing repository imports keep working.
 */

export { execute, newId, nowIso, queryAll, queryFirst, withTransaction } from '~/server/db/sql'

/** The D1 database binding for this request's worker environment. */
export function getDb(): D1Database {
  return requireBinding(env, 'DB')
}
