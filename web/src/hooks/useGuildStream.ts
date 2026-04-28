import { useState, useEffect, useRef, useCallback } from "react";
import type { GuildTask, GuildAgent } from "../types/guild";
import { clearGroupSchedulerLog, getTaskExecutionLog } from "../api/guild";

export type ExecutionEventType =
  | "text"
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "plan"
  | "harness";

export interface ExecutionEvent {
  type: ExecutionEventType;
  content: string;
  /** tool name for tool_call / tool_result */
  tool?: string;
  /** stringified args for tool_call */
  args?: string;
  /** Structured payload for plan / harness events */
  payload?: unknown;
  timestamp: string;
}

export interface TaskExecution {
  taskId: string;
  taskTitle: string;
  agentId: string;
  events: ExecutionEvent[];
  status: "working" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
}

export type SchedulerLogKind = "dispatched" | "stalled";

export interface SchedulerLogEntry {
  id: string;
  at: string;
  kind: SchedulerLogKind;
  groupId: string;
  taskId?: string;
  agentId?: string;
  taskTitle?: string;
  confidence?: number;
  openTaskCount?: number;
  message: string;
}

const SCHEDULER_LOG_MAX = 120;

function parseSchedulerLogEntries(raw: unknown): SchedulerLogEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (x): x is SchedulerLogEntry =>
        x !== null &&
        typeof x === "object" &&
        typeof (x as SchedulerLogEntry).id === "string" &&
        typeof (x as SchedulerLogEntry).at === "string" &&
        typeof (x as SchedulerLogEntry).message === "string" &&
        ((x as SchedulerLogEntry).kind === "dispatched" || (x as SchedulerLogEntry).kind === "stalled"),
    )
    .slice(0, SCHEDULER_LOG_MAX);
}

function formatSchedulerLogMessage(
  row: Omit<SchedulerLogEntry, "id" | "message"> & { message?: string },
  agents: GuildAgent[],
): string {
  if (row.message) return row.message;
  if (row.kind === "dispatched" && row.taskTitle && row.agentId) {
    const agent = agents.find((a) => a.id === row.agentId);
    const name = agent?.name ?? row.agentId.slice(0, 8);
    const pct = row.confidence !== undefined ? `${Math.round(row.confidence * 100)}%` : "—";
    return `自治调度：「${row.taskTitle}」→ ${name}（置信度 ${pct}）`;
  }
  return "调度事件";
}

export function useGuildStream(groupId: string | null) {
  const [tasks, setTasks] = useState<GuildTask[]>([]);
  const [agents, setAgents] = useState<GuildAgent[]>([]);
  const [agentOutputs, setAgentOutputs] = useState<Record<string, string>>({});
  // Last SSE event timestamp per task (ms). Used to flag tasks that haven't
  // produced output for a while so the UI can show "thinking…" instead of
  // making the user wonder whether the agent died.
  const lastTaskEventAtRef = useRef<Record<string, number>>({});
  const [staleTaskIds, setStaleTaskIds] = useState<Set<string>>(() => new Set());
  const [taskExecutions, setTaskExecutions] = useState<Record<string, TaskExecution>>({});
  const [schedulerLog, setSchedulerLog] = useState<SchedulerLogEntry[]>([]);
  const esRef = useRef<EventSource | null>(null);
  const agentsRef = useRef<GuildAgent[]>([]);
  agentsRef.current = agents;
  // tasksRef / executionsRef mirror the latest state so handlers and async
  // callbacks read fresh values instead of closure-captured snapshots. The
  // mirror assignment must happen on every render so reads that occur after
  // a state update see the new value within the same React commit.
  const tasksRef = useRef<GuildTask[]>([]);
  tasksRef.current = tasks;
  const taskExecutionsRef = useRef<Record<string, TaskExecution>>({});
  taskExecutionsRef.current = taskExecutions;
  // Tracks which task ids have a getTaskExecutionLog fetch in flight so the
  // auto-load effect doesn't double-fetch under StrictMode's double-mount or
  // when status changes fire the effect repeatedly while a load is pending.
  const loadingLogsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!groupId) {
      setTasks([]);
      setAgents([]);
      setAgentOutputs({});
      setTaskExecutions({});
      setSchedulerLog([]);
      return;
    }

    setSchedulerLog([]);

    const es = new EventSource(`/api/guild/groups/${groupId}/stream`);
    esRef.current = es;

    // Helper: ensure a TaskExecution exists for a given taskId
    const ensureExec = (taskId: string, agentId: string): void => {
      setTaskExecutions((prev) => {
        if (prev[taskId]) return prev;
        return {
          ...prev,
          [taskId]: {
            taskId,
            taskTitle: taskId,
            agentId,
            events: [],
            status: "working",
            startedAt: new Date().toISOString(),
          },
        };
      });
    };

    // Helper: append or merge an event into a task execution
    const appendEvent = (taskId: string, agentId: string, evType: ExecutionEventType, content: string, extra?: { tool?: string; args?: string; payload?: unknown }) => {
      lastTaskEventAtRef.current[taskId] = Date.now();
      // If the task was flagged stale, clear it immediately so the UI stops
      // showing "thinking…" without waiting for the next sweep tick.
      setStaleTaskIds((prev) => {
        if (!prev.has(taskId)) return prev;
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
      ensureExec(taskId, agentId);
      setTaskExecutions((prev) => {
        const exec = prev[taskId];
        if (!exec) return prev;
        const events = exec.events;
        const last = events.length > 0 ? events[events.length - 1] : null;

        // For text and reasoning, merge consecutive same-type events
        if ((evType === "text" || evType === "reasoning") && last && last.type === evType) {
          const updated = [...events];
          updated[updated.length - 1] = { ...last, content: last.content + content };
          return { ...prev, [taskId]: { ...exec, events: updated } };
        }

        // Otherwise push a new event
        return {
          ...prev,
          [taskId]: {
            ...exec,
            events: [...events, { type: evType, content, ...extra, timestamp: new Date().toISOString() }],
          },
        };
      });
    };

    es.addEventListener("initial_state", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        if (Array.isArray(data.tasks)) setTasks(data.tasks);
        if (Array.isArray(data.agents)) setAgents(data.agents);
        if (data.schedulerLog !== undefined) {
          setSchedulerLog(parseSchedulerLogEntries(data.schedulerLog));
        }
      } catch {
        // ignore
      }
    });

    es.addEventListener("scheduler_log", (e: MessageEvent) => {
      try {
        const row = JSON.parse(e.data) as {
          id?: string;
          kind: SchedulerLogKind;
          at?: string;
          groupId: string;
          taskId?: string;
          agentId?: string;
          taskTitle?: string;
          confidence?: number;
          openTaskCount?: number;
          message?: string;
        };
        const at = row.at ?? new Date().toISOString();
        const id = row.id ?? `${at}_${Math.random().toString(36).slice(2, 9)}`;
        const message =
          row.message ??
          formatSchedulerLogMessage(
            {
              at,
              kind: row.kind,
              groupId: row.groupId,
              taskId: row.taskId,
              agentId: row.agentId,
              taskTitle: row.taskTitle,
              confidence: row.confidence,
              openTaskCount: row.openTaskCount,
            },
            agentsRef.current,
          );
        const entry: SchedulerLogEntry = {
          id,
          at,
          kind: row.kind,
          groupId: row.groupId,
          taskId: row.taskId,
          agentId: row.agentId,
          taskTitle: row.taskTitle,
          confidence: row.confidence,
          openTaskCount: row.openTaskCount,
          message,
        };
        setSchedulerLog((prev) => {
          if (prev.some((x) => x.id === entry.id)) return prev;
          return [entry, ...prev].slice(0, SCHEDULER_LOG_MAX);
        });
      } catch {
        // ignore
      }
    });

    es.addEventListener("task_created", (e: MessageEvent) => {
      try {
        const task: GuildTask = JSON.parse(e.data);
        setTasks((prev) => {
          const idx = prev.findIndex((t) => t.id === task.id);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = task;
            return next;
          }
          return [...prev, task];
        });
      } catch {
        // ignore
      }
    });

    es.addEventListener("task_updated", (e: MessageEvent) => {
      try {
        const task: GuildTask = JSON.parse(e.data);
        setTasks((prev) => {
          const idx = prev.findIndex((t) => t.id === task.id);
          if (idx < 0) return [...prev, task];
          const next = [...prev];
          next[idx] = { ...next[idx], ...task };
          return next;
        });
        // If a stuck/in-progress task was reset, drop its zombie execution panel entry.
        if (task.status === "open") {
          setTaskExecutions((execs) => {
            if (!execs[task.id]) return execs;
            const { [task.id]: _drop, ...rest } = execs;
            return rest;
          });
        }
      } catch {
        // ignore
      }
    });

    es.addEventListener("task_bidding_start", (e: MessageEvent) => {
      try {
        const data: { taskId: string; task?: GuildTask } = JSON.parse(e.data);
        setTasks((prev) =>
          prev.map((t) => {
            if (t.id !== data.taskId) return t;
            if (data.task) return { ...t, ...data.task, status: "bidding" as const };
            return { ...t, status: "bidding" as const };
          })
        );
      } catch {
        // ignore
      }
    });

    es.addEventListener("task_assigned", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as Partial<GuildTask> & { taskId?: string; agentId?: string };
        const taskId = data.taskId ?? data.id;
        const agentId = data.agentId ?? data.assignedAgentId;
        if (!taskId || !agentId) return;
        const now = new Date().toISOString();
        // Resolve the title via a ref instead of nesting setTaskExecutions
        // inside setTasks's updater. Calling setState from inside another
        // setState's updater is unsafe — updaters must be pure (StrictMode
        // double-invokes them, which would emit duplicate execution entries
        // and tear ordering with concurrent rendering).
        const titleFromIncoming = typeof data.title === "string" ? data.title : undefined;
        const titleFromState = tasksRef.current.find((t) => t.id === taskId)?.title;
        const taskTitle = titleFromIncoming ?? titleFromState ?? taskId;
        setTasks((prev) =>
          prev.map((t) =>
            t.id === taskId
              ? { ...t, ...data, status: "in_progress" as const, assignedAgentId: agentId, startedAt: now }
              : t,
          ),
        );
        setTaskExecutions((execs) => ({
          ...execs,
          [taskId]: {
            taskId,
            taskTitle,
            agentId,
            events: [],
            status: "working",
            startedAt: now,
          },
        }));
      } catch {
        // ignore
      }
    });

    es.addEventListener("task_completed", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        const now = new Date().toISOString();
        setTasks((prev) =>
          prev.map((t) =>
            t.id === data.taskId
              ? { ...t, status: "completed" as const, result: data.result, completedAt: now }
              : t
          )
        );
        setTaskExecutions((prev) => {
          const exec = prev[data.taskId];
          if (!exec) return prev;
          return { ...prev, [data.taskId]: { ...exec, status: "completed", completedAt: now } };
        });
      } catch {
        // ignore
      }
    });

    es.addEventListener("task_failed", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        const now = new Date().toISOString();
        setTasks((prev) =>
          prev.map((t) =>
            t.id === data.taskId
              ? { ...t, status: "failed" as const, result: { summary: `Failed: ${data.error}` }, completedAt: now }
              : t
          )
        );
        setTaskExecutions((prev) => {
          const exec = prev[data.taskId];
          if (!exec) return prev;
          return { ...prev, [data.taskId]: { ...exec, status: "failed", completedAt: now } };
        });
      } catch {
        // ignore
      }
    });

    es.addEventListener("task_cancelled", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        setTasks((prev) =>
          prev.map((t) =>
            t.id === data.taskId ? { ...t, status: "cancelled" as const } : t
          )
        );
      } catch {
        // ignore
      }
    });

    es.addEventListener("task_removed", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        setTasks((prev) => prev.filter((t) => t.id !== data.taskId));
      } catch {
        // ignore
      }
    });

    es.addEventListener("agent_status", (e: MessageEvent) => {
      try {
        const data: { agentId: string; status: GuildAgent["status"] } = JSON.parse(e.data);
        setAgents((prev) =>
          prev.map((a) =>
            a.id === data.agentId ? { ...a, status: data.status } : a
          )
        );
      } catch {
        // ignore
      }
    });

    es.addEventListener("agent_token", (e: MessageEvent) => {
      try {
        const data: { agentId: string; taskId: string; token: string } = JSON.parse(e.data);
        // Keep agentOutputs for DetailPanel backward compat
        setAgentOutputs((prev) => ({
          ...prev,
          [data.agentId]: (prev[data.agentId] ?? "") + data.token,
        }));
        // Structured event
        appendEvent(data.taskId, data.agentId, "text", data.token);
      } catch {
        // ignore
      }
    });

    es.addEventListener("agent_reasoning", (e: MessageEvent) => {
      try {
        const data: { agentId: string; taskId: string; token: string } = JSON.parse(e.data);
        appendEvent(data.taskId, data.agentId, "reasoning", data.token);
      } catch {
        // ignore
      }
    });

    es.addEventListener("agent_tool_call", (e: MessageEvent) => {
      try {
        const data: { agentId: string; taskId: string; tool: string; input?: unknown } = JSON.parse(e.data);
        const argsStr = data.input ? JSON.stringify(data.input, null, 2) : undefined;
        appendEvent(data.taskId, data.agentId, "tool_call", data.tool, { tool: data.tool, args: argsStr });
      } catch {
        // ignore
      }
    });

    es.addEventListener("agent_tool_result", (e: MessageEvent) => {
      try {
        const data: { agentId: string; taskId: string; tool: string; output: string } = JSON.parse(e.data);
        appendEvent(data.taskId, data.agentId, "tool_result", data.output, { tool: data.tool });
      } catch {
        // ignore
      }
    });

    es.addEventListener("agent_plan", (e: MessageEvent) => {
      try {
        const data: { agentId: string; taskId: string; phase: string; payload: unknown } = JSON.parse(e.data);
        appendEvent(data.taskId, data.agentId, "plan", data.phase, { payload: data.payload });
        // Planner runs aren't backed by a real task lifecycle, so transition the
        // TaskExecution status manually when the planner finishes.
        if (data.phase === "planner_done" || data.phase === "planner_failed") {
          const now = new Date().toISOString();
          const nextStatus: TaskExecution["status"] = data.phase === "planner_done" ? "completed" : "failed";
          setTaskExecutions((prev) => {
            const exec = prev[data.taskId];
            if (!exec) return prev;
            return { ...prev, [data.taskId]: { ...exec, status: nextStatus, completedAt: now } };
          });
        }
      } catch {
        // ignore
      }
    });

    es.addEventListener("agent_harness", (e: MessageEvent) => {
      try {
        const data: { agentId: string; taskId: string; kind: string; payload: unknown } = JSON.parse(e.data);
        appendEvent(data.taskId, data.agentId, "harness", data.kind, { payload: data.payload });
      } catch {
        // ignore
      }
    });

    es.addEventListener("agent_updated", (e: MessageEvent) => {
      try {
        const agent: GuildAgent = JSON.parse(e.data);
        if (!agent.id) return;
        setAgents((prev) => {
          const idx = prev.findIndex((a) => a.id === agent.id);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = agent;
            return next;
          }
          return [...prev, agent];
        });
      } catch {
        // ignore
      }
    });

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [groupId]);

  // Load historical execution log from server
  const loadTaskLog = useCallback(async (taskId: string) => {
    if (!groupId) return;
    // Read via refs so we don't see stale snapshots after rapid status flips
    // or under StrictMode's double-mount. Without this, the auto-load effect
    // can permanently skip a task whose execution entry was created after the
    // callback was instantiated.
    if (taskExecutionsRef.current[taskId]) return;
    if (loadingLogsRef.current.has(taskId)) return;
    loadingLogsRef.current.add(taskId);
    try {
      const log = await getTaskExecutionLog(groupId, taskId);
      if (!log || !log.startedAt) return;
      const task = tasksRef.current.find((t) => t.id === taskId);
      setTaskExecutions((prev) => ({
        ...prev,
        [taskId]: {
          taskId: log.taskId,
          taskTitle: task?.title ?? log.taskId,
          agentId: log.agentId,
          events: log.events as ExecutionEvent[],
          status: log.status as TaskExecution["status"],
          startedAt: log.startedAt,
          completedAt: log.completedAt,
        },
      }));
    } catch {
      // no log available
    } finally {
      loadingLogsRef.current.delete(taskId);
    }
  }, [groupId]);

  // Remove a task execution from the panel
  const removeTaskExecution = useCallback((taskId: string) => {
    setTaskExecutions((prev) => {
      const next = { ...prev };
      delete next[taskId];
      return next;
    });
  }, []);

  const clearSchedulerLog = useCallback(async () => {
    if (!groupId) return;
    try {
      await clearGroupSchedulerLog(groupId);
      setSchedulerLog([]);
    } catch {
      // keep UI list if server rejects
    }
  }, [groupId]);

  // Stale-task sweeper: flag any in_progress task that hasn't produced an SSE
  // event for > STALE_THRESHOLD_MS. Clears automatically when a new event
  // arrives (see appendEvent). Runs every 5s; threshold 8s — picks up "quiet"
  // reasoning without crying wolf on every small pause.
  //
  // Reads `tasks` through `tasksRef` (declared at the top of the hook) so the
  // 5s interval doesn't get torn down on every SSE event.
  useEffect(() => {
    const STALE_THRESHOLD_MS = 8000;
    const timer = window.setInterval(() => {
      const now = Date.now();
      const inProgressIds = new Set(
        tasksRef.current.filter((t) => t.status === "in_progress").map((t) => t.id),
      );
      const next = new Set<string>();
      for (const id of inProgressIds) {
        const last = lastTaskEventAtRef.current[id];
        if (!last) continue; // No events yet — don't flag; the task just started.
        if (now - last > STALE_THRESHOLD_MS) next.add(id);
      }
      setStaleTaskIds((prev) => {
        if (prev.size === next.size && [...prev].every((x) => next.has(x))) return prev;
        return next;
      });
    }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  // Auto-load logs for in-progress and recently-finished tasks. Keying on
  // `tasks.length` alone misses status flips (in_progress→completed without
  // any length change) so the just-completed log never auto-loads. Derive a
  // stable signature from id+status so we re-run on transitions but not on
  // every unrelated `tasks` mutation.
  const inProgressKey = tasks
    .filter((t) => t.status === "in_progress" || t.status === "completed" || t.status === "failed")
    .map((t) => `${t.id}:${t.status}`)
    .sort()
    .join(",");
  useEffect(() => {
    if (!groupId) return;
    const inProgress = tasksRef.current.filter(
      (t) => t.status === "in_progress" || t.status === "completed" || t.status === "failed",
    );
    const working = inProgress.filter((t) => t.status === "in_progress");
    const recent = inProgress
      .filter((t) => t.status !== "in_progress")
      .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""))
      .slice(0, 3);
    for (const t of [...working, ...recent]) {
      if (!taskExecutionsRef.current[t.id]) {
        loadTaskLog(t.id);
      }
    }
  }, [groupId, inProgressKey, loadTaskLog]);

  return {
    tasks,
    agents,
    agentOutputs,
    taskExecutions,
    schedulerLog,
    staleTaskIds,
    loadTaskLog,
    removeTaskExecution,
    clearSchedulerLog,
  };
}
