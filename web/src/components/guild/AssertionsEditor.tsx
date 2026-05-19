import { useEffect, useState } from "react";
import type { AcceptanceAssertion } from "../../types/guild";

const inputCls =
  "px-2 py-1 rounded text-sm w-full bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text)]";

/** Short UI-only id for React `key`s on dynamic lists. crypto.randomUUID
 *  isn't available in some embedded WebViews — fall back to Math.random. */
function uid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `uid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs min-w-0">
      <span className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0">
        <span className="whitespace-nowrap" style={{ color: "var(--color-text)", fontWeight: 500 }}>{label}</span>
        {hint && <span style={{ color: "var(--color-text-muted)" }} className="text-[10px]">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

interface Props {
  assertions: AcceptanceAssertion[] | undefined;
  onChange: (next: AcceptanceAssertion[] | undefined) => void;
  /** Optional title override — AI preview wants compact "🛡 验收断言"
   *  while the pipeline editor uses the same default. */
  title?: string;
  /** Optional hint override — same reason as title. */
  hint?: string;
}

export default function AssertionsEditor({ assertions, onChange, title, hint }: Props) {
  const list = assertions ?? [];
  // Stable per-row UI ids — array index is unsafe as a React key here because
  // deleting row i causes downstream rows to inherit the deleted row's
  // controlled-input state, briefly displaying the wrong values.
  const [ids, setIds] = useState<string[]>(() => list.map(() => uid()));
  // Resync if the parent swapped the assertion array out (different step
  // selected). Length-based: if the parent edits in place via our handlers,
  // ids stay stable; if the array is replaced wholesale, we rebuild.
  useEffect(() => {
    if (ids.length !== list.length) {
      setIds(list.map(() => uid()));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.length]);
  const patch = (i: number, next: AcceptanceAssertion) => {
    const copy = list.slice();
    copy[i] = next;
    onChange(copy);
  };
  const add = () => {
    setIds((prev) => [...prev, uid()]);
    onChange([...list, { type: "file_exists", ref: "" }]);
  };
  const remove = (i: number) => {
    setIds((prev) => prev.filter((_, j) => j !== i));
    const copy = list.filter((_, j) => j !== i);
    onChange(copy.length === 0 ? undefined : copy);
  };
  const changeType = (i: number, type: AcceptanceAssertion["type"]) => {
    const cur = list[i];
    if (cur.type === type) return;
    if (type === "file_exists") {
      patch(i, { type: "file_exists", ref: cur.ref, description: cur.description });
    } else {
      patch(i, { type: "file_contains", ref: cur.ref, pattern: "", regex: false, description: cur.description });
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex flex-col">
          <span className="text-xs font-medium flex items-center gap-1.5" style={{ color: "var(--color-text)" }}>
            🛡 {title ?? "验收断言（可选）"}
          </span>
          <span className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>
            {hint ?? "Harness 机器校验；agent 声称完成后不过这些就不算完成"}
          </span>
        </div>
        <button
          className="text-xs px-2 py-0.5 rounded"
          style={{ border: "1px solid var(--color-border)", color: "var(--color-text)" }}
          onClick={add}
          type="button"
        >+ 添加</button>
      </div>
      {list.length === 0 && (
        <div
          className="text-xs italic px-3 py-2 rounded"
          style={{ color: "var(--color-text-muted)", background: "var(--color-bg)", border: "1px dashed var(--color-border)" }}
        >
          未声明断言（agent 完成即完成，不做机器校验）
        </div>
      )}
      {list.map((a, i) => (
        <div
          key={ids[i] ?? `__fallback-${i}`}
          className="flex flex-col gap-2 p-3 rounded-lg"
          style={{ border: "1px solid var(--color-border)", background: "var(--color-bg)" }}
        >
          <div className="flex items-center justify-between">
            <div className="inline-flex rounded overflow-hidden text-xs" style={{ border: "1px solid var(--color-border)" }}>
              {(["file_exists", "file_contains"] as const).map((t) => {
                const active = a.type === t;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => changeType(i, t)}
                    className="px-2 py-0.5"
                    style={{
                      background: active ? "#dcfce7" : "transparent",
                      color: active ? "#166534" : "var(--color-text-muted)",
                      fontWeight: active ? 600 : 400,
                      borderRight: t === "file_exists" ? "1px solid var(--color-border)" : "none",
                    }}
                  >
                    {t === "file_exists" ? "文件存在" : "文件包含"}
                  </button>
                );
              })}
            </div>
            <button
              className="w-6 h-6 rounded flex items-center justify-center text-xs"
              type="button"
              title="删除此断言"
              style={{ border: "1px solid #fca5a5", color: "#dc2626" }}
              onClick={() => remove(i)}
            >✕</button>
          </div>
          <Field label="ref" hint="文件路径，支持 ${var}">
            <input
              className={inputCls}
              placeholder="e.g. ${filename}.md"
              value={a.ref}
              onChange={(e) => patch(i, { ...a, ref: e.target.value })}
            />
          </Field>
          {a.type === "file_contains" && (
            <>
              <Field label="pattern" hint={a.regex ? "正则表达式" : "子串"}>
                <input
                  className={inputCls}
                  placeholder={a.regex ? '"price"\\\\s*:\\\\s*\\\\d+' : "## 结论"}
                  value={a.pattern}
                  onChange={(e) => patch(i, { ...a, pattern: e.target.value })}
                />
              </Field>
              <label className="flex items-center gap-1.5 text-xs cursor-pointer" style={{ color: "var(--color-text-muted)" }}>
                <input
                  type="checkbox"
                  checked={!!a.regex}
                  onChange={(e) => patch(i, { ...a, regex: e.target.checked })}
                />
                按正则匹配（RegExp）
              </label>
            </>
          )}
          <Field label="description" hint="（可选）说明这条断言的意图">
            <input
              className={inputCls}
              placeholder="e.g. 博客必须包含结论章节"
              value={a.description ?? ""}
              onChange={(e) => patch(i, { ...a, description: e.target.value || undefined })}
            />
          </Field>
        </div>
      ))}
    </div>
  );
}
