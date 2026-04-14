import { execSync, execFileSync } from "child_process";
import { existsSync } from "fs";
import { join, extname, relative } from "path";
import { serverLogger } from "../lib/logger.js";

/** Detected project type and its diagnostic command */
export interface DiagnosticInfo {
  projectType: string;
  command: string | CommandDescriptor;
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

/** Structured command descriptor to avoid shell injection. */
type CommandDescriptor = {
  /** If true, run via shell (for piped commands with no user-controlled args). */
  shell: true;
  command: string;
} | {
  /** If false, run via execFileSync with explicit args (safe for user-controlled filePath). */
  shell: false;
  file: string;
  args: string[];
  /** Max output lines to keep (applied after execution). */
  maxLines?: number;
};

/** Build the actual command descriptor — called fresh each time so filePath is never stale. */
function buildCommand(projectType: ProjectType, filePath: string): CommandDescriptor {
  switch (projectType) {
    case "typescript":
      // No user-controlled args — safe to use shell for pipe
      return { shell: true, command: "npx tsc --noEmit 2>&1 | head -50" };
    case "python-ruff":
      // filePath is user-controlled — use execFileSync to prevent injection
      return { shell: false, file: "ruff", args: ["check", filePath], maxLines: 20 };
    case "python":
      // filePath is user-controlled — use execFileSync to prevent injection
      return { shell: false, file: "python", args: ["-m", "py_compile", filePath] };
    case "go":
      return { shell: true, command: "go vet ./... 2>&1 | head -50" };
    case "rust":
      return { shell: true, command: "cargo check --message-format short 2>&1 | head -50" };
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

/** Truncate output to max length with truncation marker. */
function truncateOutput(output: string, maxLen = 2000): string | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  return trimmed.length > maxLen
    ? trimmed.slice(0, maxLen) + "\n... [truncated]"
    : trimmed;
}

/**
 * Run a diagnostic command and return error output, or null if clean.
 * Accepts either a shell command string (legacy) or a structured CommandDescriptor
 * that uses execFileSync to prevent shell injection.
 */
export async function runDiagnostic(
  command: string | CommandDescriptor,
  workspacePath: string,
  timeoutMs = 8000,
): Promise<string | null> {
  const label = typeof command === "string" ? command : (command.shell ? command.command : `${command.file} ${command.args.join(" ")}`);

  try {
    let stdout: string;

    if (typeof command === "string" || command.shell) {
      // Shell mode — only used for piped commands with NO user-controlled arguments
      const shellCmd = typeof command === "string" ? command : command.command;
      stdout = execSync(shellCmd, {
        cwd: workspacePath,
        timeout: timeoutMs,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } else {
      // Safe mode — execFileSync does NOT invoke a shell, preventing injection
      const rawOutput = execFileSync(command.file, command.args, {
        cwd: workspacePath,
        timeout: timeoutMs,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      stdout = typeof rawOutput === "string" ? rawOutput : "";
      // Apply maxLines truncation if specified
      if (command.maxLines && stdout) {
        const lines = stdout.split("\n");
        if (lines.length > command.maxLines) {
          stdout = lines.slice(0, command.maxLines).join("\n");
        }
      }
    }

    // Pipe commands (e.g. tsc | head) may exit 0 even when errors exist.
    // Check stdout for content regardless of exit code.
    return truncateOutput(typeof stdout === "string" ? stdout : "");
  } catch (err: unknown) {
    const execErr = err as {
      status?: number;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
    };
    if (execErr.killed) {
      serverLogger.warn("[diagnostics] command timed out", { command: label });
      return null;
    }
    // Exit code 127 = command not found — tool not installed, not a code error
    if (execErr.status === 127) {
      serverLogger.warn("[diagnostics] command not found, skipping", { command: label });
      return null;
    }
    const output = [execErr.stdout ?? "", execErr.stderr ?? ""]
      .filter(Boolean)
      .join("\n");
    return truncateOutput(output);
  }
}
