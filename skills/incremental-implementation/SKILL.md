---
name: incremental-implementation
description: Implements non-trivial work in thin working slices with verification between slices. Use when a task touches multiple files, layers, routes, or behaviors.
---

# Incremental Implementation

## Goal
Prevent large unverified code dumps.

## Loop
```text
choose smallest useful slice
→ implement
→ run targeted verification
→ review diff
→ continue
```

## Slice examples
- add backend contract + test before wiring UI,
- migrate one consumer before deleting old service,
- implement loading/error states before decorative polish,
- move one route to canonical component before removing legacy route.

## Stop and investigate if
- verification begins failing outside expected area,
- new duplicate source of truth appears,
- required scope expands unexpectedly,
- assumptions about stack/contracts prove wrong.

## Rule
A large task may require many changes. It does not require making all changes before checking any of them.
