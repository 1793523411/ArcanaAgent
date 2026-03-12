import type { TaskExecution } from "../types/scheduler";

interface Props {
  executions: TaskExecution[];
  onNavigateToConversation?: (conversationId: string) => void;
}

export function TaskExecutionHistory({ executions, onNavigateToConversation }: Props) {
  if (executions.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-surface)]/40 text-[var(--color-text-muted)]">
        <span className="text-4xl">📊</span>
        <span className="text-sm">暂无执行记录</span>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {executions.map((exec) => (
        <ExecutionCard key={exec.id} execution={exec} onNavigateToConversation={onNavigateToConversation} />
      ))}
    </div>
  );
}

function ExecutionCard({
  execution,
  onNavigateToConversation,
}: {
  execution: TaskExecution;
  onNavigateToConversation?: (conversationId: string) => void;
}) {
  const statusConfig = {
    success: {
      icon: "✅",
      badge: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 ring-1 ring-emerald-500/30",
      panel: "border-emerald-500/25 bg-emerald-500/5",
      output: "bg-emerald-950/80 border border-emerald-400/20",
      text: "执行成功",
    },
    failed: {
      icon: "❌",
      badge: "bg-rose-500/10 text-rose-600 dark:text-rose-300 ring-1 ring-rose-500/30",
      panel: "border-rose-500/25 bg-rose-500/5",
      output: "bg-slate-950 border border-rose-400/25",
      text: "执行失败",
    },
    skipped: {
      icon: "⏭️",
      badge: "bg-amber-500/10 text-amber-600 dark:text-amber-300 ring-1 ring-amber-500/30",
      panel: "border-amber-500/25 bg-amber-500/5",
      output: "bg-slate-900 border border-amber-300/20",
      text: "已跳过",
    },
  };

  const config = statusConfig[execution.status];

  const triggerLabels = {
    scheduled: "定时触发",
    manual: "手动执行",
    dependency: "依赖触发",
  };

  const executedAt = new Date(execution.executedAt).toLocaleString("zh-CN");
  const durationLabel =
    execution.duration < 1000 ? `${execution.duration}ms` : `${(execution.duration / 1000).toFixed(2)}s`;

  return (
    <div className={`rounded-lg border p-3 shadow-sm ${config.panel}`}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-lg leading-none">{config.icon}</span>
            <span className="truncate text-sm font-semibold text-[var(--color-text)]">{execution.taskName}</span>
            <span className={`shrink-0 rounded px-2 py-0.5 text-[11px] font-medium ${config.badge}`}>{config.text}</span>
          </div>
          <div className="flex flex-wrap gap-2 text-[11px]">
            <span className="rounded bg-[var(--color-surface)] px-2 py-1 text-[var(--color-text-muted)]">
              ⏱ {executedAt}
            </span>
            <span className="rounded bg-[var(--color-surface)] px-2 py-1 text-[var(--color-text-muted)]">
              ⚡ {durationLabel}
            </span>
            <span className="rounded bg-[var(--color-surface)] px-2 py-1 text-[var(--color-text-muted)]">
              触发: {triggerLabels[execution.trigger]}
            </span>
          </div>
        </div>
        {execution.conversationId && onNavigateToConversation && (
          <button
            type="button"
            onClick={() => onNavigateToConversation(execution.conversationId!)}
            className="shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[11px] font-medium text-[var(--color-text)] transition-colors hover:bg-[var(--color-surface-hover)]"
          >
            打开会话
          </button>
        )}
      </div>

      {execution.output && (
        <pre
          className={`mt-2 max-h-40 overflow-auto rounded-md p-2 text-xs text-slate-100 whitespace-pre-wrap break-all font-mono ${config.output}`}
        >
          {execution.output}
        </pre>
      )}

      {execution.error && (
        <pre className="mt-2 max-h-40 overflow-auto rounded-md border border-rose-500/30 bg-rose-50 p-2 text-xs text-rose-600 dark:bg-rose-950/40 dark:text-rose-300 whitespace-pre-wrap break-all font-mono">
          错误: {execution.error}
        </pre>
      )}
    </div>
  );
}
