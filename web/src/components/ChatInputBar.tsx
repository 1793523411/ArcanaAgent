import { useRef } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";

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
  models: Array<{ id: string; name: string; provider?: string; supportsImage?: boolean }>;
  modelId: string | undefined;
  onModelChange: (modelId: string) => void;
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
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);

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
  const supportsImage = currentModel?.supportsImage !== false;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSend();
      }}
      className="w-full flex flex-col gap-3"
    >
      <div
        className={`
          flex items-center gap-3 bg-[var(--color-surface)] border border-[var(--color-border)]
          ${compact ? "px-3.5 py-2.5 rounded-3xl" : "px-4 py-3.5 rounded-2xl"}
        `}
      >
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
          disabled={loading}
          className="p-1.5 rounded-lg text-[var(--color-text-muted)] flex items-center justify-center disabled:cursor-not-allowed hover:bg-[var(--color-surface-hover)] transition-colors"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          </>
        )}
        <input
          type="text"
          name="message"
          autoComplete="off"
          aria-label="输入消息"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={loading}
          className={`
            flex-1 min-w-0 p-0 bg-transparent border-none text-[var(--color-text)]
            outline-none focus:outline-none focus-visible:outline-none focus-visible:ring-0
            ${compact ? "text-[15px]" : "text-base"}
          `}
        />
        {models.length > 1 ? (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                disabled={loading}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[var(--color-text-muted)] text-[13px] disabled:cursor-not-allowed hover:bg-[var(--color-surface-hover)] transition-colors data-[state=open]:bg-[var(--color-surface-hover)]"
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
          <span className="text-[13px] text-[var(--color-text-muted)] px-2.5 py-1.5">
            {currentModel?.name ?? "模型"}
          </span>
        )}
        <button
          type="submit"
          disabled={loading || (!value.trim() && files.length === 0)}
          aria-label={loading ? "发送中" : "发送"}
          className={`
            bg-[var(--color-accent)] text-white font-semibold border-none rounded-xl
            hover:not(:disabled):bg-[var(--color-accent-hover)] disabled:bg-[var(--color-text-muted)] disabled:cursor-not-allowed
            focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-2
            ${compact ? "px-3.5 py-2 rounded-[20px]" : "px-4 py-2"}
          `}
        >
          {loading ? "…" : "发送"}
        </button>
      </div>
      {supportsImage && files.length > 0 && (
        <div className="flex flex-wrap gap-2">
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
    </form>
  );
}
