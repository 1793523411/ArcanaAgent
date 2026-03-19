import { execSync } from "child_process";
import { existsSync } from "fs";
import { join, extname, relative } from "path";
import { serverLogger } from "../lib/logger.js";

/** Detected project type and its diagnostic command */
export interface DiagnosticInfo {
  projectType: string;
  command: string;
  /** For project-wide commands, relative path of the edited file to filter output by. */
  filterRelPath?: string;
}

/** Skip diagnostics for non-code files */
const SKIP_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".yaml", ".yml", ".toml",
  ".env", ".lock", ".csv", ".svg", ".png", ".jpg",
  ".gif", ".ico", ".woff", ".woff2", ".ttf", ".eot",
  ".map", ".log", ".gitignore", ".dockerignore",
]);

/**
 * Cached project type per workspace+extension.
 * null = detection ran but no matching project type found.
 * undefined (missing key) = not yet detected.
 */
type ProjectType =
  | "typescript"
  | "python-ruff"
  | "python"
  | "go"
  | "rust";

const projectTypeCache = new Map<string, ProjectType | null>();

/** Detect project type from config files (cached per workspace+ext). */
function detectProjectType(
  ext: string,
  workspacePath: string,
): ProjectType | null {
  const cacheKey = `${workspacePath}:${ext}`;
  if (projectTypeCache.has(cacheKey)) {
    return projectTypeCache.get(cacheKey) ?? null;
  }

  let pt: ProjectType | null = null;

  if ([".ts", ".tsx", ".js", ".jsx"].includes(ext)) {
    if (existsSync(join(workspacePath, "tsconfig.json"))) pt = "typescript";
  } else if (ext === ".py") {
    const hasRuff =
      existsSync(join(workspacePath, "ruff.toml")) ||
      existsSync(join(workspacePath, ".ruff.toml"));
    if (hasRuff) {
      pt = "python-ruff";
    } else if (
      existsSync(join(workspacePath, "pyproject.toml")) ||
      existsSync(join(workspacePath, "setup.py"))
    ) {
      pt = "python";
    }
  } else if (ext === ".go") {
    if (existsSync(join(workspacePath, "go.mod"))) pt = "go";
  } else if (ext === ".rs") {
    if (existsSync(join(workspacePath, "Cargo.toml"))) pt = "rust";
  }

  projectTypeCache.set(cacheKey, pt);
  return pt;
}

/** Build the actual command string — called fresh each time so filePath is never stale. */
function buildCommand(projectType: ProjectType, filePath: string): string {
  switch (projectType) {
    case "typescript":
      return "npx tsc --noEmit 2>&1 | head -50";
    case "python-ruff":
      return `ruff check "${filePath}" 2>&1 | head -20`;
    case "python":
      return `python -m py_compile "${filePath}" 2>&1`;
    case "go":
      return "go vet ./... 2>&1 | head -50";
    case "rust":
      return "cargo check --message-format short 2>&1 | head -50";
  }
}

/** Whether this project type runs a project-wide check (vs file-specific). */
function isProjectWideCheck(projectType: ProjectType): boolean {
  return projectType === "typescript" || projectType === "go" || projectType === "rust";
}

/**
 * Detect the appropriate diagnostic command based on file extension
 * and project configuration files in the workspace.
 * Project type detection is cached; command is built fresh per filePath.
 */
export function detectDiagnosticCommand(
  filePath: string,
  workspacePath: string,
): DiagnosticInfo | null {
  const ext = extname(filePath).toLowerCase();
  if (SKIP_EXTENSIONS.has(ext)) return null;

  const pt = detectProjectType(ext, workspacePath);
  if (!pt) return null;

  return {
    projectType: pt,
    command: buildCommand(pt, filePath),
    filterRelPath: isProjectWideCheck(pt) ? relative(workspacePath, filePath) : undefined,
  };
}

/**
 * Run a diagnostic command and return error output, or null if clean.
 */
export async function runDiagnostic(
  command: string,
  workspacePath: string,
  timeoutMs = 8000,
): Promise<string | null> {
  try {
    const stdout = execSync(command, {
      cwd: workspacePath,
      timeout: timeoutMs,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Pipe commands (e.g. tsc | head) may exit 0 even when errors exist.
    // Check stdout for content regardless of exit code.
    const output = typeof stdout === "string" ? stdout.trim() : "";
    if (!output) return null;
    return output.length > 2000
      ? output.slice(0, 2000) + "\n... [truncated]"
      : output;
  } catch (err: unknown) {
    const execErr = err as {
      status?: number;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
    };
    if (execErr.killed) {
      serverLogger.warn("[diagnostics] command timed out", { command });
      return null;
    }
    // Exit code 127 = command not found — tool not installed, not a code error
    if (execErr.status === 127) {
      serverLogger.warn("[diagnostics] command not found, skipping", { command });
      return null;
    }
    const output = [execErr.stdout ?? "", execErr.stderr ?? ""]
      .filter(Boolean)
      .join("\n")
      .trim();
    if (!output) return null;
    return output.length > 2000
      ? output.slice(0, 2000) + "\n... [truncated]"
      : output;
  }
}
