#!/usr/bin/env python3
from pathlib import Path
import argparse, json, sys

ap = argparse.ArgumentParser()
ap.add_argument("contract")
ap.add_argument("result")
args = ap.parse_args()

contract = json.loads(Path(args.contract).read_text(encoding="utf-8"))
result = json.loads(Path(args.result).read_text(encoding="utf-8"))

case = next((c for c in contract["cases"] if c["id"] == result.get("case_id")), None)
if not case:
    raise SystemExit("case_id not found in contract")

problems = []
if bool(result.get("triggered")) != bool(case["should_trigger"]):
    problems.append("trigger mismatch")

obs = result.get("observed_outcomes", {})
for req in case["required_outcomes"]:
    if not obs.get(req, False):
        problems.append("missing required outcome: " + req)

forb = result.get("forbidden_outcomes", {})
for item in case["forbidden_outcomes"]:
    if forb.get(item, False):
        problems.append("forbidden outcome occurred: " + item)

if problems:
    print("FAIL")
    for p in problems:
        print("-", p)
    sys.exit(2)

print("PASS")
