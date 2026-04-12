import type { TaskHandoffArtifact } from "./types.js";

export interface ParsedHandoff {
  summary: string;
  artifacts: TaskHandoffArtifact[];
  inputsConsumed?: string[];
  openQuestions?: string[];
}

const FENCE_RE = /```handoff\s*([\s\S]*?)```/i;

/**
 * Extract a `handoff` JSON block from an agent's final output. The agent is
 * instructed (via buildGuildAgentPrompt) to wrap the block in ```handoff ...```.
 * If the fence is missing or the JSON is malformed, we fall back to a minimal
 * handoff containing the full text as summary so downstream still sees *something*.
 */
export function parseHandoffFromSummary(raw: string): ParsedHandoff | null {
  if (!raw || raw.trim().length === 0) return null;

  const match = raw.match(FENCE_RE);
  const jsonStr = match ? match[1].trim() : extractBareJson(raw);
  if (!jsonStr) {
    return {
      summary: compact(raw),
      artifacts: [],
    };
  }

  try {
    const parsed = JSON.parse(jsonStr);
    if (typeof parsed !== "object" || parsed === null) {
      return { summary: compact(raw), artifacts: [] };
    }
    const p = parsed as Record<string, unknown>;
    const summary = typeof p.summary === "string" && p.summary.trim()
      ? p.summary.trim()
      : compact(raw);
    const artifacts = Array.isArray(p.artifacts)
      ? (p.artifacts as unknown[]).filter(isArtifact)
      : [];
    const inputsConsumed = Array.isArray(p.inputsConsumed)
      ? (p.inputsConsumed as unknown[]).filter((x): x is string => typeof x === "string")
      : undefined;
    const openQuestions = Array.isArray(p.openQuestions)
      ? (p.openQuestions as unknown[]).filter((x): x is string => typeof x === "string")
      : undefined;
    return { summary, artifacts, inputsConsumed, openQuestions };
  } catch {
    return { summary: compact(raw), artifacts: [] };
  }
}

function isArtifact(v: unknown): v is TaskHandoffArtifact {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    (o.kind === "commit" || o.kind === "file" || o.kind === "url" || o.kind === "note") &&
    typeof o.ref === "string"
  );
}

function extractBareJson(raw: string): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) return null;
  const candidate = raw.slice(start, end + 1);
  if (!/\bsummary\b/.test(candidate)) return null;
  return candidate;
}

function compact(s: string): string {
  const trimmed = s.replace(/\s+/g, " ").trim();
  return trimmed.length > 400 ? `${trimmed.slice(0, 400)}…` : trimmed;
}
