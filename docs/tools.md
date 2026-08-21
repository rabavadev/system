# Tool Registry & Execution Boundary

One controlled path for every agent action:

```
Agent / Model Tool Call
  → executeTool (src/server/tools/executor.ts)
  → registry lookup (stable key)
  → agent status + capability check (server-side)
  → dynamic runtime status / configuration check (resolveToolAvailability)
  → input validation (zod, server-side)
  → approval gate (src/server/policy + src/server/approval)
  → tool adapter (src/server/tools/adapters/*)
  → output contract validation
  → structured ToolExecutionResult + safe tool.execution.* event
```

Agents never call `fetch`, D1 or external APIs directly. Model-facing schemas (JSON Schema)
are derived strictly FROM our definitions; server-side Zod validation remains authoritative.

## Definitions & Runtime Availability

`src/server/tools/definitions.ts` defines all registered tools: stable keys, human names,
category, input/output schemas, required capabilities, risk sets (`read`, `write`, `external`,
`sensitive`, `destructive`), execution mode, and default status.

Tool availability is dynamically resolved at runtime by `resolveToolAvailability(env)`:
- Tools requiring missing credentials or bindings are marked `needs_setup` or `unavailable`.
- Tools not in `available` status are **never** exposed to models or agents.

## Implemented Tools

### Internal Read Tools
- `workspace.get_current_context` — safe current-context summary via Context Engine.
- `workspace.get_product` / `workspace.list_products` — product catalogs and details.
- `workspace.get_account` / `workspace.list_accounts` — account handles and platform info (never secrets).
- `memory.list_relevant` — active, unexpired, non-superseded memory from Context Engine.
- `research.list_relevant` — stored workspace research with freshness classification.

### External Tools (Hardened in H2A/H2B)
- `web.search` — web search via Brave Search API adapter (`src/server/tools/adapters/web-search.ts`).
  - Active when `BRAVE_SEARCH_API_KEY` is configured in environment.
  - Bounded to maximum 5 results, max query length 200 chars, max snippet length 300 chars.
  - Safe URL normalization, exact-turn deduplication, no full-page scraping.
  - *Verification note*: Live remote search API calls are **NOT VERIFIED** until H4B.

### Registered but Unavailable
- `analytics.read` — requires analytics platform integrations.
- `files.list`, `files.read`, `image.generate`, `platform.get_posts`, `platform.get_analytics`, `platform.publish` — contracts defined, unavailable until concrete platform adapters exist.

## Security & Prompt Injection Defense (H2B)

- **Untrusted Content Framing**: All external tool outputs (web search snippets, external data) are framed within `<external_untrusted_data source="..." confidence="...">` tags before ingestion into model prompts.
- **Sanitization**: Raw HTML tags, markdown formatting tricks, and instruction-hijacking patterns are stripped or escaped.
- **Strict Capabilities**: Agents can only invoke tools for which their version explicitly declares capabilities (e.g. Researcher requires `read_research` and `read_context`).
- **Approval Gate**: Write/destructive tools require evaluation by Approval Policy (`auto`, `review`, `blocked`) before adapter execution.

## Observability & Events

Every execution generates a UUID and emits `tool.execution.completed` or `tool.execution.failed`
with safe metadata (caller agent, tool key, duration, risk classification, safe summary).
Secrets, tokens, and raw payloads are never logged.

Tests: `npm run test:tools` (41 tests covering registry, executor, capabilities, availability, and web search).

