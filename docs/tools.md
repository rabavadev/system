# Tool Registry (STEP 9)

One controlled path for every agent action:

```
Agent
  → executeTool (src/server/tools/executor.ts)
  → registry lookup (stable key)
  → agent status + capability check (server-side)
  → tool status / configuration
  → input validation (zod, server-side)
  → approval gate (separate layer; no workflow yet)
  → tool adapter (src/server/tools/adapters/*)
  → output contract validation
  → structured ToolExecutionResult + safe tool.execution.* event
```

Agents never call `fetch`, D1 or a platform SDK directly. Provider-specific
function schemas (OpenAI/Anthropic/...) are generated later FROM our
definitions; they are never the canonical ToolDefinition.

## Definitions

`src/server/tools/definitions.ts` is the authoritative built-in registry:
stable keys, human names/descriptions, category, input schema, output
contract, required capability, risk set (`read`, `write`, `external`,
`sensitive`, `destructive`), execution mode, status, origin, version,
timeout and cost class. There is no D1 table yet on purpose: tools are
code-reviewed contracts and no user-configured tool data exists; persistence
can be added behind the registry later without changing `executeTool`.

Statuses: `available`, `disabled`, `needs_setup`, `unavailable`. Capability,
availability and approval are separate layers: declaring `publish` does not
make publishing available, and an available write tool can still return
`approval_required` before its adapter runs.

## Implemented tools (read-only, internal)

- `workspace.get_current_context` — safe current-context summary via the
  Context Engine (never a second context loader).
- `workspace.get_product` / `workspace.list_products`
- `workspace.get_account` / `workspace.list_accounts` — safe platform
  metadata only; never secrets or `secret_ref`.
- `memory.list_relevant` — Context Engine memory only: active, unexpired,
  non-superseded; proposed learning stays `hypothesis`.
- `research.list_relevant` — stored research only, with freshness; not live
  web research.

## Registered but not available

`analytics.read` is `needs_setup` (returns `not_configured`; never invents
metrics). `web.search`, `files.list`, `files.read`, `image.generate`,
`platform.get_posts`, `platform.get_analytics` and `platform.publish` are
declared with contracts/risk but `unavailable` — no fake search, no fake
files, no fake publish.

## Safety

- Unknown/disabled tools, missing capabilities, invalid input,
  cross-workspace or archived entities, missing adapters and timeouts return
  typed errors (`tool_not_found`, `tool_disabled`, `capability_denied`,
  `invalid_input`, `scope_denied`, `approval_required`, `not_configured`,
  `no_data`, `execution_failed`, `timeout`). No stack traces.
- Every execution has a UUID execution id and emits `tool.execution.completed`
  or `tool.execution.failed` with safe metadata only (ids, category, risk,
  capability, duration, safe argument summary). Secrets and raw external
  payloads are never stored.
- `getAvailableTools(caller)` is the discovery surface for a future AI
  tool-calling loop: active agents only, available+configured tools only,
  capability-filtered. Model tool calling is NOT enabled in STEP 9.

Tests: `npm run test:tools`.
