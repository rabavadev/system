# server/ai

AI execution boundary. All model calls go through `executeAI` here so
providers are swappable; provider names appear nowhere else in the
codebase. Cloudflare AI Gateway fronts Workers AI when `AI_GATEWAY_ID` is
set.

- `types.ts` — provider-neutral request/result/usage/errors + adapter contract
- `config.ts` — model strategies, timeouts, retry policy (centralized)
- `composer.ts` — ContextPackage + instructions → provider-neutral messages
- `executor.ts` — dispatch, timeout race, controlled retries, normalization
- `runtime.ts` — the ONLY module reading Worker env/bindings
- `providers/` — one file per provider (workers-ai, echo dev stub)

See docs/ai-execution.md. Server-only code. Never import from client
bundles (`src/components`, `src/routes`, `src/features` UI files).
