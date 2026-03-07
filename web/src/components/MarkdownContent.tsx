import ReactMarkdown from "react-markdown";

const proseClasses = {
  p: "mb-2 last:mb-0",
  h1: "text-xl font-bold mt-4 mb-2 first:mt-0 text-[var(--color-text)]",
  h2: "text-lg font-semibold mt-4 mb-2 first:mt-0 text-[var(--color-text)]",
  h3: "text-base font-semibold mt-3 mb-1.5 first:mt-0 text-[var(--color-text)]",
  ul: "list-disc list-inside mb-2 space-y-0.5",
  ol: "list-decimal list-inside mb-2 space-y-0.5",
  li: "text-[var(--color-text)]",
  strong: "font-semibold text-[var(--color-text)]",
  code: "px-1.5 py-0.5 rounded bg-[var(--color-surface-hover)] text-[var(--color-text)] text-[0.9em] font-mono",
  pre: "p-3 rounded-lg bg-[var(--color-surface-hover)] overflow-x-auto mb-2 text-sm",
  blockquote: "border-l-2 border-[var(--color-border)] pl-3 my-2 text-[var(--color-text-muted)]",
  a: "text-[var(--color-accent)] hover:underline",
};

interface Props {
  children: string;
  className?: string;
}

export default function MarkdownContent({ children, className = "" }: Props) {
  return (
    <div className={`markdown-content break-words ${className}`}>
      <ReactMarkdown
        components={{
          p: ({ children }) => <p className={proseClasses.p}>{children}</p>,
          h1: ({ children }) => <h1 className={proseClasses.h1}>{children}</h1>,
          h2: ({ children }) => <h2 className={proseClasses.h2}>{children}</h2>,
          h3: ({ children }) => <h3 className={proseClasses.h3}>{children}</h3>,
          ul: ({ children }) => <ul className={proseClasses.ul}>{children}</ul>,
          ol: ({ children }) => <ol className={proseClasses.ol}>{children}</ol>,
          li: ({ children }) => <li className={proseClasses.li}>{children}</li>,
          strong: ({ children }) => <strong className={proseClasses.strong}>{children}</strong>,
          code: ({ className: c, ...props }) =>
            c ? (
              <code className={`${proseClasses.code} ${c}`} {...props} />
            ) : (
              <code className={proseClasses.code} {...props} />
            ),
          pre: ({ children }) => <pre className={proseClasses.pre}>{children}</pre>,
          blockquote: ({ children }) => <blockquote className={proseClasses.blockquote}>{children}</blockquote>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className={proseClasses.a}>
              {children}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
