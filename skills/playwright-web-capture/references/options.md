# Capture script options and behavior

## Main content detection

The script tries these CSS selectors in order to find the main content block; the first with height > 200px is used:

- `main`
- `article`
- `[role="main"]`
- `.post-content`, `.article-body`, `.entry-content`
- `.content`, `#content`, `.main-content`, `#main-content`

If none match, the full page HTML is used for Markdown and only the full-page screenshot and PDF are produced (no `main_content.png`).

## Output directory

Each run creates a **unique** subdirectory under the given base (or current directory):

- Name pattern: `web_capture_YYYYMMDD_HHMMSS` (and `_1`, `_2` if the directory already exists).
- All outputs for that run live in this directory so one run does not overwrite another.

## Output files

| File | Description |
|------|-------------|
| `full_page.png` | Full-page screenshot (for comparing with Markdown/PDF). |
| `main_content.png` | Screenshot of the main content area (only if a main block was found). |
| `page.pdf` | Full-page PDF with background. |
| `page_main.pdf` | Present when `--pdf-main-only` is used: PDF of the main content region only. |
| `content.md` | Markdown of main (or full) content: **text and images only** (script, style, code blocks removed). Images use relative `./images/...`; generic alts become 图1, 图2, …. Before save, a **validation** runs: any downloaded image not referenced in the text is appended at the end (with a short note); broken refs are reported to stderr. |
| `images/` | Downloaded images (parallel download; User-Agent and Referer sent). |
| `manifest.txt` | URL, title, and list of output files. |

## CLI options

- `url` – Required. Page URL to capture.
- `-o, --output-dir` – Base directory for the unique output folder (default: current directory).
- `--viewport-width`, `--viewport-height` – Browser viewport (default: 1440×900).
- `--wait-ms` – Milliseconds to wait after load (default: 2000). Page is waited with `load` then `networkidle` before screenshot so content is not in loading state.
- `--no-scroll` – Disable scrolling to trigger lazy-loaded images.
- `--timeout` – Navigation timeout in ms (default: 30000).
- `--wait-for-selector CSS` – Wait for this selector to be visible before capture (useful for SPAs that render content late).
- `--main-selector CSS` – Use this selector for main content instead of auto-detection (when the wrong region is chosen).
- `--storage-state PATH` – Load cookies/localStorage from a Playwright storage state file (for logged-in pages). To create one: run `scripts/save_storage_state.py "<login_url>" -o state.json`, log in in the browser, press Enter; then use `--storage-state state.json`. See `references/login_state_guide.md` for details.
- `--pdf-main-only` – Also export `page_main.pdf` containing only the main content region.
- `--user-agent STRING` – User-Agent for browser and image requests (default: Chrome-like). Referer is set to the page URL for image downloads.

Images are downloaded in parallel (thread pool). Generic or missing image alt text (e.g. "copy.png", "image") is replaced with 图1, 图2, … in the Markdown.

## Verifying Markdown vs original

Use `full_page.png` (and, when present, `main_content.png`) to visually compare the rendered page with the generated `content.md` and `page.pdf`. Images in `content.md` point to local files in `images/`.
