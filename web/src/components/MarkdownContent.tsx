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

function quoteMermaidText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("\"") || trimmed.startsWith("`")) return trimmed;
  if (/^[A-Za-z0-9_.-]+$/.test(trimmed)) return trimmed;
  return `"${trimmed.replace(/"/g, "'")}"`;
}

function normalizeQuadrantChartCode(code: string): string {
  const lines = code.split("\n");
  const firstContentLine = lines.find((line) => line.trim());
  if (!firstContentLine || !/^quadrantChart\b/i.test(firstContentLine.trim())) return code;

  return lines.map((line) => {
    const axisMatch = line.match(/^(\s*[xy]-axis\s+)(.*?)\s*--+>\s*(.*?)\s*$/i);
    if (axisMatch) {
      return `${axisMatch[1]}${quoteMermaidText(axisMatch[2])} --> ${quoteMermaidText(axisMatch[3])}`;
    }

    const quadrantMatch = line.match(/^(\s*quadrant-[1-4]\s+)(.*?)\s*$/i);
    if (quadrantMatch) {
      return `${quadrantMatch[1]}${quoteMermaidText(quadrantMatch[2])}`;
    }

    const pointMatch = line.match(/^(\s*)([^:\n]+?)\s*:\s*(\[\s*(?:1|0(?:\.\d+)?)\s*,\s*(?:1|0(?:\.\d+)?)\s*\].*)$/);
    if (pointMatch) {
      return `${pointMatch[1]}${quoteMermaidText(pointMatch[2])}: ${pointMatch[3]}`;
    }

    return line;
  }).join("\n");
}

/** 清理 mermaid 代码：去除行号前缀（如 "2|flowchart TD"） */
function cleanMermaidCode(code: string): string {
  const lines = code.split("\n");
  // 检测是否大部分行有 "数字|" 前缀
  const prefixed = lines.filter((l) => /^\d+\|/.test(l)).length;
  if (prefixed > lines.length * 0.5) {
    return normalizeQuadrantChartCode(lines.map((l) => l.replace(/^\d+\|/, "")).join("\n").trim());
  }
  return normalizeQuadrantChartCode(code.trim());
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

type LooseMarkdownBlock =
  | { type: "markdown"; content: string; normalizeInlineHtml: boolean }
  | { type: "table"; rows: LooseTableRow[] }
  | { type: "grid"; cols: number; columns: LooseGridColumn[] }
  | { type: "callout"; emoji: string; tone: CalloutTone; content: string };

interface LooseTableCell {
  tag: "th" | "td";
  content: string;
}

type LooseTableRow = LooseTableCell[];

interface LooseGridColumn {
  width?: string;
  content: string;
}

type CalloutTone = "default" | "warning" | "success" | "error" | "info";

interface QuadrantPoint {
  label: string;
  x: number;
  y: number;
}

interface QuadrantData {
  title?: string;
  xLeft?: string;
  xRight?: string;
  yBottom?: string;
  yTop?: string;
  quadrants: Partial<Record<1 | 2 | 3 | 4, string>>;
  points: QuadrantPoint[];
}

function decodeHtmlEntities(value: string): string {
  if (typeof document === "undefined") return value;
  const textarea = document.createElement("textarea");
  textarea.innerHTML = value;
  return textarea.value;
}

function normalizeLooseMarkup(source: string): string {
  return source
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\s*(?:b|strong)\s*>/gi, "**")
    .replace(/<\s*\/\s*(?:b|strong)\s*>/gi, "**")
    .replace(/<\s*(?:i|em)\s*>/gi, "*")
    .replace(/<\s*\/\s*(?:i|em)\s*>/gi, "*");
}

function nodeListToMarkdown(nodes: Iterable<ChildNode>): string {
  return Array.from(nodes).map(htmlNodeToMarkdown).join("");
}

function htmlNodeToMarkdown(node: ChildNode): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  const element = node as HTMLElement;
  const tag = element.tagName.toLowerCase();
  const inner = nodeListToMarkdown(element.childNodes);

  if (tag === "br") return "\n";
  if (tag === "b" || tag === "strong") return `**${inner}**`;
  if (tag === "i" || tag === "em") return `*${inner}*`;
  if (tag === "code") return `\`${inner.trim()}\``;
  if (tag === "li") return `- ${inner.trim()}\n`;
  if (tag === "ul" || tag === "ol") return `\n${inner.trim()}\n`;
  if (/^h[1-6]$/.test(tag)) return `\n${"#".repeat(Number(tag[1]))} ${inner.trim()}\n\n`;
  if (tag === "p" || tag === "div") return `${inner.trim()}\n\n`;
  return inner;
}

function htmlLikeToMarkdown(source: string): string {
  const normalized = normalizeLooseMarkup(source);
  if (typeof DOMParser === "undefined") {
    return decodeHtmlEntities(normalized.replace(/<[^>]+>/g, "")).trim();
  }

  const doc = new DOMParser().parseFromString(`<div>${source}</div>`, "text/html");
  const wrapper = doc.body.firstElementChild;
  if (!wrapper) return decodeHtmlEntities(normalized.replace(/<[^>]+>/g, "")).trim();
  return nodeListToMarkdown(wrapper.childNodes).trim();
}

function getLooseAttr(attrs: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = attrs.match(new RegExp(`${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function parseLooseTableWithRegex(raw: string): LooseTableRow[] {
  const rows: LooseTableRow[] = [];
  const rowMatches = raw.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const rowMatch of rowMatches) {
    const cells: LooseTableCell[] = [];
    const cellMatches = rowMatch[1].matchAll(/<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi);
    for (const cellMatch of cellMatches) {
      cells.push({ tag: cellMatch[1].toLowerCase() === "th" ? "th" : "td", content: htmlLikeToMarkdown(cellMatch[2]) });
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

function parseLooseTable(raw: string): LooseTableRow[] {
  if (typeof DOMParser === "undefined") return parseLooseTableWithRegex(raw);

  const doc = new DOMParser().parseFromString(raw, "text/html");
  const table = doc.querySelector("table");
  if (!table) return parseLooseTableWithRegex(raw);

  const rows = Array.from(table.querySelectorAll("tr")).map((row) => {
    return Array.from(row.children)
      .filter((cell) => ["th", "td"].includes(cell.tagName.toLowerCase()))
      .map((cell): LooseTableCell => ({
        tag: cell.tagName.toLowerCase() === "th" ? "th" : "td",
        content: htmlLikeToMarkdown(cell.innerHTML),
      }));
  }).filter((row) => row.length > 0);

  return rows.length > 0 ? rows : parseLooseTableWithRegex(raw);
}

function parseLooseGrid(raw: string): { cols: number; columns: LooseGridColumn[] } {
  const openTag = raw.match(/^<grid\b([^>]*)>/i);
  const declaredCols = Number(getLooseAttr(openTag?.[1] ?? "", "cols"));
  const columns = Array.from(raw.matchAll(/<column\b([^>]*)>([\s\S]*?)<\/column>/gi)).map((match) => ({
    width: getLooseAttr(match[1], "width"),
    content: htmlLikeToMarkdown(match[2]),
  }));

  return {
    cols: Number.isFinite(declaredCols) && declaredCols > 0 ? Math.min(declaredCols, 4) : Math.min(Math.max(columns.length, 1), 4),
    columns: columns.length > 0 ? columns : [{ content: htmlLikeToMarkdown(raw.replace(/^<grid\b[^>]*>/i, "").replace(/<\/grid>$/i, "")) }],
  };
}

function parseCalloutTone(background?: string): CalloutTone {
  const value = (background ?? "").toLowerCase();
  if (value.includes("yellow") || value.includes("orange")) return "warning";
  if (value.includes("green")) return "success";
  if (value.includes("red") || value.includes("pink")) return "error";
  if (value.includes("blue") || value.includes("cyan")) return "info";
  return "default";
}

function parseLooseCallout(raw: string): { emoji: string; tone: CalloutTone; content: string } {
  const openTag = raw.match(/^<callout\b([^>]*)>/i);
  const attrs = openTag?.[1] ?? "";
  const content = raw.replace(/^<callout\b[^>]*>/i, "").replace(/<\/callout>$/i, "");
  const tone = parseCalloutTone(getLooseAttr(attrs, "background-color") ?? getLooseAttr(attrs, "color"));
  const fallbackEmoji = tone === "warning" ? "⚠️" : tone === "success" ? "✅" : tone === "error" ? "❌" : tone === "info" ? "ℹ️" : "💡";

  return {
    emoji: getLooseAttr(attrs, "emoji") ?? fallbackEmoji,
    tone,
    content: htmlLikeToMarkdown(content),
  };
}

function splitFencedMarkdown(source: string): Array<{ content: string; fenced: boolean }> {
  const segments: Array<{ content: string; fenced: boolean }> = [];
  const lines = source.match(/[^\n]*(?:\n|$)/g) ?? [];
  let cursor = 0;
  let offset = 0;
  let fenceStart: number | null = null;
  let fenceChar = "";
  let fenceLength = 0;

  for (const line of lines) {
    if (!line && offset >= source.length) break;
    const match = line.match(/^ {0,3}(```+|~~~+)/);
    if (match) {
      const marker = match[1];
      if (fenceStart === null) {
        if (offset > cursor) segments.push({ content: source.slice(cursor, offset), fenced: false });
        fenceStart = offset;
        fenceChar = marker[0];
        fenceLength = marker.length;
      } else if (marker[0] === fenceChar && marker.length >= fenceLength) {
        segments.push({ content: source.slice(fenceStart, offset + line.length), fenced: true });
        cursor = offset + line.length;
        fenceStart = null;
        fenceChar = "";
        fenceLength = 0;
      }
    }
    offset += line.length;
  }

  if (fenceStart !== null) {
    segments.push({ content: source.slice(fenceStart), fenced: true });
    cursor = source.length;
  }
  if (cursor < source.length) segments.push({ content: source.slice(cursor), fenced: false });
  return segments.filter((segment) => segment.content.length > 0);
}

function parseLooseBlocksInText(text: string): LooseMarkdownBlock[] {
  const blocks: LooseMarkdownBlock[] = [];
  const blockRe = /<(table|grid|callout)\b[^>]*>[\s\S]*?<\/\1>/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = blockRe.exec(text)) !== null) {
    if (match.index > lastIndex) {
      blocks.push({ type: "markdown", content: text.slice(lastIndex, match.index), normalizeInlineHtml: true });
    }

    const raw = match[0];
    const tag = match[1].toLowerCase();
    if (tag === "table") {
      blocks.push({ type: "table", rows: parseLooseTable(raw) });
    } else if (tag === "grid") {
      const parsed = parseLooseGrid(raw);
      blocks.push({ type: "grid", ...parsed });
    } else {
      const parsed = parseLooseCallout(raw);
      blocks.push({ type: "callout", ...parsed });
    }

    lastIndex = match.index + raw.length;
  }

  if (lastIndex < text.length) {
    blocks.push({ type: "markdown", content: text.slice(lastIndex), normalizeInlineHtml: true });
  }

  return blocks;
}

function parseLooseMarkdownBlocks(source: string): LooseMarkdownBlock[] {
  return splitFencedMarkdown(source).flatMap((segment) => (
    segment.fenced
      ? [{ type: "markdown" as const, content: segment.content, normalizeInlineHtml: false }]
      : parseLooseBlocksInText(segment.content)
  ));
}

function unquoteLooseMermaidText(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("`") && trimmed.endsWith("`"))
  ) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith("\"`") && trimmed.endsWith("`\"")) return trimmed.slice(2, -2);
  return trimmed;
}

function parseQuadrantChart(code: string): QuadrantData | null {
  const lines = code.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.some((line) => /^quadrantChart\b/i.test(line))) return null;

  const data: QuadrantData = { quadrants: {}, points: [] };
  for (const line of lines) {
    const titleMatch = line.match(/^title\s+(.+)$/i);
    if (titleMatch) {
      data.title = unquoteLooseMermaidText(titleMatch[1]);
      continue;
    }

    const axisMatch = line.match(/^([xy])-axis\s+(.+?)\s*--+>\s*(.+)$/i);
    if (axisMatch) {
      if (axisMatch[1].toLowerCase() === "x") {
        data.xLeft = unquoteLooseMermaidText(axisMatch[2]);
        data.xRight = unquoteLooseMermaidText(axisMatch[3]);
      } else {
        data.yBottom = unquoteLooseMermaidText(axisMatch[2]);
        data.yTop = unquoteLooseMermaidText(axisMatch[3]);
      }
      continue;
    }

    const quadrantMatch = line.match(/^quadrant-([1-4])\s+(.+)$/i);
    if (quadrantMatch) {
      data.quadrants[Number(quadrantMatch[1]) as 1 | 2 | 3 | 4] = unquoteLooseMermaidText(quadrantMatch[2]);
      continue;
    }

    const pointMatch = line.match(/^(.+?)\s*:\s*\[\s*(1|0(?:\.\d+)?)\s*,\s*(1|0(?:\.\d+)?)\s*\]/);
    if (pointMatch) {
      data.points.push({
        label: unquoteLooseMermaidText(pointMatch[1]),
        x: Math.min(1, Math.max(0, Number(pointMatch[2]))),
        y: Math.min(1, Math.max(0, Number(pointMatch[3]))),
      });
    }
  }

  return data.points.length > 0 ? data : null;
}

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

function QuadrantChartFallback({ data, code }: { data: QuadrantData; code: string }) {
  const [showCode, setShowCode] = useState(false);
  const quadrantClass = "absolute flex items-center justify-center p-3 text-center text-xs font-semibold text-[var(--color-text-muted)]";

  return (
    <div className="my-3 rounded-lg border border-[var(--color-border)] overflow-hidden">
      <div className="flex items-center justify-between px-4 py-1.5 bg-[var(--color-bg)] border-b border-[var(--color-border)]">
        <span className="text-[11px] text-[var(--color-text-muted)] font-mono">quadrantChart</span>
        <button
          type="button"
          onClick={() => setShowCode((v) => !v)}
          className="text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
        >
          {showCode ? "图表" : "源码"}
        </button>
      </div>
      {showCode ? (
        <pre className="p-4 overflow-x-auto text-[13px] bg-[var(--color-bg)]"><code>{code}</code></pre>
      ) : (
        <div className="bg-[var(--color-bg)] p-4">
          {data.title && <div className="mb-3 text-center text-sm font-semibold text-[var(--color-text)]">{data.title}</div>}
          <div className="overflow-x-auto">
            <div className="relative mx-auto min-w-[520px] max-w-3xl">
              <div className="relative aspect-[1.45] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
                <div className={`${quadrantClass} left-1/2 top-0 h-1/2 w-1/2 bg-[var(--color-success-bg)]`}>{data.quadrants[1]}</div>
                <div className={`${quadrantClass} left-0 top-0 h-1/2 w-1/2 bg-[var(--color-accent-alpha)]`}>{data.quadrants[2]}</div>
                <div className={`${quadrantClass} left-0 top-1/2 h-1/2 w-1/2 bg-[var(--color-warning-bg)]`}>{data.quadrants[3]}</div>
                <div className={`${quadrantClass} left-1/2 top-1/2 h-1/2 w-1/2 bg-[var(--color-error-bg)]`}>{data.quadrants[4]}</div>
                <div className="absolute left-1/2 top-0 h-full w-px bg-[var(--color-border)]" />
                <div className="absolute left-0 top-1/2 h-px w-full bg-[var(--color-border)]" />
                {data.points.map((point) => (
                  <div
                    key={`${point.label}-${point.x}-${point.y}`}
                    className="absolute z-10 flex items-center gap-1.5 -translate-x-1.5 -translate-y-1/2"
                    style={{ left: `${point.x * 100}%`, top: `${(1 - point.y) * 100}%` }}
                    title={`${point.label}: [${point.x}, ${point.y}]`}
                  >
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--color-accent)] ring-2 ring-[var(--color-bg)]" />
                    <span className="max-w-24 truncate rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 text-[11px] leading-tight text-[var(--color-text)] shadow-sm">
                      {point.label}
                    </span>
                  </div>
                ))}
              </div>
              <div className="mt-2 flex justify-between text-[11px] text-[var(--color-text-muted)]">
                <span>{data.xLeft}</span>
                <span>{data.xRight}</span>
              </div>
              <div className="pointer-events-none absolute -left-3 top-0 flex h-[calc(100%-1.35rem)] -translate-x-full flex-col justify-between text-[11px] text-[var(--color-text-muted)]">
                <span>{data.yTop}</span>
                <span>{data.yBottom}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
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
    const quadrantData = parseQuadrantChart(cleaned);
    if (quadrantData) {
      return <QuadrantChartFallback data={quadrantData} code={cleaned} />;
    }

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

function RichTable({
  rows,
  renderMarkdown,
}: {
  rows: LooseTableRow[];
  renderMarkdown: (content: string, key: string) => React.ReactNode;
}) {
  const hasHeader = rows[0]?.some((cell) => cell.tag === "th") ?? false;
  const bodyRows = hasHeader ? rows.slice(1) : rows;

  if (rows.length === 0) return null;

  return (
    <div className="overflow-x-auto my-3 rounded-lg border border-[var(--color-border)]">
      <table className="w-full text-sm border-collapse">
        {hasHeader && (
          <thead className="bg-[var(--color-surface-hover)]">
            <tr className="divide-x divide-[var(--color-border)]">
              {rows[0].map((cell, index) => (
                <th key={`head-${index}`} className="px-4 py-2 text-left font-semibold text-[var(--color-text)] whitespace-nowrap">
                  {renderMarkdown(cell.content, `head-${index}`)}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody className="divide-y divide-[var(--color-border)]">
          {bodyRows.map((row, rowIndex) => (
            <tr key={`row-${rowIndex}`} className="divide-x divide-[var(--color-border)]">
              {row.map((cell, cellIndex) => (
                <td key={`cell-${rowIndex}-${cellIndex}`} className="px-4 py-2 text-[var(--color-text)] align-top">
                  {renderMarkdown(cell.content, `cell-${rowIndex}-${cellIndex}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function gridColumnClass(cols: number): string {
  if (cols >= 4) return "md:grid-cols-2 xl:grid-cols-4";
  if (cols === 3) return "md:grid-cols-3";
  if (cols === 2) return "md:grid-cols-2";
  return "grid-cols-1";
}

function RichGrid({
  cols,
  columns,
  renderBlocks,
}: {
  cols: number;
  columns: LooseGridColumn[];
  renderBlocks: (content: string, keyPrefix: string) => React.ReactNode;
}) {
  if (columns.length === 0) return null;

  return (
    <div className={`my-3 grid grid-cols-1 gap-3 ${gridColumnClass(cols)}`}>
      {columns.map((column, index) => (
        <div
          key={`column-${index}`}
          className="min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4"
          style={column.width ? { flexBasis: `${column.width}%` } : undefined}
        >
          {renderBlocks(column.content, `grid-${index}`)}
        </div>
      ))}
    </div>
  );
}

function calloutClass(tone: CalloutTone): string {
  if (tone === "warning") return "border-[var(--color-warning-border)] bg-[var(--color-warning-bg)]";
  if (tone === "success") return "border-[var(--color-success-border)] bg-[var(--color-success-bg)]";
  if (tone === "error") return "border-red-400/50 bg-[var(--color-error-bg)]";
  if (tone === "info") return "border-[var(--color-accent)] bg-[var(--color-accent-alpha)]";
  return "border-[var(--color-border)] bg-[var(--color-surface-hover)]";
}

function RichCallout({
  emoji,
  tone,
  content,
  renderBlocks,
}: {
  emoji: string;
  tone: CalloutTone;
  content: string;
  renderBlocks: (content: string, keyPrefix: string) => React.ReactNode;
}) {
  return (
    <div className={`my-3 flex gap-3 rounded-lg border px-4 py-3 ${calloutClass(tone)}`}>
      <span className="mt-0.5 shrink-0 text-base leading-none">{emoji}</span>
      <div className="min-w-0 flex-1">{renderBlocks(content, "callout")}</div>
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

  const looseBlocks = useMemo(() => parseLooseMarkdownBlocks(children), [children]);

  const renderMarkdownFragment = (content: string, key: string, normalizeInlineHtml = true) => (
    <ReactMarkdown
      key={key}
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={components}
      urlTransform={(url) => url}
    >
      {normalizeInlineHtml ? normalizeLooseMarkup(content) : content}
    </ReactMarkdown>
  );

  const renderLooseBlocks = (blocks: LooseMarkdownBlock[], keyPrefix: string): React.ReactNode => blocks.map((block, index) => {
    const key = `${keyPrefix}-${index}`;
    if (block.type === "markdown") {
      return renderMarkdownFragment(block.content, key, block.normalizeInlineHtml);
    }
    if (block.type === "table") {
      return <RichTable key={key} rows={block.rows} renderMarkdown={(content, cellKey) => renderMarkdownFragment(content, `${key}-${cellKey}`)} />;
    }
    if (block.type === "grid") {
      return (
        <RichGrid
          key={key}
          cols={block.cols}
          columns={block.columns}
          renderBlocks={(content, childPrefix) => renderLooseBlocks(parseLooseMarkdownBlocks(content), `${key}-${childPrefix}`)}
        />
      );
    }
    return (
      <RichCallout
        key={key}
        emoji={block.emoji}
        tone={block.tone}
        content={block.content}
        renderBlocks={(content, childPrefix) => renderLooseBlocks(parseLooseMarkdownBlocks(content), `${key}-${childPrefix}`)}
      />
    );
  });

  return (
    <div
      className={["markdown-content", "break-words", "text-[var(--color-text)]", "text-sm", "leading-relaxed", shareCls, className].filter(Boolean).join(" ")}
    >
      {renderLooseBlocks(looseBlocks, "root")}
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
