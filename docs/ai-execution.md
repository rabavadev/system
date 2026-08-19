# AI execution (STEP 6)

The single provider-neutral path from the application to any model:

```
feature code (e.g. Chat)
  → agent runtime (src/server/agents/reply.ts — generic since STEP 8)
  → Context Engine (src/server/context)      ← context ONLY from here
  → composer (src/server/ai/composer.ts)     ← ContextPackage → OUR messages
  → executeAI (src/server/ai/executor.ts)    ← timeout, retry, normalization
  → provider adapter (src/server/ai/providers/*)
  → model
```

No application code imports a provider SDK or the `Ai` binding directly.
The only modules that touch provider shapes are the adapters; the only
module that reads the Worker environment is `src/server/ai/runtime.ts`.

## The execution boundary

- **Request** (`AIExecutionRequest`, `src/server/ai/types.ts`): our types —
  execution id, agent ref (id + version), provider-neutral messages
  (`system|user|assistant`), model *strategy* (never a raw model id),
  generation settings, metadata. Deliberately not OpenAI/Anthropic/Gemini
  shapes.
- **Result** (`AIExecutionResult`): content, status, finishReason,
  provider, model, usage (input/output/total tokens when the provider
  reports them), latencyMs, attempts, and a typed error
  (`AIErrorCode`: not_configured, invalid_model_config,
  unsupported_execution_type, provider_unavailable, rate_limited, timeout,
  network, malformed_response, unknown). Failures never throw raw SDK
  errors and never invent content.
- **Execution types**: `direct_model` is implemented. `external_agent` and
  `router` are declared and return a controlled
  `unsupported_execution_type` failure — declared, not faked.

## Centralized policy (`src/server/ai/config.ts`)

- Strategy → provider/model mapping (`default`, `fast`, `reasoning`,
  `cheap`, `vision`). Business logic names a strategy; model ids live only
  here and may be overridden by env vars.
- Timeout: 30s per attempt, enforced with a real race — a hung provider
  cannot hang a Worker request.
- Retry: at most one extra attempt, only for `provider_unavailable`,
  `rate_limited`, `network`, with a fixed backoff. No component invents its
  own retry behavior; generation is not blindly repeated.

## Providers

### workers-ai (production path)

`src/server/ai/providers/workers-ai.ts`. Uses the `AI` binding
(`wrangler.jsonc`), so no API keys exist anywhere in code or D1. When
`AI_GATEWAY_ID` is set, requests route through **Cloudflare AI Gateway**
via the binding option `{ gateway: { id } }` — observability, caching, and
later routing/fallbacks at the gateway, zero credential sprawl.

### echo (offline local development only)

`src/server/ai/providers/echo.ts`. Deterministic, clearly-labeled stub so
the chat loop works without a Cloudflare account. Enable with
`AI_PROVIDER=echo` in `.dev.vars`. Never in production; its output says
what it is.

### Adding a provider

Implement `AIProviderAdapter` (see `types.ts` for the contract), register
it in `runtime.ts`, add strategy entries in `config.ts`. Nothing outside
`src/server/ai` changes.

## Environment / bindings

| Name | Where | Purpose |
|---|---|---|
| `AI` binding | wrangler.jsonc `ai` | Workers AI |
| `AI_PROVIDER` | var | `workers-ai` (default) or `echo` (local dev) |
| `AI_GATEWAY_ID` | var | optional; routes Workers AI through AI Gateway |
| `AI_MODEL_DEFAULT` | var | optional model id override for `default` |

For real local inference, `npm run dev` needs a Cloudflare account
(`wrangler login`) — Workers AI runs remotely even in local dev. Without
an account, use `AI_PROVIDER=echo`. First real call checklist:
`wrangler login` → send a chat message → confirm `ai.execution.completed`
on `/dev-context`.

## The agent runtime (STEP 8)

`src/server/agents/reply.ts` runs ONE direct-chat turn for any registry
agent: resolve agent (server-authoritative) → current immutable version →
Context Engine → composer → `executeAI` → persisted assistant message with
agent id + version + safe trace. `external_agent` and `router` agents fail
controlled ("not connected/enabled yet") — never faked.

## The Workspace Chief

Chief is the default built-in agent (`src/server/agents/chief.ts`, a thin
wrapper over the generic runtime): stable lookup by name/role per
workspace, created on first use, instructions versioned through
`agent_version` — shipping changed instructions rotates the version, so
every assistant message's `agent_version_id` still points at the exact
configuration that produced it. Chief has **no tools, no workflows, no
autonomy**: it reads context, reasons, recommends, replies, and says so
when asked to do something execution is not enabled for. The specialist
agents (Researcher, Strategist, Creator, Critic, Analytics, Publisher) use
the same machinery; see docs/agents.md.

Per send: user message persists → `buildContext` (conversation id + UI
selection; STEP 5 precedence unchanged) → composer renders the structured
context document (workspace, scope, brand/product/account, goals, verified
memory vs hypotheses, research with freshness, recent conversation,
current request) → `executeAI` → assistant message persists with
`agent_id`, `agent_version_id` and a safe `provider_metadata` trace
(execution id, provider, model, usage, latency, scope source, context
counts — never secrets).

## Traceability & idempotency

- `ai.execution.started/completed/failed` events (existing `event` table)
  carry the execution id, agent version, provider/model, usage, latency,
  error code, and the bounded context trace. No schema migration was
  needed: `message.provider_metadata` + `event.payload` already existed.
- The composer also stores a per-message trace summary, so "why did Chief
  say this" is answerable from the conversation row + event log.
- The client attaches a `clientRequestId` (uuid) per send; user and
  assistant messages record it. Retries/double-submits return the
  already-persisted result instead of executing twice.
- `/dev-context` (dev only) shows recent executions; production Chat UI
  never exposes provider/model internals.

## Not built yet (deliberately)

Streaming (the executor boundary is streaming-ready; chat uses one
request/response — no fake typing animation), external_agent/router
executors, tool calling, specialist agents, budget/cost accounting beyond
usage capture, semantic retrieval.
