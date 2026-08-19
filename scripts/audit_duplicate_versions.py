#!/usr/bin/env python3
from pathlib import Path
import re

root = Path.cwd()
pattern = re.compile(r"(?i)(?:[-_.](?:v\d+|new\d*|final\d*|old|backup|copy))(?=\.[^.]+$)")
skip = {".git", "node_modules", ".next", "dist", "build", "coverage", ".venv", "venv"}

hits = []
for p in root.rglob("*"):
    if not p.is_file():
        continue
    if any(part in skip for part in p.parts):
        continue
    if pattern.search(p.name):
        hits.append(str(p))

if hits:
    print("Potential duplicate/versioned implementation files:")
    for h in hits:
        print("-", h)
else:
    print("No obvious v2/new/final/backup/copy filenames found.")
