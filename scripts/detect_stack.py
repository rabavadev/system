#!/usr/bin/env python3
from pathlib import Path
import json

root = Path.cwd()
pkg = root / "package.json"
result = {}

if pkg.exists():
    data = json.loads(pkg.read_text(encoding="utf-8"))
    deps = {}
    deps.update(data.get("dependencies", {}))
    deps.update(data.get("devDependencies", {}))
    result["package_manager"] = (
        "pnpm" if (root/"pnpm-lock.yaml").exists() else
        "yarn" if (root/"yarn.lock").exists() else
        "npm" if (root/"package-lock.json").exists() else
        "unknown"
    )
    for key in ["next", "react", "react-dom", "typescript", "vite", "vue", "svelte", "@playwright/test"]:
        if key in deps:
            result[key] = deps[key]

for marker, label in [
    ("pyproject.toml", "python"),
    ("go.mod", "go"),
    ("Cargo.toml", "rust"),
    ("composer.json", "php"),
]:
    if (root/marker).exists():
        result[label] = marker

print(json.dumps(result, indent=2))
