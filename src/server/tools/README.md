# server/tools

The ONE Tool Registry and execution boundary for agents (STEP 9).

Flow:

```
Agent → executeTool → registry lookup → agent status → capability check →
tool status/configuration → input validation → approval gate → adapter →
output contract → structured result + safe tool.execution.* event
```

- `types.ts` — provider-neutral tool contracts, risk, status, errors, caller.
- `definitions.ts` — the authoritative built-in registry. No D1 table yet:
  tools are code-reviewed contracts; persistence can be added later behind
  this surface without changing callers.
- `registry.ts` — lookup, safe descriptors, capability/status filtering.
- `executor.ts` — the only execution path. Capability ≠ availability ≠
  approval; adapters never run after denial.
- `adapters/` — implementations. Internal read tools use the safe context
  repository / Context Engine. External tools are declared but unavailable
  until a real adapter and configuration exist.

Server-only code. Never import from client bundles. No provider-specific
function schemas, no secrets, no arbitrary user code.
