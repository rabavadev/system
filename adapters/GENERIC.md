# Generic Coding Agent Adapter

If the coding tool supports project instructions, point it to root `AGENTS.md`.

If it supports skill discovery, expose the `skills/` directory.

If it supports neither, load:
1. `AGENTS.md`
2. `PROJECT_RULES.md`
3. `PROJECT_STATE.md`
4. relevant `SKILL.md` files selected by `using-skills`.
