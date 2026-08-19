# Agent Registry (STEP 8)

Reusable, versioned AI workers that the user can talk to directly from Chat.

```
Conversation
  → selected agent (WHO the user picked)
  → current agent version (immutable config)
  → Context Engine (STEP 5, the only context source)
  → AI execution layer (STEP 6, provider-neutral)
  → model / external agent / router
```

Agents are workers. Workflows (later) decide when and how workers are used;
agents never orchestrate each other.

## Identity vs execution

- **Agent shell** (`agent`): stable identity — name, purpose (`description`),
  origin (`builtin` | `custom`), status, execution type. Never hard-deleted;
  history keeps its authors.
- **Agent version** (`agent_version`): immutable configuration snapshot —
  instructions, model *strategy* (never a model id), generation settings,
  declarative capabilities, external/router config. Editing any of it
  appends version N+1; old versions are never mutated, so every assistant
  message's `agent_version_id` still points at exactly what produced it.
- **Rollback** means "create a new current version copied from an old one",
  never rewriting history.

Version provenance (`source` inside the config JSON, set server-side only):
`system` versions ship with the app and rotate when a deploy changes them;
`user` versions are edits and are never silently reverted by provisioning.
Legacy pre-STEP-8 versions carry no marker and rotate exactly once.

## Built-in agents

Provisioned lazily per workspace (`ensureBuiltinAgents`), idempotently:

| Agent | Runs with | Strategy | Notes |
|---|---|---|---|
| Chief | Direct AI Model | default | Primary workspace AI; coordinates and recommends. Keeps verbatim STEP 6 instructions. |
| Researcher | Direct AI Model | default | Analyzes available workspace research/context. No live web research yet — and says so. |
| Strategist | Direct AI Model | reasoning | Turns evidence into positioning and tests; separates decisions from facts. |
| Creator | Direct AI Model | default | Concepts, hooks, copy. Never publishes. |
| Critic | Direct AI Model | reasoning | Challenges assumptions, detects generic AI language. Not agreeable by default. |
| Analytics | Direct AI Model | reasoning | Analyzes available data only; never invents metrics. |
| Publisher | Direct AI Model | default | Ships **disabled**: publishing tools don't exist yet. Never claims it published. |

One Researcher, not one per platform — platform context comes from the
Context Engine / future workflows.

Specialist instructions = `AGENT_BASE_POLICY` (shared rules, written once in
`src/server/agents/definitions.ts`) + a short role brief, concatenated at
definition time so each stored version is self-contained. Chief keeps its
verbatim STEP 6 instructions so existing versions never rotate for
formatting reasons.

## Custom agents

Name, purpose, instructions, execution type, model strategy, capabilities.
Server-side validation only: reserved built-in names and duplicates are
rejected (`assertAgentNameAvailable`), configs must parse
`agentVersionConfigSchema`. Custom agents can be disabled and archived;
built-ins can be disabled but never archived.

## Execution types

- `direct_model` — implemented, runs through the STEP 6 execution layer.
- `external_agent` — configurable (https endpoint, agent reference,
  credential **name** reference). Execution is NOT enabled: chat fails
  controlled with "no connection yet". No network calls are made.
- `router` — configurable (allowed strategies). Execution is NOT enabled:
  chat fails controlled with "not enabled yet". No fake "smart" routing.

## Capabilities

Declarative intent only (`read_context`, `read_memory`, `read_research`,
`read_analytics`, `create_draft`, `propose_memory`, `request_workflow`,
`publish`, `modify_account`). There is no Tool Registry yet, so declaring
`publish` grants nothing. Displayed as friendly labels in the UI.

## Secrets

`agentVersionConfigSchema` is the boundary: secret-looking keys
(`token`, `apiKey`, `password`, ...) and values (`sk-...`, `Bearer ...`)
are rejected, endpoints must be https, and credentials are stored as NAME
references only. Nothing provider- or secret-shaped ever enters D1.

## Chat integration

- The user picks WHO answers (selector in the conversation header); the
  system decides HOW. Selection lives in the URL (`?agent=<id>`), defaults
  to Chief, and falls back to Chief when the selected agent disappears or
  is disabled.
- Switching agents mid-conversation is the designed flow: the conversation
  belongs to the workspace, the agent choice belongs to each execution.
  Every assistant message records its agent id + version and renders the
  agent's name (Chief, Critic, ...) instead of a generic "Assistant".
- The client submits an agent id only. Instructions, config, provider and
  model are resolved server-side; there is no injection channel.
- The context transcript labels each reply with the name of the agent that
  wrote it (`ContextMessage.agentName`), so a Critic turn sees Chief's
  earlier answers attributed correctly.

## Files

```
src/server/agents/
  definitions.ts  built-in roster + shared base policy
  config.ts       agent_version.config schema + secret guard
  registry.ts     provisioning, name policy, chat resolution
  reply.ts        generic direct-chat execution (all direct_model agents)
  chief.ts        STEP 6 compatibility surface (thin wrapper)
src/features/agents/  registry UI (list, detail, version history, forms)
src/features/chat/agent-selector.tsx
```

Tests: `npm run test:agents` (18 tests: roster, versioning, switching,
context sharing, validation, secret hygiene, honest unavailability).

## Not built yet (deliberately)

Tool Registry, workflow execution, agent-to-agent orchestration, real
external-agent calls, intelligent routing, web research, publishing,
analytics ingestion, structured output persistence (ResearchReport/Draft).
