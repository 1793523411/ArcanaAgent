import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";

const MAX_WRITE_SIZE = 1024 * 1024;

export const write_file = tool(
  (input: { path: string; content: string; append?: boolean }) => {
    if (input.content.length > MAX_WRITE_SIZE) {
      return `[error] Content too large (${input.content.length} chars, max ${MAX_WRITE_SIZE}). Write in smaller chunks.`;
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
        appendFileSync(input.path, input.content, "utf-8");
      } else {
        writeFileSync(input.path, input.content, "utf-8");
      }

      const lines = input.content.split("\n").length;
      const bytes = Buffer.byteLength(input.content, "utf-8");
      return `OK: ${input.append ? "appended to" : "wrote"} ${input.path} (${lines} lines, ${bytes} bytes)`;
    } catch (e) {
      return `[error] ${e instanceof Error ? e.message : String(e)}`;
    }
  },
  {
    name: "write_file",
    description:
      "Write content to a file. Creates parent directories if they don't exist. " +
      "Use for saving generated content, config files, scripts, search results, etc.",
    schema: z.object({
      path: z.string().describe("Absolute path to the file to write"),
      content: z.string().describe("The full content to write to the file"),
      append: z.boolean().optional().describe("If true, append to the file instead of overwriting (default: false)"),
    }),
  }
);
