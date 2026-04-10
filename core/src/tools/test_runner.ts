import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { execFileSync } from "child_process";
import { existsSync, readFileSync, statSync } from "fs";
import { join, dirname } from "path";

const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;

type Framework = "jest" | "vitest" | "pytest" | "mocha" | "cargo_test" | "go_test";

/**
 * Resolve workspace root: walk up from the given path looking for project markers.
 * If `path` is a file, start from its parent directory.
 */
function resolveProjectRoot(inputPath: string): string {
  let dir = inputPath;
  try {
    if (existsSync(dir) && statSync(dir).isFile()) {
      dir = dirname(dir);
    }
  } catch {
    // fall through
  }
  // Walk up to find project root (max 10 levels)
  let current = dir;
  for (let i = 0; i < 10; i++) {
    if (
      existsSync(join(current, "package.json")) ||
      existsSync(join(current, "Cargo.toml")) ||
      existsSync(join(current, "go.mod")) ||
      existsSync(join(current, "pyproject.toml")) ||
      existsSync(join(current, "pytest.ini"))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dir; // fallback to the resolved dir
}

function detectFramework(projectRoot: string): Framework | null {
  const pkgPath = join(projectRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const testScript: string = pkg.scripts?.test ?? "";
      if (testScript.includes("vitest")) return "vitest";
      if (testScript.includes("jest")) return "jest";
      if (testScript.includes("mocha")) return "mocha";

      const devDeps = { ...pkg.devDependencies, ...pkg.dependencies };
      if (devDeps?.vitest) return "vitest";
      if (devDeps?.jest) return "jest";
      if (devDeps?.mocha) return "mocha";
    } catch {
      // ignore parse errors
    }
  }

  if (
    existsSync(join(projectRoot, "pytest.ini")) ||
    existsSync(join(projectRoot, "conftest.py")) ||
    existsSync(join(projectRoot, "pyproject.toml"))
  ) {
    return "pytest";
  }

  if (existsSync(join(projectRoot, "Cargo.toml"))) return "cargo_test";
  if (existsSync(join(projectRoot, "go.mod"))) return "go_test";

  return null;
}

/**
 * Build command as [executable, ...args] array to avoid shell injection.
 */
function buildCommand(
  framework: Framework,
  testPath?: string,
  filter?: string
): { cmd: string; args: string[] } {
  switch (framework) {
    case "jest": {
      const args = ["jest", "--no-coverage", "--forceExit"];
      if (testPath) args.push(testPath);
      if (filter) args.push("-t", filter);
      return { cmd: "npx", args };
    }
    case "vitest": {
      const args = ["vitest", "run"];
      if (testPath) args.push(testPath);
      if (filter) args.push("-t", filter);
      return { cmd: "npx", args };
    }
    case "mocha": {
      const args = ["mocha"];
      if (testPath) args.push(testPath);
      if (filter) args.push("--grep", filter);
      return { cmd: "npx", args };
    }
    case "pytest": {
      const args = ["-m", "pytest", "-v"];
      if (testPath) args.push(testPath);
      if (filter) args.push("-k", filter);
      return { cmd: "python", args };
    }
    case "cargo_test": {
      const args = ["test"];
      if (filter) args.push(filter);
      if (testPath) args.push("--", "--test-threads=1");
      return { cmd: "cargo", args };
    }
    case "go_test": {
      const pkg = testPath || "./...";
      const args = ["test", "-v", pkg];
      if (filter) args.push("-run", filter);
      return { cmd: "go", args };
    }
  }
}

function parseTestOutput(output: string, framework: Framework): string {
  const lines = output.split("\n");
  const failureLines: string[] = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  switch (framework) {
    case "jest":
    case "vitest": {
      for (const line of lines) {
        const summaryMatch = line.match(/Tests:\s+(\d+)\s+passed/);
        if (summaryMatch) passed = parseInt(summaryMatch[1]);
        const failMatch = line.match(/(\d+)\s+failed/);
        if (failMatch) failed = parseInt(failMatch[1]);
        const skipMatch = line.match(/(\d+)\s+skipped/);
        if (skipMatch) skipped = parseInt(skipMatch[1]);
        if (line.includes("FAIL") && line.includes("●")) {
          failureLines.push(line.trim());
        }
      }
      break;
    }
    case "pytest": {
      for (const line of lines) {
        const match = line.match(/(\d+)\s+passed/);
        if (match) passed = parseInt(match[1]);
        const failMatch = line.match(/(\d+)\s+failed/);
        if (failMatch) failed = parseInt(failMatch[1]);
        const skipMatch = line.match(/(\d+)\s+skipped/);
        if (skipMatch) skipped = parseInt(skipMatch[1]);
        if (line.includes("FAILED")) {
          failureLines.push(line.trim());
        }
      }
      break;
    }
    default: {
      for (const line of lines) {
        if (/fail|error|FAIL|ERROR/i.test(line) && !line.includes("0 fail")) {
          failureLines.push(line.trim());
        }
        const passMatch = line.match(/(\d+)\s+pass/i);
        if (passMatch) passed = parseInt(passMatch[1]);
        const failMatch = line.match(/(\d+)\s+fail/i);
        if (failMatch) failed = parseInt(failMatch[1]);
      }
    }
  }

  const status = failed > 0 ? "failed" : "passed";
  let summary = `[test_runner] framework: ${framework} | status: ${status}\n`;
  summary += `summary: ${passed} passed, ${failed} failed, ${skipped} skipped\n`;

  if (failureLines.length > 0) {
    summary += "failures:\n";
    failureLines.slice(0, 10).forEach((line, i) => {
      summary += `  ${i + 1}. ${line}\n`;
    });
    if (failureLines.length > 10) {
      summary += `  ... and ${failureLines.length - 10} more failures\n`;
    }
  }

  return summary;
}

function truncate(output: string): string {
  if (output.length <= MAX_OUTPUT_BYTES) return output;
  return output.slice(0, MAX_OUTPUT_BYTES) + "\n... [output truncated at 64KB]";
}

export const test_runner = tool(
  (input: {
    path?: string;
    framework?: "auto" | Framework;
    filter?: string;
    timeout_ms?: number;
  }) => {
    const timeoutMs = Math.min(input.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

    // Resolve project root for framework detection and cwd
    const projectRoot = resolveProjectRoot(input.path || ".");

    // Detect or use specified framework
    let framework: Framework;
    if (!input.framework || input.framework === "auto") {
      const detected = detectFramework(projectRoot);
      if (!detected) {
        return "[error] Could not auto-detect test framework. No package.json, pytest.ini, Cargo.toml, or go.mod found. Specify 'framework' explicitly.";
      }
      framework = detected;
    } else {
      framework = input.framework;
    }

    const { cmd, args } = buildCommand(framework, input.path, input.filter);

    try {
      const output = execFileSync(cmd, args, {
        cwd: projectRoot,
        maxBuffer: MAX_OUTPUT_BYTES * 2,
        timeout: timeoutMs,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });

      const summary = parseTestOutput(output, framework);
      return summary + "\n--- Raw Output ---\n" + truncate(output);
    } catch (e: unknown) {
      const err = e as { stdout?: string; stderr?: string; status?: number; signal?: string };
      const combinedOutput = (err.stdout || "") + (err.stderr || "");

      if (err.signal === "SIGTERM") {
        return `[error] Tests timed out after ${timeoutMs}ms.\n\n${truncate(combinedOutput)}`;
      }

      // Test failures typically exit with non-zero code
      if (combinedOutput) {
        const summary = parseTestOutput(combinedOutput, framework);
        return summary + "\n--- Raw Output ---\n" + truncate(combinedOutput);
      }

      return `[error] ${String(e)}`;
    }
  },
  {
    name: "test_runner",
    description:
      "Run tests with auto-detection of test framework. Supports jest, vitest, mocha, pytest, cargo test, and go test. " +
      "Returns structured summary with pass/fail counts and failure details.",
    schema: z.object({
      path: z.string().optional().nullable().describe("Test file or directory (auto-detects framework if omitted)"),
      framework: z.enum(["auto", "jest", "vitest", "pytest", "mocha", "cargo_test", "go_test"]).optional().nullable()
        .describe("Test framework (default: auto-detect)"),
      filter: z.string().optional().nullable().describe("Test name pattern filter"),
      timeout_ms: z.number().optional().nullable().describe("Timeout in ms (default 120000, max 300000)"),
    }),
  }
);
