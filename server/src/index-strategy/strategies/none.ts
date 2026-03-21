import { execFileSync } from "child_process";
import { readdirSync, statSync, readFileSync } from "fs";
import { join, relative } from "path";
import type { IndexStrategy, IndexStatus, SearchResult, SearchOptions } from "../types.js";

const NOISE_DIRS = new Set([
  "node_modules", ".git", "__pycache__", ".next", ".nuxt",
  "dist", "build", ".agents", ".venv", "venv", "vendor",
  "target", ".cache", "coverage",
]);

const PROJECT_CONFIG_FILES = [
  "package.json", "Cargo.toml", "go.mod", "pyproject.toml",
  "pom.xml", "build.gradle", "Makefile", "CMakeLists.txt",
  "composer.json", "Gemfile", "requirements.txt",
];

function hasRipgrep(): boolean {
  try {
    execFileSync("rg", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const useRipgrep = hasRipgrep();

function collectFileTree(
  basePath: string,
  currentPath: string,
  maxDepth: number,
  maxFiles: number,
  depth: number = 0,
): string[] {
  if (depth > maxDepth) return [];
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(currentPath);
  } catch {
    return results;
  }
  entries.sort();
  for (const entry of entries) {
    if (entry.startsWith(".") || NOISE_DIRS.has(entry)) continue;
    if (results.length >= maxFiles) break;
    const fullPath = join(currentPath, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }
    const relPath = relative(basePath, fullPath);
    if (stat.isDirectory()) {
      results.push(relPath + "/");
      if (depth < maxDepth) {
        const sub = collectFileTree(basePath, fullPath, maxDepth, maxFiles - results.length, depth + 1);
        results.push(...sub);
      }
    } else {
      results.push(relPath);
    }
    if (results.length >= maxFiles) break;
  }
  return results;
}

function extractProjectMeta(workspacePath: string): string[] {
  const meta: string[] = [];
  for (const configFile of PROJECT_CONFIG_FILES) {
    const configPath = join(workspacePath, configFile);
    try {
      const content = readFileSync(configPath, "utf-8");
      if (configFile === "package.json") {
        const pkg = JSON.parse(content) as Record<string, unknown>;
        meta.push(`Project: ${pkg.name ?? "unknown"} (${configFile})`);
        if (pkg.description) meta.push(`  Description: ${pkg.description}`);
        const deps = Object.keys((pkg.dependencies ?? {}) as Record<string, string>);
        if (deps.length > 0) meta.push(`  Dependencies: ${deps.slice(0, 15).join(", ")}${deps.length > 15 ? ` ... +${deps.length - 15}` : ""}`);
      } else if (configFile === "go.mod") {
        const moduleLine = content.match(/^module\s+(.+)$/m);
        if (moduleLine) meta.push(`Project: ${moduleLine[1]} (${configFile})`);
      } else if (configFile === "pyproject.toml") {
        const nameLine = content.match(/^name\s*=\s*"(.+)"/m);
        if (nameLine) meta.push(`Project: ${nameLine[1]} (${configFile})`);
      } else if (configFile === "Cargo.toml") {
        const nameLine = content.match(/^name\s*=\s*"(.+)"/m);
        if (nameLine) meta.push(`Project: ${nameLine[1]} (${configFile})`);
      } else {
        meta.push(`Build: ${configFile}`);
      }
    } catch {
      // file doesn't exist or can't be parsed
    }
  }
  return meta;
}

function extractTopSymbols(workspacePath: string, maxFiles: number = 10): string[] {
  if (!useRipgrep) return [];
  // Use ripgrep to find top-level exports/definitions in entry-like files
  const pattern = String.raw`(export\s+)?(async\s+)?function\s+\w+|export\s+(class|interface|type|enum|const)\s+\w+|^(def|class)\s+\w+`;
  try {
    const output = execFileSync("rg", [
      pattern,
      workspacePath,
      "--max-count", "5",
      "--max-depth", "3",
      "--glob", "!node_modules",
      "--glob", "!.git",
      "--glob", "!dist",
      "--glob", "!build",
      "--glob", "!__pycache__",
      "--glob", "!*.min.js",
      "-n",
      "--no-heading",
    ], {
      maxBuffer: 64 * 1024,
      timeout: 10_000,
      encoding: "utf-8",
    });
    const lines = output.trim().split("\n").filter(Boolean).slice(0, maxFiles * 5);
    // Group by file
    const byFile = new Map<string, string[]>();
    for (const line of lines) {
      // rg -n --no-heading format: filepath:linenum:content
      const match = line.match(/^(.+?):(\d+):(.*)$/);
      if (!match) continue;
      const file = relative(workspacePath, match[1]);
      const rest = match[3];
      // Extract just the symbol name
      const symMatch = rest.match(/(?:function|class|interface|type|enum|const|def)\s+(\w+)/);
      if (symMatch) {
        if (!byFile.has(file)) byFile.set(file, []);
        byFile.get(file)!.push(symMatch[1]);
      }
    }
    const symbols: string[] = [];
    for (const [file, names] of [...byFile.entries()].slice(0, maxFiles)) {
      symbols.push(`${file}: ${[...new Set(names)].join(", ")}`);
    }
    return symbols;
  } catch {
    return [];
  }
}

function searchWithRipgrep(
  query: string,
  workspacePath: string,
  options?: SearchOptions,
): SearchResult[] {
  const maxResults = options?.maxResults ?? 10;
  const args: string[] = [
    "-e", query, workspacePath,
    "--max-count", String(maxResults * 2),
    "--no-heading", "-n",
    "--glob", "!node_modules",
    "--glob", "!.git",
    "--glob", "!dist",
    "--glob", "!build",
    "--glob", "!__pycache__",
    "--glob", "!*.min.js",
    "--glob", "!*.min.css",
  ];
  if (options?.fileGlob) {
    args.push("--glob", options.fileGlob);
  }
  try {
    const output = execFileSync("rg", args, {
      maxBuffer: 64 * 1024,
      timeout: 15_000,
      encoding: "utf-8",
    });
    return parseRgOutput(output, workspacePath, maxResults, query);
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string };
    if (err.status === 1) return [];
    if (err.stdout && err.stdout.trim()) {
      return parseRgOutput(err.stdout, workspacePath, maxResults, query);
    }
    return [];
  }
}

function parseRgOutput(output: string, workspacePath: string, maxResults: number, query: string): SearchResult[] {
  const results: SearchResult[] = [];
  const lines = output.trim().split("\n").filter(Boolean);
  const queryLower = query.toLowerCase();
  for (const line of lines) {
    if (results.length >= maxResults) break;
    // Format: filepath:linenum:content
    const match = line.match(/^(.+?):(\d+):(.*)$/);
    if (!match) continue;
    const file = relative(workspacePath, match[1]);
    const lineNum = parseInt(match[2], 10);
    const content = match[3].trim();
    // Simple scoring: exact match > case-insensitive > partial
    const contentLower = content.toLowerCase();
    let score = 0.5;
    if (content.includes(query)) score = 1.0;
    else if (contentLower.includes(queryLower)) score = 0.8;
    else score = 0.6;
    // Boost if file name contains query
    if (file.toLowerCase().includes(queryLower)) score = Math.min(1.0, score + 0.1);
    results.push({ file, line: lineNum, content, score });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, maxResults);
}

function searchWithGrep(
  query: string,
  workspacePath: string,
  options?: SearchOptions,
): SearchResult[] {
  const maxResults = options?.maxResults ?? 10;
  const args: string[] = [
    "-rn",
    "--exclude-dir=node_modules", "--exclude-dir=.git",
    "--exclude-dir=dist", "--exclude-dir=build",
    "-m", String(maxResults * 2),
  ];
  if (options?.fileGlob) {
    args.push(`--include=${options.fileGlob}`);
  }
  args.push("--", query, workspacePath);
  try {
    const output = execFileSync("grep", args, {
      maxBuffer: 64 * 1024,
      timeout: 15_000,
      encoding: "utf-8",
    });
    return parseRgOutput(output, workspacePath, maxResults, query);
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string };
    if (err.status === 1) return [];
    if (err.stdout && err.stdout.trim()) {
      return parseRgOutput(err.stdout, workspacePath, maxResults, query);
    }
    return [];
  }
}

export class NoneStrategy implements IndexStrategy {
  readonly type = "none" as const;
  private workspacePath: string = "";
  private fileCount: number = 0;
  private lastUpdated?: string;

  async checkDependencies(): Promise<{ ready: boolean; missing: string[] }> {
    return { ready: true, missing: [] };
  }

  async buildIndex(workspacePath: string): Promise<void> {
    this.workspacePath = workspacePath;
    // Count files to populate status
    const files = collectFileTree(workspacePath, workspacePath, 5, 5000);
    this.fileCount = files.filter(f => !f.endsWith("/")).length;
    this.lastUpdated = new Date().toISOString();
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    if (!this.workspacePath) return [];
    if (useRipgrep) {
      return searchWithRipgrep(query, this.workspacePath, options);
    }
    return searchWithGrep(query, this.workspacePath, options);
  }

  async getSnapshot(maxTokens: number = 2048): Promise<string> {
    if (!this.workspacePath) return "No workspace set. Run project_index build first.";

    const sections: string[] = [];

    // 1. Project metadata
    const meta = extractProjectMeta(this.workspacePath);
    if (meta.length > 0) {
      sections.push("## Project Info\n" + meta.join("\n"));
    }

    // 2. Directory tree (estimate ~4 chars per token)
    const maxTreeChars = Math.floor(maxTokens * 4 * 0.6);
    const fileTree = collectFileTree(this.workspacePath, this.workspacePath, 4, 300);
    let treeStr = fileTree.join("\n");
    if (treeStr.length > maxTreeChars) {
      treeStr = treeStr.slice(0, maxTreeChars) + "\n... (truncated)";
    }
    sections.push("## File Tree\n" + treeStr);

    // 3. Top symbols from key files
    const symbols = extractTopSymbols(this.workspacePath, 15);
    if (symbols.length > 0) {
      sections.push("## Key Symbols\n" + symbols.join("\n"));
    }

    const snapshot = sections.join("\n\n");
    // Rough truncation to fit token budget
    const maxChars = maxTokens * 4;
    if (snapshot.length > maxChars) {
      return snapshot.slice(0, maxChars) + "\n... (truncated to fit token budget)";
    }
    return snapshot;
  }

  getStatus(): IndexStatus {
    return {
      strategy: "none",
      ready: !!this.workspacePath,
      fileCount: this.fileCount,
      lastUpdated: this.lastUpdated,
    };
  }
}
