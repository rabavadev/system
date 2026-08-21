# server/tools

The ONE Tool Registry and execution boundary for agents.

Flow:

```
Agent / Model Tool Call
  → executeTool (executor.ts)
  → registry lookup
  → agent status check
  → capability check
  → dynamic runtime availability (resolveToolAvailability)
  → input validation (Zod, server-side)
  → approval gate (policy + approval service)
  → tool adapter
  → output contract validation
  → structured ToolExecutionResult + safe tool.execution.* event
```

- `types.ts` — provider-neutral tool contracts, risk, status, errors, caller.
- `definitions.ts` — authoritative built-in registry with schemas, capabilities, risks.
- `registry.ts` — lookup, safe descriptors, capability/status filtering.
- `executor.ts` — single execution path. Capability ≠ availability ≠ approval; adapters never run after denial.
- `adapters/` — implementations:
  - Internal read tools use the Context Engine.
  - `web.search` uses Brave Search adapter with query bounding, URL normalization, and H2B untrusted content framing.
  - External write tools require concrete platform adapters and explicit approval.

Server-only code. Never import from client bundles. No provider-specific function schemas, no secrets, no arbitrary user code.

