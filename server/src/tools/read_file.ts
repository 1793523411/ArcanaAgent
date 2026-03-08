import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { readFileSync, existsSync, statSync } from "fs";

const MAX_FILE_SIZE = 256 * 1024;

export const read_file = tool(
  (input: { path: string; offset?: number; limit?: number }) => {
    if (!existsSync(input.path)) {
      return `[error] File not found: ${input.path}`;
    }
    const stat = statSync(input.path);
    if (!stat.isFile()) {
      return `[error] Not a file: ${input.path}`;
    }
    if (stat.size > MAX_FILE_SIZE && !input.limit) {
      return `[error] File too large (${stat.size} bytes, max ${MAX_FILE_SIZE}). Use offset/limit to read a portion.`;
    }

    try {
      const content = readFileSync(input.path, "utf-8");
      const lines = content.split("\n");
      const start = Math.max(0, (input.offset ?? 1) - 1);
      const end = input.limit ? start + input.limit : lines.length;
      const slice = lines.slice(start, end);
      return slice.map((line, i) => `${start + i + 1}|${line}`).join("\n") || "(empty file)";
    } catch (e) {
      return `[error] ${e instanceof Error ? e.message : String(e)}`;
    }
  },
  {
    name: "read_file",
    description:
      "Read the contents of a file. Returns numbered lines. " +
      "Use to inspect script outputs, config files, or skill reference docs.",
    schema: z.object({
      path: z.string().describe("Absolute path to the file to read"),
      offset: z.number().optional().describe("Start reading from this line number (1-based, default 1)"),
      limit: z.number().optional().describe("Max number of lines to return"),
    }),
  }
);
