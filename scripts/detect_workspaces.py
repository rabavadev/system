#!/usr/bin/env python3
from pathlib import Path
import json, re

root = Path.cwd()
result = {"root": str(root), "signals": [], "lockfiles": [], "manifests": []}

for f in ["pnpm-workspace.yaml","turbo.json","nx.json","lerna.json","rush.json","package.json","pyproject.toml","Cargo.toml","go.work"]:
    if (root/f).exists():
        result["signals"].append(f)

for pat in ["**/package.json","**/pyproject.toml","**/Cargo.toml","**/go.mod"]:
    for p in root.glob(pat):
        if not any(x in p.parts for x in ["node_modules",".git","dist","build",".next",".venv","venv"]):
            result["manifests"].append(str(p.relative_to(root)))

for f in ["pnpm-lock.yaml","package-lock.json","yarn.lock","bun.lockb","bun.lock","uv.lock","poetry.lock","Cargo.lock"]:
    for p in root.glob(f"**/{f}"):
        if not any(x in p.parts for x in ["node_modules",".git","dist","build",".next",".venv","venv"]):
            result["lockfiles"].append(str(p.relative_to(root)))

print(json.dumps(result, indent=2))
