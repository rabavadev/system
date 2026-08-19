---
name: git-workflow-versioning
description: Uses Git as a safety and change-boundary tool with focused diffs, intentional commits, branch hygiene, conflict handling, and versioning discipline.
---

# Git Workflow and Versioning

## Principles
- keep changes focused,
- inspect diff before commit,
- do not mix unrelated refactors,
- preserve user work,
- never discard unknown changes casually.

## Commits
Prefer atomic commits that describe one coherent change when the workflow allows commits.

## Conflicts
Understand both sides before resolving. Do not blindly choose ours/theirs.

## Versioning
For published packages/APIs, align version change with compatibility impact and repository policy.

Git is a recovery tool, not decoration.
