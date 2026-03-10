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

// ─── 树状结构数据类型 ────────────────────────────────────────

interface TreeNode {
  name: string;
  path: string;
  type: "file" | "folder";
  children?: TreeNode[];
  artifact?: ArtifactMeta;
}

// ─── 构建树状结构 ────────────────────────────────────────

function buildFileTree(artifacts: ArtifactMeta[]): TreeNode {
  const root: TreeNode = {
    name: "root",
    path: "",
    type: "folder",
    children: [],
  };

  for (const artifact of artifacts) {
    const parts = artifact.path.split("/");
    let current = root;

    // 遍历路径的每一部分
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isFile = i === parts.length - 1;
      const currentPath = parts.slice(0, i + 1).join("/");

      if (!current.children) current.children = [];

      // 查找已存在的节点
      let node = current.children.find((n) => n.name === part);

      if (!node) {
        // 创建新节点
        node = {
          name: part,
          path: currentPath,
          type: isFile ? "file" : "folder",
          ...(isFile ? { artifact } : { children: [] }),
        };
        current.children.push(node);
      }

      current = node;
    }
  }

  // 对每个文件夹的子节点排序：文件夹在前，文件在后，同类按名称排序
  const sortChildren = (node: TreeNode) => {
    if (node.children) {
      node.children.sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === "folder" ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });
      node.children.forEach(sortChildren);
    }
  };
  sortChildren(root);

  return root;
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
  const [expanded, setExpanded] = useState(depth === 0 || depth === 1); // 默认展开根目录和第一层

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

  // 文件夹
  const hasChildren = node.children && node.children.length > 0;
  const childrenCount = node.children?.length || 0;

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
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

// ─── 文件预览组件（保持不变）────────────────────────────────

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
