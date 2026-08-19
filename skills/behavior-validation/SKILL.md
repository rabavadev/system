---
name: behavior-validation
description: Separately validates the actual running behavior after implementation. Use after code review when source correctness alone cannot prove the feature or bug fix works.
---

# Behavior Validation

## Goal
Prove the product outcome, not just code quality.

## Validate against acceptance criteria
For each criterion:
- identify observable evidence,
- execute the relevant flow when tooling allows,
- record pass/fail/not verified.

## Sources of evidence
- runtime behavior,
- API response,
- database result,
- browser interaction,
- logs,
- automated test,
- CLI output.

Do not substitute "code looks correct" for behavioral evidence.
