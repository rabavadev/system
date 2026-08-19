// Note: relative value imports (not the `~` alias) so this module runs in
// plain node tests via --experimental-strip-types, same as the other
// server modules. Type-only imports may use the alias; they are stripped.

import type { ExecuteAIDeps } from '../ai/executor.ts'
import type { SqlDatabase } from '../db/sql.ts'
import { CHIEF_INSTRUCTIONS_V1, CHIEF_NAME, CHIEF_ROLE } from './definitions.ts'
import { type AgentHandle, ensureBuiltinAgents } from './registry.ts'
import { type AgentReply, runAgentReply } from './reply.ts'

/**
 * The Workspace Chief — the primary AI the user talks to in Chat.
 *
 * Since STEP 8, Chief is one member of the shared Agent Registry: it is
 * provisioned, versioned and executed by the same machinery as every
 * specialist (see registry.ts and reply.ts). This module keeps the STEP 6
 * surface stable for existing callers and tests.
 *
 * Chief has no tools, no workflows, and no autonomy: it reads context,
 * reasons, recommends, and replies. Anything beyond that is a later step
 * and Chief says so instead of pretending.
 */

export { CHIEF_INSTRUCTIONS_V1, CHIEF_NAME, CHIEF_ROLE }

export type ChiefAgentHandle = AgentHandle

/**
 * Load the built-in Chief for a workspace, creating it (and rotating its
 * version when the shipped instructions changed) on first use. Idempotent.
 */
export async function ensureChiefAgent(
  db: SqlDatabase,
  workspaceId: string,
): Promise<ChiefAgentHandle> {
  const builtins = await ensureBuiltinAgents(db, workspaceId)
  const chief = builtins.get(CHIEF_ROLE)
  if (!chief) {
    throw new Error('Built-in Chief definition is missing.')
  }
  return chief
}

export interface ChiefReplyInput {
  db: SqlDatabase
  workspaceId: string
  conversationId: string
  /** The user message that triggered this reply (already persisted). */
  userText: string
  /** Current UI selection; weaker than the conversation's persisted scope. */
  uiBrandId?: string | null
  /** Client-generated idempotency key (prevents duplicate executions). */
  clientRequestId?: string
  /** Test seam: inject adapters instead of the Worker runtime. */
  deps: ExecuteAIDeps
}

export type ChiefReply = AgentReply

/**
 * Run one Chief turn. Equivalent to runAgentReply with no explicit agent:
 * the registry resolves the default (Chief) and the shared runtime does
 * Context Engine → composer → AI execution → persisted assistant message.
 */
export async function runChiefReply(input: ChiefReplyInput): Promise<ChiefReply> {
  return runAgentReply({ ...input, agentId: null })
}
