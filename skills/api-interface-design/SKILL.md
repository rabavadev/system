---
name: api-interface-design
description: Designs stable internal or external interfaces including REST/GraphQL contracts, component/module APIs, errors, versioning, and compatibility. Use when changing boundaries consumed by multiple modules or clients.
---

# API and Interface Design

## Define
- consumer(s),
- inputs,
- outputs,
- errors,
- ownership,
- compatibility,
- versioning/deprecation path.

## Rules
- prefer explicit stable contracts,
- avoid leaking internal storage details,
- make error semantics intentional,
- preserve backwards compatibility when required,
- coordinate producer and consumer migrations,
- do not casually expand public surface area.

Use `deprecation-migration` when changing an existing widely consumed interface.
