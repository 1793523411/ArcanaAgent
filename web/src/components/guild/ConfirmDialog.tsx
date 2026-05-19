import * as AlertDialog from "@radix-ui/react-alert-dialog";
import type { ReactNode } from "react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** "danger" = red destructive style, "warning" = amber, "primary" = accent */
  variant?: "danger" | "warning" | "primary";
  loading?: boolean;
}

export default function ConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  title,
  description,
  confirmLabel = "确认",
  cancelLabel = "取消",
  variant = "danger",
  loading = false,
}: Props) {
  const confirmStyle =
    variant === "danger"
      ? { background: "var(--color-error-bg, #ef444422)", color: "var(--color-error-text, #dc2626)" }
      : variant === "warning"
        ? { background: "#f59e0b22", color: "#d97706" }
        : { background: "var(--color-accent)", color: "white" };
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 bg-black/60 z-[100]" />
        <AlertDialog.Content
          className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[90%] max-w-[420px] z-[101]
            bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6 shadow-xl"
        >
          <AlertDialog.Title className="text-base font-semibold text-[var(--color-text)] m-0 mb-2">
            {title}
          </AlertDialog.Title>
          {description && (
            <AlertDialog.Description className="text-[var(--color-text-muted)] text-sm leading-relaxed mb-6 whitespace-pre-line">
              {description}
            </AlertDialog.Description>
          )}
          <div className="flex gap-3 justify-end">
            <AlertDialog.Cancel asChild>
              <button
                type="button"
                disabled={loading}
                className="px-4 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text)]
                  cursor-pointer hover:bg-[var(--color-surface-hover)] transition-colors disabled:opacity-50"
              >
                {cancelLabel}
              </button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <button
                type="button"
                onClick={onConfirm}
                disabled={loading}
                className="px-4 py-2 rounded-lg font-medium text-sm cursor-pointer hover:opacity-90 transition-opacity border-none disabled:opacity-50"
                style={confirmStyle}
              >
                {loading ? "处理中…" : confirmLabel}
              </button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
