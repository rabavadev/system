# agents

Agent Registry UI (STEP 8): compact agent list, agent detail with version
history, safe editing (always creates a new version), custom agent creation,
disable/enable/archive. Agents are model-agnostic; providers are resolved
server-side. Technical internals (provider, model id, config JSON) never
render here.

UI components, hooks, and client-side state for this domain live here. Business
logic does not: it belongs in `src/server`.
