import { useRef, useEffect } from "react";

interface Props {
  agentId: string;
  output: string;
  maxHeight?: number;
}

export default function AgentOutputStream({ agentId: _agentId, output, maxHeight = 400 }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [output]);

  if (!output) {
    return (
      <div className="flex items-center gap-2 px-3 py-3" style={{ color: "var(--color-text-muted)" }}>
        <span className="inline-block w-2 h-2 rounded-full animate-pulse" style={{ background: "var(--color-accent)" }} />
        <span className="text-xs">等待输出...</span>
      </div>
    );
  }

  // Parse output for tool calls
  const segments = parseOutput(output);

  return (
    <div
      ref={ref}
      className="overflow-y-auto text-sm font-mono px-3 py-2 space-y-1"
      style={{
        maxHeight,
        background: "var(--color-bg)",
        border: "1px solid var(--color-border)",
        borderRadius: 8,
        color: "var(--color-text)",
      }}
    >
      {segments.map((seg, i) => {
        if (seg.type === "tool") {
          return (
            <div key={i} className="flex items-center gap-1.5 py-0.5">
              <span className="text-xs" style={{ color: "var(--color-accent)" }}>
                {seg.done ? "OK" : ">>"}
              </span>
              <span className="text-xs font-medium" style={{ color: "var(--color-accent)" }}>
                {seg.name}
              </span>
              {seg.preview && (
                <span className="text-xs truncate" style={{ color: "var(--color-text-muted)" }}>
                  {seg.preview}
                </span>
              )}
            </div>
          );
        }
        return (
          <div key={i} className="text-xs whitespace-pre-wrap break-words leading-relaxed">
            {seg.text}
          </div>
        );
      })}
      <span className="inline-block w-1.5 h-3.5 animate-pulse ml-0.5" style={{ background: "var(--color-accent)" }} />
    </div>
  );
}

type Segment = { type: "text"; text: string } | { type: "tool"; name: string; preview?: string; done: boolean };

function parseOutput(output: string): Segment[] {
  const segments: Segment[] = [];
  const lines = output.split("\n");
  let textBuf = "";

  for (const line of lines) {
    // Detect tool call patterns
    const toolMatch = line.match(/^(?:Tool|🔧|>>)\s*[:：]?\s*(\w+)\s*\(?(.*?)\)?$/i);
    const doneMatch = line.match(/^(?:✅|OK|Done|Result)\s*[:：]?\s*(.*)/i);

    if (toolMatch) {
      if (textBuf) { segments.push({ type: "text", text: textBuf.trimEnd() }); textBuf = ""; }
      segments.push({ type: "tool", name: toolMatch[1], preview: toolMatch[2] || undefined, done: false });
    } else if (doneMatch && segments.length > 0 && segments[segments.length - 1].type === "tool") {
      (segments[segments.length - 1] as { done: boolean }).done = true;
    } else {
      textBuf += line + "\n";
    }
  }

  if (textBuf.trim()) segments.push({ type: "text", text: textBuf.trimEnd() });
  return segments;
}
