---
name: ci-cd
description: Creates or repairs continuous integration and deployment quality gates so typecheck, lint, tests, build, security, and release checks are enforced automatically.
---

# CI/CD and Automation

## Goal
Move important correctness checks from agent memory into repository enforcement.

## CI
Prefer relevant gates:
- install reproducibly,
- typecheck,
- lint,
- tests,
- build,
- E2E/security checks when justified.

## Rules
- use the repository's package manager/lockfile,
- avoid duplicating existing pipelines,
- cache carefully,
- fail clearly,
- keep secrets in CI secret stores,
- do not deploy from unverified artifacts.

## CD
Add staged deployment/approval/rollback behavior according to project risk.
