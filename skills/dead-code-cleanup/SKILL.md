---
name: dead-code-cleanup
description: Safely proves and removes unused code, routes, imports, styles, feature flags, and abandoned implementations without deleting live behavior.
---

# Dead-Code Cleanup

1. Search definitions and all consumers.
2. Check dynamic imports/config/route registration.
3. Check tests/build scripts/deployment references.
4. Classify as definitely dead / uncertain / live.
5. Remove only proven dead code.
6. Run relevant verification.
7. Remove stale comments/docs/config created solely for deleted code.

Do not delete code based only on zero text matches if the framework supports dynamic discovery.
