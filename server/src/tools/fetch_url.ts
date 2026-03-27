import { tool } from "@langchain/core/tools";
import { z } from "zod";

const DEFAULT_MAX_LENGTH = 32 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_FETCH_BYTES = 2 * 1024 * 1024; // 2MB hard limit

/**
 * Strip HTML tags and extract readable text content.
 * Handles common elements: scripts, styles, line breaks, paragraphs.
 */
function htmlToText(html: string): string {
  return html
    // Remove script/style blocks entirely
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    // Block-level elements → newlines
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article|header|footer)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr\s*\/?>/gi, "\n---\n")
    // Remove remaining tags
    .replace(/<[^>]+>/g, "")
    // Decode common HTML entities
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    // Clean up whitespace
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const fetch_url = tool(
  async (input: { url: string; max_length?: number; format?: "text" | "html" | "json" }) => {
    const maxLen = Math.min(input.max_length ?? DEFAULT_MAX_LENGTH, DEFAULT_MAX_LENGTH * 4);
    const format = input.format ?? "text";

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await fetch(input.url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "ArcanaAgent/1.0 (fetch_url tool)",
          Accept: format === "json" ? "application/json" : "text/html,text/plain,*/*",
        },
        redirect: "follow",
      });

      clearTimeout(timer);

      if (!response.ok) {
        return `[error] HTTP ${response.status} ${response.statusText} for ${input.url}`;
      }

      const contentType = response.headers.get("content-type") ?? "";
      const contentLength = parseInt(response.headers.get("content-length") ?? "0", 10);
      if (contentLength > MAX_FETCH_BYTES) {
        return `[error] Response too large (${(contentLength / 1024 / 1024).toFixed(1)}MB). Max allowed: ${MAX_FETCH_BYTES / 1024 / 1024}MB.`;
      }

      const raw = await response.text();

      let result: string;
      if (format === "json") {
        // Try to pretty-print JSON
        try {
          result = JSON.stringify(JSON.parse(raw), null, 2);
        } catch {
          result = raw;
        }
      } else if (format === "html") {
        result = raw;
      } else {
        // "text" — strip HTML if content looks like HTML
        result = contentType.includes("html") || raw.trimStart().startsWith("<") ? htmlToText(raw) : raw;
      }

      if (result.length > maxLen) {
        result = result.slice(0, maxLen) + `\n\n... [truncated at ${(maxLen / 1024).toFixed(0)}KB]`;
      }

      return `[url: ${input.url}]\n[status: ${response.status}]\n[content-type: ${contentType}]\n\n${result}`;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        return `[error] Request timed out after ${TIMEOUT_MS / 1000}s for ${input.url}`;
      }
      return `[error] ${e instanceof Error ? e.message : String(e)}`;
    }
  },
  {
    name: "fetch_url",
    description:
      "Fetch the content of a URL. Use this to read web pages, API responses, documentation, " +
      "or any HTTP resource. By default returns plain text (HTML tags stripped). " +
      "Use format='html' for raw HTML, format='json' for JSON responses.",
    schema: z.object({
      url: z.string().describe("The URL to fetch (must start with http:// or https://)"),
      max_length: z
        .number()
        .optional()
        .describe("Maximum response length in characters (default: 32KB, max: 128KB)"),
      format: z
        .enum(["text", "html", "json"])
        .optional()
        .describe("Response format: 'text' (default, strips HTML), 'html' (raw), 'json' (pretty-printed)"),
    }),
  }
);
