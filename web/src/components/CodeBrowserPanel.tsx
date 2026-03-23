import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import Editor from "@monaco-editor/react";
import type { ArtifactMeta } from "../types";
import { getArtifacts, getArtifactText, getArtifactUrl } from "../api";
import { filterVisibleArtifacts } from "../artifactFilters";
import { buildFileTree, monacoLanguageFromPath, fileIcon, formatSize } from "../utils/fileTree";
import type { TreeNode } from "../utils/fileTree";

interface Props {
  conversationId: string;
  theme: "light" | "dark";
}

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

/** MIME types that can be rendered as text in the editor */
function isTextMime(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/javascript" ||
    mime === "application/typescript"
  );
}

/** MIME types that can be previewed inline (not as text) */
function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

function isPdfMime(mime: string): boolean {
  return mime === "application/pdf";
}

function isAudioMime(mime: string): boolean {
  return mime.startsWith("audio/");
}

function isVideoMime(mime: string): boolean {
  return mime.startsWith("video/");
}

export default function CodeBrowserPanel({ conversationId, theme }: Props) {
  const [artifacts, setArtifacts] = useState<ArtifactMeta[]>([]);
  const [selected, setSelected] = useState<ArtifactMeta | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [treeWidth, setTreeWidth] = useState(() => {
    try { return Number(localStorage.getItem("code_tree_width")) || 260; } catch { return 260; }
  });
  const resizing = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!resizing.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const newWidth = Math.min(Math.max(e.clientX - rect.left, 140), 500);
      setTreeWidth(newWidth);
    };
    const onMouseUp = () => {
      if (resizing.current) {
        resizing.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        try { localStorage.setItem("code_tree_width", String(treeWidth)); } catch { /* */ }
      }
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => { window.removeEventListener("mousemove", onMouseMove); window.removeEventListener("mouseup", onMouseUp); };
  }, [treeWidth]);

  useEffect(() => {
    let cancelled = false;
    getArtifacts(conversationId).then((list) => {
      if (!cancelled) setArtifacts(list);
    });
    return () => { cancelled = true; };
  }, [conversationId]);

  const visibleArtifacts = useMemo(
    () => filterVisibleArtifacts(artifacts),
    [artifacts]
  );

  const tree = useMemo(() => buildFileTree(visibleArtifacts), [visibleArtifacts]);

  const handleSelectFile = useCallback((artifact: ArtifactMeta) => {
    setSelected(artifact);
    setContent(null);

    // Only load text content for text-based files
    if (!isTextMime(artifact.mimeType)) return;
    if (artifact.size > MAX_FILE_SIZE) return;

    setLoading(true);
    getArtifactText(conversationId, artifact.path)
      .then((t) => setContent(t))
      .catch(() => setContent("[Failed to load]"))
      .finally(() => setLoading(false));
  }, [conversationId]);

  const language = selected ? monacoLanguageFromPath(selected.path) : "plaintext";
  const monacoTheme = theme === "dark" ? "vs-dark" : "vs";

  return (
    <div className="flex h-full" ref={containerRef}>
      {/* File tree */}
      <div className="shrink-0 border-r border-[var(--color-border)] overflow-auto bg-[var(--color-surface)]" style={{ width: treeWidth }}>
        <div className="px-3 py-2 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide border-b border-[var(--color-border)]">
          Explorer
        </div>
        <div className="py-1">
          {visibleArtifacts.length === 0 ? (
            <div className="px-3 py-4 text-xs text-[var(--color-text-muted)] text-center">
              暂无文件
            </div>
          ) : (
            tree.children?.map((node) => (
              <CodeTreeItem
                key={node.path}
                node={node}
                selected={selected}
                onSelect={handleSelectFile}
                conversationId={conversationId}
                depth={0}
              />
            ))
          )}
        </div>
      </div>

      {/* Resize handle */}
      <div
        className="shrink-0 w-[3px] cursor-col-resize hover:bg-[var(--color-accent)] active:bg-[var(--color-accent)] transition-colors"
        onMouseDown={() => {
          resizing.current = true;
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
        }}
      />

      {/* Editor area */}
      <div className="flex-1 min-w-0 flex flex-col">
        {selected ? (
          <>
            {/* Tab bar */}
            <div className="flex items-center gap-1 px-3 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-surface)] text-xs">
              <span>{fileIcon(selected.mimeType)}</span>
              <span className="text-[var(--color-text)] truncate">{selected.path}</span>
              <span className="text-[var(--color-text-muted)] ml-auto shrink-0">{formatSize(selected.size)}</span>
            </div>
            {/* Editor body */}
            <div className="flex-1 min-h-0">
              {isImageMime(selected.mimeType) ? (
                <div className="flex items-center justify-center h-full p-4 bg-[var(--color-surface)]">
                  <img
                    src={getArtifactUrl(conversationId, selected.path)}
                    alt={selected.path}
                    className="max-w-full max-h-full object-contain rounded"
                    loading="lazy"
                  />
                </div>
              ) : isPdfMime(selected.mimeType) ? (
                <iframe
                  src={getArtifactUrl(conversationId, selected.path)}
                  className="w-full h-full border-0"
                  title={selected.path}
                />
              ) : isAudioMime(selected.mimeType) ? (
                <div className="flex items-center justify-center h-full p-4">
                  <audio
                    controls
                    src={getArtifactUrl(conversationId, selected.path)}
                    className="max-w-full"
                  />
                </div>
              ) : isVideoMime(selected.mimeType) ? (
                <div className="flex items-center justify-center h-full p-4">
                  <video
                    controls
                    src={getArtifactUrl(conversationId, selected.path)}
                    className="max-w-full max-h-full rounded"
                  />
                </div>
              ) : !isTextMime(selected.mimeType) ? (
                <BinaryPlaceholder artifact={selected} conversationId={conversationId} />
              ) : selected.size > MAX_FILE_SIZE ? (
                <div className="flex flex-col items-center justify-center h-full text-[var(--color-text-muted)] gap-2 p-4">
                  <span className="text-lg">⚠️</span>
                  <span className="text-sm">文件过大（{formatSize(selected.size)}），超过 5MB 限制</span>
                  <a
                    href={getArtifactUrl(conversationId, selected.path)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[var(--color-accent)] hover:underline text-sm"
                  >
                    下载文件
                  </a>
                </div>
              ) : loading ? (
                <div className="flex items-center justify-center h-full text-[var(--color-text-muted)] text-sm">
                  加载中…
                </div>
              ) : (
                <Editor
                  value={content ?? ""}
                  language={language}
                  theme={monacoTheme}
                  options={{
                    readOnly: true,
                    minimap: { enabled: true },
                    fontSize: 13,
                    scrollBeyondLastLine: false,
                    wordWrap: "on",
                    lineNumbers: "on",
                    renderLineHighlight: "all",
                    automaticLayout: true,
                    bracketPairColorization: { enabled: true },
                    guides: { bracketPairs: true, indentation: true },
                    folding: true,
                    foldingHighlight: true,
                    showFoldingControls: "always",
                    stickyScroll: { enabled: true },
                    smoothScrolling: true,
                    cursorBlinking: "smooth",
                    cursorSmoothCaretAnimation: "on",
                    formatOnPaste: false,
                    links: true,
                    colorDecorators: true,
                    renderWhitespace: "boundary",
                    matchBrackets: "always",
                  }}
                />
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-[var(--color-text-muted)] text-sm gap-2">
            <span className="text-3xl">📝</span>
            <span>选择左侧文件以浏览代码</span>
          </div>
        )}
      </div>
    </div>
  );
}

function BinaryPlaceholder({ artifact, conversationId }: { artifact: ArtifactMeta; conversationId: string }) {
  const url = getArtifactUrl(conversationId, artifact.path);
  return (
    <div className="flex flex-col items-center justify-center h-full text-[var(--color-text-muted)] gap-2 p-4">
      <span className="text-3xl">{fileIcon(artifact.mimeType)}</span>
      <span className="text-sm">二进制文件，无法在编辑器中显示</span>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--color-accent)] hover:underline text-sm"
      >
        下载文件
      </a>
    </div>
  );
}

function CodeTreeItem({
  node,
  selected,
  onSelect,
  conversationId,
  depth,
}: {
  node: TreeNode;
  selected: ArtifactMeta | null;
  onSelect: (a: ArtifactMeta) => void;
  conversationId: string;
  depth: number;
}) {
  const storageKey = `code_tree_expanded:${conversationId}:${node.path}`;

  const [expanded, setExpanded] = useState(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      return stored !== null ? stored === "true" : false;
    } catch {
      return false;
    }
  });

  const handleToggle = () => {
    const next = !expanded;
    setExpanded(next);
    try { localStorage.setItem(storageKey, String(next)); } catch { /* ignore */ }
  };

  if (node.type === "file" && node.artifact) {
    const isSelected = selected?.path === node.artifact.path;
    return (
      <button
        onClick={() => onSelect(node.artifact!)}
        className={`w-full flex items-center gap-1.5 px-2 py-1 text-left text-xs transition-colors truncate ${
          isSelected
            ? "bg-[var(--color-accent-alpha)] text-[var(--color-text)]"
            : "text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]"
        }`}
        style={{ paddingLeft: `${depth * 16 + 12}px` }}
        title={node.path}
      >
        <span className="shrink-0">{fileIcon(node.artifact.mimeType)}</span>
        <span className="truncate">{node.name}</span>
      </button>
    );
  }

  const hasChildren = node.children && node.children.length > 0;

  return (
    <div>
      <button
        onClick={handleToggle}
        className="w-full flex items-center gap-1.5 px-2 py-1 text-left text-xs hover:bg-[var(--color-surface-hover)] transition-colors"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        <span className="text-[10px] text-[var(--color-text-muted)] shrink-0 w-3 text-center">
          {expanded ? "▼" : "▶"}
        </span>
        <span className="shrink-0">📁</span>
        <span className="text-[var(--color-text)] font-medium truncate">{node.name}</span>
      </button>
      {expanded && hasChildren && (
        <div>
          {node.children!.map((child) => (
            <CodeTreeItem
              key={child.path}
              node={child}
              selected={selected}
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
