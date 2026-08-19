---
name: feature-flag-lifecycle
description: Creates, rolls out, verifies, and removes temporary feature flags without leaving permanent old/new code paths. Use for staged releases, migrations, canaries, or risky UI/backend replacements.
metadata: {"category":"shipping","priority":"high"}
---

# Feature Flag Lifecycle

## On creation record
- purpose,
- owner,
- default state,
- environments,
- rollout criteria,
- rollback criteria,
- removal condition.

## During rollout
- test relevant OFF behavior,
- test relevant ON behavior,
- monitor success/failure signals,
- avoid unrelated differences between branches.

## At full rollout
1. prove replacement is canonical,
2. remove old path,
3. remove flag checks/config,
4. remove obsolete tests/docs,
5. verify one source of truth,
6. update `PROJECT_STATE.md`.

A flag without a removal condition is technical debt with a toggle.
