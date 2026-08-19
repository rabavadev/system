---
name: debugging
description: Diagnoses root causes of bugs, regressions, runtime errors, and incorrect behavior without patch stacking. Use when expected and actual behavior differ.
---

# Debugging

1. Reproduce or reconstruct.
2. Define expected vs actual.
3. Find first incorrect state/assumption.
4. Trace backward.
5. Check:
   - wrong source of truth,
   - stale state,
   - race,
   - duplicate handler,
   - invalid data,
   - contract mismatch,
   - permission,
   - version/environment mismatch.
6. Confirm the cause explains the symptom.
7. Fix at correct layer.
8. Add regression proof when useful.
9. Verify nearby flows.

Avoid arbitrary delays, duplicate handlers, empty catches, and replacement V2 files.
