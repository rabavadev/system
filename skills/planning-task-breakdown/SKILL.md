---
name: planning-task-breakdown
description: Breaks a validated specification into dependency-aware, independently verifiable implementation tasks. Use before multi-step features, migrations, or large refactors.
---

# Planning and Task Breakdown

## Goal
Avoid one giant AI rewrite.

## Procedure
1. Start from acceptance criteria.
2. Identify dependencies.
3. Split work into thin tasks with one clear outcome.
4. Put shared foundations before consumers.
5. Put destructive/removal steps after migration verification.
6. Give each task its own verification.

## Good task
```text
Task: migrate dashboard route to canonical DashboardShell
Depends on: shared navigation API
Verify: route renders canonical shell and old route has zero consumers
```

## Bad task
```text
Task: rewrite dashboard
```

## Rule
Plan for incremental proof, not file-count.
