# server/workflows

The Workflow Engine (STEP 10): declarative definitions, immutable versions,
the run/drive/resume/cancel lifecycle, validation, limits and the runtime
adapter boundary. See docs/workflows.md.

Server-only code. Never import from client bundles (`src/components`,
`src/routes`, `src/features` UI files). The engine never imports provider
SDKs, never calls tool adapters directly (always `executeTool`), and never
writes chat messages.
