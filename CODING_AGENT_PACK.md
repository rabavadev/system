# Coding Agent Upgrade v3

A one-time autonomous engineering pack designed to reduce AI-generated technical debt and supervision.

## Contents
- **56 Agent Skills**
- one canonical `AGENTS.md`
- project-specific state/rules
- deterministic skill routing
- concrete behavior eval contracts for every skill
- bootstrap installer for thin agent pointers
- security and imported-skill supply-chain review
- generated-file protection
- monorepo/workspace awareness
- browser/runtime helpers
- feature-flag lifecycle
- privacy/data governance
- incident response
- resilience/reliability
- environment/config discipline
- optional official Agent Skills validation

## Install

Copy the pack into the repository root, then:

```bash
python bootstrap/install_agent_pack.py --agent all
python scripts/self_check.py
```

## Main lifecycle

```text
understand
→ spec when needed
→ plan
→ inspect repository/workspace
→ identify canonical implementation
→ verify real stack
→ implement in verified slices
→ test
→ review source
→ validate runtime
→ migrate/clean old code
→ release safely
→ observe
→ report evidence
```

## Important
This pack intentionally does not install dozens of unrelated framework/cloud skills.
Stack-specific modules should remain conditional so the agent does not spend its life reading an employee handbook.
