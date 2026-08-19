---
name: visual-regression
description: Uses stable screenshots or visual snapshots to detect unintended UI changes in important flows. Use for high-value UI redesigns or components where visual consistency matters and a visual-test framework already exists or is justified.
metadata: {"category":"ui-verification","priority":"optional"}
---

# Visual Regression

## Use selectively
Best for:
- critical layouts,
- shared components,
- complex responsive UI,
- redesign migrations.

## Procedure
1. use deterministic fixture/data,
2. stabilize viewport/font/loading state,
3. capture baseline through the project's established tool,
4. compare intended changes,
5. review diffs rather than auto-accepting all baselines,
6. keep snapshots focused.

Do not use screenshot approval to hide functional failures.
Do not introduce a heavy visual framework for a trivial one-off page.
