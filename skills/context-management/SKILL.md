---
name: context-management
description: Maintains progress, decisions, unresolved risks, and handoff state across long coding sessions. Use for multi-step tasks or when context may be compacted or transferred to another agent.
---

# Context and Session Management

## Maintain
- current goal,
- acceptance criteria,
- completed tasks,
- active task,
- decisions made,
- rejected approaches,
- unresolved risks,
- verification already performed,
- canonical implementations discovered.

## Persist durable facts
Update:
- `PROJECT_STATE.md`
- ADRs when architectural decisions matter.

## Before handoff/compaction
Record:
```text
Done:
In progress:
Next:
Do not redo:
Known failures:
Verification evidence:
```

## Rule
Do not rely on conversation memory for durable architecture decisions.
