import { useEffect, useState } from "react";
import type { FileReadResult } from "../../api/guild";
import { getGroupSharedFile, getGroupSharedRawUrl } from "../../api/guild";
import MarkdownContent from "../MarkdownContent";

interface Props {
  groupId: string;
  /** Relative path under the group's shared dir (collaborative mode) or
   *  per-task subdir (isolated). The caller pre-resolves which one. */
  path: string;
  /** Display name shown in the header — usually the bare ref. */
  title?: string;
  onClose: () => void;
}

const MD_EXT = new Set([".md", ".markdown"]);
const HTML_EXT = new Set([".html", ".htm"]);
const CODE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".json", ".py", ".go", ".rs", ".java",
  ".sql", ".sh", ".yaml", ".yml", ".toml", ".css", ".scss", ".xml",
]);
const LANG_MAP: Record<string, string> = {
  ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx",
  ".json": "json", ".py": "python", ".go": "go", ".rs": "rust",
  ".java": "java", ".sql": "sql", ".sh": "bash",
  ".yaml": "yaml", ".yml": "yaml", ".toml": "toml", ".css": "css",
  ".scss": "scss", ".xml": "xml",
};

function extOf(p: string): string {
  const dot = p.lastIndexOf(".");
  return dot >= 0 ? p.slice(dot).toLowerCase() : "";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function FilePreviewModal({ groupId, path, title, onClose }: Props) {
  const [data, setData] = useState<FileReadResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setData(null);
    getGroupSharedFile(groupId, path)
      .then((r) => { if (!cancelled) setData(r); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [groupId, path]);

  // ESC closes the modal — without this the only exit is the ✕ button which
  // can be hard to target on small screens / keyboard-only flows.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const ext = extOf(path);
  const rawUrl = getGroupSharedRawUrl(groupId, path);

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div
        className="relative w-full max-w-4xl rounded-xl shadow-2xl flex flex-col overflow-hidden"
        style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", maxHeight: "85vh" }}
      >
        <div
          className="flex items-center justify-between px-5 py-3 border-b shrink-0"
          style={{ borderColor: "var(--color-border)" }}
        >
          <div className="min-w-0">
            <h3 className="text-sm font-semibold truncate" style={{ color: "var(--color-text)" }}>
              📄 {title ?? path}
            </h3>
            {data && !error && (
              <div className="text-[10px] mt-0.5" style={{ color: "var(--color-text-muted)" }}>
                {data.size != null ? formatSize(data.size) : ""}
                {ext ? ` · ${ext}` : ""}
                {" · "}
                <a
                  href={rawUrl}
                  download
                  className="underline"
                  style={{ color: "var(--color-text-muted)" }}
                  onClick={(e) => e.stopPropagation()}
                >下载原文件</a>
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-[var(--color-surface-hover)]"
            style={{ color: "var(--color-text-muted)" }}
            aria-label="关闭预览"
          >✕</button>
        </div>
        <div className="flex-1 overflow-auto">
          {error && (
            <div className="m-4 px-3 py-2 rounded text-xs" style={{ background: "#fee2e2", color: "#991b1b" }}>
              加载失败：{error}
            </div>
          )}
          {!error && !data && (
            <div className="flex items-center justify-center py-16" style={{ color: "var(--color-text-muted)" }}>
              加载中…
            </div>
          )}
          {data && data.dataUrl && ext === ".pdf" && (
            <iframe src={data.dataUrl} className="w-full h-[70vh] border-0" title={title ?? path} sandbox="allow-scripts" />
          )}
          {data && data.dataUrl && ext !== ".pdf" && (
            <div className="flex items-center justify-center p-4">
              <img
                src={data.dataUrl}
                alt={title ?? path}
                className="max-w-full max-h-[70vh] object-contain rounded-lg"
                style={{ background: "var(--color-bg)" }}
              />
            </div>
          )}
          {data && !data.dataUrl && data.binary && (
            <div className="flex flex-col items-center justify-center py-16 gap-2" style={{ color: "var(--color-text-muted)" }}>
              <span className="text-3xl">📦</span>
              <span className="text-sm">二进制文件 ({ext || "no ext"})</span>
              {data.size != null && <span className="text-xs">{formatSize(data.size)}</span>}
              <a href={rawUrl} download className="text-xs underline mt-2" style={{ color: "var(--color-accent)" }}>下载查看</a>
            </div>
          )}
          {data && !data.binary && data.content !== null && (
            HTML_EXT.has(ext) ? (
              // Sandbox prevents script-driven escape from this preview pane;
              // shared dir contents come from agent-authored output and must
              // be treated as untrusted.
              <iframe
                srcDoc={data.content}
                className="w-full h-[70vh] border-0"
                title={title ?? path}
                sandbox="allow-scripts"
              />
            ) : MD_EXT.has(ext) ? (
              <div className="p-5">
                <MarkdownContent
                  transformImageUrl={(src) => {
                    if (/^(?:[a-z]+:|\/\/|data:|\/)/i.test(src)) return src;
                    // mdast→hast pre-encodes the URL. Decode once so we
                    // don't double-encode through getGroupSharedRawUrl.
                    let decoded = src;
                    try { decoded = decodeURIComponent(src); } catch { /* keep raw */ }
                    // Resolve relative ref against the file's directory.
                    const slash = path.lastIndexOf("/");
                    const baseDir = slash >= 0 ? path.slice(0, slash) : "";
                    const segs = (baseDir ? baseDir.split("/") : []).concat(decoded.split("/"));
                    const out: string[] = [];
                    for (const s of segs) {
                      if (!s || s === ".") continue;
                      if (s === "..") { out.pop(); continue; }
                      out.push(s);
                    }
                    return getGroupSharedRawUrl(groupId, out.join("/"));
                  }}
                >
                  {data.content}
                </MarkdownContent>
              </div>
            ) : CODE_EXT.has(ext) ? (
              <div className="p-5">
                <MarkdownContent>{`\`\`\`${LANG_MAP[ext] ?? ""}\n${data.content}\n\`\`\``}</MarkdownContent>
              </div>
            ) : (
              <pre className="p-5 text-xs font-mono whitespace-pre-wrap break-words" style={{ color: "var(--color-text)" }}>
                {data.content}
              </pre>
            )
          )}
        </div>
      </div>
    </div>
  );
}
