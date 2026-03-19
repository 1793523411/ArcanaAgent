import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { execFileSync } from "child_process";

const MAX_OUTPUT_BYTES = 64 * 1024;

type GitOperation = "status" | "diff" | "log" | "branch_list" | "add" | "commit" | "create_branch";

function runGit(args: string[], cwd: string): string {
  try {
    const output = execFileSync("git", args, {
      cwd,
      maxBuffer: MAX_OUTPUT_BYTES * 2,
      timeout: 30_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output;
  } catch (e: unknown) {
    const err = e as { stderr?: string; stdout?: string };
    const stderr = err.stderr || "";
    const stdout = err.stdout || "";
    if (stdout) return stdout + (stderr ? `\n[stderr] ${stderr}` : "");
    throw new Error(stderr || String(e));
  }
}

function truncate(output: string): string {
  if (output.length <= MAX_OUTPUT_BYTES) return output;
  return output.slice(0, MAX_OUTPUT_BYTES) + "\n... [output truncated at 64KB]";
}

export const git_operations = tool(
  (input: {
    operation: GitOperation;
    args?: {
      ref?: string;
      files?: string[];
      max_count?: number;
      message?: string;
      branch_name?: string;
    };
    working_directory?: string;
  }) => {
    const cwd = input.working_directory || ".";
    const args = input.args ?? {};

    try {
      switch (input.operation) {
        case "status": {
          const output = runGit(["status", "--short"], cwd);
          return truncate(output || "(clean working tree)");
        }

        case "diff": {
          const gitArgs = ["diff"];
          if (args.ref) gitArgs.push(args.ref);
          if (args.files && args.files.length > 0) {
            gitArgs.push("--");
            gitArgs.push(...args.files);
          }
          const output = runGit(gitArgs, cwd);
          return truncate(output || "(no diff)");
        }

        case "log": {
          const maxCount = Math.min(args.max_count ?? 10, 50);
          const gitArgs = ["log", `--max-count=${maxCount}`, "--oneline", "--decorate"];
          if (args.files && args.files.length > 0) {
            gitArgs.push("--");
            gitArgs.push(...args.files);
          }
          const output = runGit(gitArgs, cwd);
          return truncate(output || "(no commits)");
        }

        case "branch_list": {
          const output = runGit(["branch", "-a", "--no-color"], cwd);
          return truncate(output || "(no branches)");
        }

        case "add": {
          if (!args.files || args.files.length === 0) {
            return "[error] 'files' is required for 'add' operation. Specify files to stage.";
          }
          const output = runGit(["add", ...args.files], cwd);
          return `OK: staged ${args.files.length} file(s)${output ? "\n" + output : ""}`;
        }

        case "commit": {
          if (!args.message) {
            return "[error] 'message' is required for 'commit' operation.";
          }
          const output = runGit(["commit", "-m", args.message], cwd);
          return truncate(output);
        }

        case "create_branch": {
          if (!args.branch_name) {
            return "[error] 'branch_name' is required for 'create_branch' operation.";
          }
          const output = runGit(["checkout", "-b", args.branch_name], cwd);
          return output || `OK: created and switched to branch '${args.branch_name}'`;
        }

        default:
          return `[error] Unknown operation: ${input.operation}`;
      }
    } catch (e) {
      return `[error] git ${input.operation}: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
  {
    name: "git_operations",
    description:
      "Perform safe Git operations. Supports: status, diff, log, branch_list, add, commit, create_branch. " +
      "Dangerous operations (push, reset --hard, clean -fd) are not available — use run_command with approval for those.",
    schema: z.object({
      operation: z.enum(["status", "diff", "log", "branch_list", "add", "commit", "create_branch"])
        .describe("Git operation to perform"),
      args: z.object({
        ref: z.string().optional().describe("Ref to diff against, e.g. 'HEAD~1', 'main'"),
        files: z.array(z.string()).optional().describe("Specific files to operate on"),
        max_count: z.number().optional().describe("Number of log entries (default 10, max 50)"),
        message: z.string().optional().describe("Commit message (required for commit)"),
        branch_name: z.string().optional().describe("Branch name (for create_branch)"),
      }).optional(),
      working_directory: z.string().optional().describe("Git repo path (defaults to workspace)"),
    }),
  }
);
