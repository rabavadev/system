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
Schema: migrations/0001–0007 + docs/database.md
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
