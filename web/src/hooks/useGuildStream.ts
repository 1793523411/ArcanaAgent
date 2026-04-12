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
  const [taskExecutions, setTaskExecutions] = useState<Record<string, TaskExecution>>({});
  const [schedulerLog, setSchedulerLog] = useState<SchedulerLogEntry[]>([]);
  const esRef = useRef<EventSource | null>(null);
  const agentsRef = useRef<GuildAgent[]>([]);
  agentsRef.current = agents;

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
        setTasks((prev) => {
          const updated = prev.map((t) =>
            t.id === taskId
              ? { ...t, ...data, status: "in_progress" as const, assignedAgentId: agentId, startedAt: now }
              : t
          );
          // Initialize task execution with task title
          const task = updated.find((t) => t.id === taskId);
          setTaskExecutions((execs) => ({
            ...execs,
            [taskId]: {
              taskId,
              taskTitle: task?.title ?? taskId,
              agentId,
              events: [],
              status: "working",
              startedAt: now,
            },
          }));
          return updated;
        });
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
    // Already have live data for this task
    if (taskExecutions[taskId]) return;
    try {
      const log = await getTaskExecutionLog(groupId, taskId);
      if (!log || !log.startedAt) return;
      // Find task title from tasks state
      const task = tasks.find((t) => t.id === taskId);
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
    }
  }, [groupId, tasks]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Auto-load logs for in-progress tasks on initial state
  useEffect(() => {
    if (!groupId) return;
    const inProgress = tasks.filter((t) => t.status === "in_progress" || t.status === "completed" || t.status === "failed");
    // Only auto-load working tasks and the last 3 completed/failed
    const working = inProgress.filter((t) => t.status === "in_progress");
    const recent = inProgress
      .filter((t) => t.status !== "in_progress")
      .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""))
      .slice(0, 3);
    for (const t of [...working, ...recent]) {
      if (!taskExecutions[t.id]) {
        loadTaskLog(t.id);
      }
    }
  }, [groupId, tasks.length]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    tasks,
    agents,
    agentOutputs,
    taskExecutions,
    schedulerLog,
    loadTaskLog,
    removeTaskExecution,
    clearSchedulerLog,
  };
}
