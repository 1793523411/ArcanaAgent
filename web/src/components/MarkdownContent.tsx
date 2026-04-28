import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { useState, useEffect, useMemo } from "react";
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

// ─── 全局全屏查看器（脱离组件树，不受父组件重渲染影响） ─────
let fullscreenRoot: HTMLDivElement | null = null;
let fullscreenCleanup: (() => void) | null = null;

function closeMermaidFullscreen() {
  if (fullscreenRoot) {
    fullscreenRoot.remove();
    fullscreenRoot = null;
  }
  if (fullscreenCleanup) {
    fullscreenCleanup();
    fullscreenCleanup = null;
  }
}

function openMermaidFullscreen(svgHtml: string) {
  closeMermaidFullscreen();

  const root = document.createElement("div");
  root.style.cssText = "position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;background:rgba(0,0,0,0.7);backdrop-filter:blur(4px)";
  document.body.appendChild(root);
  fullscreenRoot = root;

  let zoom = 1;
  const svgContainer = document.createElement("div");

  function render() {
    svgContainer.style.transform = `scale(${zoom})`;
    svgContainer.style.transformOrigin = "center center";
    const pctBtn = root.querySelector<HTMLElement>("[data-zoom-pct]");
    if (pctBtn) pctBtn.textContent = `${Math.round(zoom * 100)}%`;
  }

  // 工具栏
  const toolbar = document.createElement("div");
  toolbar.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:8px 16px;background:var(--color-bg);border-bottom:1px solid var(--color-border);flex-shrink:0";
  toolbar.innerHTML = `
    <span style="font-size:12px;color:var(--color-text-muted);font-family:monospace">mermaid</span>
    <div style="display:flex;align-items:center;gap:4px">
      <button data-zoom-out style="width:32px;height:32px;display:flex;align-items:center;justify-content:center;border-radius:4px;border:none;background:none;color:var(--color-text-muted);cursor:pointer;font-size:18px" title="缩小">−</button>
      <button data-zoom-pct style="padding:0 8px;height:32px;display:flex;align-items:center;justify-content:center;border-radius:4px;border:none;background:none;color:var(--color-text-muted);cursor:pointer;font-size:12px;font-family:monospace;min-width:48px" title="重置缩放">100%</button>
      <button data-zoom-in style="width:32px;height:32px;display:flex;align-items:center;justify-content:center;border-radius:4px;border:none;background:none;color:var(--color-text-muted);cursor:pointer;font-size:18px" title="放大">+</button>
      <div style="width:1px;height:20px;background:var(--color-border);margin:0 4px"></div>
      <button data-close style="width:32px;height:32px;display:flex;align-items:center;justify-content:center;border-radius:4px;border:none;background:none;color:var(--color-text-muted);cursor:pointer;font-size:16px" title="关闭">✕</button>
    </div>
  `;
  root.appendChild(toolbar);

  // 内容区域
  const content = document.createElement("div");
  content.style.cssText = "flex:1;overflow:auto;display:flex;align-items:center;justify-content:center";
  svgContainer.style.cssText = "transition:transform 0.1s;padding:32px";
  svgContainer.innerHTML = svgHtml;
  content.appendChild(svgContainer);
  root.appendChild(content);

  render();

  // 事件处理
  const onZoomOut = () => { zoom = Math.max(0.25, zoom - 0.25); render(); };
  const onZoomIn = () => { zoom = Math.min(5, zoom + 0.25); render(); };
  const onReset = () => { zoom = 1; render(); };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    zoom = Math.min(5, Math.max(0.25, zoom + (e.deltaY < 0 ? 0.1 : -0.1)));
    render();
  };
  const onBackdropClick = (e: MouseEvent) => {
    if (e.target === content || e.target === root) closeMermaidFullscreen();
  };
  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeMermaidFullscreen();
  };

  toolbar.querySelector("[data-zoom-out]")!.addEventListener("click", onZoomOut);
  toolbar.querySelector("[data-zoom-in]")!.addEventListener("click", onZoomIn);
  toolbar.querySelector("[data-zoom-pct]")!.addEventListener("click", onReset);
  toolbar.querySelector("[data-close]")!.addEventListener("click", closeMermaidFullscreen);
  content.addEventListener("wheel", onWheel, { passive: false });
  root.addEventListener("click", onBackdropClick);
  document.addEventListener("keydown", onKeydown);

  fullscreenCleanup = () => {
    document.removeEventListener("keydown", onKeydown);
  };
}

// ─── MermaidBlock ────────────────────────────────

function MermaidBlock({ code }: { code: string }) {
  const cleaned = cleanMermaidCode(code);
  const cached = svgCache.get(cleaned);
  const [svgContent, setSvgContent] = useState<string | null>(cached?.svg ?? null);
  const [error, setError] = useState<string | null>(cached?.error ?? null);
  const [showCode, setShowCode] = useState(false);

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
    <div className="my-3 rounded-lg border border-[var(--color-border)] overflow-hidden">
        <div className="flex items-center justify-between px-4 py-1.5 bg-[var(--color-bg)] border-b border-[var(--color-border)]">
          <span className="text-[11px] text-[var(--color-text-muted)] font-mono">mermaid</span>
          <div className="flex items-center gap-2">
            {svgContent && !showCode && (
              <button
                type="button"
                onClick={() => svgContent && openMermaidFullscreen(svgContent)}
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
          <div dangerouslySetInnerHTML={{ __html: svgContent }} className="flex justify-center p-4 bg-[var(--color-bg)] overflow-x-auto [&>svg]:max-w-full [&>svg]:h-auto [&>svg]:min-w-0" />
        ) : (
          <div className="flex justify-center p-4 bg-[var(--color-bg)] text-[var(--color-text-muted)] text-xs">渲染中…</div>
        )}
    </div>
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
  // Lightbox state — opening one image at a time keeps the overlay stack
  // shallow and avoids race conditions when a fast clicker swaps targets.
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);

  // ESC closes the lightbox without disturbing the underlying scroll position.
  // Listener only attaches while the lightbox is open so we don't pay the
  // cost on every render of every markdown block on the page.
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setLightbox(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox]);

  const components = useMemo(() => ({
    p: ({ children }: { children?: React.ReactNode }) => <p className="mb-3 last:mb-0">{children}</p>,

    h1: ({ children }: { children?: React.ReactNode }) => <h1 id={slugify(extractText(children))} className="text-xl font-bold mt-6 mb-3 first:mt-0 pb-1 border-b border-[var(--color-border)]">{children}</h1>,
    h2: ({ children }: { children?: React.ReactNode }) => <h2 id={slugify(extractText(children))} className="text-lg font-semibold mt-5 mb-2 first:mt-0 pb-1 border-b border-[var(--color-border)]">{children}</h2>,
    h3: ({ children }: { children?: React.ReactNode }) => <h3 id={slugify(extractText(children))} className="text-base font-semibold mt-4 mb-2 first:mt-0">{children}</h3>,
    h4: ({ children }: { children?: React.ReactNode }) => <h4 id={slugify(extractText(children))} className="text-sm font-semibold mt-3 mb-1 first:mt-0">{children}</h4>,

    ul: ({ children }: { children?: React.ReactNode }) => (
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
    ol: ({ children }: { children?: React.ReactNode }) => (
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
    li: ({ children }: { children?: React.ReactNode }) => (
      <li className={variant === "share" ? "share-md-li" : "leading-relaxed"}>{children}</li>
    ),

    strong: ({ children }: { children?: React.ReactNode }) => <strong className="font-semibold">{children}</strong>,
    em: ({ children }: { children?: React.ReactNode }) => <em className="italic">{children}</em>,
    del: ({ children }: { children?: React.ReactNode }) => <del className="line-through text-[var(--color-text-muted)]">{children}</del>,

    // inline code vs block code
    code: ({ className: c, children, ...props }: any) => {
      const isBlock = !!props.node?.parent && props.node?.parent?.tagName === "pre";
      if (isBlock) {
        return <code className={c ?? ""}>{children}</code>;
      }
      return (
        <code className="px-1.5 py-0.5 rounded bg-[var(--color-surface-hover)] text-[var(--color-accent)] text-[0.85em] font-mono border border-[var(--color-border)]">
          {children}
        </code>
      );
    },

    pre: ({ children, ...props }: any) => {
      const codeEl = (children as React.ReactElement<{ className?: string; children?: React.ReactNode }>);
      const codeClass = codeEl?.props?.className ?? "";
      const codeChildren = codeEl?.props?.children;
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

    blockquote: ({ children }: { children?: React.ReactNode }) => (
      <blockquote className="border-l-4 border-[var(--color-accent)] pl-4 my-3 text-[var(--color-text-muted)] italic bg-[var(--color-surface-hover)] rounded-r-lg py-2 pr-3">
        {children}
      </blockquote>
    ),

    a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
      <a href={href} target="_blank" rel="noopener noreferrer" className="text-[var(--color-accent)] hover:underline underline-offset-2">
        {children}
      </a>
    ),

    img: ({ src, alt }: { src?: string; alt?: string }) => {
      const resolved = src && transformImageUrl ? transformImageUrl(src) : src;
      // Constrain inline rendering: max ~28rem wide / 18rem tall, contained
      // so portrait + landscape both stay reasonable. Click opens a full
      // viewport lightbox; cursor-zoom-in gives the user a hint before they
      // commit. `object-contain` matters because hard width/height crop a
      // mismatched aspect ratio otherwise.
      return (
        <img
          src={resolved}
          alt={alt ?? ""}
          loading="lazy"
          className="max-w-md max-h-72 object-contain rounded-lg my-3 border border-[var(--color-border)] cursor-zoom-in transition-shadow hover:shadow-md"
          onClick={() => { if (resolved) setLightbox({ src: resolved, alt: alt ?? "" }); }}
        />
      );
    },

    // GFM tables
    table: ({ children }: { children?: React.ReactNode }) => (
      <div className="overflow-x-auto my-3 rounded-lg border border-[var(--color-border)]">
        <table className="w-full text-sm border-collapse">{children}</table>
      </div>
    ),
    thead: ({ children }: { children?: React.ReactNode }) => <thead className="bg-[var(--color-surface-hover)]">{children}</thead>,
    tbody: ({ children }: { children?: React.ReactNode }) => <tbody className="divide-y divide-[var(--color-border)]">{children}</tbody>,
    tr: ({ children }: { children?: React.ReactNode }) => <tr className="divide-x divide-[var(--color-border)]">{children}</tr>,
    th: ({ children }: { children?: React.ReactNode }) => <th className="px-4 py-2 text-left font-semibold text-[var(--color-text)] whitespace-nowrap">{children}</th>,
    td: ({ children }: { children?: React.ReactNode }) => <td className="px-4 py-2 text-[var(--color-text)]">{children}</td>,

    // GFM task list checkboxes
    input: ({ type, checked }: { type?: string; checked?: boolean }) =>
      type === "checkbox" ? (
        <input type="checkbox" checked={checked} readOnly className="mr-1.5 accent-[var(--color-accent)] cursor-default" />
      ) : null,

    hr: () => <hr className="my-4 border-[var(--color-border)]" />,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [variant, disableMermaid, transformImageUrl]);

  return (
    <div
      className={["markdown-content", "break-words", "text-[var(--color-text)]", "text-sm", "leading-relaxed", shareCls, className].filter(Boolean).join(" ")}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={components}
        // Default urlTransform sanitizes unrecognized URL schemes — including
        // bare relative paths whose first segment contains a colon (which is
        // common for Chinese filenames using full-width "：" or any path with
        // a literal colon). That collapses the src to "" before our img
        // component override runs, breaking artifact previews. Identity
        // pass-through is safe here because:
        //   1) we render markdown sourced only from trusted agent output, and
        //   2) `transformImageUrl` (when set) re-resolves img URLs to a known
        //      same-origin shape before they reach the DOM.
        urlTransform={(url) => url}
      >
        {children}
      </ReactMarkdown>
      {lightbox && (
        // Fullscreen lightbox: 95% viewport so a wide PNG isn't cropped by the
        // backdrop. z-[90] sits above guild modals (z-[80]) and below toasts.
        // Click anywhere outside the image (including the image itself) closes
        // — no separate close button needed for an image-only view.
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center cursor-zoom-out"
          style={{ background: "rgba(0,0,0,0.85)" }}
          onClick={() => setLightbox(null)}
          role="dialog"
          aria-modal="true"
          aria-label={lightbox.alt || "图片预览"}
        >
          <img
            src={lightbox.src}
            alt={lightbox.alt}
            className="max-w-[95vw] max-h-[95vh] object-contain rounded-lg shadow-2xl"
          />
        </div>
      )}
    </div>
  );
}
