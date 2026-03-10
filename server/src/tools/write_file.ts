import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";

const MAX_WRITE_SIZE = 1024 * 1024;

function decodeContent(input: { content?: string; content_base64?: string }): string {
  if (typeof input.content_base64 === "string" && input.content_base64.length > 0) {
    try {
      return Buffer.from(input.content_base64, "base64").toString("utf-8");
    } catch {
      throw new Error("content_base64 is not valid base64");
    }
  }
  if (typeof input.content === "string") return input.content;
  throw new Error("Provide either 'content' (string) or 'content_base64' (base64-encoded string). For large HTML/CSS use content_base64 to avoid JSON escaping issues.");
}

export const write_file = tool(
  (input: { path: string; content?: string; content_base64?: string; append?: boolean }) => {
    const content = decodeContent(input);
    if (content.length > MAX_WRITE_SIZE) {
      return `[error] Content too large (${content.length} chars, max ${MAX_WRITE_SIZE}). Write in smaller chunks.`;
    }

    const blocked = ["/etc/", "/usr/", "/bin/", "/sbin/", "/boot/", "/proc/", "/sys/"];
    if (blocked.some((prefix) => input.path.startsWith(prefix))) {
      return `[error] Writing to system directory is not allowed: ${input.path}`;
    }

    try {
      const dir = dirname(input.path);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      if (input.append) {
        const { appendFileSync } = require("fs") as typeof import("fs");
        appendFileSync(input.path, content, "utf-8");
      } else {
        writeFileSync(input.path, content, "utf-8");
      }

      const lines = content.split("\n").length;
      const bytes = Buffer.byteLength(content, "utf-8");
      return `OK: ${input.append ? "appended to" : "wrote"} ${input.path} (${lines} lines, ${bytes} bytes)`;
    } catch (e) {
      return `[error] ${e instanceof Error ? e.message : String(e)}`;
    }
  },
  {
    name: "write_file",
    description:
      "Write content to a file. Creates parent directories if they don't exist. " +
      "Use for saving generated content, config files, scripts, search results, etc. " +
      "For large or HTML/CSS content with many quotes, use content_base64 (base64-encoded string) instead of content to avoid JSON escaping errors.",
    schema: z.object({
      path: z.string().describe("Absolute path to the file to write"),
      content: z.string().optional().describe("The text content to write. Use content_base64 for large or HTML/CSS to avoid escaping issues."),
      content_base64: z.string().optional().describe("Base64-encoded content. Prefer this for large HTML/CSS/XML to avoid JSON quote escaping."),
      append: z.boolean().optional().describe("If true, append to the file instead of overwriting (default: false)"),
    }),
  }
);
