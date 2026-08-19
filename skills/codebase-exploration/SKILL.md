---
name: codebase-exploration
description: Inspects repository structure, call paths, routes, state ownership, tests, and duplicate implementations before editing unfamiliar or shared code.
---

# Codebase Exploration

1. Inspect manifests, lockfiles, configs.
2. Locate likely entry points.
3. Search definitions/imports/callers/routes/tests/schemas.
4. Trace:
   ```text
   user action → UI → state → service/API → backend/data → response → UI
   ```
5. Identify ownership of state, validation, auth, persistence.
6. Search for similarly named/duplicate implementations.
7. Prove which implementation is active.
8. Identify blast radius.

Stop when you know where behavior originates, what consumes it, the canonical source, and how to verify the change.
