---
name: dependency-management
description: Adds, upgrades, replaces, or removes dependencies safely with compatibility, changelog, lockfile, security, and migration checks. Use whenever dependency lifecycle changes are needed.
---

# Dependency Management

## Adding
- confirm existing platform/project capability is insufficient,
- evaluate maintenance cost,
- verify compatibility,
- keep scope minimal.

## Upgrading
- identify current and target versions,
- review breaking changes/migration notes when available,
- update in controlled scope,
- run relevant tests/build.

## Removing
- prove zero runtime/build/test usage,
- remove config/types/plugins made obsolete,
- verify lockfile/build.

Do not upgrade a framework as a side effect of unrelated work.
