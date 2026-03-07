import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import type { StoredAttachment } from "../types";

const API_BASE = "/api";

interface Props {
  attachments: StoredAttachment[];
  /** 与气泡同向对齐，human 为 end */
  align?: "start" | "end";
  /** 对话 id，用于 file 引用型附件的 URL */
  conversationId?: string;
}

function imageSrc(att: StoredAttachment, conversationId?: string): string | null {
  if (att.type !== "image") return null;
  if (att.data != null && att.mimeType != null) return `data:${att.mimeType};base64,${att.data}`;
  if (att.file != null && conversationId != null) {
    const filename = att.file.replace(/^attachments\//, "");
    return `${API_BASE}/conversations/${conversationId}/attachments/${encodeURIComponent(filename)}`;
  }
  return null;
}

function ImageThumbnail({ src, onClick }: { src: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-14 h-14 rounded-lg overflow-hidden border border-[var(--color-border)] bg-[var(--color-surface)] shrink-0 cursor-pointer hover:opacity-90 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-1"
      aria-label="预览图片"
    >
      <img src={src} alt="" className="w-full h-full object-cover" />
    </button>
  );
}

/** 预留：其他类型附件（文件等）的缩略图 */
function OtherThumbnail({ type }: { type: string }) {
  return (
    <div
      className="w-14 h-14 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shrink-0 flex items-center justify-center text-[var(--color-text-muted)]"
      title={`附件类型: ${type}`}
    >
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
        <path d="M14 2v6h6" />
      </svg>
    </div>
  );
}

export default function AttachmentStrip({ attachments, align = "end", conversationId }: Props) {
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);

  if (attachments.length === 0) return null;

  return (
    <>
      <div
        className={`flex flex-wrap gap-2 mb-1.5 max-w-[85%] ${align === "end" ? "self-end" : "self-start"}`}
        role="list"
        aria-label="附件"
      >
        {attachments.map((a, i) => {
          const src = imageSrc(a, conversationId);
          if (src != null) {
            return (
              <ImageThumbnail
                key={i}
                src={src}
                onClick={() => setPreviewSrc(src)}
              />
            );
          }
          return <OtherThumbnail key={i} type={a.type} />;
        })}
      </div>

      <Dialog.Root open={!!previewSrc} onOpenChange={(open) => !open && setPreviewSrc(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/80 z-[100] cursor-pointer" />
          <Dialog.Content
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[101] max-w-[90vw] max-h-[90vh] outline-none"
            onPointerDownOutside={() => setPreviewSrc(null)}
            onEscapeKeyDown={() => setPreviewSrc(null)}
          >
            {previewSrc && (
              <img
                src={previewSrc}
                alt="预览"
                className="max-w-full max-h-[90vh] w-auto h-auto object-contain rounded-lg shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              />
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
