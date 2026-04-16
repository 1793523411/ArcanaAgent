import { useState, useEffect, useCallback } from "react";
import type { FileTreeNode, FileReadResult } from "../../api/guild";
import MarkdownContent from "../MarkdownContent";

type HtmlViewMode = "preview" | "source";
const isHtmlExt = (ext: string) => ext === ".html" || ext === ".htm";

interface Props {
  /** Fetch the directory tree */
  fetchTree: () => Promise<FileTreeNode[]>;
  /** Fetch a file's content by relative path */
  fetchFile: (path: string) => Promise<FileReadResult>;
  /** Refresh key — change to trigger re-fetch */
  refreshKey?: string;
  /** Empty state message */
  emptyIcon?: string;
  emptyTitle?: string;
  emptyDesc?: string;
}

const CODE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".json", ".py", ".go", ".rs", ".java",
  ".kt", ".rb", ".php", ".c", ".cpp", ".h", ".cs", ".swift", ".vue",
  ".svelte", ".sql", ".graphql", ".sh", ".yaml", ".yml", ".toml",
  ".css", ".scss", ".html", ".htm", ".xml",
]);

const LANG_MAP: Record<string, string> = {
  ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx",
  ".json": "json", ".py": "python", ".go": "go", ".rs": "rust",
  ".java": "java", ".rb": "ruby", ".php": "php", ".c": "c", ".cpp": "cpp",
  ".cs": "csharp", ".swift": "swift", ".sql": "sql", ".sh": "bash",
  ".yaml": "yaml", ".yml": "yaml", ".toml": "toml", ".css": "css",
  ".scss": "scss", ".html": "html", ".htm": "html", ".xml": "xml", ".vue": "vue",
  ".svelte": "svelte", ".graphql": "graphql",
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function countFiles(nodes: FileTreeNode[]): number {
  let count = 0;
  for (const n of nodes) {
    if (n.isDir && n.children) count += countFiles(n.children);
    else count++;
  }
  return count;
}

export default function FileTreeBrowser({ fetchTree, fetchFile, refreshKey, emptyIcon, emptyTitle, emptyDesc }: Props) {
  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<FileReadResult | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [htmlViewMode, setHtmlViewMode] = useState<HtmlViewMode>("preview");

  const loadTree = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchTree();
      setTree(data);
      // Auto-expand top-level dirs
      const topDirs = data.filter(n => n.isDir).map(n => n.path);
      setExpanded(new Set(topDirs));
    } catch {
      setTree([]);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const handleManualRefresh = async () => {
    if (refreshing || loading) return;
    setRefreshing(true);
    try {
      const data = await fetchTree();
      setTree(data);
    } catch {
      // keep existing tree on error
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => { loadTree(); }, [loadTree]);

  const toggleDir = (path: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const selectFile = async (path: string) => {
    setSelectedFile(path);
    setFileLoading(true);
    setFileContent(null);
    setHtmlViewMode("preview");
    try {
      const result = await fetchFile(path);
      setFileContent(result);
    } catch {
      setFileContent(null);
    } finally {
      setFileLoading(false);
    }
  };

  const renderNode = (node: FileTreeNode, depth: number) => {
    if (node.isDir) {
      const isOpen = expanded.has(node.path);
      return (
        <div key={node.path}>
          <button
            onClick={() => toggleDir(node.path)}
            className="w-full flex items-center gap-1.5 py-1 px-2 rounded text-xs hover:bg-[var(--color-surface-hover)] transition-colors"
            style={{ paddingLeft: depth * 16 + 8, color: "var(--color-text)" }}
          >
            <span className="text-[10px] w-3 text-center shrink-0" style={{ color: "var(--color-text-muted)" }}>
              {isOpen ? "\u25BC" : "\u25B6"}
            </span>
            <span className="shrink-0">{"\uD83D\uDCC1"}</span>
            <span className="truncate font-medium">{node.name}</span>
            {node.children && (
              <span className="text-[10px] ml-auto shrink-0" style={{ color: "var(--color-text-muted)" }}>
                {node.children.length}
              </span>
            )}
          </button>
          {isOpen && node.children?.map(c => renderNode(c, depth + 1))}
        </div>
      );
    }

    const isSelected = selectedFile === node.path;
    return (
      <button
        key={node.path}
        onClick={() => selectFile(node.path)}
        className="w-full flex items-center gap-1.5 py-1 px-2 rounded text-xs hover:bg-[var(--color-surface-hover)] transition-colors"
        style={{
          paddingLeft: depth * 16 + 8,
          color: "var(--color-text)",
          background: isSelected ? "var(--color-accent-alpha)" : undefined,
        }}
      >
        <span className="w-3 shrink-0" />
        <span className="shrink-0">{"\uD83D\uDCC4"}</span>
        <span className="truncate">{node.name}</span>
        {node.size != null && (
          <span className="text-[10px] ml-auto shrink-0" style={{ color: "var(--color-text-muted)" }}>
            {formatSize(node.size)}
          </span>
        )}
      </button>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full" style={{ color: "var(--color-text-muted)" }}>
        加载中...
      </div>
    );
  }

  if (tree.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2" style={{ color: "var(--color-text-muted)" }}>
        <span className="text-3xl">{emptyIcon ?? "\uD83D\uDCC2"}</span>
        <span className="text-sm">{emptyTitle ?? "目录为空"}</span>
        {emptyDesc && <span className="text-xs text-center px-4">{emptyDesc}</span>}
      </div>
    );
  }

  // If a file is selected, show split: tree left, preview right
  if (selectedFile && fileContent !== null) {
    const ext = selectedFile.includes(".") ? "." + selectedFile.split(".").pop()!.toLowerCase() : "";
    return (
      <div className="flex flex-col h-full">
        {/* File header */}
        <div className="flex items-center justify-between px-3 py-2 border-b shrink-0" style={{ borderColor: "var(--color-border)" }}>
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs font-mono truncate" style={{ color: "var(--color-text)" }} title={selectedFile}>
              {selectedFile}
            </span>
            {fileContent.size != null && (
              <span className="text-[10px] shrink-0" style={{ color: "var(--color-text-muted)" }}>
                {formatSize(fileContent.size)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {isHtmlExt(ext) && fileContent.content !== null && (
              <div
                className="flex items-center rounded overflow-hidden"
                style={{ border: "1px solid var(--color-border)" }}
              >
                <button
                  onClick={() => setHtmlViewMode("preview")}
                  className="px-2 py-0.5 text-[11px] transition-colors"
                  style={{
                    background: htmlViewMode === "preview" ? "var(--color-accent)" : "transparent",
                    color: htmlViewMode === "preview" ? "white" : "var(--color-text-muted)",
                  }}
                >
                  预览
                </button>
                <button
                  onClick={() => setHtmlViewMode("source")}
                  className="px-2 py-0.5 text-[11px] transition-colors"
                  style={{
                    background: htmlViewMode === "source" ? "var(--color-accent)" : "transparent",
                    color: htmlViewMode === "source" ? "white" : "var(--color-text-muted)",
                  }}
                >
                  源码
                </button>
              </div>
            )}
            <button
              onClick={() => { setSelectedFile(null); setFileContent(null); }}
              className="text-xs px-2 py-0.5 rounded"
              style={{ background: "var(--color-surface-hover)", color: "var(--color-text-muted)" }}
            >
              {"\u2190"} 返回
            </button>
          </div>
        </div>
        {/* File content */}
        <div className="flex-1 overflow-auto">
          {fileContent.dataUrl && ext === ".pdf" ? (
            <iframe
              src={fileContent.dataUrl}
              className="w-full h-full border-0"
              title={selectedFile}
              sandbox="allow-scripts"
            />
          ) : fileContent.dataUrl ? (
            <div className="flex items-center justify-center p-4 h-full">
              <img
                src={fileContent.dataUrl}
                alt={selectedFile}
                className="max-w-full max-h-full object-contain rounded-lg"
                style={{ background: "var(--color-surface)" }}
              />
            </div>
          ) : fileContent.binary ? (
            <div className="flex flex-col items-center justify-center h-full gap-2" style={{ color: "var(--color-text-muted)" }}>
              <span className="text-3xl">{"\uD83D\uDCE6"}</span>
              <span className="text-sm">二进制文件 ({ext})</span>
              <span className="text-xs">{formatSize(fileContent.size)}</span>
            </div>
          ) : fileContent.content !== null ? (
            isHtmlExt(ext) && htmlViewMode === "preview" ? (
              <iframe
                srcDoc={fileContent.content}
                className="w-full h-full border-0"
                title={selectedFile}
                sandbox="allow-scripts"
              />
            ) : ext === ".md" ? (
              <div className="p-4"><MarkdownContent>{fileContent.content}</MarkdownContent></div>
            ) : CODE_EXTS.has(ext) ? (
              <div className="p-4"><MarkdownContent>{`\`\`\`${LANG_MAP[ext] ?? ""}\n${fileContent.content}\n\`\`\``}</MarkdownContent></div>
            ) : (
              <pre className="p-4 text-xs font-mono whitespace-pre-wrap break-words" style={{ color: "var(--color-text)" }}>
                {fileContent.content}
              </pre>
            )
          ) : (
            <div className="flex items-center justify-center h-full" style={{ color: "var(--color-text-muted)" }}>
              无法读取文件
            </div>
          )}
        </div>
      </div>
    );
  }

  // Tree view
  return (
    <div className="flex flex-col h-full">
      {fileLoading && (
        <div className="px-3 py-1.5 text-xs border-b" style={{ borderColor: "var(--color-border)", color: "var(--color-text-muted)" }}>
          加载中...
        </div>
      )}
      <div className="flex-1 overflow-auto p-2">
        <div className="flex items-center justify-between px-2 py-1 mb-1">
          <span className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>
            {countFiles(tree)} 个文件
          </span>
          <button
            onClick={handleManualRefresh}
            disabled={refreshing || loading}
            className="flex items-center justify-center w-5 h-5 rounded hover:bg-[var(--color-surface-hover)] transition-colors disabled:opacity-40"
            style={{ color: "var(--color-text-muted)" }}
            title="刷新文件树"
          >
            <svg
              width="12" height="12" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className={refreshing ? "animate-spin" : ""}
            >
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </button>
        </div>
        {tree.map(node => renderNode(node, 0))}
      </div>
    </div>
  );
}
