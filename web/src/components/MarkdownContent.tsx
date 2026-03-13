import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { useState } from "react";

interface Props {
  children: string;
  className?: string;
  transformImageUrl?: (src: string) => string;
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

function CodeBlock({ className, children }: { className?: string; children: React.ReactNode }) {
  const text = typeof children === "string" ? children : String(children ?? "");
  const lang = className?.match(/language-([\w-]+)/)?.[1] ?? "";
  return (
    <div className="relative group my-3">
      {lang && (
        <div className="flex items-center justify-between px-4 py-1.5 rounded-t-lg bg-[var(--color-bg)] border border-b-0 border-[var(--color-border)]">
          <span className="text-[11px] text-[var(--color-text-muted)] font-mono">{lang}</span>
        </div>
      )}
      <pre className={`${lang ? "rounded-b-lg rounded-t-none" : "rounded-lg"} overflow-x-auto border border-[var(--color-border)] bg-[var(--color-bg)] p-4 text-[13px] leading-relaxed`}>
        <code className={className}>{children}</code>
      </pre>
      <CopyButton text={text.replace(/\n$/, "")} />
    </div>
  );
}

export default function MarkdownContent({ children, className = "", transformImageUrl }: Props) {
  return (
    <div className={`markdown-content break-words text-[var(--color-text)] text-sm leading-relaxed ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,

          h1: ({ children }) => <h1 className="text-xl font-bold mt-6 mb-3 first:mt-0 pb-1 border-b border-[var(--color-border)]">{children}</h1>,
          h2: ({ children }) => <h2 className="text-lg font-semibold mt-5 mb-2 first:mt-0 pb-1 border-b border-[var(--color-border)]">{children}</h2>,
          h3: ({ children }) => <h3 className="text-base font-semibold mt-4 mb-2 first:mt-0">{children}</h3>,
          h4: ({ children }) => <h4 className="text-sm font-semibold mt-3 mb-1 first:mt-0">{children}</h4>,

          ul: ({ children }) => <ul className="mb-3 space-y-1 list-disc pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="mb-3 space-y-1 list-decimal pl-5">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,

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
            return <CodeBlock className={codeClass} {...props}>{codeChildren}</CodeBlock>;
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
