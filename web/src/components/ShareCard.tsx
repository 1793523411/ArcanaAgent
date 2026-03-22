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

    const bgGradient = isLight
      ? "linear-gradient(135deg, #f8fafc 0%, #ffffff 45%, #f1f5f9 100%)"
      : "linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%)";
    const titleColor = isLight ? "#64748b" : "#94a3b8";
    const headingColor = isLight ? "#0f172a" : "#f1f5f9";
    const bodyColor = isLight ? "#334155" : "#e2e8f0";
    const divider = isLight ? "rgba(226, 232, 240, 0.95)" : "rgba(51, 65, 85, 0.6)";
    const logoIconColor = "#fff";

    /** Short answers look top-heavy; min-height + flex centers body between header and footer. */
    const cardMinHeight = 580;

    return (
      <div
        ref={ref}
        className={isLight ? "share-card-hljs-light" : undefined}
        style={{
          display: "flex",
          flexDirection: "column",
          width: 560,
          minHeight: cardMinHeight,
          padding: "32px 32px 36px",
          background: bgGradient,
          borderRadius: 20,
          fontFamily: "'DM Sans', ui-sans-serif, system-ui, sans-serif",
          color: isLight ? "#0f172a" : "#f1f5f9",
          boxShadow: isLight ? "0 1px 3px rgba(15, 23, 42, 0.06)" : undefined,
          boxSizing: "border-box",
          ...(isLight ? lightVars : darkVars),
        } as React.CSSProperties}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            minHeight: 36,
            marginBottom: 20,
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 36 }}>
            <div
              style={{
                width: 32,
                height: 32,
                flexShrink: 0,
                borderRadius: 10,
                background: isLight
                  ? "linear-gradient(135deg, #0d9488, #115e59)"
                  : "linear-gradient(135deg, #14b8a6, #0d9488)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 15,
                fontWeight: 700,
                lineHeight: 1,
                color: logoIconColor,
              }}
            >
              A
            </div>
            <span
              style={{
                fontSize: 16,
                fontWeight: 600,
                lineHeight: "32px",
                color: headingColor,
              }}
            >
              ArcanaAgent
            </span>
          </div>
          <span
            style={{
              fontSize: 12,
              lineHeight: "32px",
              color: titleColor,
              whiteSpace: "nowrap",
            }}
          >
            {dateStr}
          </span>
        </div>

        {title && (
          <div
            style={{
              fontSize: 13,
              color: titleColor,
              marginBottom: 12,
              paddingBottom: 12,
              borderBottom: `1px solid ${divider}`,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            {title}
          </div>
        )}

        <div
          style={{
            flex: "1 1 auto",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            fontSize: 14,
            lineHeight: 1.7,
            color: bodyColor,
          }}
        >
          <MarkdownContent variant="share">{content}</MarkdownContent>
        </div>

        <div
          style={{
            marginTop: 18,
            paddingTop: 12,
            paddingBottom: 12,
            borderTop: `1px solid ${divider}`,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            flexShrink: 0,
          }}
        >
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span
              aria-hidden
              style={{
                display: "inline-block",
                width: 6,
                height: 6,
                flexShrink: 0,
                borderRadius: "50%",
                background: isLight ? "#0d9488" : "#14b8a6",
              }}
            />
            <span
              style={{
                fontSize: 11,
                lineHeight: 1.35,
                color: "#64748b",
              }}
            >
              Powered by ArcanaAgent
            </span>
          </div>
          {modelName && (
            <span
              style={{
                fontSize: 11,
                lineHeight: 1.35,
                color: "#64748b",
                textAlign: "right",
                wordBreak: "break-all",
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
