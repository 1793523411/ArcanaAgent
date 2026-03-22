import { useState, useEffect, useCallback } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  getProviders,
  createProvider,
  updateProvider,
  deleteProvider,
  validateModels,
  validateAllModels,
  getCachedValidations,
} from "../api";
import type { ProviderInfo, ModelSpec, ModelValidationResult } from "../types";
import { useToast } from "./Toast";

interface Props {
  onClose: () => void;
  onSaved: () => void;
}

// ─── Form state types ─────────────────────────────────────

interface ModelFormRow {
  id: string;
  name: string;
  api: string; // "" means inherit from provider
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  inputText: boolean;
  inputImage: boolean;
}

interface ProviderFormState {
  name: string;
  baseUrl: string;
  apiKey: string;
  apiKeyChanged: boolean;
  api: string;
  models: ModelFormRow[];
}

function makeEmptyModelRow(): ModelFormRow {
  return {
    id: "",
    name: "",
    api: "",
    contextWindow: 8192,
    maxTokens: 4096,
    reasoning: false,
    inputText: true,
    inputImage: false,
  };
}

function makeEmptyForm(): ProviderFormState {
  return {
    name: "",
    baseUrl: "",
    apiKey: "",
    apiKeyChanged: false,
    api: "openai-completions",
    models: [makeEmptyModelRow()],
  };
}

function providerToForm(p: ProviderInfo): ProviderFormState {
  return {
    name: p.name,
    baseUrl: p.baseUrl,
    apiKey: p.apiKeyMasked,
    apiKeyChanged: false,
    api: p.api,
    models: p.models.map((m) => ({
      id: m.id,
      name: m.name,
      api: m.api === p.api ? "" : m.api,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      reasoning: m.reasoning ?? false,
      inputText: m.input?.includes("text") ?? true,
      inputImage: m.input?.includes("image") ?? false,
    })),
  };
}

// ─── Validation badge ─────────────────────────────────────

type ValidationState =
  | { status: "idle" }
  | { status: "validating" }
  | { status: "success"; latencyMs: number }
  | { status: "warning"; latencyMs: number }
  | { status: "error"; error: string };

function ValidationBadge({ state }: { state: ValidationState }) {
  if (state.status === "idle") {
    return <span className="text-xs text-[var(--color-text-muted)]">未验证</span>;
  }
  if (state.status === "validating") {
    return (
      <span className="flex items-center gap-1 text-xs text-[var(--color-text-muted)]">
        <svg
          className="animate-spin h-3.5 w-3.5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
        </svg>
        验证中…
      </span>
    );
  }
  if (state.status === "success") {
    return (
      <span className="flex items-center gap-1 text-xs text-emerald-500">
        <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
          <path
            fillRule="evenodd"
            d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
            clipRule="evenodd"
          />
        </svg>
        {state.latencyMs}ms
      </span>
    );
  }
  if (state.status === "warning") {
    return (
      <span className="flex items-center gap-1 text-xs text-yellow-500">
        <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
          <path
            fillRule="evenodd"
            d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
            clipRule="evenodd"
          />
        </svg>
        {state.latencyMs}ms
      </span>
    );
  }
  // error
  return (
    <span className="flex items-center gap-1 text-xs text-red-500" title={state.error}>
      <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5 shrink-0">
        <path
          fillRule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-11a1 1 0 10-2 0v4a1 1 0 102 0V7zm0 6a1 1 0 10-2 0 1 1 0 002 0z"
          clipRule="evenodd"
        />
      </svg>
      <span className="truncate max-w-[120px]">{state.error}</span>
    </span>
  );
}

// ─── Main component ───────────────────────────────────────

export default function ModelsPanel({ onClose, onSaved }: Props) {
  const { toast } = useToast();

  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [loading, setLoading] = useState(true);

  // expanded provider names
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // validation
  const [validationMap, setValidationMap] = useState<Record<string, ValidationState>>({});
  const [validatingAll, setValidatingAll] = useState(false);

  // form mode: null = list view; "add" = add new; string = editing provider name
  const [formMode, setFormMode] = useState<null | "add" | string>(null);
  const [form, setForm] = useState<ProviderFormState>(makeEmptyForm());
  const [saving, setSaving] = useState(false);

  // ── Load providers ──────────────────────────────────────

  const loadProviders = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getProviders();
      setProviders(data);
      if (data.length > 0) {
        setExpanded(new Set([data[0].name]));
      }
      // 加载缓存的验证结果
      const cached = await getCachedValidations();
      const mapped: Record<string, ValidationState> = {};
      for (const [key, r] of Object.entries(cached)) {
        if (r.status === "success") {
          mapped[key] = { status: "success", latencyMs: r.latencyMs };
        } else if (r.status === "warning") {
          mapped[key] = { status: "warning", latencyMs: r.latencyMs };
        } else {
          mapped[key] = { status: "error", error: r.error ?? "未知错误" };
        }
      }
      setValidationMap(mapped);
    } catch (e) {
      toast(`加载失败: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  // ── Form helpers ────────────────────────────────────────

  const openAddForm = () => {
    setForm(makeEmptyForm());
    setFormMode("add");
  };

  const openEditForm = (p: ProviderInfo) => {
    setForm(providerToForm(p));
    setFormMode(p.name);
  };

  const cancelForm = () => {
    setFormMode(null);
  };

  const updateFormField = <K extends keyof ProviderFormState>(
    key: K,
    value: ProviderFormState[K]
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const updateModelRow = (idx: number, patch: Partial<ModelFormRow>) => {
    setForm((prev) => {
      const models = prev.models.map((m, i) => (i === idx ? { ...m, ...patch } : m));
      return { ...prev, models };
    });
  };

  const addModelRow = () => {
    setForm((prev) => ({ ...prev, models: [...prev.models, makeEmptyModelRow()] }));
  };

  const removeModelRow = (idx: number) => {
    setForm((prev) => ({
      ...prev,
      models: prev.models.filter((_, i) => i !== idx),
    }));
  };

  // ── Save ────────────────────────────────────────────────

  const handleSave = async () => {
    const name = form.name.trim();
    if (!name) { toast("名称不能为空", "error"); return; }
    if (!form.baseUrl.trim()) { toast("Base URL 不能为空", "error"); return; }

    const models: ModelSpec[] = form.models
      .filter((m) => m.id.trim())
      .map((m) => {
        const input: string[] = [];
        if (m.inputText) input.push("text");
        if (m.inputImage) input.push("image");
        return {
          id: m.id.trim(),
          name: m.name.trim() || m.id.trim(),
          api: m.api.trim() || form.api,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          reasoning: m.reasoning,
          input,
        };
      });

    setSaving(true);
    try {
      if (formMode === "add") {
        await createProvider({
          name,
          baseUrl: form.baseUrl.trim(),
          apiKey: form.apiKey,
          api: form.api,
          models,
        });
        toast("Provider 已创建", "success");
      } else {
        const payload: Parameters<typeof updateProvider>[1] = {
          baseUrl: form.baseUrl.trim(),
          api: form.api,
          models,
        };
        if (form.apiKeyChanged) {
          payload.apiKey = form.apiKey;
        }
        await updateProvider(formMode as string, payload);
        toast("Provider 已更新", "success");
      }
      setFormMode(null);
      await loadProviders();
      onSaved();
    } catch (e) {
      toast(`保存失败: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setSaving(false);
    }
  };

  // ── Delete ──────────────────────────────────────────────

  const handleDelete = async (providerName: string) => {
    if (!window.confirm(`确定删除 Provider「${providerName}」及其所有模型吗？`)) return;
    try {
      await deleteProvider(providerName);
      toast("Provider 已删除", "success");
      await loadProviders();
      onSaved();
    } catch (e) {
      toast(`删除失败: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  };

  // ── Validation ──────────────────────────────────────────

  const applyResults = (results: ModelValidationResult[]) => {
    setValidationMap((prev) => {
      const next = { ...prev };
      for (const r of results) {
        // r.modelId is already composite "provider:rawId"
        const key = r.modelId;
        if (r.status === "success") {
          next[key] = { status: "success", latencyMs: r.latencyMs };
        } else if (r.status === "warning") {
          next[key] = { status: "warning", latencyMs: r.latencyMs };
        } else {
          next[key] = { status: "error", error: r.error ?? "未知错误" };
        }
      }
      return next;
    });
  };

  const handleValidateOne = async (compositeId: string) => {
    setValidationMap((prev) => ({ ...prev, [compositeId]: { status: "validating" } }));
    try {
      const results = await validateModels([compositeId]);
      applyResults(results);
    } catch (e) {
      setValidationMap((prev) => ({
        ...prev,
        [compositeId]: { status: "error", error: e instanceof Error ? e.message : String(e) },
      }));
    }
  };

  const handleValidateAll = async () => {
    // mark all as validating
    const allIds: Record<string, ValidationState> = {};
    for (const p of providers) {
      for (const m of p.models) {
        allIds[`${p.name}:${m.id}`] = { status: "validating" };
      }
    }
    setValidationMap((prev) => ({ ...prev, ...allIds }));
    setValidatingAll(true);
    try {
      const results = await validateAllModels();
      applyResults(results);
    } catch (e) {
      toast(`验证失败: ${e instanceof Error ? e.message : String(e)}`, "error");
      // reset validating to idle
      setValidationMap((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(allIds)) {
          if (next[key]?.status === "validating") {
            next[key] = { status: "idle" };
          }
        }
        return next;
      });
    } finally {
      setValidatingAll(false);
    }
  };

  // ── Toggle expand ───────────────────────────────────────

  const toggleExpanded = (name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  // ── Render ──────────────────────────────────────────────

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 z-[100]" />
        <Dialog.Content
          onPointerDownOutside={onClose}
          onEscapeKeyDown={onClose}
          className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[95%] max-w-[860px] h-[90vh] min-h-[500px] max-h-[900px] flex flex-col bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl shadow-xl z-[101] overflow-hidden"
        >
          <Dialog.Title className="sr-only">模型管理</Dialog.Title>

          {/* Top bar */}
          <div className="flex items-center gap-3 px-5 py-3.5 border-b border-[var(--color-border)] bg-[var(--color-bg)] shrink-0">
            <span className="text-base font-semibold text-[var(--color-text)] flex-1">模型管理</span>
            <button
              type="button"
              onClick={openAddForm}
              disabled={formMode !== null}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[var(--color-accent)] text-white text-sm shadow-sm hover:bg-[var(--color-accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                <path fillRule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clipRule="evenodd" />
              </svg>
              添加 Provider
            </button>
            <button
              type="button"
              onClick={handleValidateAll}
              disabled={validatingAll || providers.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-[var(--color-border)] text-sm text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {validatingAll ? (
                <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                </svg>
              ) : (
                <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
              )}
              全部验证
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] transition-colors"
              aria-label="关闭"
            >
              <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
                <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            </button>
          </div>

          {/* Scrollable body */}
          <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">

            {/* Add form (only for new providers, shown at top) */}
            {formMode === "add" && (
              <ProviderForm
                form={form}
                isEditing={false}
                saving={saving}
                onChange={updateFormField}
                onModelChange={updateModelRow}
                onAddModel={addModelRow}
                onRemoveModel={removeModelRow}
                onSave={handleSave}
                onCancel={cancelForm}
              />
            )}

            {/* Provider list */}
            {loading ? (
              <div className="flex items-center justify-center py-16 text-[var(--color-text-muted)] text-sm">
                加载中…
              </div>
            ) : providers.length === 0 && formMode === null ? (
              <div className="flex flex-col items-center justify-center py-16 gap-2 text-[var(--color-text-muted)]">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-10 w-10 opacity-30">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M12 5l7 7-7 7" />
                </svg>
                <p className="text-sm">暂无 Provider，点击「添加 Provider」开始配置</p>
              </div>
            ) : (
              providers.map((p) => {
                const isOpen = expanded.has(p.name);
                const isEditingThis = formMode === p.name;

                // 就地显示编辑表单，替换原卡片
                if (isEditingThis) {
                  return (
                    <ProviderForm
                      key={`edit-${p.name}`}
                      form={form}
                      isEditing={true}
                      saving={saving}
                      onChange={updateFormField}
                      onModelChange={updateModelRow}
                      onAddModel={addModelRow}
                      onRemoveModel={removeModelRow}
                      onSave={handleSave}
                      onCancel={cancelForm}
                    />
                  );
                }
                return (
                  <div
                    key={p.name}
                    className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] overflow-hidden"
                  >
                    {/* Provider header */}
                    <div className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none hover:bg-[var(--color-surface-hover)] transition-colors"
                      onClick={() => toggleExpanded(p.name)}
                    >
                      <svg
                        viewBox="0 0 20 20"
                        fill="currentColor"
                        className={`h-4 w-4 text-[var(--color-text-muted)] transition-transform shrink-0 ${isOpen ? "rotate-90" : ""}`}
                      >
                        <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
                      </svg>
                      <span className="text-sm font-semibold text-[var(--color-text)] flex-1">{p.name}</span>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text-muted)] font-mono">
                        {p.api}
                      </span>
                      <span className="text-xs text-[var(--color-text-muted)] max-w-[220px] truncate hidden sm:block">
                        {p.baseUrl}
                      </span>
                      <div className="flex items-center gap-1.5 ml-2" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          onClick={() => openEditForm(p)}
                          className="p-1.5 rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)] transition-colors"
                          aria-label={`编辑 ${p.name}`}
                        >
                          <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
                            <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(p.name)}
                          className="p-1.5 rounded-md text-[var(--color-text-muted)] hover:bg-red-500/10 hover:text-red-500 transition-colors"
                          aria-label={`删除 ${p.name}`}
                        >
                          <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
                            <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
                          </svg>
                        </button>
                      </div>
                    </div>

                    {/* Model list */}
                    {isOpen && (
                      <div className="border-t border-[var(--color-border)]">
                        {p.models.length === 0 ? (
                          <p className="px-6 py-3 text-xs text-[var(--color-text-muted)]">暂无模型</p>
                        ) : (
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="bg-[var(--color-surface)] text-[var(--color-text-muted)]">
                                <th className="px-4 py-2 text-left font-medium">模型名称</th>
                                <th className="px-2 py-2 text-left font-medium">ID</th>
                                <th className="px-2 py-2 text-left font-medium">类型</th>
                                <th className="px-2 py-2 text-left font-medium">输入</th>
                                <th className="px-2 py-2 text-left font-medium">验证</th>
                                <th className="px-2 py-2 text-left font-medium"></th>
                              </tr>
                            </thead>
                            <tbody>
                              {p.models.map((m) => {
                                const key = `${p.name}:${m.id}`;
                                const vs: ValidationState = validationMap[key] ?? { status: "idle" };
                                return (
                                  <tr
                                    key={m.id}
                                    className="border-t border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] transition-colors"
                                  >
                                    <td className="px-4 py-2.5 text-[var(--color-text)] font-medium">{m.name}</td>
                                    <td className="px-2 py-2.5 text-[var(--color-text-muted)] font-mono">{m.id}</td>
                                    <td className="px-2 py-2.5">
                                      {m.reasoning && (
                                        <span className="px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-500 text-[10px] font-medium">
                                          reasoning
                                        </span>
                                      )}
                                    </td>
                                    <td className="px-2 py-2.5">
                                      <span className="flex gap-1 flex-wrap">
                                        {(m.input ?? ["text"]).map((t) => (
                                          <span
                                            key={t}
                                            className="px-1.5 py-0.5 rounded bg-[var(--color-surface)] border border-[var(--color-border)] text-[10px] text-[var(--color-text-muted)]"
                                          >
                                            {t}
                                          </span>
                                        ))}
                                      </span>
                                    </td>
                                    <td className="px-2 py-2.5">
                                      <ValidationBadge state={vs} />
                                    </td>
                                    <td className="px-2 py-2.5">
                                      <button
                                        type="button"
                                        disabled={vs.status === "validating"}
                                        onClick={() => handleValidateOne(key)}
                                        className="px-2 py-1 rounded border border-[var(--color-border)] text-[10px] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                      >
                                        验证
                                      </button>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ─── Provider form sub-component ─────────────────────────

interface ProviderFormProps {
  form: ProviderFormState;
  isEditing: boolean;
  saving: boolean;
  onChange: <K extends keyof ProviderFormState>(key: K, value: ProviderFormState[K]) => void;
  onModelChange: (idx: number, patch: Partial<ModelFormRow>) => void;
  onAddModel: () => void;
  onRemoveModel: (idx: number) => void;
  onSave: () => void;
  onCancel: () => void;
}

function ProviderForm({
  form,
  isEditing,
  saving,
  onChange,
  onModelChange,
  onAddModel,
  onRemoveModel,
  onSave,
  onCancel,
}: ProviderFormProps) {
  return (
    <div className="rounded-lg border border-[var(--color-accent)]/35 bg-[var(--color-surface)] p-5 space-y-5 shadow-sm">
      <h3 className="text-sm font-semibold text-[var(--color-text)]">
        {isEditing ? `编辑 Provider：${form.name}` : "添加新 Provider"}
      </h3>

      {/* Provider basic fields */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs font-medium text-[var(--color-text-muted)]">名称</label>
          <input
            type="text"
            value={form.name}
            readOnly={isEditing}
            onChange={(e) => onChange("name", e.target.value)}
            placeholder="e.g. OpenAI"
            className={`w-full px-3 py-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/40 focus:border-[var(--color-accent)] ${isEditing ? "opacity-60 cursor-not-allowed" : ""}`}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-[var(--color-text-muted)]">API 类型</label>
          <select
            value={form.api}
            onChange={(e) => onChange("api", e.target.value)}
            className="w-full px-3 py-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] text-sm text-[var(--color-text)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/40 focus:border-[var(--color-accent)]"
          >
            <option value="openai-completions">openai-completions</option>
            <option value="anthropic-messages">anthropic-messages</option>
          </select>
        </div>
        <div className="space-y-1 sm:col-span-2">
          <label className="text-xs font-medium text-[var(--color-text-muted)]">Base URL</label>
          <input
            type="url"
            value={form.baseUrl}
            onChange={(e) => onChange("baseUrl", e.target.value)}
            placeholder="https://api.openai.com/v1"
            className="w-full px-3 py-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/40 focus:border-[var(--color-accent)]"
          />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <label className="text-xs font-medium text-[var(--color-text-muted)]">
            API Key{isEditing ? "（留空则保留原值）" : ""}
          </label>
          <input
            type="password"
            value={form.apiKey}
            onChange={(e) => {
              onChange("apiKey", e.target.value);
              onChange("apiKeyChanged", true);
            }}
            placeholder={isEditing ? "••••••••（不修改则留空）" : "sk-..."}
            autoComplete="off"
            className="w-full px-3 py-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/40 focus:border-[var(--color-accent)]"
          />
        </div>
      </div>

      {/* Models sub-section */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wide">模型列表</h4>
          <button
            type="button"
            onClick={onAddModel}
            className="flex items-center gap-1 px-2 py-1 rounded border border-[var(--color-border)] text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] transition-colors"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
              <path fillRule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clipRule="evenodd" />
            </svg>
            添加模型
          </button>
        </div>

        {form.models.length === 0 ? (
          <p className="text-xs text-[var(--color-text-muted)] py-2">暂无模型，点击「添加模型」</p>
        ) : (
          <div className="space-y-3">
            {form.models.map((m, idx) => (
              <ModelFormRowEditor
                key={idx}
                row={m}
                providerApi={form.api}
                onChange={(patch) => onModelChange(idx, patch)}
                onRemove={() => onRemoveModel(idx)}
                canRemove={form.models.length > 1}
              />
            ))}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1 border-t border-[var(--color-border)]">
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="px-3 py-1.5 rounded-md bg-[var(--color-accent)] text-white text-sm shadow-sm hover:bg-[var(--color-accent-hover)] disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? "保存中…" : "保存"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="px-3 py-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] disabled:opacity-60 transition-colors"
        >
          取消
        </button>
      </div>
    </div>
  );
}

// ─── Model row editor ─────────────────────────────────────

interface ModelFormRowEditorProps {
  row: ModelFormRow;
  providerApi: string;
  onChange: (patch: Partial<ModelFormRow>) => void;
  onRemove: () => void;
  canRemove: boolean;
}

function ModelFormRowEditor({ row, providerApi, onChange, onRemove, canRemove }: ModelFormRowEditorProps) {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 sm:p-3.5 space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 sm:gap-3">
        <div className="space-y-1 col-span-2 sm:col-span-1">
          <label className="text-[10px] font-medium text-[var(--color-text-muted)]">模型 ID</label>
          <input
            type="text"
            value={row.id}
            onChange={(e) => onChange({ id: e.target.value })}
            placeholder="gpt-4o"
            className="w-full px-2.5 py-1.5 rounded border border-[var(--color-border)] bg-[var(--color-surface)] text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/40 focus:border-[var(--color-accent)]"
          />
        </div>
        <div className="space-y-1 col-span-2 sm:col-span-1">
          <label className="text-[10px] font-medium text-[var(--color-text-muted)]">显示名称</label>
          <input
            type="text"
            value={row.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="GPT-4o"
            className="w-full px-2.5 py-1.5 rounded border border-[var(--color-border)] bg-[var(--color-surface)] text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/40 focus:border-[var(--color-accent)]"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[10px] font-medium text-[var(--color-text-muted)]">Context 窗口</label>
          <input
            type="number"
            value={row.contextWindow}
            min={1}
            onChange={(e) => onChange({ contextWindow: parseInt(e.target.value, 10) || 0 })}
            className="w-full px-2.5 py-1.5 rounded border border-[var(--color-border)] bg-[var(--color-surface)] text-xs text-[var(--color-text)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/40 focus:border-[var(--color-accent)]"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[10px] font-medium text-[var(--color-text-muted)]">Max Tokens</label>
          <input
            type="number"
            value={row.maxTokens}
            min={1}
            onChange={(e) => onChange({ maxTokens: parseInt(e.target.value, 10) || 0 })}
            className="w-full px-2.5 py-1.5 rounded border border-[var(--color-border)] bg-[var(--color-surface)] text-xs text-[var(--color-text)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/40 focus:border-[var(--color-accent)]"
          />
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-[10px] font-medium text-[var(--color-text-muted)]">
          API 类型（留空继承 Provider: {providerApi}）
        </label>
        <select
          value={row.api}
          onChange={(e) => onChange({ api: e.target.value })}
          className="w-full sm:w-48 px-2.5 py-1.5 rounded border border-[var(--color-border)] bg-[var(--color-surface)] text-xs text-[var(--color-text)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/40 focus:border-[var(--color-accent)]"
        >
          <option value="">继承 Provider</option>
          <option value="openai-completions">openai-completions</option>
          <option value="anthropic-messages">anthropic-messages</option>
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-1.5 cursor-pointer text-xs text-[var(--color-text)]">
          <input
            type="checkbox"
            checked={row.reasoning}
            onChange={(e) => onChange({ reasoning: e.target.checked })}
            className="size-3.5 rounded border-[var(--color-border)] accent-[var(--color-accent)]"
          />
          reasoning
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer text-xs text-[var(--color-text)]">
          <input
            type="checkbox"
            checked={row.inputText}
            onChange={(e) => onChange({ inputText: e.target.checked })}
            className="size-3.5 rounded border-[var(--color-border)] accent-[var(--color-accent)]"
          />
          输入: text
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer text-xs text-[var(--color-text)]">
          <input
            type="checkbox"
            checked={row.inputImage}
            onChange={(e) => onChange({ inputImage: e.target.checked })}
            className="size-3.5 rounded border-[var(--color-border)] accent-[var(--color-accent)]"
          />
          输入: image
        </label>
        <div className="flex-1" />
        {canRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="flex items-center gap-1 px-2 py-1 rounded border border-red-500/30 text-[10px] text-red-500 hover:bg-red-500/10 transition-colors"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-3 w-3">
              <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
            移除
          </button>
        )}
      </div>
    </div>
  );
}
