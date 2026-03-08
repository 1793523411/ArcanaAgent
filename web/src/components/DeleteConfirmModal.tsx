import * as AlertDialog from "@radix-ui/react-alert-dialog";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  title?: string;
  description?: string;
  loading?: boolean;
}

export default function DeleteConfirmModal({
  open,
  onOpenChange,
  onConfirm,
  title = "删除会话",
  description = "确定要删除此会话吗？删除后无法恢复。",
  loading = false,
}: Props) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 bg-black/60 z-[100]" />
        <AlertDialog.Content
          className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[90%] max-w-[400px] z-[101]
            bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6 shadow-xl"
        >
          <AlertDialog.Title className="text-lg font-semibold text-[var(--color-text)] m-0 mb-2">
            {title}
          </AlertDialog.Title>
          <AlertDialog.Description className="text-[var(--color-text-muted)] text-[15px] leading-relaxed mb-6">
            {description}
          </AlertDialog.Description>
          <div className="flex gap-3 justify-end">
            <AlertDialog.Cancel asChild>
              <button
                type="button"
                disabled={loading}
                className="px-4 py-2.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text)]
                  cursor-pointer hover:bg-[var(--color-surface-hover)] transition-colors disabled:opacity-50"
              >
                取消
              </button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <button
                type="button"
                onClick={onConfirm}
                disabled={loading}
                className="px-4 py-2.5 rounded-lg bg-[var(--color-error-bg)] text-[var(--color-error-text)]
                  font-medium cursor-pointer hover:opacity-90 transition-opacity border-none disabled:opacity-50"
              >
                {loading ? "删除中…" : "删除"}
              </button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
