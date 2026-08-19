---
name: testing
description: Designs behavior-focused unit, integration, and end-to-end tests with realistic data and meaningful failure coverage. Use whenever implementation needs automated correctness evidence.
---

# Testing

1. Define intended behavior.
2. Choose cheapest level that proves it:
   - unit,
   - integration,
   - E2E.
3. Cover happy path.
4. Cover important failure path.
5. Cover regression-prone edge cases.
6. Use realistic data shapes.
7. Mock only boundaries that do not need proving.
8. Never weaken a valid assertion just to pass.
9. Prefer integration coverage when mocks would hide the real risk.
