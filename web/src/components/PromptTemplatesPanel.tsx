import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  getPromptTemplates,
  createPromptTemplate,
  updatePromptTemplate,
  deletePromptTemplate,
} from "../api";
import type { PromptTemplate } from "../types";
import { useToast } from "./Toast";

interface Props {
  onClose: () => void;
  onLaunch: (prompt: string) => Promise<void>;
}

function extractParams(content: string): string[] {
  const matches = content.matchAll(/\{\{\s*([a-zA-Z_][\w.-]*)\s*\}\}/g);
  const unique = new Set<string>();
  for (const match of matches) {
    if (match[1]) unique.add(match[1]);
  }
  return Array.from(unique);
}

function renderTemplate(content: string, values: Record<string, string>): string {
  return content.replace(/\{\{\s*([a-zA-Z_][\w.-]*)\s*\}\}/g, (_, key: string) => values[key] ?? "");
}

export default function PromptTemplatesPanel({ onClose, onLaunch }: Props) {
  const { toast } = useToast();
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [activeTab, setActiveTab] = useState<"launch" | "manage">("launch");
  const [selectedId, setSelectedId] = useState<string>("");
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");

  useEffect(() => {
    getPromptTemplates()
      .then((list) => {
        setTemplates(list);
        if (list.length > 0) {
          setSelectedId(list[0].id);
        }
      })
      .catch((e) => {
        toast(`加载模板失败: ${e instanceof Error ? e.message : String(e)}`, "error");
      })
      .finally(() => setLoading(false));
  }, [toast]);

  const selectedTemplate = useMemo(
    () => templates.find((item) => item.id === selectedId) ?? null,
    [templates, selectedId]
  );

  const selectedParams = useMemo(
    () => extractParams(selectedTemplate?.content ?? ""),
    [selectedTemplate?.content]
  );

  useEffect(() => {
    setParamValues((prev) => {
      const next: Record<string, string> = {};
      for (const key of selectedParams) next[key] = prev[key] ?? "";
      return next;
    });
  }, [selectedId, selectedParams]);

  const startCreate = () => {
    setEditingId(null);
    setName("");
    setDescription("");
    setContent("");
  };

  const startEdit = (template: PromptTemplate) => {
    setEditingId(template.id);
    setName(template.name);
    setDescription(template.description ?? "");
    setContent(template.content);
  };

  const saveTemplate = async () => {
    const cleanName = name.trim();
    if (!cleanName) {
      toast("模板名称不能为空", "error");
      return;
    }
    if (!content.trim()) {
      toast("模板内容不能为空", "error");
      return;
    }
    setSaving(true);
    try {
      if (editingId) {
        const updated = await updatePromptTemplate(editingId, {
          name: cleanName,
          content,
          description: description.trim() || undefined,
        });
        setTemplates((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
        if (selectedId === updated.id) setSelectedId(updated.id);
        toast("模板已更新", "success");
      } else {
        const created = await createPromptTemplate({
          name: cleanName,
          content,
          description: description.trim() || undefined,
        });
        setTemplates((prev) => [created, ...prev]);
        setSelectedId(created.id);
        setActiveTab("launch");
        toast("模板已创建", "success");
      }
      startCreate();
    } catch (e) {
      toast(`保存模板失败: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setSaving(false);
    }
  };

  const removeTemplate = async (id: string) => {
    try {
      await deletePromptTemplate(id);
      setTemplates((prev) => prev.filter((item) => item.id !== id));
      if (selectedId === id) {
        const next = templates.find((item) => item.id !== id);
        setSelectedId(next?.id ?? "");
      }
      if (editingId === id) startCreate();
      toast("模板已删除", "success");
    } catch (e) {
      toast(`删除模板失败: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  };

  const launchFromTemplate = async () => {
    if (!selectedTemplate) {
      toast("请先选择模板", "error");
      return;
    }
    const missing = selectedParams.filter((key) => !paramValues[key]?.trim());
    if (missing.length > 0) {
      toast(`请填写参数: ${missing.join("、")}`, "error");
      return;
    }
    const prompt = renderTemplate(selectedTemplate.content, paramValues);
    if (!prompt.trim()) {
      toast("模板渲染结果为空", "error");
      return;
    }
    setLaunching(true);
    try {
      await onLaunch(prompt);
      onClose();
    } catch (e) {
      toast(`发起对话失败: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setLaunching(false);
    }
  };

  const previewText = selectedTemplate ? renderTemplate(selectedTemplate.content, paramValues) : "";

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 z-[100]" />
        <Dialog.Content
          onPointerDownOutside={onClose}
          onEscapeKeyDown={onClose}
          className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[92%] max-w-[880px] h-[86vh] min-h-[460px] max-h-[760px] flex flex-col bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl shadow-xl z-[101] overflow-hidden"
        >
          <Dialog.Title className="px-6 pt-5 text-lg font-semibold text-[var(--color-text)]">
            模板管理
          </Dialog.Title>
          <div className="px-6 pt-3 flex gap-2">
            <button
              type="button"
              onClick={() => setActiveTab("launch")}
              className={`px-3 py-1.5 rounded-lg text-sm border ${activeTab === "launch" ? "bg-[var(--color-accent)] text-white border-[var(--color-accent)]" : "bg-transparent border-[var(--color-border)] text-[var(--color-text-muted)]"}`}
            >
              使用模板
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("manage")}
              className={`px-3 py-1.5 rounded-lg text-sm border ${activeTab === "manage" ? "bg-[var(--color-accent)] text-white border-[var(--color-accent)]" : "bg-transparent border-[var(--color-border)] text-[var(--color-text-muted)]"}`}
            >
              管理模板
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-hidden p-6 pt-4">
            {loading ? (
              <div className="h-full flex items-center justify-center text-[var(--color-text-muted)]">加载中…</div>
            ) : activeTab === "launch" ? (
              <div className="h-full grid grid-cols-[280px_1fr] gap-4 min-h-0">
                <div className="min-h-0 overflow-auto border border-[var(--color-border)] rounded-lg p-2">
                  {templates.length === 0 ? (
                    <p className="text-sm text-[var(--color-text-muted)] p-3">暂无模板，请先到“管理模板”创建。</p>
                  ) : (
                    templates.map((template) => (
                      <button
                        key={template.id}
                        type="button"
                        onClick={() => setSelectedId(template.id)}
                        className={`w-full text-left p-3 rounded-lg mb-2 border transition-colors ${selectedId === template.id ? "border-[var(--color-accent)] bg-[var(--color-accent-alpha)]" : "border-[var(--color-border)] hover:bg-[var(--color-surface-hover)]"}`}
                      >
                        <div className="font-medium text-sm text-[var(--color-text)]">{template.name}</div>
                        {template.description && (
                          <div className="mt-1 text-xs text-[var(--color-text-muted)] line-clamp-2">{template.description}</div>
                        )}
                      </button>
                    ))
                  )}
                </div>
                <div className="min-h-0 overflow-auto border border-[var(--color-border)] rounded-lg p-4 space-y-3">
                  {!selectedTemplate ? (
                    <div className="text-sm text-[var(--color-text-muted)]">请选择一个模板。</div>
                  ) : (
                    <>
                      <h3 className="m-0 text-base font-semibold text-[var(--color-text)]">{selectedTemplate.name}</h3>
                      {selectedTemplate.description && (
                        <p className="m-0 text-sm text-[var(--color-text-muted)]">{selectedTemplate.description}</p>
                      )}
                      {selectedParams.length > 0 && (
                        <div className="space-y-2">
                          <div className="text-sm text-[var(--color-text)]">参数</div>
                          {selectedParams.map((param) => (
                            <label key={param} className="block text-sm text-[var(--color-text)]">
                              {param}
                              <input
                                type="text"
                                value={paramValues[param] ?? ""}
                                onChange={(e) => setParamValues((prev) => ({ ...prev, [param]: e.target.value }))}
                                className="mt-1 w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)]"
                              />
                            </label>
                          ))}
                        </div>
                      )}
                      <div className="space-y-1">
                        <div className="text-sm text-[var(--color-text)]">预览</div>
                        <textarea
                          value={previewText}
                          readOnly
                          rows={10}
                          className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] text-sm resize-none"
                        />
                      </div>
                    </>
                  )}
                </div>
              </div>
            ) : (
              <div className="h-full grid grid-cols-[300px_1fr] gap-4 min-h-0">
                <div className="min-h-0 overflow-auto border border-[var(--color-border)] rounded-lg p-2">
                  <button
                    type="button"
                    onClick={startCreate}
                    className="w-full mb-2 py-2 rounded-lg border border-dashed border-[var(--color-border)] text-sm text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                  >
                    新建模板
                  </button>
                  {templates.map((template) => (
                    <div key={template.id} className="mb-2 p-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]">
                      <button
                        type="button"
                        onClick={() => startEdit(template)}
                        className="w-full text-left"
                      >
                        <div className="font-medium text-sm text-[var(--color-text)]">{template.name}</div>
                        {template.description && (
                          <div className="mt-1 text-xs text-[var(--color-text-muted)] line-clamp-2">{template.description}</div>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => removeTemplate(template.id)}
                        className="mt-2 px-2 py-1 text-xs rounded border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-error-text)]"
                      >
                        删除
                      </button>
                    </div>
                  ))}
                </div>
                <div className="min-h-0 overflow-auto border border-[var(--color-border)] rounded-lg p-4 space-y-3">
                  <label className="block text-sm text-[var(--color-text)]">
                    模板名称
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="mt-1 w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)]"
                    />
                  </label>
                  <label className="block text-sm text-[var(--color-text)]">
                    描述
                    <input
                      type="text"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      className="mt-1 w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)]"
                    />
                  </label>
                  <label className="block text-sm text-[var(--color-text)]">
                    模板内容
                    <textarea
                      value={content}
                      onChange={(e) => setContent(e.target.value)}
                      rows={14}
                      placeholder="使用 {{变量名}} 作为动态参数，例如：请分析 {{项目名}} 的风险"
                      className="mt-1 w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] resize-none"
                    />
                  </label>
                  <div className="text-xs text-[var(--color-text-muted)]">
                    变量语法：{"{{参数名}}"}，例如 {"{{date}}"}、{"{{repo}}"}
                  </div>
                  <button
                    type="button"
                    onClick={saveTemplate}
                    disabled={saving}
                    className="px-4 py-2 rounded-lg bg-[var(--color-accent)] text-white border-none disabled:opacity-60"
                  >
                    {saving ? "保存中…" : editingId ? "更新模板" : "创建模板"}
                  </button>
                </div>
              </div>
            )}
          </div>
          <div className="shrink-0 flex gap-2 justify-end p-4 border-t border-[var(--color-border)]">
            <Dialog.Close asChild>
              <button
                type="button"
                className="px-4 py-2.5 rounded-lg bg-transparent border border-[var(--color-border)] text-[var(--color-text)] cursor-pointer hover:bg-[var(--color-surface-hover)] transition-colors"
              >
                关闭
              </button>
            </Dialog.Close>
            {activeTab === "launch" && (
              <button
                type="button"
                onClick={launchFromTemplate}
                disabled={launching || !selectedTemplate}
                className="px-4 py-2.5 rounded-lg bg-[var(--color-accent)] text-white font-semibold border-none cursor-pointer disabled:opacity-60"
              >
                {launching ? "发起中…" : "填写后发起对话"}
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
