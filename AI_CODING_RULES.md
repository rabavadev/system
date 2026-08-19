# AI Coding Rules

## 1. Repository Before Memory

- Installed manifests, lockfiles, config, source code, local types, and tests outrank model memory.
- Detect exact framework/library versions before using version-sensitive APIs.
- Do not introduce deprecated patterns when the project has a current supported pattern.
- If exact external behavior is uncertain and web access exists, use official version-matched documentation.

## 2. Inspect Before Editing

Before meaningful edits:
- locate the active entry point,
- inspect callers/imports,
- inspect routes,
- inspect state ownership,
- inspect existing utilities/components/services,
- inspect relevant tests,
- inspect project conventions.

Do not edit a file simply because its name appears relevant.

## 3. Canonical Source of Truth

For each concept, prefer one canonical:
- implementation,
- state owner,
- service,
- schema,
- component,
- design token system,
- route,
- configuration source.

If duplicates exist, determine which is active before changing anything.

## 4. No V2/V3/New/Final Junk

Do not create parallel replacement files with names such as:
- `*-v2`
- `*-v3`
- `*-new`
- `*-new2`
- `*-final`
- `*-final2`
- `*-old`
- `*-backup`
- `*-copy`

Exceptions require an explicit architectural/product reason, such as a deliberately versioned public API, experiment, migration stage, or immutable historical artifact.

A hard implementation is not a reason to create a second implementation.

## 5. Replacement Protocol

If an implementation truly must be replaced:

1. identify the active canonical implementation,
2. document why in-place repair is unsafe or inappropriate,
3. create the replacement intentionally,
4. migrate every consumer,
5. verify the new path,
6. remove obsolete code/routes/state,
7. confirm only one canonical implementation remains.

Do not leave migration branches indefinitely.

## 6. Root Cause Over Patch Stacking

- Reproduce or reconstruct the issue.
- Find the earliest incorrect assumption/state.
- Fix the correct ownership layer.
- Avoid arbitrary conditions, duplicate handlers, sleeps, retries, and state mirrors.
- If the architecture is the cause, restructure the affected area.

## 7. Clean Integration Over Visible Success

Working code is not enough.

The change must:
- fit the project,
- reuse existing systems when appropriate,
- preserve naming/domain terminology,
- avoid duplicated state/logic,
- avoid unnecessary dependencies,
- handle relevant failure states,
- remove obsolete code,
- preserve business rules.

## 8. Smallest Correct Change

Do not interpret "minimal change" as "never restructure."

Prefer the smallest change that fully resolves the problem.

Restructure the affected area when:
- architecture is the root cause,
- duplicated ownership causes bugs,
- the current boundary prevents safe implementation,
- repeated patches would create technical debt.

Do not rewrite unrelated working code.

## 9. Product Behavior First

Understand:
- who the user is,
- what they are trying to achieve,
- the complete flow,
- business rules,
- permissions,
- saved state,
- existing-user compatibility.

Technical success does not count if product behavior is wrong.

## 10. UI/UX Rules

- Design around user goals, not backend schemas.
- Do not expose internal settings merely because they exist.
- Preserve one canonical design system.
- Reuse canonical components.
- Do not create parallel buttons/modals/forms/layout systems.
- Handle loading, empty, error, success, disabled, unauthorized, and partial-data states when relevant.
- Responsive design must adapt, not just shrink.
- Test realistic long text, missing values, large counts, and zero states.
- Preserve keyboard/focus behavior and semantic HTML.
- References are inspiration unless exact reproduction is explicitly requested.

## 11. Data and Migrations

- Existing user data must be considered.
- Prefer additive/staged migrations.
- Validate legacy/null/unexpected values.
- Do not drop/rename/transform persisted fields casually.
- Coordinate schema changes with readers/writers.
- Consider rollback/recovery.

## 12. Authentication and Authorization

- Authentication answers "who are you?"
- Authorization answers "may you do this?"
- Ownership checks belong at trusted boundaries.
- Never rely on frontend-only permission checks.
- Do not weaken security to make a feature work.

## 13. Secrets

Never:
- hardcode secrets,
- log secrets,
- expose server secrets to clients,
- commit credentials,
- invent environment variables without checking conventions.

Update environment documentation when required.

## 14. APIs and External Services

- Verify installed SDK/API version.
- Do not invent methods, fields, endpoints, or response shapes.
- Handle realistic errors, timeouts, rate limits, pagination, and partial failure when relevant.
- Do not blindly retry non-idempotent operations.

## 15. Async and Concurrency

Consider:
- duplicate submissions,
- race conditions,
- stale responses,
- out-of-order completion,
- abandoned requests,
- conflicting writes.

High-value actions should be idempotent or protected from accidental repetition where appropriate.

## 16. Dependencies

- Prefer existing capabilities.
- Do not add a package for trivial code.
- Check compatibility before adding/upgrading.
- Do not upgrade frameworks as a side effect of unrelated work.

## 17. Code Structure

Avoid both extremes:
- giant god files,
- excessive fragmentation.

Create abstractions only when they clarify a real pattern.

Consolidate repeated logic when repetition is established.

## 18. Naming and Domain Language

- Follow established naming.
- Use one term for one concept.
- Do not rename domain concepts into generic technical words without reason.
- Do not create `userId`, `uid`, `accountId` drift for the same concept.

## 19. Comments and Documentation

Comments should explain:
- why,
- constraints,
- invariants,
- non-obvious decisions.

Do not narrate obvious syntax.

Update stale docs/comments caused by the change.

## 20. Performance

- Avoid obvious waste.
- Do not prematurely optimize.
- Prefer evidence-driven fixes.
- Check N+1 queries, repeated requests, excessive renders, giant bundles, full-dataset loading when relevant.
- Add caching only when invalidation is understood.

## 21. Tests

- Test intended behavior.
- Never weaken valid tests to make code pass.
- Do not mock away the integration being tested.
- Add regression coverage when a bug warrants it.
- Passing tests do not excuse known broken behavior.

## 22. Completion

A task is complete only when:
- required behavior exists,
- the implementation is connected,
- no fake substitute remains,
- relevant checks were run,
- known limitations are reported,
- unverified areas are labeled,
- obsolete code created/replaced by the task is cleaned up.

"Code written" is not "done."
