---
name: playwright-web-capture
description: This skill should be used when users need to capture a webpage as PDF and Markdown with local images, full-page and main-content screenshots for verification, and all outputs in a single unique directory. Use for archiving pages, offline reading, or comparing extracted content to the original layout.
---

# Playwright Web Capture

## Overview

Capture a URL into a **unique output directory** with: full-page screenshot (for verifying output vs original), main-content screenshot when detectable, PDF, and Markdown. Main-content images are downloaded locally and referenced in Markdown with relative paths (`./images/...`). No API keys; runs locally with Playwright.

## Prerequisites

Install dependencies and Chromium:

```bash
pip install -r <SKILL_PATH>/requirements.txt
python3 -m playwright install chromium
```

## Core usage

Run the capture script; it creates a **new unique directory** for this run and prints its path:

```bash
python <SKILL_PATH>/scripts/capture.py "<url>"
```

Example with custom output base:

```bash
python <SKILL_PATH>/scripts/capture.py "https://example.com/article" -o ./captures
```

Output directory name pattern: `web_capture_YYYYMMDD_HHMMSS` (e.g. `web_capture_20250305_143022`). All artifacts for that run go inside it.

## Outputs in the run directory

| Output | Description |
|--------|-------------|
| `full_page.png` | Full-page screenshot; use to compare with Markdown/PDF and confirm consistency with original. |
| `main_content.png` | Screenshot of the main content block (only if a main region was detected). |
| `page.pdf` | Full-page PDF (print-style, with background). |
| `content.md` | Markdown of main (or full) content; image links are relative (`./images/...`). |
| `images/` | Downloaded images from main content (`image_001.png`, etc.). |
| `manifest.txt` | URL, title, and list of output files. |

## Workflow

1. **Identify the URL** and, if needed, a base directory for outputs (`-o`).
2. **Run the script** with the URL; capture runs headless and creates the unique directory.
3. **Use the printed path** to open the directory; open `content.md` and `page.pdf` for the document, and `full_page.png` (and `main_content.png` when present) to verify that the Markdown/PDF match the original page.
4. **Share or archive** the whole directory so Markdown and images stay together.

## Common options

- `-o, --output-dir <path>` – Base directory for the unique run folder (default: current directory).
- `--viewport-width`, `--viewport-height` – Browser viewport size (default: 1440×900).
- `--wait-ms <ms>` – Wait after load before capture (default: 2000).
- `--no-scroll` – Disable scrolling (use if lazy-load causes issues).
- `--timeout <ms>` – Navigation timeout (default: 30000).
- `--wait-for-selector <CSS>` – Wait for selector visible before capture (for SPAs).
- `--main-selector <CSS>` – Override main content region (when auto-detection is wrong).
- `--storage-state <PATH>` – Load Playwright storage state (cookies/localStorage) for logged-in pages.
- `--pdf-main-only` – Also export `page_main.pdf` with only the main content region.
- `--user-agent <STRING>` – Custom User-Agent for browser and image requests.

## Login and request behavior

- **Login state**: Use `--storage-state path/to/state.json` so the capture runs as a logged-in session. You must create the state file first: run `python <SKILL_PATH>/scripts/save_storage_state.py "https://site-you-log-in.com" -o state.json`, log in in the opened browser, then press Enter in the terminal to save. After that, run capture with `--storage-state state.json`. See `references/login_state_guide.md` for a full step-by-step and practice example.
- **Request headers**: Image downloads use a default Chrome-like User-Agent and the page URL as Referer. Override with `--user-agent` if a site blocks default requests.

## Verifying Markdown vs original page

Use the screenshots produced in the same run:

- **full_page.png** – Compare with the opened page; use it to check that `content.md` and `page.pdf` reflect the same content and layout.
- **main_content.png** – When present, confirms the region used for Markdown and local images.

Images in `content.md` point to `./images/...`; keep the run directory intact so those links resolve.

## Resources

### scripts/capture.py

Main capture script: loads the URL with Playwright, takes full-page and (when possible) main-content screenshots, exports PDF, extracts main content HTML, downloads images to `images/`, builds Markdown with relative image references, and writes everything into a unique subdirectory. Run without overwriting previous runs.

### references/options.md

Details on main-content selectors, output layout, and CLI options.
