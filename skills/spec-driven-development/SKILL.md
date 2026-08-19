---
name: spec-driven-development
description: Creates a concise implementation specification and acceptance criteria for non-trivial features, redesigns, migrations, and ambiguous product changes before code is written.
---

# Spec-Driven Development

## Use when
- feature spans multiple files/systems,
- behavior is ambiguous,
- redesign changes user flow,
- migration changes contracts/data,
- task likely lasts beyond one small edit.

## Produce internally
```text
Goal:
Current behavior:
Desired behavior:
In scope:
Out of scope:
Acceptance criteria:
Edge cases:
Permissions/data constraints:
Compatibility requirements:
Verification evidence:
```

## Acceptance criteria
Must be observable and testable.

Bad:
- "make dashboard better"

Good:
- "existing dashboard route remains `/dashboard`"
- "no DashboardV2 route exists after migration"
- "empty/loading/error states are present"
- "existing saved user settings remain intact"

## Rule
Do not turn the spec into a giant design document. It is a control surface for implementation.
