#!/usr/bin/env python3
"""Run a command while a local dev server is alive, then cleanly stop it."""
import argparse, subprocess, time, urllib.request, sys, os, signal

ap = argparse.ArgumentParser()
ap.add_argument("--server", required=True, help="Server command, e.g. 'npm run dev'")
ap.add_argument("--url", required=True, help="Health URL")
ap.add_argument("--timeout", type=int, default=45)
ap.add_argument("command", nargs=argparse.REMAINDER)
args = ap.parse_args()

proc = subprocess.Popen(args.server, shell=True)
try:
    deadline = time.time() + args.timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(args.url, timeout=2) as r:
                if r.status < 500:
                    break
        except Exception:
            time.sleep(1)
    else:
        raise SystemExit("Server did not become ready.")

    if not args.command:
        print("Server ready:", args.url)
    else:
        cmd = args.command[1:] if args.command and args.command[0] == "--" else args.command
        raise SystemExit(subprocess.call(cmd))
finally:
    proc.terminate()
    try:
        proc.wait(timeout=8)
    except subprocess.TimeoutExpired:
        proc.kill()
