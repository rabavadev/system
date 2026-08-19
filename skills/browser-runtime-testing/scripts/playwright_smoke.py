#!/usr/bin/env python3
"""Optional helper. Requires Python Playwright already installed in the environment."""
import argparse, sys

ap = argparse.ArgumentParser()
ap.add_argument("url")
ap.add_argument("--screenshot")
args = ap.parse_args()

try:
    from playwright.sync_api import sync_playwright
except Exception:
    print("Playwright is not installed. Use the repository's existing browser/E2E tooling instead.")
    sys.exit(3)

console_errors = []
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
    response = page.goto(args.url, wait_until="networkidle")
    print("status:", response.status if response else "no response")
    print("title:", page.title())
    if args.screenshot:
        page.screenshot(path=args.screenshot, full_page=True)
        print("screenshot:", args.screenshot)
    if console_errors:
        print("console-errors:")
        for e in console_errors:
            print("-", e)
    browser.close()
sys.exit(2 if console_errors else 0)
