---
name: canonical-implementation
description: Finds and preserves one active source of truth for routes, components, services, state, schemas, and design systems. Use when duplicate, legacy, V2/new/final, or redesign implementations exist.
---

# Canonical Implementation

1. List competing implementations.
2. Trace imports/routes/callers for each.
3. Classify each as:
   - canonical active,
   - intentional migration,
   - dead/legacy,
   - deliberately versioned.
4. Do not create another implementation.
5. Repair canonical implementation when possible.
6. If replacement is necessary, use `deprecation-migration`.
7. Update `PROJECT_STATE.md`.

Forbidden shortcut:
`Dashboard-v4` because `Dashboard-v3` is messy.
