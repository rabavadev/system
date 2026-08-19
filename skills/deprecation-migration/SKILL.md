---
name: deprecation-migration
description: Migrates consumers from an old implementation to one canonical replacement and removes the legacy path only after zero active usage is verified.
---

# Deprecation and Migration

1. Identify old and replacement implementations.
2. Enumerate consumers.
3. Confirm replacement covers required behavior.
4. Migrate consumers in controlled slices.
5. Verify each slice.
6. Search again for active legacy usage.
7. Remove old code/routes/config/tests/docs.
8. Update `PROJECT_STATE.md`.
9. Create/update ADR when architectural significance warrants it.

Legacy code is not removed until consumers are proven migrated.
Legacy code is not kept indefinitely merely because deletion feels scary.
