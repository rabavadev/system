---
name: refactoring
description: Improves structure while preserving behavior when architecture, duplication, or maintainability genuinely blocks safe work. Use for behavior-preserving structural change.
---

# Refactoring

Refactor only when:
- task requires it,
- architecture is root cause,
- harmful duplication is real,
- current structure blocks safe implementation.

Define behavior to preserve, identify verification, refactor in controlled steps, remove obsolete code, preserve public contracts unless intentionally changing them, and ensure one source of truth.
