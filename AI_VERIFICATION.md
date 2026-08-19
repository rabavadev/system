# Verification Standard

## Level 0 — Documentation Only
- inspect diff,
- verify references/format.

## Level 1 — Small Local Change
- targeted behavior check,
- typecheck/lint when available,
- diff review.

## Level 2 — Feature/UI/API Change
- relevant tests,
- typecheck,
- lint,
- build,
- happy path,
- important failure states,
- regression check.

## Level 3 — Shared Architecture
- targeted + broader tests,
- typecheck/lint/build,
- dependent flows,
- final diff review,
- canonical source-of-truth check.

## Level 4 — High Risk
For auth, permissions, billing, migrations, deletion, secrets, user data, production config:
- automated checks,
- failure-path validation,
- existing-user/data compatibility,
- authorization validation,
- rollback/recovery consideration,
- destructive-operation review,
- explicit unverified areas.

---

# Mandatory Final Checks

## Canonicalization
- [ ] Edited implementation is actually active.
- [ ] No accidental `v2/new/final/backup/copy` implementation was introduced.
- [ ] No duplicate state/service/component now represents the same concept.
- [ ] Obsolete implementation was removed if replacement was completed.

## Stack
- [ ] Version-sensitive code matches installed versions.
- [ ] No deprecated API was introduced unknowingly.
- [ ] No unnecessary dependency/framework upgrade.

## Behavior
- [ ] Requested behavior works.
- [ ] Related behavior still works.
- [ ] Important failure path is handled.
- [ ] No fake/mock substitute remains.

## UI/UX
- [ ] Primary action/flow works.
- [ ] Loading/empty/error/success states considered.
- [ ] Responsive behavior checked where relevant.
- [ ] Long/realistic content considered.
- [ ] Keyboard/focus/accessibility considered.
- [ ] Existing design system remains canonical.

## Backend/Data
- [ ] Server validation.
- [ ] Authorization/ownership.
- [ ] Existing data compatibility.
- [ ] Duplicate requests/races considered.
- [ ] Destructive changes intentional and recoverable.

## Tests
- [ ] Tests validate behavior.
- [ ] Existing tests were not weakened merely to pass.
- [ ] Mocks do not hide the critical integration.

## Evidence Vocabulary

Use these accurately:

```text
Verified = executed or directly checked.
Reasoned = inspected and concluded, but not executed.
Not verified = could not validate.
```

## Generated / Workspace / Flag Checks

- [ ] No generated file was manually patched when a source generator exists.
- [ ] Correct workspace/package boundary was used.
- [ ] Authoritative lockfile/package manager was respected.
- [ ] Temporary feature flags have an owner/removal condition.
- [ ] Completed migrations do not leave both old and new implementations active.
- [ ] New environment variables/config are validated and documented.
