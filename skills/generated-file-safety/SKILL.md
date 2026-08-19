---
name: generated-file-safety
description: Detects generated or machine-managed files and redirects fixes to the authoritative schema, generator, source, or package-manager operation. Use before editing generated clients, build output, codegen, compiled assets, or lockfiles.
metadata: {"category":"core-safety","priority":"critical"}
---

# Generated File Safety

## Goal
Fix the source of generated output, not the disposable artifact.

## Identify generation signals
- comments such as "generated" / "do not edit",
- output under `dist/`, `build/`, `.next/`, generated folders,
- OpenAPI/GraphQL/protobuf clients,
- ORM clients,
- codegen configuration,
- package-manager lockfiles.

## Procedure
1. Prove whether the file is generated.
2. Locate generator/schema/source/config.
3. Make the source change.
4. Run the canonical generation command.
5. Inspect generated diff.
6. Verify downstream consumers.

## Lockfiles
Use the repository package manager. Do not manually rewrite lockfile dependency graphs.

## Exit criteria
- authoritative source changed,
- generated output is reproducible,
- no hand patch will disappear on regeneration.
