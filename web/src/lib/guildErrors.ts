import type React from "react";

/**
 * Trap Tab navigation inside a dialog container — prevents focus from
 * escaping the modal into the backdrop page content (WCAG 2.4.3). Attach
 * via `onKeyDown` on the dialog's outermost div. Not a full focus manager
 * (doesn't restore focus on close, doesn't auto-focus on open); it's the
 * minimum needed to keep the focus ring contained.
 */
export function trapTabInDialog(e: React.KeyboardEvent<HTMLElement>): void {
  if (e.key !== "Tab") return;
  const root = e.currentTarget;
  const focusables = root.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement as HTMLElement | null;
  if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * Map raw fetch/LLM exceptions to user-actionable Chinese messages.
 *
 * Error surfaces we cover:
 *   - AbortError            — user cancelled
 *   - Failed to fetch       — network down / server offline
 *   - SyntaxError / JSON    — server returned non-JSON (often a proxy error page)
 *   - 499 / timeout         — request exceeded the server's hard timeout
 *   - 500                   — generic server error (real cause is in server log)
 *
 * Consumers should NEVER display `String(e)` directly in user-facing UI —
 * the raw messages leak stack traces and SDK internals that the user can't act on.
 */
export function friendlyError(e: unknown): string {
  const msg = String(e);
  if (msg.includes("AbortError") || msg.includes("aborted")) return "已取消";
  if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) return "网络连接失败，请检查后重试";
  if (msg.includes("SyntaxError") || msg.includes("JSON")) return "服务器返回无效响应，请重试";
  if (msg.includes("499") || msg.includes("已取消") || msg.includes("timeout")) return "请求超时，请稍后重试";
  if (msg.includes("500")) return "服务端错误，请稍后重试";
  // Preserve server-thrown validation messages (short, no stack marker), but
  // fall back to a generic message for anything that smells like raw SDK /
  // fetch internals. The prior behaviour leaked `String(e)` including stack
  // traces and module paths — the module comment says NEVER do that.
  if (msg.startsWith("Error: ") && msg.length < 200 && !msg.includes("\n") && !/\bat\s+/.test(msg)) {
    return msg.slice("Error: ".length);
  }
  // Stash the raw error for developer debugging but keep the UI clean.
  if (typeof console !== "undefined") console.warn("[guildErrors] unclassified error:", e);
  return "操作失败，请重试";
}
