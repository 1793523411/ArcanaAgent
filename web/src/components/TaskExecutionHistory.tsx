import type { TaskExecution } from "../types/scheduler";

interface Props {
  executions: TaskExecution[];
}

export function TaskExecutionHistory({ executions }: Props) {
  if (executions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-[var(--color-text-muted)] gap-2">
        <span className="text-4xl">📊</span>
        <span className="text-sm">暂无执行记录</span>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {executions.map((exec) => (
        <ExecutionCard key={exec.id} execution={exec} />
      ))}
    </div>
  );
}

function ExecutionCard({ execution }: { execution: TaskExecution }) {
  const statusConfig = {
    success: {
      icon: "✅",
      color: "text-green-600 dark:text-green-400",
      bg: "bg-green-50 dark:bg-green-900/20",
    },
    failed: {
      icon: "❌",
      color: "text-red-600 dark:text-red-400",
      bg: "bg-red-50 dark:bg-red-900/20",
    },
    skipped: {
      icon: "⏭️",
      color: "text-yellow-600 dark:text-yellow-400",
      bg: "bg-yellow-50 dark:bg-yellow-900/20",
    },
  };

  const config = statusConfig[execution.status];

  const triggerLabels = {
    scheduled: "定时触发",
    manual: "手动执行",
    dependency: "依赖触发",
  };

  return (
    <div className={`p-3 rounded border border-[var(--color-border)] ${config.bg}`}>
      <div className="flex items-start justify-between mb-2">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-lg">{config.icon}</span>
            <span className="font-medium text-[var(--color-text)]">{execution.taskName}</span>
            <span className="text-xs px-2 py-0.5 rounded bg-[var(--color-surface)] text-[var(--color-text-muted)]">
              {triggerLabels[execution.trigger]}
            </span>
          </div>
          <div className="text-xs text-[var(--color-text-muted)] space-y-0.5">
            <div>⏱️ 执行时间: {new Date(execution.executedAt).toLocaleString("zh-CN")}</div>
            <div>⚡ 耗时: {execution.duration}ms</div>
          </div>
        </div>
      </div>

      {execution.output && (
        <div className="mt-2 p-2 bg-[var(--color-bg)] rounded text-xs text-[var(--color-text)] font-mono">
          {execution.output}
        </div>
      )}

      {execution.error && (
        <div className="mt-2 p-2 bg-red-50 dark:bg-red-900/30 rounded text-xs text-red-600 dark:text-red-400 font-mono">
          错误: {execution.error}
        </div>
      )}
    </div>
  );
}
