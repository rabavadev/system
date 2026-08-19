#!/usr/bin/env python3
import shutil, subprocess, sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
cmd = shutil.which("skills-ref")
if not cmd:
    print("SKIP: official `skills-ref` executable is not installed in this environment.")
    print("The pack's own validator still ran. When skills-ref is available, run this script again.")
    sys.exit(0)

failures = []
for skill in sorted((root/"skills").glob("*/SKILL.md")):
    proc = subprocess.run([cmd, "validate", str(skill.parent)], capture_output=True, text=True)
    if proc.returncode:
        failures.append((skill.parent.name, proc.stdout + proc.stderr))
if failures:
    print("OFFICIAL VALIDATION FAILED")
    for name, msg in failures:
        print(f"\n[{name}]\n{msg}")
    sys.exit(2)
print("OK: official skills-ref validated all skills")
