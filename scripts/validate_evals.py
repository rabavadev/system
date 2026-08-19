#!/usr/bin/env python3
from pathlib import Path
import json, sys

ROOT = Path(__file__).resolve().parents[1]
skills = {p.parent.name for p in (ROOT/"skills").glob("*/SKILL.md")}
errors = []

for name in sorted(skills):
    p = ROOT/"evals"/f"{name}.json"
    if not p.exists():
        errors.append(f"missing eval: {name}")
        continue
    try:
        obj = json.loads(p.read_text(encoding="utf-8"))
    except Exception as e:
        errors.append(f"{p}: invalid JSON: {e}")
        continue
    if obj.get("skill") != name:
        errors.append(f"{p}: skill mismatch")
    cases = obj.get("cases") or []
    if len(cases) < 2:
        errors.append(f"{p}: need at least positive and negative case")
        continue
    if not any(c.get("should_trigger") is True for c in cases):
        errors.append(f"{p}: missing trigger-positive case")
    if not any(c.get("should_trigger") is False for c in cases):
        errors.append(f"{p}: missing trigger-negative case")
    for c in cases:
        for key in ["id","task","required_outcomes","forbidden_outcomes"]:
            if key not in c:
                errors.append(f"{p}: case missing {key}")
        if not c.get("required_outcomes"):
            errors.append(f"{p}: case has no required outcomes")
        if not c.get("forbidden_outcomes"):
            errors.append(f"{p}: case has no forbidden outcomes")

if errors:
    print("EVAL VALIDATION FAILED")
    for e in errors:
        print("-", e)
    sys.exit(1)

print(f"OK: validated concrete eval contracts for {len(skills)} skills")
