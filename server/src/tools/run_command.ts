import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { execFile } from "child_process";
import { existsSync } from "fs";

const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

function truncate(s: string, max: number): string {
  if (Buffer.byteLength(s) <= max) return s;
  const buf = Buffer.from(s);
  const head = buf.subarray(0, max / 2).toString("utf-8");
  const tail = buf.subarray(buf.length - max / 2).toString("utf-8");
  return head + "\n...[truncated]...\n" + tail;
}

export const run_command = tool(
  async (input: { command: string; timeout_ms?: number; working_directory?: string }) => {
    const timeoutMs = Math.min(input.timeout_ms ?? 30_000, MAX_TIMEOUT_MS);
    const cwd = input.working_directory && existsSync(input.working_directory) ? input.working_directory : process.cwd();

    return new Promise<string>((resolve) => {
      const child = execFile(
        "/bin/sh",
        ["-c", input.command],
        { cwd, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES * 2, env: { ...process.env, LANG: "en_US.UTF-8" } },
        (error, stdout, stderr) => {
          const parts: string[] = [];
          if (stdout) parts.push(truncate(stdout, MAX_OUTPUT_BYTES));
          if (stderr) parts.push("[stderr]\n" + truncate(stderr, MAX_OUTPUT_BYTES));
          if (error) {
            if (error.killed) {
              parts.push(`[timeout] Process killed after ${timeoutMs}ms`);
            } else if (error.code !== undefined) {
              parts.push(`[exit_code] ${error.code}`);
            } else {
              parts.push(`[error] ${error.message}`);
            }
          }
          resolve(parts.join("\n") || "(no output)");
        }
      );
      child.stdin?.end();
    });
  },
  {
    name: "run_command",
    description:
      "Execute a shell command. Use for running skill scripts, installing dependencies, " +
      "or any system operation. Returns stdout, stderr, and exit code.",
    schema: z.object({
      command: z.string().describe("The shell command to execute, e.g. 'python script.py --arg value' or 'bash hello.sh'"),
      timeout_ms: z.number().optional().describe("Max execution time in milliseconds (default 30000, max 120000)"),
      working_directory: z.string().optional().describe("Working directory for the command (defaults to server cwd)"),
    }),
  }
);
