import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { minimatch } from "minimatch";

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
    if (currentDepth === 0 && ["node_modules", ".git", "__pycache__", ".next", ".nuxt", "dist", "build"].includes(item)) {
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
      "Automatically skips node_modules, .git, and other common noise directories.",
    schema: z.object({
      path: z.string().describe("Directory to list (absolute path)"),
      pattern: z.string().optional().describe("Glob pattern to filter, e.g. '*.ts', '**/*.test.js'"),
      max_depth: z.number().optional().describe("Max recursion depth (default 3, max 10)"),
      max_results: z.number().optional().describe("Max entries to return (default 200, max 1000)"),
      include_hidden: z.boolean().optional().describe("Include hidden files/dirs (default false)"),
    }),
  }
);
