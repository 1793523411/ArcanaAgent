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
    return input;
  } catch {
    return input;
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

  return (
    <div className="my-2">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors mb-1"
      >
        <span className="select-none">{collapsed ? "▶" : "▼"}</span>
        <span className="font-mono">
          Terminal ({logs.length} call{logs.length > 1 ? "s" : ""})
        </span>
      </button>
      {!collapsed && (
        <div className="terminal-block rounded-lg overflow-hidden border border-[#2a2a2a]">
          <div className="terminal-header flex items-center gap-1.5 px-3 py-1.5 bg-[#1a1a2e] border-b border-[#2a2a2a]">
            <span className="w-2.5 h-2.5 rounded-full bg-[#ff5f56]" />
            <span className="w-2.5 h-2.5 rounded-full bg-[#ffbd2e]" />
            <span className="w-2.5 h-2.5 rounded-full bg-[#27c93f]" />
            <span className="ml-2 text-[10px] text-[#666] font-mono">agent — skill execution</span>
          </div>
          <div className="terminal-body bg-[#0d1117] p-3 max-h-[400px] overflow-auto text-xs font-mono leading-relaxed space-y-3">
            {logs.map((log, i) => (
              <ToolEntry key={i} log={log} />
            ))}
          </div>
        </div>
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

  return (
    <div>
      <div className="flex items-start gap-1.5">
        <span className="text-[#27c93f] select-none shrink-0">$</span>
        <span className="text-[#e2e8f0] break-all">{displayInput}</span>
      </div>
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
