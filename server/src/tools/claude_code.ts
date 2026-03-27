/**
 * Claude Code 工具 —— 通过 Claude Agent SDK 委托复杂编码任务
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { EventEmitter } from "events";
import { loadUserConfig } from "../config/userConfig.js";

/** 实时日志事件 emitter，routes.ts 监听并转发为 SSE */
export const claudeCodeEmitter = new EventEmitter();

export interface ClaudeCodeLogEvent {
  executionId: string;
  type: "tool_progress" | "tool_summary" | "text" | "tool_use" | "tool_result" | "result" | "error" | "system";
  toolName?: string;
  elapsed?: number;
  content?: string;
}

const MAX_RESULT_CHARS = 32_000;

function truncateResult(s: string, max = MAX_RESULT_CHARS): string {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return s.slice(0, half) + "\n...[truncated]...\n" + s.slice(-half);
}

export const claude_code = tool(
  async (input) => {
    // 动态 import 避免在未安装 SDK 时报错
    let queryFn: typeof import("@anthropic-ai/claude-agent-sdk").query;
    try {
      const sdk = await import("@anthropic-ai/claude-agent-sdk");
      queryFn = sdk.query;
    } catch {
      return "Error: @anthropic-ai/claude-agent-sdk is not installed. Run: pnpm add @anthropic-ai/claude-agent-sdk";
    }

    const prompt = input.prompt?.trim();
    if (!prompt) return "Error: prompt is required.";

    const cwd = input.cwd || process.cwd();
    const globalCc = loadUserConfig().claudeCode;
    const maxTurns = input.maxTurns ?? globalCc?.maxTurns ?? 15;
    const model = input.model || globalCc?.model || undefined;
    const allowedTools = input.allowedTools ?? globalCc?.allowedTools ?? ["Read", "Edit", "Write", "Bash", "Glob", "Grep"];

    const abortController = new AbortController();
    // 10 分钟超时
    const timeout = setTimeout(() => abortController.abort(), 10 * 60 * 1000);

    // 唯一执行 ID，用于 routes.ts 区分并发执行
    const executionId = `cc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const emit = (evt: Omit<ClaudeCodeLogEvent, "executionId">) =>
      claudeCodeEmitter.emit("log", { ...evt, executionId } as ClaudeCodeLogEvent);

    try {
      const conversation = queryFn({
        prompt,
        options: {
          cwd,
          model,
          maxTurns,
          allowedTools,
          permissionMode: "bypassPermissions",
          abortController,
          persistSession: false,
        },
      });

      let resultText = "";
      const toolCalls: string[] = [];
      // 累积连续 retry，合并为单条日志
      let retryCount = 0;
      let retryTotalDelay = 0;

      const flushRetries = () => {
        if (retryCount > 0) {
          emit({ type: "system", content: `[retry] ${retryCount} retries, total delay ${(retryTotalDelay / 1000).toFixed(1)}s` });
          retryCount = 0;
          retryTotalDelay = 0;
        }
      };

      for await (const message of conversation) {
        const msgType = (message as { type?: string }).type;
        const msgSubtype = (message as { subtype?: string }).subtype;

        if (msgType === "assistant") {
          flushRetries();
          // assistant 消息：文本、思考、工具调用
          const msg = (message as { message?: { role?: string; content?: unknown } }).message;
          if (msg?.content) {
            const contentArr = Array.isArray(msg.content) ? msg.content : [msg.content];
            for (const block of contentArr) {
              if (typeof block === "string" && block.trim()) {
                emit({ type: "text", content: block });
              } else if (block && typeof block === "object") {
                const b = block as { type?: string; text?: string; thinking?: string; name?: string; input?: unknown; content?: unknown };
                if (b.type === "thinking" && b.thinking?.trim()) {
                  emit({ type: "text", content: b.thinking });
                } else if (b.type === "text" && b.text?.trim()) {
                  emit({ type: "text", content: b.text });
                } else if (b.type === "tool_use" && b.name) {
                  const inputStr = typeof b.input === "string" ? b.input : JSON.stringify(b.input ?? {});
                  emit({ type: "tool_use", toolName: b.name, content: inputStr });
                  toolCalls.push(`[${b.name}] called`);
                } else if (b.type && !["tool_use", "text", "thinking"].includes(b.type)) {
                  const fallbackContent = b.text || (typeof b.content === "string" ? b.content : "") || JSON.stringify(b);
                  if (fallbackContent.trim()) emit({ type: "text", content: `[${b.type}] ${fallbackContent}` });
                }
              }
            }
          }

        } else if (msgType === "user") {
          // 工具返回结果
          const msg = (message as { message?: { role?: string; content?: unknown } }).message;
          if (msg?.content) {
            const contentArr = Array.isArray(msg.content) ? msg.content : [msg.content];
            for (const block of contentArr) {
              if (block && typeof block === "object") {
                const b = block as { type?: string; content?: unknown; tool_use_id?: string; is_error?: boolean };
                if (b.type === "tool_result") {
                  const resultContent = typeof b.content === "string"
                    ? b.content
                    : Array.isArray(b.content)
                      ? (b.content as Array<{ type?: string; text?: string }>).map(c => c.text ?? "").join("\n")
                      : JSON.stringify(b.content ?? "");
                  emit({ type: "tool_result", content: resultContent });
                  toolCalls.push(`[result] ${resultContent.slice(0, 100)}`);
                }
              }
            }
          }

        } else if (msgType === "stream_event") {
          // 流式 token 增量 — 跳过，避免和最终 assistant text block 重复
          continue;

        } else if (msgType === "tool_progress") {
          const toolName = (message as { tool_name?: string }).tool_name ?? "unknown";
          const elapsed = (message as { elapsed_time_seconds?: number }).elapsed_time_seconds ?? 0;
          toolCalls.push(`[${toolName}] ${elapsed}s`);
          emit({ type: "tool_progress", toolName, elapsed });

        } else if (msgType === "tool_use_summary") {
          const summary = (message as { summary?: string }).summary ?? "";
          toolCalls.push(`[summary] ${summary}`);
          emit({ type: "tool_summary", content: summary });

        } else if (msgType === "result") {
          flushRetries();
          if (msgSubtype === "success") {
            const r = message as { result?: string; duration_ms?: number; num_turns?: number; total_cost_usd?: number };
            resultText = r.result || resultText;
            const meta = [
              r.num_turns ? `${r.num_turns} turns` : "",
              r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)}s` : "",
              typeof r.total_cost_usd === "number" ? `$${r.total_cost_usd.toFixed(4)}` : "",
            ].filter(Boolean).join(", ");
            emit({ type: "result", content: meta ? `${resultText}\n\n[${meta}]` : resultText });
          } else {
            const errMsg = ((message as { errors?: string[] }).errors?.join("; ") || `Claude Code execution failed (${msgSubtype})`);
            resultText += `\n\n[Error] ${errMsg}`;
            emit({ type: "error", content: errMsg });
          }

        } else if (msgType === "system") {
          // 系统消息子类型
          if (msgSubtype === "init") {
            const init = message as { model?: string; tools?: string[]; cwd?: string };
            const toolCount = init.tools?.length ?? 0;
            emit({ type: "system", content: `[init] model: ${init.model ?? "unknown"} | ${toolCount} tools available` });
          } else if (msgSubtype === "status") {
            const status = (message as { status?: string }).status;
            if (status) emit({ type: "system", content: `[status] ${status}` });
          } else if (msgSubtype === "api_retry") {
            const r = message as { attempt?: number; max_retries?: number; retry_delay_ms?: number; error?: string };
            retryCount++;
            retryTotalDelay += r.retry_delay_ms ?? 0;
            // 不立即 emit，等下一个非 retry 事件时 flush
          } else if (msgSubtype === "task_started") {
            const t = message as { task_id?: string; description?: string };
            emit({ type: "system", content: `[task started] ${t.description ?? t.task_id ?? ""}` });
          } else if (msgSubtype === "task_progress") {
            const t = message as { description?: string; last_tool_name?: string; summary?: string };
            emit({ type: "system", content: `[task progress] ${t.summary || t.description || ""} ${t.last_tool_name ? `(${t.last_tool_name})` : ""}` });
          } else if (msgSubtype === "task_notification") {
            const t = message as { status?: string; summary?: string; task_id?: string };
            emit({ type: "system", content: `[task ${t.status ?? "done"}] ${t.summary ?? t.task_id ?? ""}` });
          } else if (msgSubtype === "hook_response") {
            const h = message as { hook_name?: string; outcome?: string; output?: string };
            emit({ type: "system", content: `[hook ${h.outcome ?? ""}] ${h.hook_name ?? ""}: ${h.output ?? ""}` });
          } else if (msgSubtype === "compact_boundary") {
            emit({ type: "system", content: "[compact] context compacted" });
          } else if (msgSubtype === "local_command_output") {
            const lc = (message as { content?: string }).content ?? "";
            if (lc.trim()) emit({ type: "system", content: lc });
          }
          // init, session_state_changed 等其他系统消息静默忽略

        } else if (msgType === "auth_status") {
          const auth = message as { isAuthenticating?: boolean; output?: string[]; error?: string };
          if (auth.error) {
            emit({ type: "error", content: `[auth] ${auth.error}` });
          } else if (auth.output?.length) {
            emit({ type: "system", content: `[auth] ${auth.output.join(" ")}` });
          }

        } else if (msgType === "rate_limit_event") {
          const rl = (message as { rate_limit_info?: { status?: string; utilization?: number } }).rate_limit_info;
          if (rl?.status && rl.status !== "allowed") {
            emit({ type: "system", content: `[rate limit] ${rl.status}${rl.utilization ? ` (${(rl.utilization * 100).toFixed(0)}%)` : ""}` });
          }

        } else if (msgType === "prompt_suggestion") {
          // 忽略 prompt 建议
        }
        // 其他未知类型静默忽略
      }

      // flush 未输出的 retry
      flushRetries();

      const toolCallsSummary = toolCalls.length > 0
        ? `\n\n--- Tool Activity (${toolCalls.length}) ---\n${toolCalls.join("\n")}`
        : "";

      return truncateResult(resultText + toolCallsSummary);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("abort")) {
        return "[Claude Code] Execution timed out (10 min limit).";
      }
      return `[Claude Code] Error: ${msg}`;
    } finally {
      clearTimeout(timeout);
    }
  },
  {
    name: "claude_code",
    description: `Delegate complex coding tasks to Claude Code — an AI coding agent with full file editing, terminal execution, and code search capabilities.
Use this tool when:
- The task requires multi-file refactoring or complex code changes
- You need precise AST-aware code editing (search-and-replace)
- The task benefits from deep codebase exploration and understanding
- You need to run commands, check test results, and iterate

Do NOT use for simple file reads or single-line edits — use existing tools for those.

Input:
- prompt: Detailed description of the coding task
- cwd: (optional) Working directory, defaults to current workspace
- maxTurns: (optional) Max execution rounds, default 15
- allowedTools: (optional) Tools Claude Code can use, default: Read, Edit, Write, Bash, Glob, Grep`,
    schema: z.object({
      prompt: z.string().describe("Detailed description of the coding task to delegate"),
      cwd: z.string().optional().describe("Working directory for Claude Code execution"),
      model: z.string().optional().describe("Claude model to use (e.g. 'sonnet', 'opus', 'claude-sonnet-4-6')"),
      maxTurns: z.number().optional().describe("Maximum execution rounds (default: 15)"),
      allowedTools: z.array(z.string()).optional().describe("Allowed Claude Code tools (default: Read, Edit, Write, Bash, Glob, Grep)"),
    }),
  }
);
