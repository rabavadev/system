---
name: database
description: Changes schemas and persisted data safely with existing-user compatibility, staged migrations, constraints, and rollback planning. Use for database schema or data migrations.
---

# Database / Migration

1. Inspect schema and all real reads/writes.
2. Consider existing and legacy data.
3. Classify migration: additive / transform / rename / destructive.
4. Prefer:
   ```text
   add → backfill → switch readers/writers → verify → remove old later
   ```
5. Validate constraints/indexes.
6. Consider transactions.
7. Define rollback/recovery.
8. Verify realistic existing data.

Never assume tables are empty or all rows match newest expectations.
