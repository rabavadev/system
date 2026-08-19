---
name: monorepo-workspaces
description: Finds workspace roots, package ownership, authoritative lockfiles, dependency boundaries, and affected packages before commands or dependency changes. Use in monorepos, workspaces, or repositories with multiple apps/packages.
metadata: {"category":"repository-awareness","priority":"high"}
---

# Monorepo / Workspace Awareness

## Discover
- workspace root,
- package manager,
- root and package manifests,
- workspace declarations,
- lockfile authority,
- package owning touched code,
- dependent packages/apps,
- shared config packages.

## Before changing dependencies
Determine whether dependency belongs:
- at root,
- in one package,
- in a shared package.

## Before running commands
Prefer the repository's established workspace command.

Avoid:
- installing the same dependency independently in multiple packages,
- editing the wrong manifest,
- running destructive broad commands from root without scope,
- creating duplicate shared config.

## Exit criteria
The change is scoped to the correct workspace and affected dependents are verified.
