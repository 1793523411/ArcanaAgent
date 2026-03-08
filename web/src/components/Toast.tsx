import { createContext, useContext, useState, useCallback, useRef } from "react";

interface ToastItem {
  id: number;
  message: string;
  type: "success" | "error" | "info";
}

interface ToastContextValue {
  toast: (message: string, type?: ToastItem["type"]) => void;
}

const ToastContext = createContext<ToastContextValue>({ toast: () => {} });

export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const toast = useCallback((message: string, type: ToastItem["type"] = "info") => {
    const id = ++idRef.current;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {toasts.length > 0 && (
        <div className="fixed bottom-5 right-5 flex flex-col gap-2 z-[9999] pointer-events-none">
          {toasts.map((t) => (
            <div
              key={t.id}
              role="alert"
              className={`pointer-events-auto px-4 py-3 rounded-xl shadow-lg text-sm font-medium animate-toast-in ${
                t.type === "error"
                  ? "bg-red-500/90 text-white"
                  : t.type === "success"
                  ? "bg-emerald-500/90 text-white"
                  : "bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)]"
              }`}
            >
              {t.message}
            </div>
          ))}
        </div>
      )}
    </ToastContext.Provider>
  );
}
