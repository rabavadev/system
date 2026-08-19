# Forbidden Behaviors

## Project Reality
Never invent:
- files,
- routes,
- APIs,
- fields,
- SDK methods,
- environment variables,
- package versions,
- tests,
- deployment behavior.

## Duplicate Implementations
Never create a second implementation because the first is difficult to change.

Do not create casual:
- `DashboardV2`,
- `DashboardNew`,
- `DashboardFinal`,
- `NewButton`,
- `ModernModal`,
- `NewUserContext`,
- `legacy/new` parallel state,

unless an intentional migration/versioning plan requires it.

## Fake Completion
Never hide missing work behind:
- mocks,
- hardcoded data,
- placeholder UI,
- TODOs,
- dummy callbacks,
- static success,
- unconnected buttons.

## Test Manipulation
Never:
- delete valid failing tests to get green,
- weaken assertions to match broken code,
- skip tests without justification,
- claim tests ran when they did not.

## Error Hiding
Never:
- use empty `catch`,
- suppress failures without handling,
- remove logs solely to hide errors,
- convert errors to success silently.

## Security
Never:
- hardcode secrets,
- expose private keys/tokens,
- trust client validation as authorization,
- bypass permissions,
- log sensitive information.

## Destructive Work
Never treat these as routine:
- data deletion,
- schema drops,
- account deletion,
- billing changes,
- permission changes,
- production configuration changes.

## Architecture
Never:
- fork architecture to avoid understanding it,
- keep old/new systems indefinitely without a migration requirement,
- create multiple sources of truth,
- rewrite unrelated code because another style is preferred.

## UI
Never:
- create parallel design systems casually,
- rebuild shared components differently per page,
- copy backend fields directly into UI without product reasoning,
- add gradients/shadows/cards merely to make a page look "modern."

## Stack Freshness
Never use a remembered old/deprecated API without first checking the repository's actual installed version when the behavior is version-sensitive.

## Generated / Machine-Managed Files

Never manually patch generated output as the permanent fix when a source generator/schema/config exists.

Do not hand-edit dependency lockfile internals to simulate a package-manager operation.

## Workspace Mistakes

Never run broad dependency upgrades or repository-wide commands before identifying the workspace/package boundary in a monorepo.

## Feature-Flag Fossils

Never leave old and new implementations permanently alive behind a completed rollout flag.

## Imported Skill Trust

Never execute a newly imported third-party skill's scripts before reviewing its permissions and behavior.

## Incident Scope Creep

Never perform unrelated cleanup/refactoring during an active production incident unless it is necessary to restore service safely.
