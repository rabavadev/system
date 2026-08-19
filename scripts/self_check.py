#!/usr/bin/env python3
from pathlib import Path
import subprocess, sys

root = Path(__file__).resolve().parents[1]
checks = [
    root/"scripts"/"validate_skills.py",
    root/"scripts"/"validate_evals.py",
    root/"scripts"/"validate_official_skills_ref.py",
]
failed = False
for check in checks:
    print("\n==", check.name, "==")
    r = subprocess.run([sys.executable, str(check)], cwd=root)
    if r.returncode:
        failed = True
if failed:
    raise SystemExit(2)
print("\nALL AVAILABLE PACK CHECKS PASSED")
