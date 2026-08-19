---
name: typescript-best-practices
description: Applies TypeScript-specific correctness, type modeling, narrowing, public type boundaries, strictness, and maintainability. Use only when the repository uses TypeScript.
---

# TypeScript Best Practices

- prefer precise domain types over `any`,
- use narrowing instead of unsafe assertions,
- avoid duplicate types for the same domain concept,
- derive types from canonical schemas/contracts when possible,
- keep public types stable,
- do not introduce advanced type tricks when simple types communicate better,
- respect the repository's strictness/version configuration.
