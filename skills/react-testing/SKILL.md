---
name: react-testing
description: Tests React behavior with user-focused queries, realistic state, and minimal implementation coupling. Use when the repository uses React and component/integration tests are needed.
---

# React Testing

- test rendered/user-observable behavior,
- prefer accessible queries,
- avoid testing internal hook/state implementation,
- mock network/service boundaries only when appropriate,
- verify loading/error/success states,
- use real providers when the integration is part of the behavior,
- avoid snapshot-only proof for meaningful interactions.
