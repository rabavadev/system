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
Schema: migrations/0001–0023 + docs/database.md
Design system: Tailwind v4 + src/components/ui/
Shared components: src/components/ui/*, src/components/layout/*
```

## Active Major Features

| Feature | Canonical implementation | Notes |
|---|---|---|
| Workspaces | src/server/db (workspace), seed.sql | single default workspace |
| Brands | src/features/brands/ + src/server/db/brand.ts | active brand selection cookie in topbar |
| Niches | src/features/niches/ + src/server/db/niche.ts | belong to brand; primary-niche rules; first-class conversation scope (H3B.1) |
| Products | src/features/products/ + src/server/db/product.ts | owned by brand, grouped by niche |
| Accounts | src/features/accounts/ + src/server/db/account.ts | multi-niche via account_niche; platform derivation for content; active status lifecycle enforcement |
| Platforms | src/server/db/platform.ts | reference data |
| Relationship integrity | src/server/db/relations.ts | pure module, cross-brand/archived rules |
| Chat / conversations | src/features/chat/ + src/server/db/conversation.ts, message.ts | real workspace UI; /chat + /chat/:id; brand/niche/product/account/campaign scoped |
| Context Engine | src/server/context/ + src/server/db/context.ts | central buildContext(request); precedence explicit>conversation>ui>workspace; /dev-context inspector |
| AI execution | src/server/ai/ | provider-neutral executeAI; Workers AI adapter (+ optional AI Gateway); echo stub for offline dev; docs/ai-execution.md |
| Tool Registry & Engine | src/server/tools/ + docs/tools.md | capability checks, approval gates, input/output validation, safe event logging, strict tool protocol (H2A/H2A.1) |
| Web Search Tool | src/server/tools/adapters/web-search.ts | Brave search provider adapter, prompt injection sanitization (H1A, H2A, H2B) |
| Agent Registry | src/server/agents/ + docs/agents.md | 7 built-in agents (Chief, Researcher, Strategist, Creator, Critic, Analytics, Publisher), immutable versions |
| Workflows | src/server/workflows/ + docs/workflows.md | declarative, versioned, resumable workflow engine with exact scope integrity (H3B.2, migration 0018) |
| Approval Policy & Requests | src/server/policy/ + src/server/approval/ | auto/review/blocked policies, immutable snapshots, SHA-256 fingerprinting, deduplication, human authorization (H1B) |
| Research Workspace & Lifecycle | src/features/research/ + src/server/db/research.ts | research storage, taxonomy, freshness derivation, exact source citation & server provenance (H3A.2) |
| Campaigns & Strategy | src/features/campaigns/ + src/server/db/campaign.ts | objectives, angles, hypotheses, targets with canonical metric validation (H4A, migration 0013) |
| Canonical Metrics Registry | src/server/db/metric.ts + docs/database.md | metric_definition single source of truth; 12 built-in metrics + workspace custom metrics; dynamic validation (H4A) |
| Creator Draft Studio (Step 15A) | src/features/campaigns/ + src/server/db/content-variant.ts | draft candidate lifecycle (`content_draft_candidate`), platform derivation, human edit hash tracking (H3A.1, migration 0016) |
| Critic Editorial Reviews (Step 15B) | src/server/db/content-review.ts + src/features/campaigns/ | human-triggered AI critique on saved immutable variants; server-authoritative `content_review_candidate` lifecycle; structured `pass`/`revise` verdicts; immutable `content_review` (migrations 0015, 0021) |
| Creator Revisions (Step 15C) | src/server/db/content-variant.ts + src/server/agents/content-draft.ts | human-controlled revisions from Critic feedback; `source_variant_id` & `source_review_id` candidate lineage; immutable variant chains (migration 0019) |
| Content Editorial Approval (Step 15D) | src/server/db/content-approval.ts + src/features/campaigns/ | explicit human editorial gate; `content.status = 'ready'`; `content.selected_variant_id`; immutable `content_approval` audit history; strict server-side Critic override enforcement; zero auto-publishing (migration 0020) |
| Publication Foundation & Readiness (Step 15E.1 / 15E.1.1) | src/server/db/post.ts + src/features/campaigns/ | server-authoritative publication intent (`post` table); binds exact approved `content_variant_id` to exact active `account_id` and `content_approval_id`; `workspace_id NOT NULL`; active intent unique index; request-bound idempotency; full pre-dispatch eligibility validation; zero external network calls; platform publish tool remains `unavailable` and Publisher agent remains `disabled` (migrations 0022, 0023) |

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
- **Step 12 — Research Workspace**: Research taxonomy, freshness, sources (migration 0012).
- **Step 13 — Campaign Orchestration**: Multi-channel campaign management.
- **Step 14 — Campaign Strategy & Variants**: Strategy fields, targets, content plan (migrations 0013, 0014).
- **Step 15A — Creator Draft Studio**: Draft candidate generation, platform derivation, hash tracking (migration 0016).
- **Step 15B — Critic Editorial Reviews**: Structured review contract (`pass`/`revise`), immutable variant evaluation (migration 0015).
- **Step 15C — Creator Revisions**: Human-controlled Creator revisions from Critic review feedback with lineage links (migration 0019).
- **Step 15D — Human Content Approval & Readiness**: Human editorial gate, `selected_variant_id`, readiness status, revocation (migration 0020).
- **HARDENING H1A**: Authoritative Web Search Runtime Configuration and Agent Wiring.
- **HARDENING H1B / H1B.1 / H1B.2**: Tool loop protocol, strict error mapping, policy semantics, event integrity.
- **HARDENING H2A / H2A.1**: Tool JSON Schema conversion, provider-neutral loop, strict Workers AI tool protocol.
- **HARDENING H2B**: Content sanitization, prompt injection defense, `<external_untrusted_data>` framing.
- **HARDENING H3A.1**: Creator draft candidate lifecycle, edit tracking, server-derived provenance.
- **HARDENING H3A.2**: Research source citation integrity, server-derived provenance, exact-turn deduplication.
- **HARDENING H3B.1**: First-class Niche scope integrity in conversations (migration 0017).
- **HARDENING H3B.2**: Exact generic workflow run scope integrity (migration 0018).
- **HARDENING H4A**: Canonical metrics registry (`metric_definition`), dynamic campaign target validation.
- **HARDENING H4A.1**: Architecture documentation synchronization across migrations 0001–0020.
- **HARDENING H4B / H4B.1**: Local Worker Runtime verified; automated browser E2E session suite not configured (NOT TESTED).
- **HARDENING P1 / P1.1**: Server-authoritative Critic review candidate architecture (`content_review_candidate`, migration 0021), strict Zod parsing with zero fallback fabrication, deterministic sorting on timestamp ties, and strict server-side Critic editorial override enforcement.
- **STEP 15E.1 — Publication Foundation & Server-Authoritative Dispatch Readiness**: Server-authoritative `post` record creation, eligibility verification, idempotency handling, safe event emission (`publication.prepared`), and audit logging (migration 0022).
- **HARDENING 15E.1.1 — Publication Integrity Closure Before External Adapters**: Rebuilt `post` table with `workspace_id NOT NULL REFERENCES workspace(id) ON DELETE RESTRICT` (migration 0023), backfilled legacy posts, removed all NULL-workspace query wildcards, enforced `account.status === 'active'` (rejecting paused/archived/deleted accounts), derived Campaign identity strictly from Content, hardened pre-dispatch eligibility to verify current approval lineage and post status (`draft`/`scheduled` only), enforced request-bound idempotency conflict rejection, and established database partial unique index `idx_post_active_intent`.
- **HARDENING 15E.1.2 — Close Publication Lineage + Read-Isolation Gaps**: Hardened pre-dispatch validation for legacy posts without approval lineage (`content_approval_id = NULL`), verified append-only approval semantics (revocation inserts a new row and leaves prior approval rows untouched, invalidating old posts), enforced human-authoritative approval requirements (`actor_type === 'user'`), ensured tenant isolation across all joined entities in Post read queries (`a.workspace_id = p.workspace_id`, `ca.workspace_id = p.workspace_id`, `cmp.workspace_id = p.workspace_id`), server-derived current post eligibility and dispatch statuses (`isCurrentlyEligible`, `dispatchStatus`), and updated UI to determine publication readiness from live server eligibility.
- **STEP 15E.2**: Platform connectors / external publishing execution (FUTURE PHASE).

## Content Lifecycle & Publishing Boundary

```text
Campaign Content Item (draft)
  → Creator Draft Candidate (content_draft_candidate: uncommitted, server-derived provenance)
  → Human Reviews & Saves Variant (content_variant: immutable V1, tracks human_edited hash diff)
  → Critic Review Candidate (content_review_candidate: uncommitted, server-derived provenance, SHA-256 review_hash)
  → Human Reviews & Saves Review (content_review: immutable critique, verdict pass | revise, strictly server-derived)
  → [Optional] Human Triggers Creator Revision (content_draft_candidate with source lineage)
  → [Optional] Human Reviews & Saves Revised Variant (content_variant: immutable V2, parent_variant_id = V1)
  → Human Final Editorial Approval (content_approval: approved, content.status = 'ready', content.selected_variant_id = variant_id)
  → Server-Authoritative Publication Preparation (post: status = 'draft' | 'scheduled', external_id = null, url = null, published_at = null, content_approval_id linked)
  → [Optional] Human Revocation (content_approval: revoked, content.status = 'draft', content.selected_variant_id = null, subsequent publication validation fails)
```

### Critical Invariants:
1. **READY != PUBLISHED**: Marking content as `ready` is an internal editorial status signifying approval. It performs **ZERO** external network calls, interacts with **NO** platform APIs, and schedules **NO** automated publishing jobs.
2. **PREPARED POST != EXTERNALLY SENT**: A `post` record in `draft` status is an internal publication intent linked to the exact approved variant, target account, and approval audit ID. All external fields (`external_id`, `url`, `published_at`) remain `NULL`.
3. **Publisher Agent Status**: The `Publisher` agent is explicitly `disabled` (`status: 'disabled'`).
4. **Platform Publish Tool**: The `platform.publish` tool is an unavailable stub (`Not available yet`, `status: 'unavailable'`).
5. **Human Primacy & Server-Authoritative Override**: Critic verdict `pass` never auto-approves content. Critic verdict `revise` strictly blocks approval on the server unless the human operator explicitly provides `overrideCritic: true` (`critic_override = 1`). Notes are documentation only and do not authorize approval.

## Approval System Disambiguation

The architecture contains two distinct approval subsystems that serve separate purposes:

1. **Tool / Workflow Approval Policy (`approval_policy`, `approval_request`)**:
   - Modes: `auto`, `review`, `blocked`.
   - Governs sensitive agent and workflow tool executions (e.g. `web.search`, `workflow.run`, external writes).
   - Generates approval requests with action snapshots, SHA-256 fingerprinting, and resume tokens.
2. **Human Content Editorial Approval (`content_approval`, `selected_variant_id`, `content.status = 'ready'`)**:
   - Governs editorial readiness of content variants for campaign publishing.
   - Binds to an exact immutable `content_variant` row and updates `content.status` to `'ready'` (or back to `'draft'` on revocation).
   - Records an append-only audit trail in `content_approval`.

## Truthful Verification Status

| Capability / Runtime Area | Verification Status | Notes |
|---|---|---|
| Unit & Integration Tests (22 suites) | **VERIFIED** | All automated tests run and pass in local Node / SQLite environment |
| Database Migrations (0001–0023) | **VERIFIED** | Verified through `npm run db:test` (23/23 tests pass) |
| Context Engine & Ranking | **VERIFIED** | Verified through `npm run test:context` |
| Policy & Approval Engine | **VERIFIED** | Verified through `npm run test:policy`, `test:approvals`, `test:approvals-ux` |
| Campaign Strategy & Metrics | **VERIFIED** | Verified through `npm run test:campaign-strategy`, `test:campaigns` |
| Content Candidate Lifecycle | **VERIFIED** | Verified through `npm run test:creator-draft` |
| Critic Editorial Review System | **VERIFIED** | Verified through `npm run test:critic-review` (candidate architecture, strict Zod parsing, server-authoritative save) |
| Creator Revision Lineage System | **VERIFIED** | Verified through `npm run test:creator-revision` |
| Human Content Approval Gate | **VERIFIED** | Verified through `npm run test:content-approval` (strict server-side override enforcement) |
| Publication Foundation & Integrity | **VERIFIED** | Verified through `npm run test:publication` (exact approved variant binding, account/platform match, request-bound idempotency, post status guard, reapproval lineage isolation, zero external calls) |
| Research Source Provenance | **VERIFIED** | Verified through `npm run test:research` |
| Workflow Run Scope Integrity | **VERIFIED** | Verified through `npm run test:workflows` |
| Local Workers Runtime & Vite Build | **VERIFIED** | Verified through `npm run build` and local development server |
| Workers AI Live Remote Generation | **NOT CONFIGURED** | Offline Echo / test adapter used in automated suites; live Workers AI binding requires Cloudflare deployment |
| Workers AI Live Tool Calling | **NOT CONFIGURED** | Protocol implemented & unit tested; live remote tool execution requires Cloudflare deployment |
| Brave Live Web Search | **NOT CONFIGURED** | Adapter implemented & mock-tested; live remote API calls require `BRAVE_SEARCH_API_KEY` |
| Real Model → Search → Model | **NOT CONFIGURED** | Protocol implemented & offline tested; requires live Workers AI and Brave API keys |
| Browser End-to-End Sessions | **NOT TESTED** | automated browser E2E session suite not configured in local agent environment |

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
| Immutable variant revision lineage | Creator revisions track `source_variant_id` and `source_review_id` without mutating prior variants | STEP 15C, migration 0019 |
| Human editorial gate for publish readiness | explicit human sign-off on exact variant ID; separates readiness from automated publishing | STEP 15D, migration 0020 |
| Server-authoritative Critic review candidates & override enforcement | Critic reviews derive verdict, review JSON, provenance strictly from database candidates (`content_review_candidate`); server strictly enforces `overrideCritic: true` for revise reviews | HARDENING P1, migration 0021 |
| Server-authoritative publication intent with post table | binds exact immutable approved variant to account & approval; enforces ready eligibility pre-dispatch; prevents client forgery of status/urls/ids | STEP 15E.1, migration 0022 |
| Post table rebuild with NOT NULL workspace_id, active intent unique index, and lineage integrity | eliminates NULL-workspace security hazards, enforces active account state, server campaign derivation, post status guards, and approval lineage tracking | HARDENING 15E.1.1, migration 0023 |

## Known Technical Debt & Limitations

| Issue | Severity | Intended resolution |
|---|---|---|
| No auth/multi-user | medium | post-hardening phase |
| Remote Cloudflare Workflows binding | low | currently uses inline runtime; binding can be attached in Cloudflare |
| Live API keys (Brave, Workers AI remote) | low | configured via environment variables in `.dev.vars` / Cloudflare secrets |
