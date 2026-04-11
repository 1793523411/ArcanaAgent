import { useState, useEffect, useRef, useCallback } from "react";
import type { GuildTask, GuildAgent } from "../types/guild";
import { getTaskExecutionLog } from "../api/guild";

export type ExecutionEventType = "text" | "reasoning" | "tool_call" | "tool_result";

export interface ExecutionEvent {
  type: ExecutionEventType;
  content: string;
  /** tool name for tool_call / tool_result */
  tool?: string;
  /** stringified args for tool_call */
  args?: string;
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

export function useGuildStream(groupId: string | null) {
  const [tasks, setTasks] = useState<GuildTask[]>([]);
  const [agents, setAgents] = useState<GuildAgent[]>([]);
  const [agentOutputs, setAgentOutputs] = useState<Record<string, string>>({});
  const [taskExecutions, setTaskExecutions] = useState<Record<string, TaskExecution>>({});
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!groupId) {
      setTasks([]);
      setAgents([]);
      setAgentOutputs({});
      setTaskExecutions({});
      return;
    }

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
    const appendEvent = (taskId: string, agentId: string, evType: ExecutionEventType, content: string, extra?: { tool?: string; args?: string }) => {
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

    es.addEventListener("task_assigned", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        const now = new Date().toISOString();
        setTasks((prev) => {
          const updated = prev.map((t) =>
            t.id === data.taskId
              ? { ...t, status: "in_progress" as const, assignedAgentId: data.agentId, startedAt: now }
              : t
          );
          // Initialize task execution with task title
          const task = updated.find((t) => t.id === data.taskId);
          setTaskExecutions((execs) => ({
            ...execs,
            [data.taskId]: {
              taskId: data.taskId,
              taskTitle: task?.title ?? data.taskId,
              agentId: data.agentId,
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

  return { tasks, agents, agentOutputs, taskExecutions, loadTaskLog, removeTaskExecution };
}
