import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { useState, useEffect } from "react";
import mermaid from "mermaid";
import "../share-markdown.css";

// 跟踪当前主题，主题变化时重新初始化 mermaid 并清缓存
let currentMermaidTheme: "dark" | "default" = "dark";

function detectTheme(): "dark" | "default" {
  return document.documentElement.classList.contains("theme-light") ? "default" : "dark";
}

function initMermaid() {
  const theme = detectTheme();
  if (theme !== currentMermaidTheme) {
    // 主题变化，清缓存
    svgCache.clear();
    currentMermaidTheme = theme;
  }
  mermaid.initialize({
    startOnLoad: false,
    theme,
    securityLevel: "loose",
    suppressErrorRendering: true,
  });
}

/** 检测是否为完整的 mermaid 图（必须以图类型关键字开头） */
const MERMAID_KEYWORDS = /^\s*(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|quadrantChart|requirementDiagram|gitgraph|mindmap|timeline|sankey|xychart|block-beta|packet-beta|kanban|architecture)/m;
function isMermaidDiagram(code: string): boolean {
  return MERMAID_KEYWORDS.test(cleanMermaidCode(code));
}

/** 清理 mermaid 代码：去除行号前缀（如 "2|flowchart TD"） */
function cleanMermaidCode(code: string): string {
  const lines = code.split("\n");
  // 检测是否大部分行有 "数字|" 前缀
  const prefixed = lines.filter((l) => /^\d+\|/.test(l)).length;
  if (prefixed > lines.length * 0.5) {
    return lines.map((l) => l.replace(/^\d+\|/, "")).join("\n").trim();
  }
  return code.trim();
}

/** 从 ReactNode children 提取纯文本，用于生成标题 id */
function extractText(node: React.ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (node && typeof node === "object" && "props" in node) {
    return extractText((node as React.ReactElement).props.children);
  }
  return "";
}

/** 生成标题 slug id，支持中文 */
export function slugify(text: string): string {
  return "heading-" + text.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^\w\u4e00-\u9fff-]/g, "");
}

let mermaidCounter = 0;
const svgCache = new Map<string, { svg?: string; error?: string }>();

function MermaidBlock({ code }: { code: string }) {
  const cleaned = cleanMermaidCode(code);
  const cached = svgCache.get(cleaned);
  const [svgContent, setSvgContent] = useState<string | null>(cached?.svg ?? null);
  const [error, setError] = useState<string | null>(cached?.error ?? null);
  const [showCode, setShowCode] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    // 已有缓存，不再触发 setState（useState 初始值已从缓存读取）
    if (svgCache.has(cleaned)) return;

    initMermaid();
    const id = `mermaid_${++mermaidCounter}`;
    let cancelled = false;
    (async () => {
      try {
        const { svg } = await mermaid.render(id, cleaned);
        svgCache.set(cleaned, { svg });
        if (!cancelled) {
          setSvgContent(svg);
          setError(null);
        }
      } catch (e) {
        let errMsg = e instanceof Error ? e.message : String(e);
        // 为常见问题提供更友好的提示
        const isBeta = /^(architecture-beta|packet-beta|block-beta)/.test(cleaned);
        const hasChinese = /[\u4e00-\u9fff]/.test(cleaned);
        if (isBeta && hasChinese) {
          errMsg = "该实验性图表类型暂不支持中文标签，请使用英文";
        }
        svgCache.set(cleaned, { error: errMsg });
        if (!cancelled) {
          setSvgContent(null);
          setError(errMsg);
        }
      } finally {
        document.getElementById(id)?.remove();
      }
    })();
    return () => { cancelled = true; };
  }, [cleaned]);

  if (error) {
    return (
      <div className="my-3 rounded-lg border border-[var(--color-border)] overflow-hidden">
        <div className="flex items-center justify-between px-4 py-1.5 bg-[var(--color-bg)] border-b border-[var(--color-border)]">
          <span className="text-[11px] text-[var(--color-text-muted)] font-mono">mermaid</span>
          <span className="text-[11px] text-yellow-500" title={error}>语法有误，显示源码</span>
        </div>
        <pre className="p-4 overflow-x-auto text-[13px] bg-[var(--color-bg)]"><code>{code}</code></pre>
      </div>
    );
  }

  return (
    <>
      <div className="my-3 rounded-lg border border-[var(--color-border)] overflow-hidden">
        <div className="flex items-center justify-between px-4 py-1.5 bg-[var(--color-bg)] border-b border-[var(--color-border)]">
          <span className="text-[11px] text-[var(--color-text-muted)] font-mono">mermaid</span>
          <div className="flex items-center gap-2">
            {svgContent && !showCode && (
              <button
                type="button"
                onClick={() => setFullscreen(true)}
                className="text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
                title="全屏查看"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 3 21 3 21 9" /><line x1="14" y1="10" x2="21" y2="3" />
                  <polyline points="9 21 3 21 3 15" /><line x1="10" y1="14" x2="3" y2="21" />
                </svg>
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowCode((v) => !v)}
              className="text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
            >
              {showCode ? "图表" : "源码"}
            </button>
          </div>
        </div>
        {showCode ? (
          <pre className="p-4 overflow-x-auto text-[13px] bg-[var(--color-bg)]"><code>{code}</code></pre>
        ) : svgContent ? (
          <div dangerouslySetInnerHTML={{ __html: svgContent }} className="flex justify-center p-4 bg-[var(--color-bg)] overflow-x-auto [&>svg]:max-w-full [&>svg]:min-w-[600px] [&>svg]:h-auto" />
        ) : (
          <div className="flex justify-center p-4 bg-[var(--color-bg)] text-[var(--color-text-muted)] text-xs">渲染中…</div>
        )}
      </div>

      {/* 全屏遮罩 */}
      {fullscreen && svgContent && (
        <div
          className="fixed inset-0 z-[9999] flex flex-col bg-black/70 backdrop-blur-sm"
          onClick={() => { setFullscreen(false); setZoom(1); }}
        >
          {/* 工具栏 */}
          <div className="flex items-center justify-between px-4 py-2 bg-[var(--color-bg)] border-b border-[var(--color-border)]" onClick={(e) => e.stopPropagation()}>
            <span className="text-xs text-[var(--color-text-muted)] font-mono">mermaid</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}
                className="w-8 h-8 flex items-center justify-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] transition-colors"
                title="缩小"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="5" y1="12" x2="19" y2="12" /></svg>
              </button>
              <button
                type="button"
                onClick={() => setZoom(1)}
                className="px-2 h-8 flex items-center justify-center rounded text-xs font-mono text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] transition-colors min-w-[48px]"
                title="重置缩放"
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                onClick={() => setZoom((z) => Math.min(5, z + 0.25))}
                className="w-8 h-8 flex items-center justify-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] transition-colors"
                title="放大"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
              </button>
              <div className="w-px h-5 bg-[var(--color-border)] mx-1" />
              <button
                type="button"
                onClick={() => { setFullscreen(false); setZoom(1); }}
                className="w-8 h-8 flex items-center justify-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] transition-colors"
                title="关闭"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </div>
          {/* 图表内容 */}
          <div
            className="flex-1 overflow-auto flex items-center justify-center"
            onClick={(e) => e.stopPropagation()}
            onWheel={(e) => {
              e.stopPropagation();
              setZoom((z) => Math.min(5, Math.max(0.25, z + (e.deltaY < 0 ? 0.1 : -0.1))));
            }}
          >
            <div
              style={{ transform: `scale(${zoom})`, transformOrigin: "center center" }}
              className="transition-transform duration-100 p-8"
              dangerouslySetInnerHTML={{ __html: svgContent }}
            />
          </div>
        </div>
      )}
    </>
  );
}

interface Props {
  children: string;
  className?: string;
  transformImageUrl?: (src: string) => string;
  /** Share card: code block layout tweaks (see share-markdown.css) */
  variant?: "default" | "share";
  /** 禁用 mermaid 渲染（流式输出时使用） */
  disableMermaid?: boolean;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };
  return (
    <button
      type="button"
      onClick={handleCopy}
      className="absolute top-2 right-2 px-2 py-1 rounded text-[11px] text-[var(--color-text-muted)] bg-[var(--color-surface)] border border-[var(--color-border)] opacity-0 group-hover:opacity-100 transition-opacity hover:text-[var(--color-text)]"
    >
      {copied ? "已复制" : "复制"}
    </button>
  );
}

function CodeBlock({
  className,
  children,
  variant = "default",
}: {
  className?: string;
  children: React.ReactNode;
  variant?: "default" | "share";
}) {
  const text = typeof children === "string" ? children : String(children ?? "");
  const lang = className?.match(/language-([\w-]+)/)?.[1] ?? "";
  const isShare = variant === "share";
  const pad = isShare ? "" : "p-4";
  const barPad = isShare ? "" : "px-4";
  return (
    <div className="relative group my-3">
      {lang && (
        <div className={`flex items-center justify-between ${barPad} py-1.5 rounded-t-lg ${isShare ? "" : "bg-[var(--color-bg)] border border-b-0 border-[var(--color-border)]"}`}>
          <span className={`font-mono ${isShare ? "" : "text-[11px] text-[var(--color-text-muted)]"}`}>{lang}</span>
        </div>
      )}
      <pre
        className={`${lang ? "rounded-b-lg rounded-t-none" : "rounded-lg"} overflow-x-auto overflow-y-visible ${isShare ? "share-card-pre" : `border border-[var(--color-border)] bg-[var(--color-bg)] ${pad} text-[13px] leading-relaxed`}`}
      >
        <code className={className}>{children}</code>
      </pre>
      <CopyButton text={text.replace(/\n$/, "")} />
    </div>
  );
}

export default function MarkdownContent({ children, className = "", transformImageUrl, variant = "default", disableMermaid = false }: Props) {
  const shareCls = variant === "share" ? "share-markdown" : "";
  return (
    <div
      className={["markdown-content", "break-words", "text-[var(--color-text)]", "text-sm", "leading-relaxed", shareCls, className].filter(Boolean).join(" ")}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,

          h1: ({ children }) => <h1 id={slugify(extractText(children))} className="text-xl font-bold mt-6 mb-3 first:mt-0 pb-1 border-b border-[var(--color-border)]">{children}</h1>,
          h2: ({ children }) => <h2 id={slugify(extractText(children))} className="text-lg font-semibold mt-5 mb-2 first:mt-0 pb-1 border-b border-[var(--color-border)]">{children}</h2>,
          h3: ({ children }) => <h3 id={slugify(extractText(children))} className="text-base font-semibold mt-4 mb-2 first:mt-0">{children}</h3>,
          h4: ({ children }) => <h4 id={slugify(extractText(children))} className="text-sm font-semibold mt-3 mb-1 first:mt-0">{children}</h4>,

          ul: ({ children }) => (
            <ul
              className={
                variant === "share"
                  ? "mb-3 list-disc share-md-list-ul"
                  : "mb-3 space-y-1 list-disc pl-5"
              }
            >
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol
              className={
                variant === "share"
                  ? "mb-3 list-decimal share-md-list-ol"
                  : "mb-3 space-y-1 list-decimal pl-5"
              }
            >
              {children}
            </ol>
          ),
          li: ({ children }) => (
            <li className={variant === "share" ? "share-md-li" : "leading-relaxed"}>{children}</li>
          ),

          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          del: ({ children }) => <del className="line-through text-[var(--color-text-muted)]">{children}</del>,

          // inline code vs block code
          code: ({ className: c, children, ...props }) => {
            // block code (inside <pre>) is handled by the pre renderer below
            const isBlock = !!(props as { node?: { parent?: { tagName?: string } } }).node?.parent &&
              (props as { node?: { parent?: { tagName?: string } } }).node?.parent?.tagName === "pre";
            if (isBlock) {
              return <code className={c ?? ""}>{children}</code>;
            }
            return (
              <code className="px-1.5 py-0.5 rounded bg-[var(--color-surface-hover)] text-[var(--color-accent)] text-[0.85em] font-mono border border-[var(--color-border)]">
                {children}
              </code>
            );
          },

          pre: ({ children, ...props }) => {
            // extract className and children from the nested <code>
            const codeEl = (children as React.ReactElement<{ className?: string; children?: React.ReactNode }>);
            const codeClass = codeEl?.props?.className ?? "";
            const codeChildren = codeEl?.props?.children;
            // Mermaid diagram rendering
            const lang = codeClass.match(/language-([\w-]+)/)?.[1];
            if (lang === "mermaid" && !disableMermaid) {
              const text = typeof codeChildren === "string" ? codeChildren : String(codeChildren ?? "");
              if (isMermaidDiagram(text)) {
                return <MermaidBlock code={text} />;
              }
            }
            return (
              <CodeBlock variant={variant} className={codeClass} {...props}>
                {codeChildren}
              </CodeBlock>
            );
          },

          blockquote: ({ children }) => (
            <blockquote className="border-l-4 border-[var(--color-accent)] pl-4 my-3 text-[var(--color-text-muted)] italic bg-[var(--color-surface-hover)] rounded-r-lg py-2 pr-3">
              {children}
            </blockquote>
          ),

          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-[var(--color-accent)] hover:underline underline-offset-2">
              {children}
            </a>
          ),

          img: ({ src, alt }) => {
            const resolved = src && transformImageUrl ? transformImageUrl(src) : src;
            return <img src={resolved} alt={alt ?? ""} className="max-w-full rounded-lg my-3 border border-[var(--color-border)]" loading="lazy" />;
          },

          // GFM tables
          table: ({ children }) => (
            <div className="overflow-x-auto my-3 rounded-lg border border-[var(--color-border)]">
              <table className="w-full text-sm border-collapse">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-[var(--color-surface-hover)]">{children}</thead>,
          tbody: ({ children }) => <tbody className="divide-y divide-[var(--color-border)]">{children}</tbody>,
          tr: ({ children }) => <tr className="divide-x divide-[var(--color-border)]">{children}</tr>,
          th: ({ children }) => <th className="px-4 py-2 text-left font-semibold text-[var(--color-text)] whitespace-nowrap">{children}</th>,
          td: ({ children }) => <td className="px-4 py-2 text-[var(--color-text)]">{children}</td>,

          // GFM task list checkboxes
          input: ({ type, checked }) =>
            type === "checkbox" ? (
              <input type="checkbox" checked={checked} readOnly className="mr-1.5 accent-[var(--color-accent)] cursor-default" />
            ) : null,

          hr: () => <hr className="my-4 border-[var(--color-border)]" />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
