---
name: playwright-e2e
description: Creates and debugs Playwright end-to-end tests for critical user journeys, visual behavior, accessibility, network flows, and flaky browser interactions.
---

# Playwright E2E

Use when Playwright exists or E2E browser proof is justified.

## Procedure
1. Identify critical user journey.
2. Prefer stable semantic locators.
3. Avoid arbitrary sleeps.
4. Wait on observable state.
5. Keep tests independent.
6. Capture traces/screenshots when debugging failures.
7. Test meaningful success and failure flows.
8. Avoid asserting implementation details.
9. Keep E2E count focused on high-value journeys.

Do not install Playwright casually if the repository uses another established E2E framework.
