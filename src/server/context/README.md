# server/context

The Context Engine: the ONE shared context source for future AI execution.
`buildContext(db, request)` resolves scope (explicit > conversation > ui >
workspace), validates relationships, and returns a bounded, ranked,
provider-neutral, JSON-serializable `ContextPackage` with a developer
trace. See docs/context-engine.md.

Server-only code. Never import from client bundles (`src/components`,
`src/routes`, `src/features` UI files). No AI provider types belong here.
