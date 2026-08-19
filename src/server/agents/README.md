# server/agents

Agent runtime. Agents receive context from the Context Engine, execute
models through the server/ai boundary, and are never tied to a provider.

- `chief.ts` — the Workspace Chief, the built-in primary agent for Chat.
  Versioned instructions via agent/agent_version, context only via
  buildContext, replies persisted with agent/version/provider metadata.

Specialist agents (Researcher, Strategist, Creator, Critic, Analytics,
Publisher) and workflow execution are intentionally NOT built yet.

Server-only code. Never import from client bundles (`src/components`,
`src/routes`, `src/features` UI files).
