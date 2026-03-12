import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { execFile } from "child_process";
import { existsSync } from "fs";

const MAX_TIMEOUT_MS = 600_000; // 10 分钟，足够处理图片生成等耗时操作
const DEFAULT_TIMEOUT_MS = 600_000; // 默认也设为 10 分钟
const MAX_OUTPUT_BYTES = 64 * 1024;
const COMMAND_CACHE_TTL_MS = 5 * 60 * 1000;
const RUN_COMMAND_EXECUTED_SIGNAL = "__RUN_COMMAND_EXECUTED__";
const RUN_COMMAND_DUPLICATE_SIGNAL = "__RUN_COMMAND_DUPLICATE_SKIPPED__";

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

type CommandCacheItem = {
  status: "success";
  command: string;
  cwd: string;
  at: number;
  summary: string;
};

const successCache = new Map<string, CommandCacheItem>();

function cleanupCache(now: number): void {
  for (const [k, item] of successCache.entries()) {
    if (now - item.at > COMMAND_CACHE_TTL_MS) successCache.delete(k);
  }
}

function toCacheKey(command: string, cwd: string): string {
  return `${cwd}\n${command.trim()}`;
}

function toOneLine(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function formatRunCommandResult(payload: {
  status: "success" | "failed" | "timeout" | "blocked" | "duplicate_skipped";
  command: string;
  cwd: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  signal?: string;
  note?: string;
}): string {
  const rows: string[] = [
    "[run_command]",
    `status: ${payload.status}`,
    `command: ${payload.command}`,
    `cwd: ${payload.cwd}`,
  ];
  if (payload.signal) rows.push(`signal: ${payload.signal}`);
  if (typeof payload.exitCode === "number") rows.push(`exit_code: ${payload.exitCode}`);
  if (payload.note) rows.push(`note: ${payload.note}`);
  if (payload.stdout) rows.push(`stdout:\n${payload.stdout}`);
  if (payload.stderr) rows.push(`stderr:\n${payload.stderr}`);
  return rows.join("\n");
}

export const run_command = tool(
  async (input: { command: string; timeout_ms?: number; working_directory?: string }) => {
    const blocked = isDangerous(input.command);
    const cwd = input.working_directory && existsSync(input.working_directory) ? input.working_directory : process.cwd();
    if (blocked) {
      return formatRunCommandResult({
        status: "blocked",
        command: input.command,
        cwd,
        note: blocked,
      });
    }

    const timeoutMs = Math.min(input.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const now = Date.now();
    cleanupCache(now);
    const cacheKey = toCacheKey(input.command, cwd);
    const hit = successCache.get(cacheKey);
    if (hit) {
      return formatRunCommandResult({
        status: "duplicate_skipped",
        command: input.command,
        cwd,
        signal: RUN_COMMAND_DUPLICATE_SIGNAL,
        note: `命中 ${Math.round((now - hit.at) / 1000)} 秒内成功执行缓存，跳过重复命令。最近成功摘要：${hit.summary}`,
      });
    }

    return new Promise<string>((resolve) => {
      const child = execFile(
        "/bin/sh",
        ["-c", input.command],
        { cwd, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES * 2, env: { ...process.env, LANG: "en_US.UTF-8" } },
        (error, stdout, stderr) => {
          const out = stdout ? truncate(stdout, MAX_OUTPUT_BYTES) : "";
          const err = stderr ? truncate(stderr, MAX_OUTPUT_BYTES) : "";
          if (!error) {
            const summarySeed = toOneLine(`${out}\n${err}`) || "(no output)";
            successCache.set(cacheKey, {
              status: "success",
              command: input.command,
              cwd,
              at: Date.now(),
              summary: summarySeed.slice(0, 160),
            });
            resolve(formatRunCommandResult({
              status: "success",
              command: input.command,
              cwd,
              stdout: out || "(no output)",
              stderr: err || undefined,
              exitCode: 0,
              signal: RUN_COMMAND_EXECUTED_SIGNAL,
            }));
            return;
          }
          if (error.killed) {
            resolve(formatRunCommandResult({
              status: "timeout",
              command: input.command,
              cwd,
              stdout: out || undefined,
              stderr: err || undefined,
              note: `Process killed after ${timeoutMs}ms`,
            }));
            return;
          }
          resolve(formatRunCommandResult({
            status: "failed",
            command: input.command,
            cwd,
            stdout: out || undefined,
            stderr: err || undefined,
            exitCode: typeof error.code === "number" ? error.code : undefined,
            note: typeof error.message === "string" ? error.message : undefined,
          }));
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
      timeout_ms: z.number().optional().describe("Max execution time in milliseconds (default 600000, max 600000 = 10 minutes)"),
      working_directory: z.string().optional().describe("Working directory for the command (defaults to server cwd)"),
    }),
  }
);
