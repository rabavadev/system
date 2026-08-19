#!/usr/bin/env python3
from pathlib import Path
import re, json, sys

ROOT = Path(__file__).resolve().parents[1]
skills_dir = ROOT / "skills"
errors = []

name_re = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")

for skill_file in sorted(skills_dir.glob("*/SKILL.md")):
    text = skill_file.read_text(encoding="utf-8")
    if not text.startswith("---\n"):
        errors.append(f"{skill_file}: missing YAML frontmatter")
        continue
    parts = text.split("---\n", 2)
    if len(parts) < 3:
        errors.append(f"{skill_file}: malformed frontmatter")
        continue
    fm = parts[1]
    name = None
    desc = None
    for line in fm.splitlines():
        if line.startswith("name:"):
            name = line.split(":", 1)[1].strip()
        if line.startswith("description:"):
            desc = line.split(":", 1)[1].strip()
    folder = skill_file.parent.name
    if not name:
        errors.append(f"{skill_file}: missing name")
    elif name != folder:
        errors.append(f"{skill_file}: name '{name}' != folder '{folder}'")
    elif not name_re.match(name):
        errors.append(f"{skill_file}: invalid skill name '{name}'")
    if not desc or len(desc) < 25:
        errors.append(f"{skill_file}: description missing/too short")
    if len(text) > 14000:
        errors.append(f"{skill_file}: SKILL.md too large; move detail into references/")

manifest_path = skills_dir / "MANIFEST.json"
if manifest_path.exists():
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    declared = {x["name"] for x in manifest.get("skills", [])}
    actual = {p.parent.name for p in skills_dir.glob("*/SKILL.md")}
    if declared != actual:
        errors.append("skills/MANIFEST.json does not match skill folders")

if errors:
    print("SKILL VALIDATION FAILED")
    for e in errors:
        print("-", e)
    sys.exit(1)

print(f"OK: validated {len(list(skills_dir.glob('*/SKILL.md')))} skills")
