/**
 * Lightweight SVG chevron for collapse / expand affordances. Replaces the
 * unicode triangles (▲ ▼ ◀ ▶) which read as dated ASCII-art on modern
 * displays. Stroke pulls from currentColor so callers control color via
 * `style.color`.
 */
type Direction = "up" | "down" | "left" | "right";

const PATH: Record<Direction, string> = {
  up: "M18 15l-6-6-6 6",
  down: "M6 9l6 6 6-6",
  left: "M15 18l-6-6 6-6",
  right: "M9 18l6-6-6-6",
};

export default function Chevron({
  direction,
  size = 14,
  strokeWidth = 2,
  className,
}: {
  direction: Direction;
  size?: number;
  strokeWidth?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d={PATH[direction]} />
    </svg>
  );
}
