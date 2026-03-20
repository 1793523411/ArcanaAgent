import { useState, useEffect, useMemo } from "react";
import type { ArtifactMeta } from "../types";
import { getArtifacts, getArtifactUrl, getArtifactText } from "../api";
import { filterVisibleArtifacts } from "../artifactFilters";
import MarkdownContent from "./MarkdownContent";
import CodeBrowserPanel from "./CodeBrowserPanel";
import {
  baseName,
  formatSize,
  fileIcon,
  isPreviewable,
  languageFromPath,
  isCodeLikeText,
  buildFileTree,
} from "../utils/fileTree";
import type { TreeNode } from "../utils/fileTree";

interface Props {
  conversationId: string;
  onClose: () => void;
  theme: "light" | "dark";
}

function compactPath(path: string, max = 72): string {
  if (path.length <= max) return path;
  const keepHead = Math.max(16, Math.floor(max * 0.45));
  const keepTail = Math.max(20, max - keepHead - 1);
  return `${path.slice(0, keepHead)}…${path.slice(-keepTail)}`;
}

export default function ArtifactPanel({ conversationId, onClose, theme }: Props) {
  const [tab, setTab] = useState<"files" | "code">("files");
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

  const visibleArtifacts = useMemo(
    () => filterVisibleArtifacts(artifacts),
    [artifacts]
  );

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
      {/* Header with tabs */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] shrink-0">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setTab("files")}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              tab === "files"
                ? "bg-[var(--color-accent)] text-white"
                : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)]"
            }`}
          >
            文件
          </button>
          <button
            onClick={() => setTab("code")}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              tab === "code"
                ? "bg-[var(--color-accent)] text-white"
                : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)]"
            }`}
          >
            代码
          </button>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {tab === "files" && selected && (
            <button
              onClick={() => setSelected(null)}
              className="text-xs px-2 py-1 rounded bg-[var(--color-surface-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
            >
              ← 返回列表
            </button>
          )}
          {tab === "files" && (
            <button
              onClick={refreshList}
              className="text-xs px-2 py-1 rounded bg-[var(--color-surface-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
              title="刷新"
            >
              ↻
            </button>
          )}
          <button
            onClick={onClose}
            className="text-xs px-2 py-1 rounded bg-[var(--color-surface-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          >
            ✕
          </button>
        </div>
      </div>

      {/* File info sub-header (files tab only) */}
      {tab === "files" && selected && (
        <div className="flex items-center gap-2 px-4 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
          <div className="text-sm font-medium text-[var(--color-text)] truncate" title={selected.path}>
            {baseName(selected.path)}
          </div>
          <div className="text-xs text-[var(--color-text-muted)] truncate" title={selected.path}>
            {compactPath(selected.path)}
          </div>
          <span className="text-xs text-[var(--color-text-muted)] ml-auto shrink-0">{formatSize(selected.size)}</span>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-hidden">
        {tab === "files" ? (
          <div className="h-full overflow-auto">
            {!selected ? (
              <FileList artifacts={visibleArtifacts} onSelect={setSelected} conversationId={conversationId} />
            ) : (
              <FilePreview artifact={selected} conversationId={conversationId} textContent={textContent} loading={loading} />
            )}
          </div>
        ) : (
          <CodeBrowserPanel conversationId={conversationId} theme={theme} />
        )}
      </div>
    </div>
  );
}

// ─── 树节点组件 ────────────────────────────────────────

function TreeNodeItem({
  node,
  onSelect,
  conversationId,
  depth = 0,
}: {
  node: TreeNode;
  onSelect: (a: ArtifactMeta) => void;
  conversationId: string;
  depth?: number;
}) {
  const storageKey = `artifact_tree_expanded:${conversationId}:${node.path}`;

  const [expanded, setExpanded] = useState(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      return stored !== null ? stored === "true" : false;
    } catch {
      return false;
    }
  });

  const handleToggleExpand = () => {
    const newState = !expanded;
    setExpanded(newState);
    try {
      localStorage.setItem(storageKey, String(newState));
    } catch {
      // ignore
    }
  };

  if (node.type === "file" && node.artifact) {
    const artifact = node.artifact;
    return (
      <button
        onClick={() =>
          isPreviewable(artifact.mimeType)
            ? onSelect(artifact)
            : window.open(getArtifactUrl(conversationId, artifact.path), "_blank")
        }
        className="w-full flex items-center gap-2 px-3 py-1.5 rounded hover:bg-[var(--color-surface-hover)] transition-colors text-left group"
        style={{ paddingLeft: `${depth * 20 + 12}px` }}
      >
        <span className="text-base shrink-0">{fileIcon(artifact.mimeType)}</span>
        <div className="flex-1 min-w-0">
          <div className="text-sm text-[var(--color-text)] truncate">{node.name}</div>
        </div>
        <span className="text-xs text-[var(--color-text-muted)]">{formatSize(artifact.size)}</span>
        <span className="text-xs text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100 transition-opacity">
          {isPreviewable(artifact.mimeType) ? "预览" : "下载"}
        </span>
      </button>
    );
  }

  const hasChildren = node.children && node.children.length > 0;
  const childrenCount = node.children?.length || 0;

  return (
    <div>
      <button
        onClick={handleToggleExpand}
        className="w-full flex items-center gap-2 px-3 py-1.5 rounded hover:bg-[var(--color-surface-hover)] transition-colors text-left"
        style={{ paddingLeft: `${depth * 20 + 12}px` }}
      >
        <span className="text-xs text-[var(--color-text-muted)] shrink-0">
          {expanded ? "▼" : "▶"}
        </span>
        <span className="text-base shrink-0">📁</span>
        <div className="flex-1 min-w-0">
          <span className="text-sm text-[var(--color-text)] font-medium">{node.name}</span>
          <span className="text-xs text-[var(--color-text-muted)] ml-2">({childrenCount})</span>
        </div>
      </button>
      {expanded && hasChildren && (
        <div>
          {node.children!.map((child) => (
            <TreeNodeItem
              key={child.path}
              node={child}
              onSelect={onSelect}
              conversationId={conversationId}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── 文件列表组件（树状结构）────────────────────────────────

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

  const tree = buildFileTree(artifacts);

  return (
    <div className="p-2 space-y-0.5">
      {tree.children?.map((node) => (
        <TreeNodeItem
          key={node.path}
          node={node}
          onSelect={onSelect}
          conversationId={conversationId}
          depth={0}
        />
      ))}
    </div>
  );
}

// ─── 文件预览组件 ────────────────────────────────

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
  const [viewMode, setViewMode] = useState<"preview" | "code">("preview");
  const url = getArtifactUrl(conversationId, artifact.path);
  const mime = artifact.mimeType;
  const codeLanguage = languageFromPath(artifact.path) || (mime === "application/json" ? "json" : "");

  const hasDualMode = mime === "text/html" || mime.startsWith("text/markdown");

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

  if (hasDualMode) {
    const codeView = textContent !== null ? (
      <div className="p-5 overflow-auto h-full">
        <MarkdownContent>{`\`\`\`${mime === "text/html" ? "html" : "markdown"}\n${textContent}\n\`\`\``}</MarkdownContent>
      </div>
    ) : (
      <div className="flex items-center justify-center h-full text-[var(--color-text-muted)]">源码加载中…</div>
    );

    let previewView: React.ReactNode;
    if (mime === "text/html") {
      previewView = <iframe src={url} className="w-full h-full border-0" title={artifact.name} sandbox="allow-scripts allow-same-origin" />;
    } else {
      const artifactDir = artifact.path.includes("/")
        ? artifact.path.slice(0, artifact.path.lastIndexOf("/") + 1)
        : "";
      const transformImageUrl = (src: string) => {
        if (src.startsWith("http://") || src.startsWith("https://") || src.startsWith("data:")) return src;
        const cleaned = src.startsWith("./") ? src.slice(2) : src;
        return getArtifactUrl(conversationId, artifactDir + cleaned);
      };
      previewView = textContent !== null ? (
        <div className="p-5 overflow-auto h-full">
          <MarkdownContent transformImageUrl={transformImageUrl}>{textContent}</MarkdownContent>
        </div>
      ) : (
        <div className="flex items-center justify-center h-full text-[var(--color-text-muted)]">加载中…</div>
      );
    }

    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-1 px-3 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-surface)] shrink-0">
          <button
            onClick={() => setViewMode("preview")}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              viewMode === "preview"
                ? "bg-[var(--color-accent)] text-white"
                : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)]"
            }`}
          >
            预览
          </button>
          <button
            onClick={() => setViewMode("code")}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              viewMode === "code"
                ? "bg-[var(--color-accent)] text-white"
                : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)]"
            }`}
          >
            源码
          </button>
        </div>
        <div className="flex-1 overflow-hidden">
          {viewMode === "preview" ? previewView : codeView}
        </div>
      </div>
    );
  }

  if (textContent !== null) {
    if (isCodeLikeText(mime, artifact.path)) {
      const fenced = `\`\`\`${codeLanguage}\n${textContent}\n\`\`\``;
      return (
        <div className="p-5 overflow-auto h-full">
          <MarkdownContent>{fenced}</MarkdownContent>
        </div>
      );
    }
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
