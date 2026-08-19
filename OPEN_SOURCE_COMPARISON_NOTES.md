# Open-Source Comparison Notes

This v2 pack was strengthened using patterns found in public Agent Skills ecosystems.

Key upgrades applied:
- standard skill metadata and discovery descriptions,
- progressive disclosure,
- dedicated skill router,
- spec → plan → incremental implementation lifecycle,
- TDD/regression workflow,
- separate source review from runtime behavior validation,
- browser/E2E validation,
- migration/deprecation lifecycle,
- dead-code cleanup,
- dependency lifecycle,
- Git/CI/CD/release/rollback,
- observability,
- ADRs,
- trigger eval fixtures,
- deterministic validation scripts.

The pack intentionally does not import huge unrelated catalogs. Stack-specific skills are optional and should trigger only when the repository actually uses that stack.
