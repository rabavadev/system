# Project State

Maintained by the coding agent to prevent architecture drift.

## Canonical Sources

```text
Active app entry: src/routes/__root.tsx
Primary dashboard: src/routes/index.tsx → src/features/home/
Navigation: src/components/layout/nav-items.ts + topbar.tsx (shows active brand)
Auth: none yet — single seeded workspace
Current user: n/a; active brand via cookie (src/features/workspace/server.ts)
API client: per-feature server functions (src/features/*/server.ts)
Schema: migrations/0001–0012 + docs/database.md
Design system: Tailwind v4 + src/components/ui/
Shared components: src/components/ui/*, src/components/layout/*
```

## Active Major Features

| Feature | Canonical implementation | Notes |
|---|---|---|
| Workspaces | src/server/db (workspace), seed.sql | single default workspace |
| Brands | src/features/brands/ + src/server/db/brand.ts | active brand selection cookie in topbar |
| Niches | src/features/niches/ + src/server/db/niche.ts | belong to brand; primary-niche rules |
| Products | src/features/products/ + src/server/db/product.ts | owned by brand, grouped by niche |
| Accounts | src/features/accounts/ + src/server/db/account.ts | multi-niche via account_niche |
| Platforms | src/server/db/platform.ts | reference data |
| Relationship integrity | src/server/db/relations.ts | pure module, cross-brand/archived rules |
| Chat / conversations | src/features/chat/ + src/server/db/conversation.ts, message.ts | real workspace UI; /chat + /chat/:id; brand-scoped via cookie |
| Context Engine | src/server/context/ + src/server/db/context.ts | central buildContext(request); precedence explicit>conversation>ui>workspace; /dev-context inspector (dev only) |
| AI execution | src/server/ai/ | provider-neutral executeAI; Workers AI adapter (+ optional AI Gateway); echo stub for offline dev; docs/ai-execution.md |
| Workspace Chief | src/server/agents/chief.ts + src/server/db/agent.ts | built-in versioned agent; answers in Chat via Context Engine; no tools/autonomy yet |
| Tool Registry | src/server/tools/ + docs/tools.md | registered tool contracts, risk and capability enforcement |
| Workflows | src/server/workflows/ + docs/workflows.md | declarative, versioned, resumable workflow engine |
| Approval Policy | src/server/policy/ + src/server/db/policy.ts + docs/approval-policy.md | central resolver (auto/review/blocked), brand overrides, safe defaults, hard security invariants |
| Approval Requests | src/server/approval/ + src/server/db/approval.ts + docs/approval-requests.md | concrete action requests, safe snapshots, SHA-256 fingerprinting, deduplication, human authorization |
| Workflow Approvals Integration | src/server/workflows/engine.ts + policy.ts + docs/approval-requests.md | waiting flow on REVIEW policy, snapshot validation on resume, anti-loop authorization, cascade cancellation |
| Approval Center & Autonomy UX | src/features/approvals/ + src/features/settings/ | production UI for pending approvals, audit history, and policy management |
| Research Workspace & Lifecycle | src/features/research/ + src/server/db/research.ts | research storage, taxonomy (market, audience, competitor, etc.), derived freshness, scope validation |

## Legacy / Deprecated

| Item | Replacement | Consumers remaining | Removal status |
|---|---|---|---|
| Chat placeholder (FeatureScreen) | real chat workspace (STEP 4) | 0 | done |

## Architecture Decisions

| Decision | Why | Context/date |
|---|---|---|
| Scoped refs (scope_type/scope_id) not FKs | avoids join-table explosion; integrity in repository layer | docs/database.md, STEP 2 |
| Agent/workflow immutable versions | history never rewritten | STEP 2 |
| message.provider_metadata JSON | provider-agnostic conversation store | STEP 2 |
| Wire schemas isolated from repository schemas | cloudflare:workers client tree-shaking breakage | STEP 3 gotcha |
| Cookie-based active brand | survives navigation, no global state system | STEP 3 |
| Conversation scope via (scope_type, scope_id), no FK | consistent with scoped-reference doctrine; optional brand/product/account/campaign context | STEP 4, migration 0007 |
| Chat repositories take db as a parameter (structural SqlDatabase) | keeps cloudflare:workers out of the module so repositories run in plain node tests | STEP 4, src/server/db/sql.ts |
| Client send path fixes sender role server-side | clients cannot fabricate assistant/system messages | STEP 4 |
| One central Context Engine, provider-neutral | every future AI execution shares one context source; no per-agent context logic | STEP 5, docs/context-engine.md |
| Context repository is db-first (structural SqlDatabase) | whole context pipeline testable in plain node; no cloudflare:workers import | STEP 5, src/server/db/context.ts |
| Knowledge eligibility filtered in SQL, ranked in pure code | dead rows cannot starve the bounded candidate pool; trace samples explain exclusions | STEP 5 |
| AI execution trace in message.provider_metadata + event payloads | no migration needed; both columns existed since 0002/0006 | STEP 6 |
| Workers AI binding (not REST) as first provider | zero credentials in code/D1; AI Gateway via binding option | STEP 6 |
| clientRequestId idempotency on send | browser retries/double-submit never double-execute or double-persist | STEP 6 |
| Relative value imports in testable server modules | `~` alias only survives type-only imports under node --experimental-strip-types | STEP 6 |
| Policy model distinct from Approval Requests | Policy answers "what should happen for this action type", requests are individual pending rows | STEP 11A, migration 0010 |
| Deterministic policy precedence: Brand > Workspace > Risk > Safe Default | clear hierarchy with zero ambiguity or duplicate systems | STEP 11A, docs/approval-policy.md |
| Hard security invariants above user policy | "Auto" must never permit secret leakage or isolation bypass | STEP 11A, src/server/policy/security.ts |
| Immutable action snapshots + SHA-256 fingerprinting | guarantees that approved action parameters match proposed action exactly with zero secret leakage | STEP 11B, migration 0011 |
| Anti-self-approval gate | AI agents, Chief, and Tools cannot authorize requests; authority resides strictly with human user/system | STEP 11B, src/server/approval/service.ts |
| Pending request deduplication | prevents repeated duplicate approval rows for the same pending action and execution context | STEP 11B, src/server/approval/service.ts |
| Authorized approval authorization token on resume | indicates exact tool action approved by request ID + fingerprint to prevent re-entry loops without a global bypass flag | STEP 11C, src/server/workflows/engine.ts |
| Snapshot fingerprint verification before resume tool execution | protects against workflow input drift or tampering between request creation and resume | STEP 11C, src/server/workflows/engine.ts |
| Cascade cancellation of pending approvals on workflow cancel | prevents orphaned approval requests from resurrecting cancelled workflow runs | STEP 11C, src/server/workflows/engine.ts |

## Rejected Approaches

| Approach | Why rejected |
|---|---|
| AI-provider-specific message fields | violates model-agnostic rule |
| Integer rowids as public ids | leaks counts, merge-unsafe |

## Known Technical Debt

| Issue | Severity | Intended resolution |
|---|---|---|
| No auth/multi-user | medium | later step |
| R2/Workflows/Queues/AI Gateway in architecture only | low | future steps |

## Known Schema Limitations

| Issue | Impact | Options |
|---|---|---|
| `message` has no status field (pending/streaming/failed) | streaming UX will need one | add when AI execution lands, not before |

## Temporary Code

| Temporary item | Reason | Removal condition |
|---|---|---|
