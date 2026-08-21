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
Schema: migrations/0001–0018 + docs/database.md
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
| Chat / conversations | src/features/chat/ + src/server/db/conversation.ts, message.ts | real workspace UI; /chat + /chat/:id; brand/niche/product/account/campaign scoped |
| Context Engine | src/server/context/ + src/server/db/context.ts | central buildContext(request); precedence explicit>conversation>ui>workspace; /dev-context inspector |
| AI execution | src/server/ai/ | provider-neutral executeAI; Workers AI adapter (+ optional AI Gateway); echo stub for offline dev; docs/ai-execution.md |
| Tool Registry & Engine | src/server/tools/ + docs/tools.md | capability checks, approval gates, input/output validation, safe event logging |
| Web Search Tool | src/server/tools/adapters/web-search.ts | Brave search provider adapter, prompt injection sanitization (H2A/H2B) |
| Agent Registry | src/server/agents/ + docs/agents.md | 7 built-in agents (Chief, Researcher, Strategist, Creator, Critic, Analytics, Publisher), immutable versions |
| Workflows | src/server/workflows/ + docs/workflows.md | declarative, versioned, resumable workflow engine with exact scope integrity (H3B.2) |
| Approval Policy & Requests | src/server/policy/ + src/server/approval/ | auto/review/blocked policies, immutable snapshots, SHA-256 fingerprinting, deduplication, human authorization |
| Research Workspace & Lifecycle | src/features/research/ + src/server/db/research.ts | research storage, taxonomy, freshness derivation, exact source citation & provenance (H3A.2) |
| Campaigns & Strategy | src/features/campaigns/ + src/server/db/campaign.ts | objectives, angles, hypotheses, targets with canonical metric validation (H4A) |
| Canonical Metrics Registry | src/server/db/metric.ts + docs/database.md | metric_definition single source of truth; 12 built-in metrics + workspace metrics |
| Content Engine & Studio | src/features/campaigns/ + src/server/db/content.ts | drafts, candidate lifecycle (H3A.1), variants, platform derivation, human edit hash tracking |
| Critic Reviews (Step 15B) | src/server/db/content.ts + src/features/campaigns/ | automated/interactive AI critique; content_review rows; pending dedicated final audit |

## Completed Steps & Hardening Sequence

- **Step 1 — Foundation & Monorepo Setup**: TanStack Start, Cloudflare Workers, Tailwind v4.
- **Step 2 — Schema Architecture**: D1 migrations 0001–0006.
- **Step 3 — Core Entities**: Workspaces, Brands, Niches, Products, Accounts, Platforms.
- **Step 4 — Chat & Conversation Scope**: Real conversation UI, scoped conversations (migration 0007).
- **Step 5 — Context Engine**: Unified retrieval, ranking, freshness, /dev-context inspector.
- **Step 6 — AI Execution Layer**: Provider-neutral executor, Workers AI adapter, Echo dev stub.
- **Step 7 — Workspace Chief**: Default orchestrator & advisor agent.
- **Step 8 — Agent Registry**: Multi-agent roster, versioning, immutable snapshots.
- **Step 9 — Tool Registry**: Safe capability-gated internal tool execution.
- **Step 10 — Workflow Engine**: Resumable multi-step workflows (migration 0009).
- **Step 11 — Approval System**: Policy engine, approval requests, anti-loop resume tokens (migrations 0008, 0010, 0011).
- **Step 12 — Research Workspace**: Research taxonomy, freshness, sources (migration 0011).
- **Step 13 — Campaign Orchestration**: Multi-channel campaign management (migration 0012).
- **Step 14 — Campaign Strategy & Variants**: Strategy fields, targets, content variants (migration 0013).
- **Step 15 — Creator & Critic Studio**: Draft generation, candidate lifecycle, reviews (migrations 0014–0016).
- **HARDENING H1A**: Execution Trace & Status Normalization.
- **HARDENING H1B / H1B.1 / H1B.2**: Tool loop protocol, strict error mapping, event integrity.
- **HARDENING H2A / H2A.1**: Web search runtime tooling, Brave search adapter, contract hardening.
- **HARDENING H2B**: Content sanitization, prompt injection defense, untrusted data framing.
- **HARDENING H3A.1**: Content draft candidate lifecycle, edit tracking, account platform derivation.
- **HARDENING H3A.2**: Research source citation integrity, server-derived provenance, exact-turn deduplication.
- **HARDENING H3B.1**: Niche scope integrity in conversations (migration 0017).
- **HARDENING H3B.2**: Exact workflow run scope integrity (migration 0018).
- **HARDENING H4A**: Canonical metrics registry (`metric_definition`) & architecture documentation repair.
- **HARDENING H4B**: Runtime verification & environment readiness (PENDING).
- **STEP 15B Final Audit**: Dedicated post-hardening audit of Critic review system (PENDING).

## Truthful Verification Status

| Capability / Runtime Feature | Verification Status | Notes |
|---|---|---|
| Unit & Integration Tests (19 suites) | **VERIFIED** | All automated tests run and pass in local Node / SQLite environment |
| Database Migrations (0001–0018) | **VERIFIED** | Verified through `npm run db:test` |
| Context Engine & Ranking | **VERIFIED** | Verified through `npm run test:context` |
| Policy & Approval Engine | **VERIFIED** | Verified through `npm run test:policy`, `test:approvals`, `test:approvals-ux` |
| Campaign Strategy & Metrics | **VERIFIED** | Verified through `npm run test:campaign-strategy`, `test:campaigns` |
| Content Candidate Lifecycle | **VERIFIED** | Verified through `npm run test:creator-draft` |
| Research Source Provenance | **VERIFIED** | Verified through `npm run test:research` |
| Workflow Run Scope Integrity | **VERIFIED** | Verified through `npm run test:workflows` |
| Workers AI Live Tool Calling | **NOT VERIFIED** | Protocol implemented & unit tested; live remote tool-calling execution pending H4B |
| Brave Live Web Search | **NOT VERIFIED** | Adapter implemented & mock-tested; live remote API calls pending H4B |
| Cloudflare Deployed Runtime Smoke | **NOT VERIFIED** | Local Workers runtime verified; remote production deploy pending H4B |
| Browser End-to-End Smoke | **NOT VERIFIED** | Component & server function tests verified; full browser E2E pending H4B |
| STEP 15B Final Dedicated Audit | **PENDING** | Review system implemented & tested; scheduled after H4B |

## Architecture Decisions

| Decision | Why | Context/date |
|---|---|---|
| Scoped refs (scope_type/scope_id) not FKs | avoids join-table explosion; integrity in repository layer | docs/database.md, STEP 2 |
| Agent/workflow immutable versions | history never rewritten | STEP 2 |
| message.provider_metadata JSON | provider-agnostic conversation store | STEP 2 |
| Wire schemas isolated from repository schemas | cloudflare:workers client tree-shaking breakage | STEP 3 gotcha |
| Cookie-based active brand | survives navigation, no global state system | STEP 3 |
| Conversation scope via (scope_type, scope_id), no FK | consistent with scoped-reference doctrine; supports brand, niche, product, account, campaign | STEP 4, migrations 0007, 0017 |
| Workflow run exact scope via (scope_type, scope_id) | eliminates fuzzy JSON substring queries; guarantees exact scope isolation and composite index optimization | H3B.2, migration 0018 |
| Canonical metric registry via `metric_definition` table | single authoritative metric source; removed duplicate enum schemas | H4A |
| Chat repositories take db as a parameter (structural SqlDatabase) | keeps cloudflare:workers out of the module so repositories run in plain node tests | STEP 4, src/server/db/sql.ts |
| Client send path fixes sender role server-side | clients cannot fabricate assistant/system messages | STEP 4 |
| One central Context Engine, provider-neutral | every future AI execution shares one context source; no per-agent context logic | STEP 5, docs/context-engine.md |
| Untrusted external content framing | all external/web/tool inputs wrapped in `<external_untrusted_data>` markers to prevent prompt injection | H2B |
| Candidate draft lifecycle with hash comparison | enables tracking whether human modified AI-generated text before saving as variant | H3A.1, migration 0016 |
| Server-derived research provenance | research sources derive author, model, execution id from server message context rather than client | H3A.2 |

## Known Technical Debt & Limitations

| Issue | Severity | Intended resolution |
|---|---|---|
| No auth/multi-user | medium | post-hardening phase |
| Remote Cloudflare Workflows binding | low | currently uses inline runtime; binding can be attached in Cloudflare |
| Live API keys (Brave, Workers AI remote) | low | configured via environment variables in `.dev.vars` / Cloudflare secrets |

