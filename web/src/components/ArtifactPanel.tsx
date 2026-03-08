import { useState, useEffect } from "react";
import type { ArtifactMeta } from "../types";
import { getArtifacts, getArtifactUrl, getArtifactText } from "../api";
import MarkdownContent from "./MarkdownContent";

interface Props {
  conversationId: string;
  onClose: () => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIcon(mime: string): string {
  if (mime.startsWith("image/")) return "🖼";
  if (mime === "application/pdf") return "📄";
  if (mime.startsWith("text/markdown")) return "📝";
  if (mime.startsWith("text/") || mime === "application/json") return "📃";
  if (mime.startsWith("audio/")) return "🎵";
  if (mime.startsWith("video/")) return "🎬";
  return "📎";
}

function isPreviewable(mime: string): boolean {
  return (
    mime.startsWith("image/") ||
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/pdf"
  );
}

export default function ArtifactPanel({ conversationId, onClose }: Props) {
  const [artifacts, setArtifacts] = useState<ArtifactMeta[]>([]);
  const [selected, setSelected] = useState<ArtifactMeta | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getArtifacts(conversationId).then((list) => {
      if (!cancelled) setArtifacts(list);
    });
    return () => { cancelled = true; };
  }, [conversationId]);

  const refreshList = () => {
    getArtifacts(conversationId).then(setArtifacts);
  };

  useEffect(() => {
    if (!selected) { setTextContent(null); return; }
    const mime = selected.mimeType;
    if (mime.startsWith("text/") || mime === "application/json") {
      setLoading(true);
      getArtifactText(conversationId, selected.path)
        .then((t) => setTextContent(t))
        .catch(() => setTextContent("[Failed to load]"))
        .finally(() => setLoading(false));
    } else {
      setTextContent(null);
    }
  }, [selected, conversationId]);

  return (
    <div className="flex flex-col h-full border-l border-[var(--color-border)] bg-[var(--color-bg)]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-[var(--color-text)]">
            {selected ? selected.name : "产物文件"}
          </span>
          {selected && (
            <span className="text-xs text-[var(--color-text-muted)]">{formatSize(selected.size)}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {selected && (
            <button
              onClick={() => setSelected(null)}
              className="text-xs px-2 py-1 rounded bg-[var(--color-surface-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
            >
              ← 返回列表
            </button>
          )}
          <button
            onClick={refreshList}
            className="text-xs px-2 py-1 rounded bg-[var(--color-surface-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
            title="刷新"
          >
            ↻
          </button>
          <button
            onClick={onClose}
            className="text-xs px-2 py-1 rounded bg-[var(--color-surface-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          >
            ✕ 关闭
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto">
        {!selected ? (
          <FileList artifacts={artifacts} onSelect={setSelected} conversationId={conversationId} />
        ) : (
          <FilePreview artifact={selected} conversationId={conversationId} textContent={textContent} loading={loading} />
        )}
      </div>
    </div>
  );
}

function FileList({
  artifacts,
  onSelect,
  conversationId,
}: {
  artifacts: ArtifactMeta[];
  onSelect: (a: ArtifactMeta) => void;
  conversationId: string;
}) {
  if (artifacts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-[var(--color-text-muted)] text-sm gap-2 p-8">
        <span className="text-3xl">📂</span>
        <span>暂无产物文件</span>
        <span className="text-xs">Agent 执行 skill 后的输出文件会显示在这里</span>
      </div>
    );
  }

  return (
    <div className="p-2 space-y-0.5">
      {artifacts.map((a) => (
        <button
          key={a.path}
          onClick={() => isPreviewable(a.mimeType) ? onSelect(a) : window.open(getArtifactUrl(conversationId, a.path), "_blank")}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-[var(--color-surface-hover)] transition-colors text-left group"
        >
          <span className="text-lg shrink-0">{fileIcon(a.mimeType)}</span>
          <div className="flex-1 min-w-0">
            <div className="text-sm text-[var(--color-text)] truncate">{a.name}</div>
            <div className="text-xs text-[var(--color-text-muted)]">
              {formatSize(a.size)} · {new Date(a.modifiedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
            </div>
          </div>
          <span className="text-xs text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100 transition-opacity">
            {isPreviewable(a.mimeType) ? "预览" : "下载"}
          </span>
        </button>
      ))}
    </div>
  );
}

function FilePreview({
  artifact,
  conversationId,
  textContent,
  loading,
}: {
  artifact: ArtifactMeta;
  conversationId: string;
  textContent: string | null;
  loading: boolean;
}) {
  const url = getArtifactUrl(conversationId, artifact.path);
  const mime = artifact.mimeType;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--color-text-muted)]">
        加载中…
      </div>
    );
  }

  if (mime.startsWith("image/")) {
    return (
      <div className="flex items-center justify-center p-4 h-full">
        <img src={url} alt={artifact.name} className="max-w-full max-h-full object-contain rounded-lg" />
      </div>
    );
  }

  if (mime === "application/pdf") {
    return <iframe src={url} className="w-full h-full border-0" title={artifact.name} />;
  }

  if (mime === "text/markdown" && textContent !== null) {
    const artifactDir = artifact.path.includes("/")
      ? artifact.path.slice(0, artifact.path.lastIndexOf("/") + 1)
      : "";
    const transformImageUrl = (src: string) => {
      if (src.startsWith("http://") || src.startsWith("https://") || src.startsWith("data:")) return src;
      const cleaned = src.startsWith("./") ? src.slice(2) : src;
      return getArtifactUrl(conversationId, artifactDir + cleaned);
    };
    return (
      <div className="p-5 overflow-auto h-full">
        <MarkdownContent transformImageUrl={transformImageUrl}>{textContent}</MarkdownContent>
      </div>
    );
  }

  if (textContent !== null) {
    return (
      <pre className="p-4 text-sm font-mono text-[var(--color-text)] whitespace-pre-wrap break-words overflow-auto h-full">
        {textContent}
      </pre>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center h-full text-[var(--color-text-muted)] gap-2">
      <span>无法预览此文件类型</span>
      <a href={url} target="_blank" rel="noopener noreferrer" className="text-[var(--color-accent)] hover:underline text-sm">
        下载文件
      </a>
    </div>
  );
}
