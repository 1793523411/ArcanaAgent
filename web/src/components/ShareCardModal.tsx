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

function resolveVar(el: HTMLElement, prop: string): string {
  return getComputedStyle(el).getPropertyValue(prop).trim();
}

function inlineComputedStyles(root: HTMLElement) {
  const walk = (el: HTMLElement) => {
    const cs = getComputedStyle(el);

    el.style.color = cs.color;
    el.style.backgroundColor = cs.backgroundColor;
    el.style.fontSize = cs.fontSize;
    el.style.fontWeight = cs.fontWeight;
    el.style.fontFamily = cs.fontFamily;
    el.style.lineHeight = cs.lineHeight;
    el.style.letterSpacing = cs.letterSpacing;
    el.style.textAlign = cs.textAlign;

    el.style.margin = cs.margin;
    el.style.padding = cs.padding;

    el.style.borderTop = cs.borderTop;
    el.style.borderRight = cs.borderRight;
    el.style.borderBottom = cs.borderBottom;
    el.style.borderLeft = cs.borderLeft;
    el.style.borderRadius = cs.borderRadius;

    el.style.display = cs.display;
    if (cs.display.includes("flex")) {
      el.style.flexDirection = cs.flexDirection;
      el.style.alignItems = cs.alignItems;
      el.style.justifyContent = cs.justifyContent;
      el.style.gap = cs.gap;
      el.style.flexWrap = cs.flexWrap;
      el.style.flexShrink = cs.flexShrink;
      el.style.flexGrow = cs.flexGrow;
    }

    el.style.width = cs.width;
    el.style.minWidth = cs.minWidth;
    el.style.maxWidth = cs.maxWidth;
    el.style.height = cs.height;
    el.style.minHeight = cs.minHeight;
    el.style.overflow = cs.overflow;
    el.style.overflowX = cs.overflowX;
    el.style.overflowY = cs.overflowY;
    el.style.boxSizing = cs.boxSizing;
    el.style.whiteSpace = cs.whiteSpace;
    el.style.wordBreak = cs.wordBreak;
    el.style.textOverflow = cs.textOverflow;
    el.style.textDecoration = cs.textDecoration;

    if (cs.listStyleType !== "none") {
      el.style.listStyleType = cs.listStyleType;
      el.style.listStylePosition = cs.listStylePosition;
    }

    if (cs.position === "relative" || cs.position === "absolute") {
      el.style.position = cs.position;
    }

    for (let i = 0; i < el.children.length; i++) {
      const child = el.children[i];
      if (child instanceof HTMLElement) {
        walk(child);
      }
    }
  };
  walk(root);
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

  const captureCard = useCallback(async (): Promise<HTMLCanvasElement | null> => {
    const src = cardRef.current;
    if (!src) return null;

    if (typeof document.fonts?.ready !== "undefined") {
      await document.fonts.ready;
    }
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

    return html2canvas(src, {
      backgroundColor: null,
      scale: 2,
      useCORS: true,
      logging: false,
      onclone: (_doc, clonedRoot) => {
        inlineComputedStyles(clonedRoot);

        clonedRoot.querySelectorAll("pre").forEach((el) => {
          const p = el as HTMLElement;
          p.style.overflow = "visible";
          p.style.maxHeight = "none";
          p.style.whiteSpace = "pre-wrap";
          p.style.wordBreak = "break-all";
        });

        clonedRoot.querySelectorAll("code").forEach((el) => {
          const c = el as HTMLElement;
          c.style.whiteSpace = "pre-wrap";
          c.style.wordBreak = "break-all";
        });

        const rootBg = resolveVar(src, "--color-bg") || (theme === "light" ? "#f8fafc" : "#0f172a");
        clonedRoot.style.setProperty("--color-bg", rootBg);
        clonedRoot.style.setProperty("--color-surface", resolveVar(src, "--color-surface") || (theme === "light" ? "#ffffff" : "#1e293b"));
        clonedRoot.style.setProperty("--color-surface-hover", resolveVar(src, "--color-surface-hover") || (theme === "light" ? "#f1f5f9" : "#334155"));
        clonedRoot.style.setProperty("--color-border", resolveVar(src, "--color-border") || (theme === "light" ? "#e2e8f0" : "#334155"));
        clonedRoot.style.setProperty("--color-text", resolveVar(src, "--color-text") || (theme === "light" ? "#0f172a" : "#f1f5f9"));
        clonedRoot.style.setProperty("--color-text-muted", resolveVar(src, "--color-text-muted") || (theme === "light" ? "#64748b" : "#94a3b8"));
        clonedRoot.style.setProperty("--color-accent", resolveVar(src, "--color-accent") || (theme === "light" ? "#0d9488" : "#14b8a6"));
      },
    });
  }, [theme]);

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
