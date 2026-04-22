import type { TaskDeclaredOutput } from "../../types/guild";

interface Props {
  outputs: TaskDeclaredOutput[];
  title?: string;
  /** When true, compact single-line rendering suitable for subtask inline display. */
  dense?: boolean;
}

const STATUS_ICON: Record<NonNullable<TaskDeclaredOutput["status"]>, { icon: string; color: string; label: string }> = {
  pending: { icon: "⏳", color: "#f59e0b", label: "待产出" },
  produced: { icon: "✅", color: "#10b981", label: "已产出" },
  missing: { icon: "❌", color: "#ef4444", label: "缺失" },
};

const KIND_LABEL: Record<TaskDeclaredOutput["kind"], string> = {
  file: "文件",
  url: "URL",
  data: "数据",
  commit: "提交",
};

export default function DeliverablesPanel({ outputs, title = "交付产物", dense }: Props) {
  if (!outputs || outputs.length === 0) return null;

  const producedCount = outputs.filter((o) => o.status === "produced").length;
  const missingCount = outputs.filter((o) => o.status === "missing").length;
  const summary = `${producedCount}/${outputs.length} 已产出${missingCount > 0 ? ` · ${missingCount} 缺失` : ""}`;

  return (
    <div
      className="rounded-lg"
      style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)" }}
    >
      <div
        className="px-3 py-2 flex items-center justify-between border-b"
        style={{ borderColor: "var(--color-border)" }}
      >
        <div className="flex items-center gap-1.5">
          <span>🎯</span>
          <span className="text-xs font-semibold" style={{ color: "var(--color-text)" }}>
            {title}
          </span>
        </div>
        <span className="text-[11px]" style={{ color: "var(--color-text-muted)" }}>
          {summary}
        </span>
      </div>
      <div className="divide-y" style={{ borderColor: "var(--color-border)" }}>
        {outputs.map((o, i) => {
          const status = o.status ?? "pending";
          const s = STATUS_ICON[status];
          return (
            <div
              key={`${o.ref}-${i}`}
              className={dense ? "px-3 py-1.5 flex items-center gap-2" : "px-3 py-2 flex flex-col gap-1"}
              style={{ borderColor: "var(--color-border)" }}
            >
              <div className="flex items-center gap-2 flex-wrap">
                {o.isFinal && (
                  <span
                    className="text-[9px] px-1 py-0.5 rounded font-semibold"
                    style={{ background: "#fbbf2422", color: "#d97706" }}
                    title="最终交付物"
                  >
                    ⭐ 终稿
                  </span>
                )}
                <span
                  className="font-mono text-xs px-1.5 py-0.5 rounded"
                  style={{
                    background: "var(--color-surface)",
                    color: "var(--color-text)",
                    border: "1px solid var(--color-border)",
                  }}
                  title={o.description || ""}
                >
                  {o.ref}
                </span>
                <span className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>
                  {KIND_LABEL[o.kind]}
                </span>
                <span
                  className="inline-flex items-center gap-1 text-[11px] ml-auto"
                  style={{ color: s.color }}
                  title={s.label}
                >
                  {s.icon} {s.label}
                </span>
              </div>
              {!dense && o.label && (
                <div className="text-xs" style={{ color: "var(--color-text)" }}>
                  {o.label}
                </div>
              )}
              {!dense && o.description && (
                <div className="text-[11px]" style={{ color: "var(--color-text-muted)" }}>
                  {o.description}
                </div>
              )}
              {!dense && o.producedBy && (
                <div className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>
                  由 <span className="font-mono">{o.producedBy.agentId}</span> 在 {new Date(o.producedBy.at).toLocaleString()} 产出
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
