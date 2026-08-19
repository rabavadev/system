# server/agents

Agent runtime. Agents receive context from the Context Engine, execute
models through the server/ai boundary, and are never tied to a provider.

- `definitions.ts` — built-in roster (Chief + specialists) and the shared
  base policy.
- `config.ts` — the one allowed shape of agent_version.config, with the
  secret guard.
- `registry.ts` — idempotent built-in provisioning, name policy, chat
  resolution (client picks an id; everything else is server-side).
- `reply.ts` — generic direct-chat execution for every direct_model agent:
  Context Engine → composer → AI execution → persisted reply.
- `chief.ts` — STEP 6 compatibility surface for the Workspace Chief (thin
  wrapper over the generic runtime).

Workflow execution and tool use are intentionally NOT built yet.

Server-only code. Never import from client bundles (`src/components`,
`src/routes`, `src/features` UI files).
