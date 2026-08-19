#!/usr/bin/env python3
"""
Install thin instruction pointers without duplicating the master policy.

Supported outputs:
- Claude Code: CLAUDE.md imports AGENTS.md / project state
- Cursor: .cursor/rules/00-agent-core.mdc
- GitHub Copilot: .github/copilot-instructions.md
- Zed: no extra file required; root AGENTS.md is already supported
- Generic: no extra file required
"""
from pathlib import Path
import argparse, sys

MARK_START = "<!-- coding-agent-upgrade:managed:start -->"
MARK_END = "<!-- coding-agent-upgrade:managed:end -->"

ap = argparse.ArgumentParser()
ap.add_argument("--repo", default=".")
ap.add_argument("--agent", choices=["all","claude","cursor","copilot","zed","generic"], default="all")
ap.add_argument("--force", action="store_true")
args = ap.parse_args()

repo = Path(args.repo).resolve()
if not (repo/"AGENTS.md").exists():
    raise SystemExit("AGENTS.md not found at repository root. Copy the pack first.")

def managed_write(path: Path, body: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    block = f"{MARK_START}\n{body.strip()}\n{MARK_END}\n"
    if not path.exists():
        path.write_text(block, encoding="utf-8")
        print("created", path.relative_to(repo))
        return
    text = path.read_text(encoding="utf-8")
    if MARK_START in text and MARK_END in text:
        a = text.index(MARK_START)
        b = text.index(MARK_END, a) + len(MARK_END)
        text = text[:a] + block.rstrip() + text[b:]
        path.write_text(text.rstrip()+"\n", encoding="utf-8")
        print("updated managed block", path.relative_to(repo))
        return
    if args.force:
        path.write_text(text.rstrip()+"\n\n"+block, encoding="utf-8")
        print("appended managed block", path.relative_to(repo))
    else:
        print("SKIP existing unmanaged file:", path.relative_to(repo), "(use --force to append)")

targets = [args.agent] if args.agent != "all" else ["claude","cursor","copilot","zed"]

if "claude" in targets:
    managed_write(repo/"CLAUDE.md", """
@AGENTS.md
@PROJECT_RULES.md
@PROJECT_STATE.md

Use the skill router at `skills/using-skills/SKILL.md` and load only task-relevant skills.
""")

if "cursor" in targets:
    managed_write(repo/".cursor/rules/00-agent-core.mdc", """---
description: Canonical repository coding-agent controller
globs:
alwaysApply: true
---

Follow the repository root `AGENTS.md`, `PROJECT_RULES.md`, and `PROJECT_STATE.md`.
Route non-trivial work through `skills/using-skills/SKILL.md`.
Do not duplicate the master policy here.
""")

if "copilot" in targets:
    managed_write(repo/".github/copilot-instructions.md", """
Follow the repository root `AGENTS.md` as the canonical coding-agent policy.
Also use `PROJECT_RULES.md`, `PROJECT_STATE.md`, and task-relevant skills selected by `skills/using-skills/SKILL.md`.
Do not duplicate or override the master policy in this file.
""")

if "zed" in targets:
    print("zed: root AGENTS.md is the project instruction source; no duplicate adapter file installed.")

print("done")
