import { useState, useRef, useEffect } from "react";
import type { GuildAgent } from "../../types/guild";
import type { TaskExecution, ExecutionEvent } from "../../hooks/useGuildStream";

interface Props {
  agents: GuildAgent[];
  taskExecutions: Record<string, TaskExecution>;
  onCloseTab?: (taskId: string) => void;
  /** Externally selected task ID (e.g. from clicking a task card) */
  activeTaskId?: string | null;
}

const STATUS_DOT: Record<TaskExecution["status"], { bg: string; pulse: boolean; label: string }> = {
  working: { bg: "#22c55e", pulse: true, label: "执行中" },
  completed: { bg: "#22c55e", pulse: false, label: "已完成" },
  failed: { bg: "#ef4444", pulse: false, label: "失败" },
};

export default function LiveAgentPanel({ agents, taskExecutions, onCloseTab, activeTaskId }: Props) {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [panelHeight, setPanelHeight] = useState(260);
  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef<{ y: number; h: number } | null>(null);

  // Sort executions: working first, then by startedAt desc
  const executions = Object.values(taskExecutions).sort((a, b) => {
    if (a.status === "working" && b.status !== "working") return -1;
    if (a.status !== "working" && b.status === "working") return 1;
    return b.startedAt.localeCompare(a.startedAt);
  });

  // Auto-select first working task, or keep current selection
  useEffect(() => {
    if (executions.length === 0) { setSelectedTaskId(null); return; }
    if (selectedTaskId && taskExecutions[selectedTaskId]) return;
    const firstWorking = executions.find((e) => e.status === "working");
    setSelectedTaskId(firstWorking?.taskId ?? executions[0]?.taskId ?? null);
  }, [Object.keys(taskExecutions).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync with externally selected task (e.g. clicking a task card)
  useEffect(() => {
    if (activeTaskId && taskExecutions[activeTaskId]) {
      setSelectedTaskId(activeTaskId);
    }
  }, [activeTaskId, taskExecutions[activeTaskId ?? ""]]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-switch to new working task when it appears
  useEffect(() => {
    const workingExecs = executions.filter((e) => e.status === "working");
    if (workingExecs.length > 0) {
      const current = selectedTaskId ? taskExecutions[selectedTaskId] : null;
      if (!current || current.status !== "working") {
        setSelectedTaskId(workingExecs[0].taskId);
      }
    }
  }, [executions.filter((e) => e.status === "working").map((e) => e.taskId).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  // Drag to resize
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      if (!dragStartRef.current) return;
      const delta = dragStartRef.current.y - e.clientY;
      setPanelHeight(Math.min(600, Math.max(120, dragStartRef.current.h + delta)));
    };
    const onUp = () => setDragging(false);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  const selectedExec = selectedTaskId ? taskExecutions[selectedTaskId] : null;
  const selectedAgent = selectedExec ? agents.find((a) => a.id === selectedExec.agentId) : null;
  const workingCount = executions.filter((e) => e.status === "working").length;

  return (
    <div className="shrink-0 flex flex-col" style={{ height: panelHeight }}>
      {/* Drag handle */}
      <div
        className="h-1.5 shrink-0 cursor-row-resize hover:bg-[var(--color-accent)] transition-colors"
        style={{ background: dragging ? "var(--color-accent)" : "var(--color-border)" }}
        onMouseDown={(e) => {
          e.preventDefault();
          dragStartRef.current = { y: e.clientY, h: panelHeight };
          setDragging(true);
        }}
      />

      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-1.5 shrink-0"
        style={{ background: "var(--color-surface)", borderBottom: "1px solid var(--color-border)" }}
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold" style={{ color: "var(--color-text)" }}>
            执行日志
          </span>
          {workingCount > 0 && (
            <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full"
              style={{ background: "#22c55e22", color: "#22c55e" }}>
              <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: "#22c55e" }} />
              {workingCount} 个执行中
            </span>
          )}
          {executions.length > 0 && (
            <span className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>
              共 {executions.length} 条
            </span>
          )}
        </div>
        {selectedExec && selectedAgent && (
          <div className="flex items-center gap-1.5 text-xs" style={{ color: "var(--color-text-muted)" }}>
            <span>{selectedAgent.icon}</span>
            <span style={{ color: selectedAgent.color }}>{selectedAgent.name}</span>
            <span style={{ color: STATUS_DOT[selectedExec.status].bg }}>
              {STATUS_DOT[selectedExec.status].label}
            </span>
            {selectedExec.completedAt && (
              <span>· {formatDuration(selectedExec.startedAt, selectedExec.completedAt)}</span>
            )}
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 flex min-h-0" style={{ background: "var(--color-bg)" }}>
        {/* Execution list (left) */}
        <div
          className="w-48 shrink-0 overflow-y-auto border-r"
          style={{ background: "var(--color-surface)", borderColor: "var(--color-border)" }}
        >
          {executions.length === 0 ? (
            <div className="flex items-center justify-center h-full text-xs" style={{ color: "var(--color-text-muted)" }}>
              暂无执行记录
            </div>
          ) : (
            <div className="py-1">
              {executions.map((exec) => {
                const agent = agents.find((a) => a.id === exec.agentId);
                const dot = STATUS_DOT[exec.status];
                const selected = selectedTaskId === exec.taskId;
                const toolCount = exec.events.filter((e) => e.type === "tool_call").length;
                return (
                  <div
                    key={exec.taskId}
                    className="flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors"
                    style={{
                      background: selected ? "var(--color-accent-alpha)" : "transparent",
                      borderLeft: selected ? "2px solid var(--color-accent)" : "2px solid transparent",
                    }}
                    onClick={() => setSelectedTaskId(exec.taskId)}
                  >
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${dot.pulse ? "animate-pulse" : ""}`}
                      style={{ background: dot.bg }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1">
                        {agent && <span className="text-xs">{agent.icon}</span>}
                        <span className="text-xs font-medium truncate" style={{ color: "var(--color-text)" }}>
                          {exec.taskTitle}
                        </span>
                      </div>
                      <div className="text-[10px] truncate" style={{ color: "var(--color-text-muted)" }}>
                        {agent?.name ?? exec.agentId.slice(0, 8)}
                        {toolCount > 0 && ` · ${toolCount} 次工具调用`}
                        {exec.completedAt && ` · ${formatDuration(exec.startedAt, exec.completedAt)}`}
                      </div>
                    </div>
                    {onCloseTab && exec.status !== "working" && (
                      <button
                        className="shrink-0 w-4 h-4 flex items-center justify-center rounded hover:bg-[var(--color-surface-hover)] text-[10px]"
                        style={{ color: "var(--color-text-muted)" }}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (selectedTaskId === exec.taskId) {
                            const others = executions.filter((ex) => ex.taskId !== exec.taskId);
                            setSelectedTaskId(others[0]?.taskId ?? null);
                          }
                          onCloseTab(exec.taskId);
                        }}
                        title="关闭"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Event stream (right) */}
        <div className="flex-1 min-w-0 flex flex-col">
          {selectedExec ? (
            <EventStreamView
              events={selectedExec.events}
              status={selectedExec.status}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-xs" style={{ color: "var(--color-text-muted)" }}>
              {executions.length === 0 ? "创建任务后，Agent 的执行日志将在此展示" : "选择左侧记录查看日志"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Event Stream View ─────────────────────────────────────

function EventStreamView({ events, status }: { events: ExecutionEvent[]; status: TaskExecution["status"] }) {
  const ref = useRef<HTMLDivElement>(null);
  const isAutoScroll = useRef(true);
  const [collapsedThinking, setCollapsedThinking] = useState<Set<number>>(new Set());
  const [collapsedTools, setCollapsedTools] = useState<Set<number>>(new Set());

  const handleScroll = () => {
    if (!ref.current) return;
    const { scrollTop, scrollHeight, clientHeight } = ref.current;
    isAutoScroll.current = scrollHeight - scrollTop - clientHeight < 40;
  };

  useEffect(() => {
    if (ref.current && isAutoScroll.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [events.length, events[events.length - 1]?.content.length]);

  const toggleThinking = (idx: number) => {
    setCollapsedThinking((prev) => {
      const next = new Set(prev);
      next.has(idx) ? next.delete(idx) : next.add(idx);
      return next;
    });
  };

  const toggleTool = (idx: number) => {
    setCollapsedTools((prev) => {
      const next = new Set(prev);
      next.has(idx) ? next.delete(idx) : next.add(idx);
      return next;
    });
  };

  if (events.length === 0 && status === "working") {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ color: "var(--color-text-muted)" }}>
        <div className="flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full animate-pulse" style={{ background: "var(--color-accent)" }} />
          <span className="text-xs">Agent 正在处理中，等待输出...</span>
        </div>
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-xs" style={{ color: "var(--color-text-muted)" }}>
        无输出内容
      </div>
    );
  }

  return (
    <div
      ref={ref}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto px-4 py-2 space-y-1"
    >
      {events.map((ev, i) => {
        switch (ev.type) {
          case "reasoning": {
            const isCollapsed = collapsedThinking.has(i);
            const preview = ev.content.slice(0, 80).replace(/\n/g, " ");
            return (
              <div key={i} className="rounded-lg overflow-hidden" style={{ border: "1px solid var(--color-border)" }}>
                <div
                  className="flex items-center gap-2 px-3 py-1.5 cursor-pointer select-none"
                  style={{ background: "var(--color-surface)" }}
                  onClick={() => toggleThinking(i)}
                >
                  <span className="text-[10px]" style={{ color: "#a78bfa" }}>
                    {isCollapsed ? "▶" : "▼"}
                  </span>
                  <span className="text-[10px] font-semibold" style={{ color: "#a78bfa" }}>
                    Thinking
                  </span>
                  {isCollapsed && (
                    <span className="text-[10px] truncate flex-1" style={{ color: "var(--color-text-muted)" }}>
                      {preview}...
                    </span>
                  )}
                  <span className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>
                    {ev.content.length} 字
                  </span>
                </div>
                {!isCollapsed && (
                  <div
                    className="px-3 py-2 text-xs font-mono whitespace-pre-wrap break-words leading-relaxed"
                    style={{ color: "#a78bfa", background: "var(--color-bg)", borderTop: "1px solid var(--color-border)", maxHeight: 200, overflowY: "auto" }}
                  >
                    {ev.content}
                  </div>
                )}
              </div>
            );
          }

          case "tool_call": {
            // Find the matching tool_result (next tool_result with same tool name)
            const resultEvent = events.slice(i + 1).find(
              (e) => e.type === "tool_result" && e.tool === ev.tool
            );
            const isCollapsed = collapsedTools.has(i);

            return (
              <div key={i} className="rounded-lg overflow-hidden" style={{ border: "1px solid var(--color-border)" }}>
                <div
                  className="flex items-center gap-2 px-3 py-1.5 cursor-pointer select-none"
                  style={{ background: "var(--color-surface)" }}
                  onClick={() => toggleTool(i)}
                >
                  <span className="text-[10px]" style={{ color: "var(--color-accent)" }}>
                    {isCollapsed ? "▶" : "▼"}
                  </span>
                  <span className="text-[10px] font-bold" style={{ color: "var(--color-accent)" }}>
                    {ev.tool ?? ev.content}
                  </span>
                  {resultEvent && (
                    <span className="text-[10px]" style={{ color: "#22c55e" }}>OK</span>
                  )}
                  {!resultEvent && status === "working" && (
                    <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: "var(--color-accent)" }} />
                  )}
                  {isCollapsed && ev.args && (
                    <span className="text-[10px] truncate flex-1" style={{ color: "var(--color-text-muted)" }}>
                      {ev.args.slice(0, 60)}
                    </span>
                  )}
                </div>
                {!isCollapsed && (
                  <div style={{ borderTop: "1px solid var(--color-border)" }}>
                    {/* Args */}
                    {ev.args && (
                      <div className="px-3 py-1.5" style={{ background: "var(--color-bg)" }}>
                        <div className="text-[10px] font-semibold mb-1" style={{ color: "var(--color-text-muted)" }}>参数</div>
                        <div className="overflow-auto rounded" style={{ maxHeight: 120, background: "var(--color-surface)", border: "1px solid var(--color-border)" }}>
                          <pre className="text-[11px] font-mono whitespace-pre-wrap break-words p-2 m-0" style={{ color: "var(--color-text)" }}>
                            {ev.args}
                          </pre>
                        </div>
                      </div>
                    )}
                    {/* Result (inline) */}
                    {resultEvent && (
                      <div className="px-3 py-1.5" style={{ background: "var(--color-bg)", borderTop: "1px solid var(--color-border)" }}>
                        <div className="text-[10px] font-semibold mb-1" style={{ color: "var(--color-text-muted)" }}>结果</div>
                        <div className="overflow-auto rounded" style={{ maxHeight: 180, background: "var(--color-surface)", border: "1px solid var(--color-border)" }}>
                          <pre className="text-[11px] font-mono whitespace-pre-wrap break-words p-2 m-0" style={{ color: "var(--color-text)" }}>
                            {resultEvent.content}
                          </pre>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          }

          case "tool_result": {
            // Skip standalone rendering — already rendered inline with tool_call above
            // Only render if there's no preceding tool_call for this tool
            const hasPrecedingCall = events.slice(0, i).some(
              (e) => e.type === "tool_call" && e.tool === ev.tool
            );
            if (hasPrecedingCall) return null;
            // Orphan result — render standalone
            return (
              <div key={i} className="rounded-lg overflow-hidden" style={{ border: "1px solid var(--color-border)" }}>
                <div className="px-3 py-1.5" style={{ background: "var(--color-surface)" }}>
                  <span className="text-[10px] font-bold" style={{ color: "var(--color-accent)" }}>
                    {ev.tool ?? "tool"} 结果
                  </span>
                </div>
                <div className="px-3 py-1.5" style={{ background: "var(--color-bg)", borderTop: "1px solid var(--color-border)" }}>
                  <div className="overflow-auto rounded" style={{ maxHeight: 180, background: "var(--color-surface)", border: "1px solid var(--color-border)" }}>
                    <pre className="text-[11px] font-mono whitespace-pre-wrap break-words p-2 m-0" style={{ color: "var(--color-text)" }}>
                      {ev.content}
                    </pre>
                  </div>
                </div>
              </div>
            );
          }

          case "text":
            return (
              <div key={i} className="text-xs whitespace-pre-wrap break-words leading-relaxed" style={{ color: "var(--color-text)" }}>
                {ev.content}
              </div>
            );

          default:
            return null;
        }
      })}

      {status === "working" && (
        <span className="inline-block w-1.5 h-3.5 animate-pulse ml-0.5" style={{ background: "var(--color-accent)" }} />
      )}
    </div>
  );
}

// ─── Helpers ───────────────────────────────────────────────

function formatDuration(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return "<1s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m${rs > 0 ? `${rs}s` : ""}`;
}
