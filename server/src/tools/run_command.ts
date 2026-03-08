import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { execFile } from "child_process";
import { existsSync } from "fs";

const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

const DANGEROUS_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)?\/\s*$/,
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/\s*$/,
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\/\s*$/,
  /\brm\s+-rf\s+\/\b/,
  /\brm\s+-fr\s+\/\b/,
  /\bmkfs\b/,
  /\bdd\s+.*\bof=\/dev\/[sh]d/,
  /\b:(){ :\|:& };:/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\binit\s+0\b/,
  /\bhalt\b/,
  />\s*\/dev\/[sh]d/,
  /\bchmod\s+-R\s+777\s+\/\s*$/,
  /\bchown\s+-R\s+.*\s+\/\s*$/,
  /\bformat\s+[cCdD]:/,
];

function isDangerous(command: string): string | null {
  const trimmed = command.trim();
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmed)) {
      return `Blocked: this command matches a dangerous pattern (${pattern.source}). If you really need this, ask the user to run it manually.`;
    }
  }
  return null;
}

function truncate(s: string, max: number): string {
  if (Buffer.byteLength(s) <= max) return s;
  const buf = Buffer.from(s);
  const head = buf.subarray(0, max / 2).toString("utf-8");
  const tail = buf.subarray(buf.length - max / 2).toString("utf-8");
  return head + "\n...[truncated]...\n" + tail;
}

export const run_command = tool(
  async (input: { command: string; timeout_ms?: number; working_directory?: string }) => {
    const blocked = isDangerous(input.command);
    if (blocked) return blocked;

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
      "or any system operation. Returns stdout, stderr, and exit code. " +
      "Dangerous system-level commands (rm -rf /, mkfs, dd, shutdown, etc.) are blocked for safety.",
    schema: z.object({
      command: z.string().describe("The shell command to execute, e.g. 'python script.py --arg value' or 'bash hello.sh'"),
      timeout_ms: z.number().optional().describe("Max execution time in milliseconds (default 30000, max 120000)"),
      working_directory: z.string().optional().describe("Working directory for the command (defaults to server cwd)"),
    }),
  }
);
