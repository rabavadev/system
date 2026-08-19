---
name: test-driven-development
description: Uses red-green-refactor discipline for bug fixes and behavior that benefits from executable specification. Use when a failing test can reproduce the issue or define the required behavior.
---

# Test-Driven Development

## Red
Write or identify a test that fails for the real missing/broken behavior.

Confirm failure is for the intended reason.

## Green
Make the smallest correct implementation that passes.

Do not weaken the test.

## Refactor
Clean structure without changing behavior, then rerun.

## Good regression test
- fails before fix,
- passes after fix,
- tests user/business behavior,
- does not overfit implementation details.

## Do not use TDD mechanically
Skip red-first when it adds no value, such as trivial static text edits.
