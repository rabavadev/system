---
name: code-review
description: Performs a structured post-implementation review for correctness, architecture, security, performance, maintainability, tests, and unintended changes.
---

# Code Review

Review the final diff for:

## Correctness
- requirements satisfied,
- edge cases,
- contract mismatches,
- async/race issues.

## Architecture
- one source of truth,
- no parallel systems,
- appropriate boundaries,
- no needless abstraction.

## Security/Data
- auth/ownership,
- validation,
- secrets,
- destructive behavior.

## Performance
- obvious N+1/repeated work,
- unnecessary rerenders,
- needless full data loading.

## Tests
- meaningful coverage,
- no weakened tests,
- no mocks hiding the real risk.

Rank findings:
critical → major → minor.

Do not invent problems merely to produce review output.
