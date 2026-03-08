#!/usr/bin/env python3
"""
Save Playwright storage state (cookies + localStorage) after you log in in the browser.
Use the output file with: capture.py --storage-state <path> "https://..."
"""

import argparse
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright


def main():
    parser = argparse.ArgumentParser(
        description="Open a browser, let you log in, then save login state to a file for use with --storage-state."
    )
    parser.add_argument("url", help="URL to open (e.g. https://lifexue.com)")
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default=Path("state.json"),
        help="Output path for the state file (default: state.json)",
    )
    parser.add_argument(
        "--viewport-width", type=int, default=1280,
        help="Browser width (default: 1280)",
    )
    parser.add_argument(
        "--viewport-height", type=int, default=800,
        help="Browser height (default: 800)",
    )
    args = parser.parse_args()

    out = Path(args.output).resolve()
    print(f"Opening browser at: {args.url}", file=sys.stderr)
    print("Log in in the browser, then come back here and press Enter to save state.", file=sys.stderr)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        context = browser.new_context(
            viewport={"width": args.viewport_width, "height": args.viewport_height},
        )
        page = context.new_page()
        page.goto(args.url, wait_until="domcontentloaded")
        input()
        context.storage_state(path=str(out))
        browser.close()

    print(f"Saved to {out}", file=sys.stderr)
    print(str(out))
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
