import { useState } from "react";
import type { ToolLog } from "../types";

interface Props {
  logs: ToolLog[];
  defaultCollapsed?: boolean;
}

function formatInput(name: string, input: string): string {
  try {
    const parsed = JSON.parse(input);
    if (name === "run_command" && parsed.command) return parsed.command;
    if (name === "read_file" && parsed.path) return `cat ${parsed.path}`;
    if (name === "claude_code" && parsed.prompt) {
      return parsed.prompt as string;
    }
    return input;
  } catch {
    return input;
  }
}

/** 格式化 Claude Code subLog 中 tool_use 的内容，将 JSON 参数美化显示 */
function formatToolUseContent(raw: string): { toolName: string; summary: string; detail: string } {
  // raw 格式: "$ ToolName: {json...}" 或 "$ ToolName: plain text"
  const match = raw.match(/^\$\s+(\w+):\s*([\s\S]*)$/);
  if (!match) return { toolName: "", summary: raw, detail: "" };
  const toolName = match[1];
  const rest = match[2];
  try {
    const parsed = JSON.parse(rest);
    // 针对常见工具生成摘要
    if (toolName === "Write" && parsed.file_path) {
      const content = typeof parsed.content === "string" ? parsed.content : "";
      const lines = content.split("\n").length;
      return { toolName, summary: `${parsed.file_path} (${lines} lines)`, detail: content };
    }
    if (toolName === "Edit" && parsed.file_path) {
      return { toolName, summary: parsed.file_path, detail: JSON.stringify(parsed, null, 2) };
    }
    if (toolName === "Read" && parsed.file_path) {
      return { toolName, summary: parsed.file_path, detail: "" };
    }
    if (toolName === "Bash" && parsed.command) {
      return { toolName, summary: parsed.command, detail: "" };
    }
    if (toolName === "Glob" && parsed.pattern) {
      return { toolName, summary: parsed.pattern, detail: "" };
    }
    if (toolName === "Grep" && parsed.pattern) {
      return { toolName, summary: `${parsed.pattern}${parsed.path ? ` in ${parsed.path}` : ""}`, detail: "" };
    }
    // 通用：美化 JSON
    return { toolName, summary: "", detail: JSON.stringify(parsed, null, 2) };
  } catch {
    return { toolName, summary: rest, detail: "" };
  }
}

function truncateOutput(output: string, maxLines = 80): { text: string; truncated: boolean } {
  const lines = output.split("\n");
  if (lines.length <= maxLines) return { text: output, truncated: false };
  const head = lines.slice(0, 40).join("\n");
  const tail = lines.slice(-40).join("\n");
  return { text: `${head}\n\n  ... (${lines.length - 80} lines hidden) ...\n\n${tail}`, truncated: true };
}

export default function ToolCallBlock({ logs, defaultCollapsed = false }: Props) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  if (logs.length === 0) return null;

  const ccCount = logs.filter((l) => l.name === "claude_code").length;
  const toolCount = logs.length - ccCount;
  const headerParts: string[] = [];
  if (ccCount > 0) headerParts.push(`${ccCount} Claude Code`);
  if (toolCount > 0) headerParts.push(`${toolCount} tool${toolCount > 1 ? "s" : ""}`);
  const headerText = headerParts.join(", ");

  return (
    <div className="my-2">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors mb-1"
      >
        <span className="select-none">{collapsed ? "▶" : "▼"}</span>
        <span className="font-mono">
          Execution ({headerText})
        </span>
      </button>
      {!collapsed && (
        <div className="terminal-block rounded-lg overflow-hidden border border-[#2a2a2a]">
          <div className="terminal-header flex items-center gap-1.5 px-3 py-1.5 bg-[#1a1a2e] border-b border-[#2a2a2a]">
            <span className="w-2.5 h-2.5 rounded-full bg-[#ff5f56]" />
            <span className="w-2.5 h-2.5 rounded-full bg-[#ffbd2e]" />
            <span className="w-2.5 h-2.5 rounded-full bg-[#27c93f]" />
            <span className="ml-2 text-[10px] text-[#666] font-mono">
              {ccCount > 0 ? "claude code — agent execution" : "agent — tool execution"}
            </span>
          </div>
          <div className="terminal-body bg-[#0d1117] p-3 max-h-[600px] overflow-auto text-xs font-mono leading-relaxed space-y-3">
            {logs.map((log, i) => (
              <ToolEntry key={i} log={log} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SubLogToolUse({ content }: { content: string }) {
  const { toolName, summary, detail } = formatToolUseContent(content);
  const [expanded, setExpanded] = useState(false);
  const hasDetail = detail.length > 0;

  return (
    <div>
      <span className="inline-flex items-center gap-1">
        <span className="text-[#27c93f]">$</span>
        <span className="text-[#79c0ff] font-semibold">{toolName}</span>
        {summary && <span className="text-[#e2e8f0]">{summary}</span>}
        {hasDetail && (
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="text-[#484f58] hover:text-[#8b949e] transition-colors ml-1"
          >
            {expanded ? "▼" : "▶"} {expanded ? "收起" : "展开"}
          </button>
        )}
      </span>
      {hasDetail && expanded && (
        <pre className="mt-0.5 pl-4 text-[#8b949e] whitespace-pre-wrap break-words text-[10px] max-h-[300px] overflow-auto bg-[#161b22] rounded p-2 border border-[#21262d]">
          {detail}
        </pre>
      )}
    </div>
  );
}

function SubLogCollapsible({ label, color, content }: { label: string; color: string; content: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = content.split("\n");
  const isLong = lines.length > 5 || content.length > 300;
  const preview = isLong ? lines.slice(0, 3).join("\n") + (lines.length > 3 ? " ..." : "") : content;

  return (
    <div>
      {isLong ? (
        <>
          <span className="inline-flex items-center gap-1">
            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              className="hover:text-[#8b949e] transition-colors"
              style={{ color }}
            >
              {expanded ? "▼" : "▶"} {label} ({lines.length} lines)
            </button>
          </span>
          {expanded ? (
            <pre className="mt-0.5 pl-2 whitespace-pre-wrap break-words text-[10px] max-h-[300px] overflow-auto bg-[#161b22] rounded p-2 border border-[#21262d]" style={{ color }}>
              {content}
            </pre>
          ) : (
            <pre className="mt-0.5 pl-2 whitespace-pre-wrap break-words m-0" style={{ color }}>
              {preview}
            </pre>
          )}
        </>
      ) : (
        <pre className="pl-2 whitespace-pre-wrap break-words m-0" style={{ color }}>
          {content}
        </pre>
      )}
    </div>
  );
}

function ToolEntry({ log }: { log: ToolLog }) {
  const displayInput = formatInput(log.name, log.input);
  const hasOutput = log.output && log.output.trim();
  const { text: displayOutput } = hasOutput
    ? truncateOutput(log.output)
    : { text: "" };
  const isClaudeCode = log.name === "claude_code";
  const hasSubLogs = isClaudeCode && Array.isArray(log.subLogs) && log.subLogs.length > 0;
  const [promptExpanded, setPromptExpanded] = useState(false);
  const promptTruncLen = 200;
  const isLongPrompt = isClaudeCode && displayInput.length > promptTruncLen;
  const shownPrompt = isLongPrompt && !promptExpanded
    ? displayInput.slice(0, promptTruncLen) + "..."
    : displayInput;

  return (
    <div>
      <div className="flex items-start gap-1.5">
        {isClaudeCode ? (
          <span className="text-[#a371f7] select-none shrink-0 font-semibold text-[11px]">Claude Code &gt;</span>
        ) : (
          <span className="text-[#27c93f] select-none shrink-0">$</span>
        )}
        <span className={`break-all ${isClaudeCode ? "text-[#d2a8ff]" : "text-[#e2e8f0]"}`}>
          {shownPrompt}
          {isLongPrompt && (
            <button
              type="button"
              onClick={() => setPromptExpanded((e) => !e)}
              className="ml-1 text-[#484f58] hover:text-[#8b949e] transition-colors text-[10px]"
            >
              {promptExpanded ? "▲ collapse" : "▼ more"}
            </button>
          )}
        </span>
      </div>
      {hasSubLogs && (
        <div className="mt-1 pl-4 space-y-0.5">
          {log.subLogs!.map((sub, i) => (
            <div key={i} className="text-[#8b949e] text-[11px]">
              {sub.type === "tool_progress" ? (
                <span><span className="text-[#ffbd2e]">&gt;</span> {sub.content}</span>
              ) : sub.type === "tool_summary" ? (
                <span className="text-[#58a6ff] italic">{sub.content}</span>
              ) : sub.type === "tool_use" ? (
                <SubLogToolUse content={sub.content} />
              ) : sub.type === "tool_result" ? (
                <SubLogCollapsible label="result" color="#7d8590" content={sub.content} />
              ) : sub.type === "text" ? (
                <span className="text-[#d2a8ff] whitespace-pre-wrap">{sub.content}</span>
              ) : sub.type === "system" ? (
                <span className="text-[#8b949e] italic"><span className="text-[#484f58]">⚙</span> {sub.content}</span>
              ) : (
                <span>{sub.content}</span>
              )}
            </div>
          ))}
        </div>
      )}
      {hasOutput && (
        <pre className="mt-1 pl-4 text-[#8b949e] whitespace-pre-wrap break-words">
          {displayOutput}
        </pre>
      )}
      {!hasOutput && log.output === "" && (
        <div className="mt-1 pl-4 text-[#484f58]">
          <span className="terminal-cursor">_</span>
        </div>
      )}
    </div>
  );
}
