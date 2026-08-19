---
name: using-skills
description: Routes coding tasks to the minimum relevant skill sequence. Use at the start of any non-trivial task to decide which specialized workflows should run and in what order.
---

# Skill Router

## Goal
Automatically choose the engineering lifecycle so the user does not need to supervise skill selection.

## Task Classification

### Bug / regression
Use:
1. `codebase-exploration`
2. `debugging`
3. `test-driven-development` when a regression test is practical
4. relevant domain skill
5. `code-review`
6. `behavior-validation`
7. `final-review`

### New feature
Use:
1. `spec-driven-development`
2. `planning-task-breakdown`
3. `codebase-exploration`
4. `stack-freshness`
5. relevant implementation skills
6. `incremental-implementation`
7. `testing` / `test-driven-development`
8. `code-review`
9. `behavior-validation`
10. `final-review`

### UI redesign
Use:
1. `canonical-implementation`
2. `product-thinking`
3. `frontend-ui-ux`
4. `design-system`
5. `component-system`
6. `browser-runtime-testing`
7. `accessibility`
8. `ui-review`
9. `final-review`

### Migration / duplicate cleanup
Use:
1. `architecture-review`
2. `canonical-implementation`
3. `deprecation-migration`
4. relevant tests
5. `dead-code-cleanup`
6. `documentation-adrs`
7. `final-review`

### High-risk backend/data
Use:
1. `spec-driven-development`
2. `architecture-review`
3. `security`
4. `database` or `backend`
5. `test-driven-development`
6. `code-review`
7. `behavior-validation`
8. `shipping-rollback`

## Rules
- Load only skills relevant to the task.
- Do not mechanically execute every skill.
- Escalate to architecture/security/migration skills when risk increases.
- Prefer the shortest workflow that still proves correctness.

## Additional automatic escalation

### Generated / machine-managed files
Add `generated-file-safety`.

### Monorepo / workspace
Add `monorepo-workspaces` before dependency/build/test scope decisions.

### Feature flag / staged migration
Add `feature-flag-lifecycle` and `deprecation-migration`.

### Personal/sensitive user data
Add `privacy-data-governance` plus `security` when access/trust boundaries change.

### Active production outage
Use:
1. `incident-response`
2. `observability`
3. `reliability-resilience` as relevant
4. `debugging` after containment
5. `shipping-rollback`

### New environment/config
Add `environment-configuration`.

### Imported third-party skill
Run `skill-security-review` before executing its scripts.

### High-value visual redesign
Add `visual-regression` only if an established or justified visual-test path exists.

