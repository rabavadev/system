import type { SqlDatabase } from '../db/sql.ts'
import { driveRun, type WorkflowEngineDeps } from './engine.ts'

/**
 * Runtime adapter boundary (STEP 10 §33/§34).
 *
 * TWO layers stay separate:
 *
 *   Workflow Engine (engine.ts) — OUR domain semantics: definitions,
 *   validation, steps, transitions, agent/tool execution, persisted state.
 *   It knows nothing about Cloudflare.
 *
 *   WorkflowRuntime — HOW a run's drive loop is scheduled/resumed. The
 *   engine's state is persisted after every transition, so any runtime
 *   that can call driveRun(runId) later gives the same semantics.
 *
 * Cloudflare Workflows is the intended durable runtime, but the binding is
 * not configured in this environment, so no live Cloudflare execution is
 * claimed. The inline runtime below runs the SAME engine logic — there is
 * no second engine and no fake semantics. When a real Workflows binding is
 * added (wrangler.jsonc `workflows` + `npm run cf-typegen`), a
 * CloudflareWorkflowsRuntime can wrap driveRun in a Workflow entrypoint
 * without touching the engine.
 */

export interface WorkflowRuntime {
  readonly key: string
  /** Schedule/await execution of a persisted run. */
  drive(db: SqlDatabase, runId: string, deps: WorkflowEngineDeps): Promise<void>
}

/**
 * Inline runtime: drives the run inside the current request/Worker
 * invocation. Deterministic and used by both the manual UI and tests.
 */
export const inlineRuntime: WorkflowRuntime = {
  key: 'inline',
  async drive(db, runId, deps) {
    await driveRun(db, runId, deps)
  },
}

/** The active runtime. One place to swap when a durable runtime lands. */
export function resolveWorkflowRuntime(): WorkflowRuntime {
  return inlineRuntime
}
