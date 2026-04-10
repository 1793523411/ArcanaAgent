import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { execFileSync } from "child_process";
import { minimatch } from "minimatch";

/* ---------- fd / find detection (runs once at startup) ---------- */

function hasFd(): boolean {
  try {
    execFileSync("fd", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function hasFind(): boolean {
  try {
    execFileSync("find", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    // macOS `find` doesn't support --version but still exists
    try {
      execFileSync("find", ["."], { stdio: "pipe", timeout: 2000 });
      return true;
    } catch {
      return false;
    }
  }
}

const useFd = hasFd();
const useFind = hasFind();

/* ---------- Fast pattern search via fd ---------- */

const NOISE_DIRS = ["node_modules", ".git", "__pycache__", ".next", ".nuxt", "dist", "build"];
const MAX_OUTPUT_BYTES = 128 * 1024;

function searchWithFd(
  basePath: string,
  pattern: string,
  maxDepth: number,
  maxResults: number,
  includeHidden: boolean,
): string[] {
  const args: string[] = [];

  // fd uses regex by default; switch to glob mode for glob patterns
  if (pattern.includes("*") || pattern.includes("?") || pattern.includes("{")) {
    args.push("--glob", pattern);
  } else {
    args.push(pattern);
  }

  args.push(basePath);
  args.push("--max-depth", String(maxDepth));
  args.push("--max-results", String(maxResults));

  if (includeHidden) {
    args.push("--hidden");
  }

  // Exclude noise directories
  for (const dir of NOISE_DIRS) {
    args.push("--exclude", dir);
  }

  try {
    const output = execFileSync("fd", args, {
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: 15_000,
      encoding: "utf-8",
    });
    return output.trim().split("\n").filter(Boolean);
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string };
    // fd returns exit code 1 when no matches
    if (err.status === 1) return [];
    if (err.stdout && typeof err.stdout === "string" && err.stdout.trim()) {
      return err.stdout.trim().split("\n").filter(Boolean);
    }
    throw e;
  }
}

/* ---------- Fallback pattern search via find ---------- */

function searchWithFind(
  basePath: string,
  pattern: string,
  maxDepth: number,
  maxResults: number,
  includeHidden: boolean,
): string[] {
  const args: string[] = [basePath];

  args.push("-maxdepth", String(maxDepth));

  // Prune noise directories
  const pruneExprs: string[] = [];
  for (const dir of NOISE_DIRS) {
    pruneExprs.push("-name", dir, "-prune", "-o");
  }
  args.push(...pruneExprs);

  // Skip hidden files unless requested
  if (!includeHidden) {
    args.push("-not", "-name", ".*");
  }

  // Pattern matching: find uses -name with shell glob
  // Convert glob patterns like **/*.ts to just *.ts for find -name
  const findPattern = pattern.replace(/^\*\*\//, "");
  args.push("-name", findPattern, "-print");

  try {
    const output = execFileSync("find", args, {
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: 15_000,
      encoding: "utf-8",
    });
    const lines = output.trim().split("\n").filter(Boolean);
    return lines.slice(0, maxResults);
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string };
    if (err.stdout && typeof err.stdout === "string" && err.stdout.trim()) {
      return err.stdout.trim().split("\n").filter(Boolean).slice(0, maxResults);
    }
    throw e;
  }
}

/* ---------- Original Node.js tree collection (no-pattern or last-resort fallback) ---------- */

interface FileEntry {
  relativePath: string;
  isDirectory: boolean;
  depth: number;
}

function collectFiles(
  basePath: string,
  currentPath: string,
  pattern: string | undefined,
  maxDepth: number,
  includeHidden: boolean,
  maxResults: number,
  currentDepth: number = 0
): { entries: FileEntry[]; totalFound: number } {
  const entries: FileEntry[] = [];
  let totalFound = 0;

  let items: string[];
  try {
    items = readdirSync(currentPath);
  } catch {
    return { entries, totalFound };
  }

  // Sort: directories first, then alphabetically
  items.sort((a, b) => {
    try {
      const aIsDir = statSync(join(currentPath, a)).isDirectory();
      const bIsDir = statSync(join(currentPath, b)).isDirectory();
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
    } catch {
      // ignore stat errors
    }
    return a.localeCompare(b);
  });

  for (const item of items) {
    if (!includeHidden && item.startsWith(".")) continue;

    // Skip common noise directories
    if (currentDepth === 0 && NOISE_DIRS.includes(item)) {
      continue;
    }

    const fullPath = join(currentPath, item);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    const relPath = relative(basePath, fullPath);
    const isDir = stat.isDirectory();

    if (pattern) {
      // For directories, include them if they could contain matches
      if (isDir) {
        if (totalFound < maxResults) {
          // Only recurse if we haven't hit depth limit
          if (currentDepth < maxDepth) {
            const sub = collectFiles(basePath, fullPath, pattern, maxDepth, includeHidden, maxResults - totalFound, currentDepth + 1);
            if (sub.entries.length > 0) {
              entries.push({ relativePath: relPath, isDirectory: true, depth: currentDepth });
              entries.push(...sub.entries);
              totalFound += sub.totalFound + 1;
            }
          }
        }
      } else if (minimatch(relPath, pattern, { matchBase: true })) {
        entries.push({ relativePath: relPath, isDirectory: false, depth: currentDepth });
        totalFound++;
      }
    } else {
      entries.push({ relativePath: relPath, isDirectory: isDir, depth: currentDepth });
      totalFound++;

      if (isDir && currentDepth < maxDepth && totalFound < maxResults) {
        const sub = collectFiles(basePath, fullPath, pattern, maxDepth, includeHidden, maxResults - totalFound, currentDepth + 1);
        entries.push(...sub.entries);
        totalFound += sub.totalFound;
      }
    }

    if (totalFound >= maxResults) break;
  }

  return { entries, totalFound };
}

/* ---------- Formatting ---------- */

function formatTree(entries: FileEntry[], maxResults: number, totalFound: number): string {
  const lines: string[] = [];

  for (const entry of entries.slice(0, maxResults)) {
    const indent = "  ".repeat(entry.depth);
    const suffix = entry.isDirectory ? "/" : "";
    const name = entry.relativePath.split("/").pop() || entry.relativePath;
    lines.push(`${indent}${name}${suffix}`);
  }

  if (totalFound > maxResults) {
    lines.push(`\n... and ${totalFound - maxResults} more entries`);
  }

  return lines.join("\n");
}

function formatFlatList(paths: string[], basePath: string, maxResults: number): string {
  const lines: string[] = [];
  const shown = paths.slice(0, maxResults);
  for (const p of shown) {
    // Show relative path from basePath
    const rel = p.startsWith(basePath) ? relative(basePath, p) : p;
    lines.push(rel || p);
  }
  if (paths.length > maxResults) {
    lines.push(`\n... and ${paths.length - maxResults} more entries`);
  }
  return lines.join("\n");
}

/* ---------- Tool ---------- */

export const list_files = tool(
  (input: {
    path: string;
    pattern?: string;
    max_depth?: number;
    max_results?: number;
    include_hidden?: boolean;
  }) => {
    const maxDepth = Math.min(input.max_depth ?? 3, 10);
    const maxResults = Math.min(input.max_results ?? 200, 1000);
    const includeHidden = input.include_hidden ?? false;

    let stat;
    try {
      stat = statSync(input.path);
    } catch {
      return `[error] Path not found: ${input.path}`;
    }

    if (!stat.isDirectory()) {
      return `[error] Not a directory: ${input.path}`;
    }

    try {
      // Fast path: when pattern is specified, use fd → find → Node.js fallback
      if (input.pattern) {
        let results: string[] | null = null;
        let backend = "node";

        if (useFd) {
          try {
            results = searchWithFd(input.path, input.pattern, maxDepth, maxResults, includeHidden);
            backend = "fd";
          } catch {
            results = null; // fall through to find
          }
        }

        if (results === null && useFind) {
          try {
            results = searchWithFind(input.path, input.pattern, maxDepth, maxResults, includeHidden);
            backend = "find";
          } catch {
            results = null; // fall through to Node.js
          }
        }

        if (results !== null) {
          if (results.length === 0) {
            return `No files matching pattern '${input.pattern}' found in ${input.path}`;
          }
          const header = `Files matching '${input.pattern}' in ${input.path} (via ${backend}):`;
          return `${header}\n\n${formatFlatList(results, input.path, maxResults)}`;
        }

        // Final fallback: Node.js collectFiles
      }

      // Tree mode (no pattern) or Node.js fallback for pattern
      const { entries, totalFound } = collectFiles(
        input.path,
        input.path,
        input.pattern,
        maxDepth,
        includeHidden,
        maxResults
      );

      if (entries.length === 0) {
        return input.pattern
          ? `No files matching pattern '${input.pattern}' found in ${input.path}`
          : `Directory is empty: ${input.path}`;
      }

      const header = input.pattern
        ? `Files matching '${input.pattern}' in ${input.path}:`
        : `Contents of ${input.path}:`;

      return `${header}\n\n${formatTree(entries, maxResults, totalFound)}`;
    } catch (e) {
      return `[error] ${e instanceof Error ? e.message : String(e)}`;
    }
  },
  {
    name: "list_files",
    description:
      "List files and directories in a tree-like format. Supports glob pattern filtering and depth control. " +
      "Uses fd (fast) → find (fallback) for pattern search. " +
      "Automatically skips node_modules, .git, and other common noise directories.",
    schema: z.object({
      path: z.string().describe("Directory to list (absolute path)"),
      pattern: z.string().optional().nullable().describe("Glob pattern to filter, e.g. '*.ts', '**/*.test.js'"),
      max_depth: z.number().optional().nullable().describe("Max recursion depth (default 3, max 10)"),
      max_results: z.number().optional().nullable().describe("Max entries to return (default 200, max 1000)"),
      include_hidden: z.boolean().optional().nullable().describe("Include hidden files/dirs (default false)"),
    }),
  }
);
