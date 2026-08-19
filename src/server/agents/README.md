# server/agents

Agent runtime and orchestration. Agents receive a model handle from server/ai and tools from server/tools; they are not tied to a provider.

Server-only code. Never import from client bundles (`src/components`,
`src/routes`, `src/features` UI files).
