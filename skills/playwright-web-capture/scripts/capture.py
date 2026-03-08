#!/usr/bin/env python3
"""
Capture a webpage with Playwright: full-page and main-content screenshots,
PDF export, main content as Markdown with images downloaded and relatively referenced.
All outputs go into a single unique directory per run.
"""

import argparse
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Dict, Optional
from urllib.parse import urljoin, urlparse

DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

import requests
from bs4 import BeautifulSoup
from markdownify import markdownify as md
from playwright.sync_api import sync_playwright


# Selectors to try for main content, in order of preference
MAIN_CONTENT_SELECTORS = [
    "main",
    "article",
    '[role="main"]',
    ".post-content",
    ".article-body",
    ".entry-content",
    ".content",
    "#content",
    ".main-content",
    "#main-content",
]


def make_unique_output_dir(base_dir: Path) -> Path:
    """Create a unique output directory under base_dir."""
    base_dir = Path(base_dir).resolve()
    base_dir.mkdir(parents=True, exist_ok=True)
    timestamp = time.strftime("%Y%m%d_%H%M%S")
    name = f"web_capture_{timestamp}"
    out = base_dir / name
    idx = 0
    while out.exists():
        idx += 1
        out = base_dir / f"{name}_{idx}"
    out.mkdir(parents=True)
    return out


def resolve_url(base_url: str, src: str) -> str:
    """Resolve relative image src to absolute URL."""
    return urljoin(base_url, src)


def download_image(
    url: str,
    dest_path: Path,
    timeout: int = 30,
    headers: Optional[Dict[str, str]] = None,
) -> bool:
    """Download image to dest_path. Return True on success."""
    try:
        r = requests.get(url, timeout=timeout, stream=True, headers=headers or {})
        r.raise_for_status()
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        with open(dest_path, "wb") as f:
            for chunk in r.iter_content(chunk_size=8192):
                f.write(chunk)
        return True
    except Exception as e:
        print(f"Warning: failed to download {url}: {e}", file=sys.stderr)
        return False


def get_extension(url: str, default: str = ".png") -> str:
    """Infer file extension from URL path."""
    path = urlparse(url).path
    if "." in path:
        ext = Path(path).suffix
        if ext.lower() in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"):
            return ext
    return default


def extract_and_download_images(
    soup: BeautifulSoup,
    page_url: str,
    images_dir: Path,
    timeout: int = 30,
    headers: Optional[Dict[str, str]] = None,
    max_workers: int = 8,
) -> Dict[str, str]:
    """
    Find all img in soup, download to images_dir in parallel, return mapping old_src -> relative path.
    """
    mapping: Dict[str, str] = {}
    images_dir = Path(images_dir)
    images_dir.mkdir(parents=True, exist_ok=True)
    seen_urls = set()
    index = [0]
    tasks = []

    def next_name(url: str) -> str:
        index[0] += 1
        ext = get_extension(url)
        return f"image_{index[0]:03d}{ext}"

    for img in soup.find_all("img", src=True):
        src = img["src"].strip()
        if not src or src.startswith("data:"):
            continue
        abs_url = resolve_url(page_url, src)
        if abs_url in seen_urls:
            continue
        seen_urls.add(abs_url)
        fname = next_name(abs_url)
        dest = images_dir / fname
        rel_path = f"./images/{fname}"
        tasks.append((src, abs_url, dest, rel_path))

    req_headers = headers or {}
    if "User-Agent" not in req_headers:
        req_headers = {**req_headers, "User-Agent": DEFAULT_USER_AGENT}
    if "Referer" not in req_headers and page_url:
        req_headers = {**req_headers, "Referer": page_url}

    def do_one(task: tuple) -> Optional[tuple]:
        src, abs_url, dest, rel_path = task
        if download_image(abs_url, dest, timeout=timeout, headers=req_headers):
            return (src, abs_url, rel_path)
        return None

    with ThreadPoolExecutor(max_workers=min(max_workers, len(tasks) or 1)) as executor:
        futures = {executor.submit(do_one, t): t for t in tasks}
        for future in as_completed(futures):
            result = future.result()
            if result:
                src, abs_url, rel_path = result
                mapping[src] = rel_path
                mapping[abs_url] = rel_path

    return mapping


# Alt text considered generic (will be replaced with 图1, 图2, ...)
GENERIC_ALT = frozenset(
    {"", "copy.png", "image.png", "img", "image", "picture", "photo", "截图", "图片"}
)


def replace_img_src_in_soup(
    soup: BeautifulSoup, mapping: Dict[str, str], page_url: str = ""
) -> None:
    """Replace img src in soup in-place; set generic alt to 图1, 图2, ..."""
    imgs = soup.find_all("img", src=True)
    for i, img in enumerate(imgs):
        src = img["src"].strip()
        if not src:
            continue
        if src in mapping:
            img["src"] = mapping[src]
        else:
            abs_url = resolve_url(page_url, src)
            if abs_url in mapping:
                img["src"] = mapping[abs_url]
        alt = (img.get("alt") or "").strip().lower()
        if alt in GENERIC_ALT or (len(alt) <= 12 and alt.endswith(".png")):
            img["alt"] = f"图{i + 1}"


def validate_and_fix_markdown_images(content_md: str, images_dir: Path) -> str:
    """
    Ensure every downloaded image is referenced in the markdown.
    Append any missing refs at the end; warn on broken refs. Return (possibly fixed) content_md.
    """
    images_dir = Path(images_dir)
    if not images_dir.exists():
        return content_md
    # Referenced images in markdown: extract path from ![alt](path)
    ref_pattern = re.compile(r"!\[[^\]]*\]\((\./images/[^)]+)\)")
    referenced = set()
    for m in ref_pattern.finditer(content_md):
        path = m.group(1).strip()
        # normalize to filename
        name = path.replace("\\", "/").split("/")[-1]
        referenced.add(name)
    # Actual files on disk
    on_disk = {f.name for f in images_dir.iterdir() if f.is_file()}
    missing_in_md = on_disk - referenced
    broken_refs = referenced - on_disk
    for name in sorted(broken_refs):
        print(f"Warning: markdown references missing file images/{name}", file=sys.stderr)
    if not missing_in_md:
        return content_md
    # Append missing images so nothing is lost
    appendix = ["\n\n---\n\n*以下图片已下载但未在正文中引用，已自动追加：*\n"]
    for i, fname in enumerate(sorted(missing_in_md), start=1):
        appendix.append(f"\n![图{i}](./images/{fname})")
    appendix.append("\n")
    return content_md + "".join(appendix)


def find_main_content_element(page):
    """Return the Playwright locator for main content, or None to use body."""
    for sel in MAIN_CONTENT_SELECTORS:
        try:
            loc = page.locator(sel).first
            if loc.count() > 0:
                # Prefer element with substantial height
                box = loc.bounding_box()
                if box and box.get("height", 0) > 200:
                    return loc
        except Exception:
            continue
    return None


def run_capture(
    url: str,
    output_base: Path,
    viewport_width: int = 1440,
    viewport_height: int = 900,
    wait_after_load_ms: int = 2000,
    scroll_to_load_lazy: bool = True,
    timeout_ms: int = 30000,
    wait_for_selector: Optional[str] = None,
    main_selector: Optional[str] = None,
    storage_state: Optional[Path] = None,
    pdf_main_only: bool = False,
    user_agent: Optional[str] = None,
) -> Path:
    """
    Capture URL into a new unique directory under output_base.
    Returns the path to the created output directory.
    """
    out_dir = make_unique_output_dir(output_base)
    images_dir = out_dir / "images"
    images_dir.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context_opts = {
            "viewport": {"width": viewport_width, "height": viewport_height},
            "ignore_https_errors": True,
        }
        if user_agent:
            context_opts["user_agent"] = user_agent
        if storage_state and Path(storage_state).exists():
            context_opts["storage_state"] = str(storage_state)
        context = browser.new_context(**context_opts)
        page = context.new_page()
        # Wait for full load (HTML + resources) so page is not in loading state
        page.goto(url, wait_until="load", timeout=timeout_ms)
        page.wait_for_timeout(wait_after_load_ms)
        # Optional: wait for network idle so dynamic content and lazy assets finish
        try:
            page.wait_for_load_state("networkidle", timeout=min(10000, timeout_ms))
            page.wait_for_timeout(500)
        except Exception:
            pass
        # Optional: wait for specific selector (e.g. SPA content)
        if wait_for_selector:
            try:
                page.wait_for_selector(wait_for_selector, state="visible", timeout=min(15000, timeout_ms))
                page.wait_for_timeout(500)
            except Exception as e:
                print(f"Warning: wait-for-selector failed: {e}", file=sys.stderr)

        if scroll_to_load_lazy:
            try:
                page.evaluate(
                    """
                    async () => {
                        const step = 400;
                        let last = 0;
                        while (true) {
                            window.scrollBy(0, step);
                            await new Promise(r => setTimeout(r, 150));
                            const now = window.scrollY + window.innerHeight;
                            if (now >= document.body.scrollHeight - 10 || now === last) break;
                            last = now;
                        }
                        window.scrollTo(0, 0);
                    }
                    """
                )
                page.wait_for_timeout(300)
            except Exception as e:
                print(f"Warning: scroll failed: {e}", file=sys.stderr)

        # Full page screenshot (for comparing with output)
        page.screenshot(path=out_dir / "full_page.png", full_page=True)
        # PDF
        page.pdf(path=out_dir / "page.pdf", print_background=True)

        main_loc = None
        if main_selector:
            try:
                loc = page.locator(main_selector).first
                if loc.count() > 0 and loc.bounding_box():
                    main_loc = loc
            except Exception as e:
                print(f"Warning: main-selector failed: {e}", file=sys.stderr)
        if main_loc is None:
            main_loc = find_main_content_element(page)
        has_main_screenshot = False
        if main_loc:
            main_loc.screenshot(path=out_dir / "main_content.png")
            has_main_screenshot = True

        page_title = page.title() or "Untitled"
        main_html = ""
        if main_loc:
            try:
                main_html = main_loc.inner_html()
            except Exception:
                main_html = page.content()
        else:
            main_html = page.content()

        # Optional: PDF of main content only
        if pdf_main_only and main_html:
            try:
                pdf_page = context.new_page()
                pdf_page.set_content(
                    main_html,
                    wait_until="load",
                    timeout=timeout_ms,
                    base_url=url,
                )
                pdf_page.pdf(path=out_dir / "page_main.pdf", print_background=True)
                pdf_page.close()
            except Exception as e:
                print(f"Warning: main-content PDF failed: {e}", file=sys.stderr)

        browser.close()

    # Parse main content HTML, download images, build markdown
    soup = BeautifulSoup(main_html, "lxml")
    # Remove code/script/style so output is text + images only (no code blocks)
    for tag in soup.find_all(["script", "style", "pre", "code", "noscript", "svg"]):
        tag.decompose()
    # Remove inline style/on* attributes so markdown is clean
    for tag in soup.find_all(True):
        tag.attrs = {k: v for k, v in tag.attrs.items() if k in ("href", "src", "alt", "title")}
    download_headers = {}
    if user_agent:
        download_headers["User-Agent"] = user_agent
    download_headers["Referer"] = url
    mapping = extract_and_download_images(
        soup, url, images_dir, headers=download_headers
    )
    replace_img_src_in_soup(soup, mapping, page_url=url)
    html_str = str(soup)
    markdown_body = md(
        html_str,
        heading_style="ATX",
        strip=["script", "style", "pre", "code", "noscript", "svg"],
        keep_inline_images_in=["td", "th"],
    )
    # Drop lines that look like code (minified JS/CSS or JSON blobs)
    lines = []
    for line in markdown_body.splitlines():
        s = line.strip()
        if not s:
            lines.append("")
            continue
        # Skip lines that look like code (minified JS, JSON blobs, CSS)
        if s.startswith("!function") or (s.startswith("window.") and "=" in s):
            continue
        if s.startswith(".") and "{" in s and "}" in s and len(s) > 100:
            continue
        if ("{" in s and "}" in s) and (s.count("{") + s.count("}") > 4) and len(s) > 200:
            continue
        lines.append(line)
    markdown_body = "\n".join(lines)
    # Collapse excessive blank lines
    while "\n\n\n" in markdown_body:
        markdown_body = markdown_body.replace("\n\n\n", "\n\n")
    content_md = f"# {page_title}\n\n\n{markdown_body}"
    content_md = validate_and_fix_markdown_images(content_md, images_dir)
    (out_dir / "content.md").write_text(content_md, encoding="utf-8")

    # Write a small manifest
    manifest_lines = [
        f"url={url}",
        f"title={page_title}",
        "full_page_screenshot=full_page.png",
        "pdf=page.pdf",
        "markdown=content.md",
        "images_dir=images/",
    ]
    if has_main_screenshot:
        manifest_lines.insert(3, "main_content_screenshot=main_content.png")
    if pdf_main_only and (out_dir / "page_main.pdf").exists():
        manifest_lines.append("pdf_main=page_main.pdf")
    (out_dir / "manifest.txt").write_text("\n".join(manifest_lines) + "\n", encoding="utf-8")

    return out_dir


def main():
    parser = argparse.ArgumentParser(
        description="Capture webpage: screenshots, PDF, Markdown with local images. Outputs to a unique directory."
    )
    parser.add_argument("url", help="Web page URL to capture")
    parser.add_argument(
        "-o",
        "--output-dir",
        type=Path,
        default=Path("."),
        help="Base directory for output (default: current directory). A unique subdir is created.",
    )
    parser.add_argument("--viewport-width", type=int, default=1440)
    parser.add_argument("--viewport-height", type=int, default=900)
    parser.add_argument("--wait-ms", type=int, default=2000, help="Wait after load (ms)")
    parser.add_argument("--no-scroll", action="store_true", help="Disable scroll-for-lazy-load")
    parser.add_argument("--timeout", type=int, default=30000, help="Navigation timeout (ms)")
    parser.add_argument(
        "--wait-for-selector",
        type=str,
        default=None,
        metavar="CSS",
        help="Wait for this CSS selector to be visible before capture (for SPAs).",
    )
    parser.add_argument(
        "--main-selector",
        type=str,
        default=None,
        metavar="CSS",
        help="Use this CSS selector for main content instead of auto-detection.",
    )
    parser.add_argument(
        "--storage-state",
        type=Path,
        default=None,
        metavar="PATH",
        help="Load cookies/localStorage from this Playwright storage state file (for logged-in pages).",
    )
    parser.add_argument(
        "--pdf-main-only",
        action="store_true",
        help="Also export a PDF containing only the main content region (page_main.pdf).",
    )
    parser.add_argument(
        "--user-agent",
        type=str,
        default=None,
        metavar="STRING",
        help="User-Agent for browser and image requests (default: Chrome-like).",
    )
    args = parser.parse_args()

    out = run_capture(
        url=args.url,
        output_base=args.output_dir,
        viewport_width=args.viewport_width,
        viewport_height=args.viewport_height,
        wait_after_load_ms=args.wait_ms,
        scroll_to_load_lazy=not args.no_scroll,
        timeout_ms=args.timeout,
        wait_for_selector=args.wait_for_selector,
        main_selector=args.main_selector,
        storage_state=args.storage_state,
        pdf_main_only=args.pdf_main_only,
        user_agent=args.user_agent,
    )
    print(str(out))
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
