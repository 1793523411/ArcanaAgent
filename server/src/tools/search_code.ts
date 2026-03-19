import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { execFileSync } from "child_process";

const MAX_OUTPUT_BYTES = 64 * 1024;

function hasRipgrep(): boolean {
  try {
    execFileSync("rg", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

interface RgMatch {
  type: string;
  data: {
    path?: { text: string };
    lines?: { text: string };
    line_number?: number;
    submatches?: Array<{ match: { text: string }; start: number; end: number }>;
  };
}

function searchWithRipgrep(
  pattern: string,
  path: string,
  fileGlob?: string,
  caseSensitive?: boolean,
  contextLines?: number,
  maxResults?: number
): string {
  const args: string[] = [
    pattern,
    path,
    "--json",
    "--max-count", String(maxResults ?? 50),
  ];

  if (contextLines !== undefined && contextLines > 0) {
    args.push("-C", String(Math.min(contextLines, 10)));
  }

  if (caseSensitive === false) {
    args.push("-i");
  }

  if (fileGlob) {
    args.push("--glob", fileGlob);
  }

  // Skip common non-code directories
  args.push(
    "--glob", "!node_modules",
    "--glob", "!.git",
    "--glob", "!dist",
    "--glob", "!build",
    "--glob", "!__pycache__",
    "--glob", "!*.min.js",
    "--glob", "!*.min.css",
  );

  try {
    const output = execFileSync("rg", args, {
      maxBuffer: MAX_OUTPUT_BYTES * 2,
      timeout: 30_000,
      encoding: "utf-8",
    });
    return formatRgJsonOutput(output, maxResults ?? 50);
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    // rg returns exit code 1 when no matches found
    if (err.status === 1) {
      return "No matches found.";
    }
    if (err.stdout && typeof err.stdout === "string" && err.stdout.length > 0) {
      return formatRgJsonOutput(err.stdout, maxResults ?? 50);
    }
    throw new Error(`ripgrep failed: ${err.stderr || String(e)}`);
  }
}

function formatRgJsonOutput(jsonOutput: string, maxResults: number): string {
  const lines = jsonOutput.trim().split("\n").filter(Boolean);
  const fileMatches = new Map<string, string[]>();
  let matchCount = 0;

  for (const line of lines) {
    try {
      const entry: RgMatch = JSON.parse(line);
      if (entry.type === "match" && entry.data.path?.text && entry.data.lines?.text) {
        const file = entry.data.path.text;
        const lineNum = entry.data.line_number ?? 0;
        const text = entry.data.lines.text.replace(/\n$/, "");
        if (!fileMatches.has(file)) {
          fileMatches.set(file, []);
        }
        fileMatches.get(file)!.push(`  ${lineNum}|${text}`);
        matchCount++;
      } else if (entry.type === "context" && entry.data.path?.text && entry.data.lines?.text) {
        const file = entry.data.path.text;
        const lineNum = entry.data.line_number ?? 0;
        const text = entry.data.lines.text.replace(/\n$/, "");
        if (fileMatches.has(file)) {
          fileMatches.get(file)!.push(`  ${lineNum} ${text}`);
        }
      }
    } catch {
      // skip malformed JSON lines
    }
  }

  if (matchCount === 0) return "No matches found.";

  const parts: string[] = [];
  for (const [file, lines] of fileMatches) {
    parts.push(`${file}\n${lines.join("\n")}`);
  }

  let result = parts.join("\n\n");
  if (matchCount >= maxResults) {
    result += `\n\n... results capped at ${maxResults} matches. Use file_glob or a more specific pattern to narrow results.`;
  }

  // Truncate to 64KB
  if (result.length > MAX_OUTPUT_BYTES) {
    result = result.slice(0, MAX_OUTPUT_BYTES) + "\n... [output truncated at 64KB]";
  }

  return `Found ${matchCount} match(es) in ${fileMatches.size} file(s):\n\n${result}`;
}

function searchWithGrep(
  pattern: string,
  path: string,
  fileGlob?: string,
  caseSensitive?: boolean,
  contextLines?: number,
  maxResults?: number
): string {
  const max = maxResults ?? 50;
  const ctx = Math.min(contextLines ?? 2, 10);
  const args: string[] = ["-rn"];
  if (caseSensitive === false) args.push("-i");
  if (ctx > 0) args.push("-C", String(ctx));
  if (fileGlob) args.push(`--include=${fileGlob}`);
  args.push("--exclude-dir=node_modules", "--exclude-dir=.git", "--exclude-dir=dist", "--exclude-dir=build");
  args.push("-m", String(max));
  args.push("--", pattern, path);

  try {
    const output = execFileSync("grep", args, {
      maxBuffer: MAX_OUTPUT_BYTES * 2,
      timeout: 30_000,
      encoding: "utf-8",
    });
    if (!output.trim()) return "No matches found.";
    let result = output;
    if (result.length > MAX_OUTPUT_BYTES) {
      result = result.slice(0, MAX_OUTPUT_BYTES) + "\n... [output truncated at 64KB]";
    }
    return result;
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string };
    if (err.status === 1) return "No matches found.";
    if (err.stdout && err.stdout.length > 0) return err.stdout;
    throw new Error(`grep failed: ${String(e)}`);
  }
}

const useRipgrep = hasRipgrep();

export const search_code = tool(
  (input: {
    pattern: string;
    path?: string;
    file_glob?: string;
    case_sensitive?: boolean;
    context_lines?: number;
    max_results?: number;
  }) => {
    const searchPath = input.path || ".";
    const maxResults = Math.min(input.max_results ?? 50, 200);
    const contextLines = Math.min(input.context_lines ?? 2, 10);

    try {
      if (useRipgrep) {
        return searchWithRipgrep(
          input.pattern,
          searchPath,
          input.file_glob,
          input.case_sensitive,
          contextLines,
          maxResults
        );
      }
      return searchWithGrep(
        input.pattern,
        searchPath,
        input.file_glob,
        input.case_sensitive,
        contextLines,
        maxResults
      );
    } catch (e) {
      return `[error] ${e instanceof Error ? e.message : String(e)}`;
    }
  },
  {
    name: "search_code",
    description:
      "Search for code patterns using regex across files. Uses ripgrep (rg) for fast searching with fallback to grep. " +
      "Results are grouped by file with line numbers. Automatically skips node_modules, .git, dist, and build directories.",
    schema: z.object({
      pattern: z.string().describe("Regex pattern to search for (ripgrep syntax)"),
      path: z.string().optional().describe("Directory or file to search in (defaults to workspace root)"),
      file_glob: z.string().optional().describe("File glob filter, e.g. '*.ts', '*.{py,js}'"),
      case_sensitive: z.boolean().optional().describe("Case sensitive search (default true)"),
      context_lines: z.number().optional().describe("Context lines before and after each match (default 2, max 10)"),
      max_results: z.number().optional().describe("Maximum number of matching lines (default 50, max 200)"),
    }),
  }
);
