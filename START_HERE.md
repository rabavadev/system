# START HERE

Put this folder at the repository root and make `AGENTS.md` visible to the coding agent.

## One-time initialization

The agent should inspect the repository and populate:

- `PROJECT_RULES.md`
- `PROJECT_STATE.md`

It should not ask the user for stack facts it can discover itself.

## What changed in v2

This version adds:

- valid Agent Skills frontmatter to every skill,
- automatic lifecycle routing,
- spec-driven development,
- task planning,
- incremental implementation,
- TDD workflow,
- separate code review and runtime behavior validation,
- browser and Playwright validation,
- migration/deprecation lifecycle,
- dead-code cleanup,
- dependency lifecycle management,
- Git/versioning,
- CI/CD,
- observability,
- shipping/rollback,
- ADR documentation,
- context/session management,
- optional TypeScript/React/Next.js/React-testing skills,
- skill manifest,
- skill/eval validators,
- trigger eval cases.

## Core idea

```text
ONE canonical implementation
+ CURRENT stack knowledge
+ INCREMENTAL verified work
+ RUNTIME evidence
+ CLEAN migration/cleanup
```
