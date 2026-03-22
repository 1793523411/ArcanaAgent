import { useRef, useState, useCallback } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import html2canvas from "html2canvas";
import ShareCard from "./ShareCard";
import { createShare } from "../api";
import { useToast } from "./Toast";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  content: string;
  title: string;
  modelName?: string;
  conversationId: string;
  messageIndex: number;
  theme: "light" | "dark";
}

export default function ShareCardModal({
  open,
  onOpenChange,
  content,
  title,
  modelName,
  conversationId,
  messageIndex,
  theme,
}: Props) {
  const cardRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [sharing, setSharing] = useState(false);

  /**
   * Capture the same DOM node as the preview. A previous approach cloned the
   * card off-screen and inlined computed styles; that diverged from the real
   * layout (flex vertical alignment, list markers) in html2canvas output.
   */
  const captureCard = useCallback(async (): Promise<HTMLCanvasElement | null> => {
    const src = cardRef.current;
    if (!src) return null;

    if (typeof document.fonts?.ready !== "undefined") {
      await document.fonts.ready;
    }
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

    // html2canvas 把 DOM「重画」到 canvas 上，不是系统截屏，因此与浏览器原生排版/抗锯齿
    // 可能有细微差别（字体、渐变、阴影、列表 marker、圆角等）。scale: 2 也会与 1x 屏显观感略不同。
    // 若需更接近矢量效果可试 foreignObjectRendering: true（部分环境/跨域图可能异常）。
    return html2canvas(src, {
      backgroundColor: null,
      scale: 2,
      useCORS: true,
      logging: false,
      onclone: (_doc, root) => {
        root.querySelectorAll("pre").forEach((el) => {
          const p = el as HTMLElement;
          p.style.overflow = "visible";
          p.style.maxHeight = "none";
        });
      },
    });
  }, []);

  const handleSaveImage = async () => {
    setSaving(true);
    try {
      const canvas = await captureCard();
      if (!canvas) return;
      const link = document.createElement("a");
      link.download = `share-${Date.now()}.png`;
      link.href = canvas.toDataURL("image/png");
      link.click();
      toast("图片已保存", "success");
    } catch {
      toast("保存失败", "error");
    } finally {
      setSaving(false);
    }
  };

  const handleCopyImage = async () => {
    setSaving(true);
    try {
      const canvas = await captureCard();
      if (!canvas) return;
      canvas.toBlob(async (blob) => {
        if (!blob) {
          toast("复制失败", "error");
          setSaving(false);
          return;
        }
        try {
          await navigator.clipboard.write([
            new ClipboardItem({ "image/png": blob }),
          ]);
          toast("图片已复制到剪贴板", "success");
        } catch {
          toast("复制失败，请使用保存图片功能", "error");
        }
        setSaving(false);
      }, "image/png");
    } catch {
      toast("复制失败", "error");
      setSaving(false);
    }
  };

  const handleCopyLink = async () => {
    setSharing(true);
    try {
      const record = await createShare(conversationId, messageIndex);
      const url = `${window.location.origin}/share/${record.shareId}`;
      await navigator.clipboard.writeText(url);
      toast("分享链接已复制", "success");
    } catch {
      toast("生成分享链接失败", "error");
    } finally {
      setSharing(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 z-[100]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[90%] max-w-[660px] max-h-[90vh] bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6 z-[101] shadow-xl flex flex-col">
          <Dialog.Title className="text-base font-semibold text-[var(--color-text)] mb-4">
            分享
          </Dialog.Title>

          {/* Card Preview — scrollable wrapper, card inside renders at full height */}
          <div className="flex-1 min-h-0 overflow-auto mb-4 rounded-xl bg-[var(--color-bg)] p-4">
            <div className="flex justify-center">
              <ShareCard
                ref={cardRef}
                theme={theme}
                content={content}
                title={title}
                modelName={modelName}
              />
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-3 justify-end flex-wrap shrink-0">
            <button
              type="button"
              onClick={handleCopyLink}
              disabled={sharing}
              className="px-4 py-2.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text)] cursor-pointer hover:bg-[var(--color-surface-hover)] transition-colors disabled:opacity-50 text-sm"
            >
              {sharing ? "生成中..." : "复制分享链接"}
            </button>
            <button
              type="button"
              onClick={handleCopyImage}
              disabled={saving}
              className="px-4 py-2.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text)] cursor-pointer hover:bg-[var(--color-surface-hover)] transition-colors disabled:opacity-50 text-sm"
            >
              复制图片
            </button>
            <button
              type="button"
              onClick={handleSaveImage}
              disabled={saving}
              className="px-4 py-2.5 rounded-lg bg-[var(--color-accent)] text-white font-medium cursor-pointer hover:opacity-90 transition-opacity border-none disabled:opacity-50 text-sm"
            >
              {saving ? "保存中..." : "保存图片"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
