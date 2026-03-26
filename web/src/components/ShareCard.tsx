import { forwardRef } from "react";
import MarkdownContent from "./MarkdownContent";
import "../share-card-github-light.css";

interface Props {
  theme: "light" | "dark";
  content: string;
  title: string;
  modelName?: string;
  createdAt?: string;
}

const darkVars: Record<string, string> = {
  "--color-bg": "#0f172a",
  "--color-surface": "#1e293b",
  "--color-surface-hover": "#334155",
  "--color-border": "#334155",
  "--color-text": "#f1f5f9",
  "--color-text-muted": "#94a3b8",
  "--color-accent": "#14b8a6",
  "--color-accent-hover": "#2dd4bf",
};

const lightVars: Record<string, string> = {
  "--color-bg": "#f8fafc",
  "--color-surface": "#ffffff",
  "--color-surface-hover": "#f1f5f9",
  "--color-border": "#e2e8f0",
  "--color-text": "#0f172a",
  "--color-text-muted": "#64748b",
  "--color-accent": "#0d9488",
  "--color-accent-hover": "#0f766e",
};

const ShareCard = forwardRef<HTMLDivElement, Props>(
  ({ theme, content, title, modelName, createdAt }, ref) => {
    const isLight = theme === "light";
    const dateStr = createdAt
      ? new Date(createdAt).toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" })
      : new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });

    const vars = isLight ? lightVars : darkVars;
    const titleColor = isLight ? "#94a3b8" : "#64748b";
    const headingColor = isLight ? "#0f172a" : "#f1f5f9";
    const bodyColor = isLight ? "#334155" : "#cbd5e1";
    const divider = isLight ? "#e2e8f0" : "#1e293b";
    const accentColor = isLight ? "#0d9488" : "#14b8a6";

    return (
      <div
        ref={ref}
        className={isLight ? "share-card-hljs-light share-card-root" : "share-card-root"}
        style={{
          display: "flex",
          flexDirection: "column",
          width: 560,
          minHeight: 420,
          padding: "36px 36px 28px",
          background: isLight
            ? "linear-gradient(180deg, #ffffff 0%, #f8fafc 100%)"
            : "linear-gradient(180deg, #0f172a 0%, #1a2332 100%)",
          borderRadius: 16,
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif",
          color: isLight ? "#0f172a" : "#f1f5f9",
          boxSizing: "border-box",
          ...vars,
        } as React.CSSProperties}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: title ? 16 : 24,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: 7,
                background: `linear-gradient(135deg, ${accentColor}, ${isLight ? "#115e59" : "#0d9488"})`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 13,
                fontWeight: 700,
                color: "#fff",
                letterSpacing: 0,
              }}
            >
              A
            </div>
            <span
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: headingColor,
                letterSpacing: "-0.01em",
              }}
            >
              ArcanaAgent
            </span>
          </div>
          <span
            style={{
              fontSize: 11,
              color: titleColor,
            }}
          >
            {dateStr}
          </span>
        </div>

        {title && (
          <div
            style={{
              fontSize: 12,
              color: isLight ? "#64748b" : "#94a3b8",
              marginBottom: 20,
              paddingBottom: 16,
              borderBottom: `1px solid ${divider}`,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              letterSpacing: "0.01em",
            }}
          >
            {title}
          </div>
        )}

        {/* Content */}
        <div
          style={{
            flex: "1 1 auto",
            fontSize: 13.5,
            lineHeight: 1.8,
            color: bodyColor,
          }}
        >
          <MarkdownContent variant="share">{content}</MarkdownContent>
        </div>

        {/* Footer */}
        <div
          style={{
            marginTop: 28,
            paddingTop: 14,
            borderTop: `1px solid ${divider}`,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span
              aria-hidden
              style={{
                display: "inline-block",
                width: 5,
                height: 5,
                borderRadius: "50%",
                background: accentColor,
              }}
            />
            <span
              style={{
                fontSize: 10,
                color: titleColor,
                letterSpacing: "0.02em",
              }}
            >
              Powered by ArcanaAgent
            </span>
          </div>
          {modelName && (
            <span
              style={{
                fontSize: 10,
                color: titleColor,
                textAlign: "right",
                wordBreak: "break-all",
                letterSpacing: "0.01em",
              }}
            >
              {modelName}
            </span>
          )}
        </div>
      </div>
    );
  }
);

ShareCard.displayName = "ShareCard";

export default ShareCard;
