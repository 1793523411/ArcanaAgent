import { useState, useEffect, useMemo } from "react";
import type { ArtifactMeta } from "../types";
import { getArtifacts, getArtifactUrl, getArtifactText } from "../api";
import { filterVisibleArtifacts } from "../artifactFilters";
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

function compactPath(path: string, max = 72): string {
  if (path.length <= max) return path;
  const keepHead = Math.max(16, Math.floor(max * 0.45));
  const keepTail = Math.max(20, max - keepHead - 1);
  return `${path.slice(0, keepHead)}…${path.slice(-keepTail)}`;
}

function baseName(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}

function languageFromPath(path: string): string {
  const name = baseName(path).toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  if (["sh", "bash", "zsh"].includes(ext)) return "bash";
  if (["js", "mjs", "cjs"].includes(ext)) return "javascript";
  if (["ts", "tsx"].includes(ext)) return "typescript";
  if (["jsx"].includes(ext)) return "jsx";
  if (["json"].includes(ext)) return "json";
  if (["py"].includes(ext)) return "python";
  if (["go"].includes(ext)) return "go";
  if (["java"].includes(ext)) return "java";
  if (["rb"].includes(ext)) return "ruby";
  if (["rs"].includes(ext)) return "rust";
  if (["yml", "yaml"].includes(ext)) return "yaml";
  if (["xml"].includes(ext)) return "xml";
  if (["html", "htm"].includes(ext)) return "html";
  if (["css"].includes(ext)) return "css";
  if (["sql"].includes(ext)) return "sql";
  if (["md", "markdown"].includes(ext)) return "markdown";
  if (["toml"].includes(ext)) return "toml";
  if (["ini", "conf"].includes(ext)) return "ini";
  return "";
}

function isCodeLikeText(mime: string, path: string): boolean {
  const lang = languageFromPath(path);
  if (lang && lang !== "markdown") return true;
  return mime === "application/json";
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

  const visibleArtifacts = useMemo(
    () => filterVisibleArtifacts(artifacts),
    [artifacts]
  );

  useEffect(() => {
    if (!selected) { setTextContent(null); return; }
    const mime = selected.mimeType;
    if (mime === "text/html") {
      setTextContent(null);
      setLoading(false);
      return;
    }
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
        <div className="flex items-center gap-2 min-w-0 flex-1 pr-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-[var(--color-text)] truncate" title={selected ? selected.path : "产物文件"}>
              {selected ? baseName(selected.path) : "产物文件"}
            </div>
            {selected && (
              <div className="text-xs text-[var(--color-text-muted)] truncate" title={selected.path}>
                {compactPath(selected.path)}
              </div>
            )}
          </div>
          {selected && (
            <span className="text-xs text-[var(--color-text-muted)]">{formatSize(selected.size)}</span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
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
          <FileList artifacts={visibleArtifacts} onSelect={setSelected} conversationId={conversationId} />
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
  // 生成唯一的 storage key，基于 conversationId 和文件夹路径
  const storageKey = `artifact_tree_expanded:${conversationId}:${node.path}`;
  
  // 从 localStorage 读取初始状态，默认收起
  const [expanded, setExpanded] = useState(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      return stored !== null ? stored === "true" : false;
    } catch {
      return false;
    }
  });

  // 当展开状态变化时，保存到 localStorage
  const handleToggleExpand = () => {
    const newState = !expanded;
    setExpanded(newState);
    try {
      localStorage.setItem(storageKey, String(newState));
    } catch {
      // 忽略 storage 错误
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

  // 文件夹
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
  const codeLanguage = languageFromPath(artifact.path) || (mime === "application/json" ? "json" : "");

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

  if (mime === "text/html") {
    return <iframe src={url} className="w-full h-full border-0 rounded-b-lg" title={artifact.name} sandbox="allow-scripts allow-same-origin" />;
  }

  if (mime.startsWith("text/markdown") && textContent !== null) {
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
