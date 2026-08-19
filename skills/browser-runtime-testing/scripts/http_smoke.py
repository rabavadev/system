#!/usr/bin/env python3
import argparse, urllib.request, sys

ap = argparse.ArgumentParser()
ap.add_argument("url")
ap.add_argument("--expect", type=int, default=200)
args = ap.parse_args()

try:
    with urllib.request.urlopen(args.url, timeout=10) as r:
        body = r.read(1024)
        print("status:", r.status)
        print("content-type:", r.headers.get("content-type"))
        print("sample-bytes:", len(body))
        sys.exit(0 if r.status == args.expect else 2)
except Exception as e:
    print("request failed:", e)
    sys.exit(2)
