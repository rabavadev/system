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
| Chief | Direct AI Model | default | Primary workspace AI; coordinates and recommends. |
| Researcher | Direct AI Model | default | Analyzes workspace research and performs live web search when `web.search` tool is available. Cites exact verified sources (H3A.2). |
| Strategist | Direct AI Model | reasoning | Turns evidence into positioning, angles, hypotheses, and tests; separates decisions from facts. |
| Creator | Direct AI Model | default | Draft concepts, hooks, and copy. Generates structured candidates (`content_draft_candidate`), requires account selection to derive target platform, tracks human edit hashes (H3A.1). Never publishes. |
| Critic | Direct AI Model | reasoning | Challenges assumptions, evaluates copy quality, creates `content_review` feedback and suggestions (Step 15B). |
| Analytics | Direct AI Model | reasoning | Analyzes available performance data only; never invents metrics. |
| Publisher | Direct AI Model | default | Ships **disabled**: publishing tools don't exist yet. Never claims it published. |

One Researcher, not one per platform — platform context comes from the
Context Engine and Account selection.

Specialist instructions = `AGENT_BASE_POLICY` (shared rules, written once in
`src/server/agents/definitions.ts`) + a role-specific brief, concatenated at
definition time so each stored version is self-contained.

## Creator Draft & Revision Lifecycle (H3A.1, STEP 15C)

1. **Draft Generation (Step 15A)**: The Creator agent generates structured drafts (`headline`, `body`, `hook`, `call_to_action`).
2. **Draft Candidate**: Stored in `content_draft_candidate` with `generated_hash` (SHA-256) and server-derived provenance.
3. **Platform Derivation**: Platform is derived directly from the selected Account — never guessed or defaulted alphabetically.
4. **Human Editing & Saving**: When the user edits and saves as a `content_variant`, the server compares the saved text hash with `generated_hash` to record `human_edited = true/false`.
5. **Critic Editorial Review (Step 15B)**: Critic evaluates saved immutable variants and produces structured reviews (`pass` | `revise`).
6. **Creator Revision (Step 15C)**: When Critic verdict is `revise`, the human operator can trigger a Creator revision. Creator takes the immutable source variant text + Critic review recommendations to generate a new candidate with `source_variant_id` and `source_review_id`, which saves to a new immutable variant linked via `parent_variant_id`.
7. **Human Editorial Approval (Step 15D)**: Explicit human sign-off on an exact variant ID transitions `content.status` to `'ready'` and designates `content.selected_variant_id`.


## Research & Source Provenance (H3A.2)

- When Researcher uses `web.search`, search result URLs and titles are cited as `research_source` rows.
- Provenance is derived server-side from the execution metadata (`agent_id`, `agent_version_id`, `provider`, `model`, `execution_id`).
- Unverified, failed, or blocked searches never create fake citation records.

## Custom agents

Name, purpose, instructions, execution type, model strategy, capabilities.
Server-side validation only: reserved built-in names and duplicates are
rejected (`assertAgentNameAvailable`), configs must parse
`agentVersionConfigSchema`. Custom agents can be disabled and archived;
built-ins can be disabled but never archived.

## Capabilities

Declarative intent (`read_context`, `read_memory`, `read_research`,
`read_analytics`, `create_draft`, `propose_memory`, `request_workflow`,
`publish`, `modify_account`). The Tool Registry enforces them server-side:
an agent's required capability must be present before its adapter can run.
Capability does NOT imply availability or approval.

## Chat & Studio Integration

- In Chat, switching agents mid-conversation preserves conversation scope.
- In Studio (Campaigns / Content), Creator and Critic run focused tasks with structured outputs.
- In all contexts, external inputs and search results are wrapped in untrusted data markers (H2B).

