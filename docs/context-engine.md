# Context Engine

The ONE shared context source for every future AI execution (Workspace
Chief, specialist agents, direct models, routers, workflows). Callers ask
for context; nobody assembles repository queries by hand.

```ts
import { buildContext } from '~/server/context'

const pkg = await buildContext(getDb(), {
  conversationId,          // any subset of identifiers
  uiSelection: { brandId },
  task: { text: '...' },
})
```

No AI provider is involved. The package contains OUR types only; a future
provider adapter turns it into a prompt. There is deliberately no
`toPrompt()` here.

## Layout

```
src/server/context/
  index.ts      public surface (buildContext, types, errors, limits)
  types.ts      ContextRequest / ContextPackage / ContextTrace (serializable)
  config.ts     ALL retrieval limits live here (DEFAULT_CONTEXT_LIMITS)
  errors.ts     ContextError with typed codes, user-safe messages
  freshness.ts  pure freshness derivation
  ranking.ts    pure deterministic ranking
  scope.ts      pure relationship validation + precedence
  engine.ts     orchestration
src/server/db/context.ts   focused read queries (structural SqlDatabase)
```

Precedence/ranking/freshness/validation are pure functions; the engine and
repository take a structural `SqlDatabase`, so everything is tested under
plain node (`npm run test:context`) with the same SQL the Worker runs.

## The four context sources (NOT the same thing)

1. **explicit request** — ids passed by the caller
2. **persisted conversation scope** — `conversation.scope_type/scope_id`
3. **current UI selection** — the active-brand cookie, passed in as
   `uiSelection`
4. **workspace default** — no scope at all

Precedence is deterministic: **explicit > conversation > ui > workspace**.

- Explicit context wins, but must be *compatible* with a persisted
  conversation scope; a contradiction is a `conversation_mismatch` error,
  never a silent override.
- Changing the UI brand never mutates a conversation's persisted scope.
- The UI brand is used only when nothing stronger exists, and only if it
  is a live brand in the resolved workspace.

## Scope resolution and conflicts

Hierarchy: workspace → brand → niche → product/account → campaign →
conversation → task. Product and account are siblings, not parent/child:
products resolve brand (+ optional niche) from their row; accounts resolve
brands through their active `account_niche` links (primary niche's brand,
else the single shared brand, else none — never guessed).

Conflicting references **reject** with a typed `ContextError`
(`scope_conflict` / `workspace_mismatch` / `conversation_mismatch` /
`invalid_relationship`): product of brand A + explicit brand B, niche of
brand A + product of brand B, account whose active niches live only in
brand A + explicit brand B, conversation scope vs explicit scope, any
cross-workspace combination. Unknown ids → `entity_not_found`.

## Archived / deleted entities

Active context never silently includes archived entities.

- **Explicit** reference to an archived entity → `entity_archived` error.
- **Persisted conversation scope** pointing at an archived/gone entity →
  treated as historical reference: excluded with a trace entry, resolution
  continues at the next precedence level (the conversation still works).
- **Derived parent** that has since been archived (e.g. active product
  under an archived brand) → excluded with a trace note.

## Memory

Retrieved by structured scope relevance (workspace + every resolved
entity). No semantic/vector retrieval yet.

- Eligibility is enforced in SQL: `status = 'active'` and not expired.
  Superseded, archived, rejected and expired rows never enter the package;
  a bounded sample is fetched separately so the trace can explain them.
- Authority is preserved per memory: `permanent_fact` → `fact`,
  `verified_learning` → `trusted`, `proposed_learning` → **`hypothesis`
  (never presented as fact)**, `temporary_context` → `ephemeral`.
- Deterministic ranking: scope specificity (campaign > product > account >
  niche > brand > platform > workspace) → authority → confidence →
  verification recency → creation recency → id.

## Research

Only finished research (`completed`, `stale`) is eligible; drafts and
in-progress work are excluded (traced). Freshness is **derived**, never
stored: `expired` (past `expires_at` or archived) > excluded; `stale`
(explicit status) > included but marked; `aging` (completed but not
verified/updated within `researchAgingDays`, default 90) > included,
marked; otherwise `current`. Ranking: specificity → freshness → confidence
→ recency. Stale research is never presented as current truth.

## Goals

Active, non-deleted goals scoped to the workspace, brand, product or
campaign in the resolved scope set. Ranking: specificity → soonest due →
recency. Not every context has goals; absence is normal.

## Limits

All bounds live in `config.ts` (`DEFAULT_CONTEXT_LIMITS`): 30 recent
messages (chosen inside the agreed 20–40 window), 20 memories, 10 research
items, 10 goals. Candidate queries over-fetch by a fixed multiplier
(ordering is specificity-aware so over-fetching cannot starve narrow-scope
knowledge); trace exclusion samples are bounded by
`TRACE_EXCLUSION_SAMPLE` (25). Per-call overrides are clamped. This is a
count budget; token budgeting is a later provider-layer concern.

## Trace

Every package carries a `ContextTrace`: the requested ids, which source
won, and an entry for every inclusion (why), exclusion (why: expired,
superseded-by-X, over limit, not finished...), precedence decision (e.g.
"UI-selected brand ignored: the conversation has a persisted scope") and
note. Entries contain only ids, display labels and reasons — no row dumps,
no secrets.

## Safety and serialization

- `ContextPackage` is plain JSON-safe data: no database clients, no
  classes, no SDK objects. Persisting "what context did this run get" is a
  future `JSON.stringify` away.
- Platform context is a safe mapper: platform name + connection status
  only. `secret_ref`, scopes, tokens and connection metadata are never
  selected by the context repository.
- Message provider metadata is not carried into the package.

## Context Inspector (development only)

`/dev-context` renders the inspector: pick a conversation / explicit
brand / product / account, optionally include the real UI cookie
selection, and inspect every section plus the full trace. It is not in the
navigation, renders NotFound outside dev builds, and its server functions
refuse to run when `import.meta.env.DEV` is false. Normal users never see
scope types, ranking or trace internals.

## Not built yet (on purpose)

AI providers, prompt formatting, token budgeting, summarization,
semantic/vector retrieval, automatic memory creation, web research,
snapshot persistence. STEP 5 is context only.
