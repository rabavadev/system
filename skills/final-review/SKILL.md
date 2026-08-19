---
name: final-review
description: Performs the final repository hygiene and evidence review before completion, including duplicate implementations, placeholders, dead code, weakened tests, dependency drift, and unverified claims.
---

# Final Review

1. Read final diff.
2. Compare with requested outcome/spec.
3. Search for:
   - unrelated changes,
   - V2/new/final files,
   - old implementation still active,
   - duplicate state/services,
   - TODO/FIXME,
   - mock/placeholder data,
   - dead code,
   - temporary logs,
   - unsafe defaults,
   - stale comments,
   - naming drift,
   - weakened tests,
   - accidental dependency upgrades.
4. Re-check permissions/data/contracts/migrations when relevant.
5. Confirm behavior evidence.
6. Update `PROJECT_STATE.md` / ADRs when needed.
7. Only then declare completion.
