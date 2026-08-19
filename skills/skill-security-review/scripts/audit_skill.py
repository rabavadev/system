#!/usr/bin/env python3
from pathlib import Path
import re, sys, json

target = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
patterns = {
    "network": re.compile(r"\b(curl|wget|requests\.|urllib|fetch\(|axios|http://|https://)\b", re.I),
    "process": re.compile(r"\b(subprocess|os\.system|exec\(|eval\(|powershell|bash\s+-c|sh\s+-c)\b", re.I),
    "destructive": re.compile(r"\b(rm\s+-rf|rmdir\s+/s|Remove-Item\s+.*-Recurse|shutil\.rmtree)\b", re.I),
    "secrets": re.compile(r"\b(API_KEY|TOKEN|PASSWORD|SECRET|PRIVATE_KEY|os\.environ|getenv)\b", re.I),
    "obfuscation": re.compile(r"\b(base64\.b64decode|fromCharCode|atob\(|marshal\.loads|pickle\.loads)\b", re.I),
    "policy-bypass": re.compile(r"(ignore .*instructions|bypass .*permission|disable .*safety|skip .*permission)", re.I),
}
hits = []
for p in target.rglob("*"):
    if not p.is_file() or any(x in p.parts for x in [".git","node_modules","dist","build"]):
        continue
    if p.stat().st_size > 2_000_000:
        continue
    try:
        text = p.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        continue
    for i, line in enumerate(text.splitlines(), 1):
        for kind, rx in patterns.items():
            if rx.search(line):
                hits.append({"file": str(p.relative_to(target)), "line": i, "kind": kind, "text": line[:240]})
print(json.dumps({"target": str(target), "findings": hits}, indent=2))
sys.exit(2 if hits else 0)
