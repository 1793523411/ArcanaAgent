import { useState, useRef, useEffect, useCallback } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { ConversationMode } from "../types";

export interface FileWithData {
  file: File;
  mimeType: string;
  data: string;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  loading: boolean;
  compact?: boolean;
  placeholder?: string;
  files: FileWithData[];
  onFilesChange: (files: FileWithData[]) => void;
  models: Array<{ id: string; name: string; provider?: string; supportsImage?: boolean; contextWindow?: number }>;
  modelId: string | undefined;
  onModelChange: (modelId: string) => void;
  mode: ConversationMode;
  onModeChange: (mode: ConversationMode) => void;
  modeLocked?: boolean;
  disabled?: boolean;
  contextUsage?: {
    strategy?: "full" | "trim" | "compress";
    percentByWindow?: number;
    percentByThreshold?: number;
    sessionTokens?: number;
    totalTokens: number;
    thresholdTokens?: number;
    tokenThresholdPercent?: number;
  } | null;
  onCompress?: () => void;
  compressing?: boolean;
}

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"];

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

export default function ChatInputBar({
  value,
  onChange,
  onSend,
  loading,
  compact,
  placeholder = "今天我能为你做些什么？",
  files,
  onFilesChange,
  models,
  modelId,
  onModelChange,
  mode,
  onModeChange,
  modeLocked = false,
  disabled = false,
  contextUsage = null,
  onCompress,
  compressing = false,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [contextTooltipOpen, setContextTooltipOpen] = useState(false);

  useEffect(() => {
    if (loading) {
      setModelMenuOpen(false);
      setModeMenuOpen(false);
      setContextTooltipOpen(false);
    }
  }, [loading]);

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const lineH = compact ? 22 : 24;
    const minH = lineH * 3;
    const maxH = compact ? 150 : 200;
    el.style.height = Math.max(minH, Math.min(el.scrollHeight, maxH)) + "px";
  }, [compact]);

  useEffect(() => {
    autoResize();
  }, [value, autoResize]);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files ?? []);
    e.target.value = "";
    const imageFiles = selected.filter((f) => IMAGE_TYPES.includes(f.type));
    if (imageFiles.length === 0) return;
    const newOnes: FileWithData[] = await Promise.all(
      imageFiles.slice(0, 4).map(async (file) => ({
        file,
        mimeType: file.type,
        data: (await readFileAsDataUrl(file)).split(",")[1] ?? "",
      }))
    );
    onFilesChange([...files, ...newOnes]);
  };

  const removeFile = (i: number) => {
    onFilesChange(files.filter((_, idx) => idx !== i));
  };

  const currentModel = models.find((m) => m.id === modelId) ?? models[0];
  const modeLabel = mode === "team" ? "Team Mode" : "默认模式";
  const supportsImage = currentModel?.supportsImage !== false;
  const strategyLabel = {
    full: "全量上下文",
    trim: "截断",
    compress: "压缩",
  } as const;
  const displayPercent = contextUsage ? (contextUsage.percentByThreshold ?? contextUsage.percentByWindow) : undefined;
  const strategyText = contextUsage?.strategy ? strategyLabel[contextUsage.strategy] : "未知";

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSend();
      }}
      className="w-full flex flex-col gap-2"
    >
      {supportsImage && files.length > 0 && (
        <div className="flex flex-wrap gap-2 px-1">
          {files.map((f, i) => (
            <div
              key={i}
              className="relative w-14 h-14 rounded-lg overflow-hidden bg-[var(--color-surface)] border border-[var(--color-border)]"
            >
              <img
                src={`data:${f.mimeType};base64,${f.data}`}
                alt=""
                className="w-full h-full object-cover"
              />
              <button
                type="button"
                onClick={() => removeFile(i)}
                aria-label="移除"
                className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 text-white text-xs flex items-center justify-center border-none cursor-pointer hover:bg-black/80 transition-colors"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div
        className={`
          flex flex-col bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl
          ${compact ? "px-3.5 pt-3 pb-2" : "px-4 pt-3.5 pb-2.5"}
        `}
      >
        <textarea
          ref={textareaRef}
          name="message"
          autoComplete="off"
          aria-label="输入消息"
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSend();
            }
          }}
          placeholder={loading || disabled ? "AI 正在思考中…" : placeholder}
          disabled={loading || disabled}
          className={`
            w-full p-0 bg-transparent border-none text-[var(--color-text)]
            outline-none resize-none overflow-y-auto leading-relaxed
            placeholder:text-[var(--color-text-muted)]
            ${compact ? "text-[15px]" : "text-base"}
          `}
        />
        <div className="flex items-center justify-between mt-2">
          <div className="flex items-center gap-1">
            {supportsImage && (
              <>
                <input
                  ref={fileRef}
                  type="file"
                  accept={IMAGE_TYPES.join(",")}
                  multiple
                  className="hidden"
                  onChange={handleFileSelect}
                />
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  aria-label="上传图片"
                  disabled={loading || disabled}
                  className="p-1.5 rounded-lg text-[var(--color-text-muted)] flex items-center justify-center disabled:cursor-not-allowed hover:bg-[var(--color-surface-hover)] transition-colors"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
                  </svg>
                </button>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            {contextUsage && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setContextTooltipOpen(!contextTooltipOpen)}
                  className="flex items-center gap-1 p-0.5 rounded-full hover:bg-[var(--color-surface-hover)] transition-colors"
                  aria-label="查看上下文 token 详情"
                  title={contextUsage.sessionTokens != null ? `上下文估算 token：${contextUsage.sessionTokens.toLocaleString()}` : "上下文估算 token：0"}
                >
                  <span
                    className="relative block w-3.5 h-3.5 rounded-full"
                    style={{
                      background:
                        displayPercent != null
                          ? `conic-gradient(var(--color-accent) ${displayPercent}%, var(--color-border) ${displayPercent}% 100%)`
                          : "conic-gradient(var(--color-border) 100%, var(--color-border) 100%)",
                    }}
                  >
                    <span className="absolute inset-[2px] rounded-full bg-[var(--color-surface)]" />
                  </span>
                  <span className="text-[12px] text-[var(--color-text-muted)]">
                    {displayPercent != null ? `${Math.round(displayPercent)}%` : "0%"}
                  </span>
                </button>
                {contextTooltipOpen && (
                  <>
                    {/* 点击外部关闭 */}
                    <div
                      className="fixed inset-0 z-10"
                      onClick={() => setContextTooltipOpen(false)}
                    />
                    <div className="absolute bottom-full right-0 mb-2 z-20 animate-in fade-in slide-in-from-bottom-1 duration-150">
                      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg p-3 text-[12px] text-[var(--color-text)] space-y-1 whitespace-nowrap">
                        <div className="font-medium">上下文占用</div>
                        <div className="text-[var(--color-text-muted)]">
                          当前策略：{strategyText}
                        </div>
                        <div className="text-[var(--color-text-muted)]">
                          上下文估算 token：{contextUsage.sessionTokens != null
                            ? `${contextUsage.sessionTokens.toLocaleString()} / ${contextUsage.totalTokens.toLocaleString()} tokens`
                            : `0 / ${contextUsage.totalTokens.toLocaleString()} tokens`}
                        </div>
                        <div className="text-[var(--color-text-muted)]">
                          策略触发阈值：{typeof contextUsage.thresholdTokens === "number"
                            ? `${contextUsage.thresholdTokens.toLocaleString()} tokens`
                            : "未设置"}
                          {typeof contextUsage.tokenThresholdPercent === "number" ? `（${contextUsage.tokenThresholdPercent}%）` : ""}
                        </div>
                        <div className="text-[var(--color-text-muted)]">
                          相对触发阈值占用：{contextUsage.percentByThreshold != null ? `${Math.round(contextUsage.percentByThreshold)}%` : "0%"}
                        </div>
                        {contextUsage.strategy === "compress" && onCompress && (
                          <div className="pt-1.5 mt-1.5 border-t border-[var(--color-border)]">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onCompress();
                                setContextTooltipOpen(false);
                              }}
                              disabled={compressing}
                              className="w-full px-3 py-1 rounded-md text-[12px] font-medium bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                              {compressing ? "压缩中..." : "立即压缩"}
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
            {!loading && !disabled ? (
              <DropdownMenu.Root open={modeMenuOpen} onOpenChange={setModeMenuOpen}>
                <DropdownMenu.Trigger asChild>
                  <button
                    type="button"
                    disabled={loading || disabled || modeLocked}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[var(--color-text-muted)] text-[13px] disabled:cursor-not-allowed disabled:opacity-60 hover:bg-[var(--color-surface-hover)] transition-colors data-[state=open]:bg-[var(--color-surface-hover)]"
                  >
                    <span>{modeLabel}</span>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
                      <path d="M18 15l-6-6-6 6" />
                    </svg>
                  </button>
                </DropdownMenu.Trigger>
                {!modeLocked && (
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      side="top"
                      sideOffset={4}
                      align="end"
                      className="min-w-[160px] bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl shadow-lg p-1.5 z-50"
                    >
                      <DropdownMenu.Item
                        onSelect={() => onModeChange("default")}
                        className={`
                          w-full text-left px-3 py-2 rounded-md text-sm cursor-pointer outline-none
                          data-[highlighted]:bg-[var(--color-accent-alpha)]
                          ${mode === "default" ? "bg-[var(--color-accent-alpha)]" : ""}
                        `}
                      >
                        默认模式
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        onSelect={() => onModeChange("team")}
                        className={`
                          w-full text-left px-3 py-2 rounded-md text-sm cursor-pointer outline-none
                          data-[highlighted]:bg-[var(--color-accent-alpha)]
                          ${mode === "team" ? "bg-[var(--color-accent-alpha)]" : ""}
                        `}
                      >
                        Team Mode
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                )}
              </DropdownMenu.Root>
            ) : (
              <span className="text-[13px] text-[var(--color-text-muted)] px-2 py-1">
                {modeLabel}
              </span>
            )}
            {models.length > 1 && !loading && !disabled ? (
              <DropdownMenu.Root open={modelMenuOpen} onOpenChange={setModelMenuOpen}>
                <DropdownMenu.Trigger asChild>
                  <button
                    type="button"
                    disabled={loading || disabled}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[var(--color-text-muted)] text-[13px] disabled:cursor-not-allowed hover:bg-[var(--color-surface-hover)] transition-colors data-[state=open]:bg-[var(--color-surface-hover)]"
                  >
                    <span>{currentModel?.name ?? "模型"}</span>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
                      <path d="M18 15l-6-6-6 6" />
                    </svg>
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    side="top"
                    sideOffset={4}
                    align="end"
                    className="min-w-[160px] max-h-[200px] overflow-auto bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl shadow-lg p-1.5 z-50"
                  >
                    {models.map((m) => (
                      <DropdownMenu.Item
                        key={m.id}
                        onSelect={() => onModelChange(m.id)}
                        className={`
                          w-full text-left px-3 py-2 rounded-md text-sm cursor-pointer outline-none
                          data-[highlighted]:bg-[var(--color-accent-alpha)]
                          ${m.id === modelId ? "bg-[var(--color-accent-alpha)]" : ""}
                        `}
                      >
                        {m.name}
                      </DropdownMenu.Item>
                    ))}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            ) : (
              <span className="text-[13px] text-[var(--color-text-muted)] px-2 py-1">
                {currentModel?.name ?? "模型"}
              </span>
            )}
            <button
              type="submit"
              disabled={loading || disabled || (!value.trim() && files.length === 0)}
              aria-label={loading || disabled ? "发送中" : "发送"}
              className="p-2 rounded-full bg-[var(--color-accent)] text-white border-none hover:not-disabled:bg-[var(--color-accent-hover)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="19" x2="12" y2="5" />
                <polyline points="5 12 12 5 19 12" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}
