import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, extname } from "path";
import type { AgentAsset } from "./types.js";
import { getMcpStatus } from "../mcp/client.js";

interface ResolvedAssetContext {
  assetId: string;
  type: AgentAsset["type"];
  name: string;
  contextSnippet: string;
}

/**
 * Resolve assets into context snippets that can be injected into an agent's prompt.
 * Each asset type produces a different kind of context:
 * - repo: directory tree summary + key file listing
 * - document: file content (truncated)
 * - api: spec/description
 * - database: connection info (masked)
 * - prompt: template content
 * - config: config content
 * - mcp_server: endpoint info
 * - custom: description only
 */
export function resolveAssetContext(assets: AgentAsset[]): ResolvedAssetContext[] {
  const results: ResolvedAssetContext[] = [];

  for (const asset of assets) {
    try {
      const ctx = resolveOne(asset);
      if (ctx) results.push(ctx);
    } catch {
      // Skip unresolvable assets
      results.push({
        assetId: asset.id,
        type: asset.type,
        name: asset.name,
        contextSnippet: `[${asset.type}] ${asset.name}: ${asset.description ?? asset.uri} (unable to resolve)`,
      });
    }
  }

  return results;
}

function resolveOne(asset: AgentAsset): ResolvedAssetContext | null {
  switch (asset.type) {
    case "repo":
      return resolveRepo(asset);
    case "document":
      return resolveDocument(asset);
    case "api":
      return resolveApi(asset);
    case "database":
      return resolveDatabase(asset);
    case "prompt":
      return resolvePrompt(asset);
    case "config":
      return resolveConfig(asset);
    case "mcp_server":
      return resolveMcpServer(asset);
    case "custom":
      return resolveCustom(asset);
    default:
      return null;
  }
}

/** Files a repo almost always has that encode its *conventions* or
 *  *runtime shape*. Sampled in priority order until the total budget is
 *  exhausted — giving the agent a genuine chance to understand the repo
 *  rather than only its README first page. */
const REPO_KEY_FILES = [
  "README.md",
  "readme.md",
  "README",
  "README.txt",
  "CLAUDE.md",        // this project's convention file
  "AGENTS.md",
  "CONTRIBUTING.md",
  "package.json",     // Node — also dependency fingerprint
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",       // Rust
  "go.mod",           // Go
  "pom.xml",          // Maven
  "build.gradle",
  "tsconfig.json",
  "tsconfig.base.json",
];

const REPO_PER_FILE_CHARS = 1500;
const REPO_TOTAL_CHARS = 9000;

function resolveRepo(asset: AgentAsset): ResolvedAssetContext {
  const uri = asset.uri;
  if (!existsSync(uri)) {
    return {
      assetId: asset.id,
      type: "repo",
      name: asset.name,
      contextSnippet: `[repo] ${asset.name}: ${uri}\n${asset.description ?? ""}`,
    };
  }

  // Deeper tree + wider entry budget than the previous 3/100 limits — a real
  // repo's "what's in it" picture needs to reach past top-level folders.
  const tree = buildDirTree(uri, 4, 200);
  const keyFiles = collectKeyFiles(uri);

  const parts: string[] = [`[repo] ${asset.name}: ${uri}`];
  if (asset.description) parts.push(asset.description);
  parts.push("", "Structure:", tree);
  for (const kf of keyFiles) {
    parts.push("", `${kf.label}:`, kf.content);
  }
  return {
    assetId: asset.id,
    type: "repo",
    name: asset.name,
    contextSnippet: parts.join("\n"),
  };
}

/** Scan REPO_KEY_FILES in priority order, collecting `{label, content}` up
 *  to per-file and total budgets. Skips unreadable files silently so a
 *  permission error on one file doesn't kill the whole resolution. */
function collectKeyFiles(repoRoot: string): Array<{ label: string; content: string }> {
  const out: Array<{ label: string; content: string }> = [];
  let used = 0;
  const seen = new Set<string>(); // case-insensitive dedup (README.md vs readme.md)
  for (const name of REPO_KEY_FILES) {
    if (used >= REPO_TOTAL_CHARS) break;
    const lower = name.toLowerCase();
    if (seen.has(lower)) continue;
    const path = join(repoRoot, name);
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, "utf-8");
      const budget = Math.min(REPO_PER_FILE_CHARS, REPO_TOTAL_CHARS - used);
      const snippet = raw.length > budget ? raw.slice(0, budget) + "\n... (truncated)" : raw;
      out.push({ label: name, content: snippet });
      used += snippet.length;
      seen.add(lower);
    } catch {
      // unreadable (perm / binary / EACCES) — skip
    }
  }
  return out;
}

function resolveDocument(asset: AgentAsset): ResolvedAssetContext {
  const uri = asset.uri;
  let content = "";

  if (existsSync(uri)) {
    const raw = readFileSync(uri, "utf-8");
    content = raw.slice(0, 8192);
    if (raw.length > 8192) content += "\n... (truncated)";
  } else {
    content = `URL: ${uri}`;
  }

  return {
    assetId: asset.id,
    type: "document",
    name: asset.name,
    contextSnippet: `[document] ${asset.name}\n${asset.description ?? ""}\n\n${content}`,
  };
}

function resolveApi(asset: AgentAsset): ResolvedAssetContext {
  const meta = asset.metadata ?? {};
  const spec = meta.spec ? `\nSpec: ${JSON.stringify(meta.spec).slice(0, 1000)}` : "";
  return {
    assetId: asset.id,
    type: "api",
    name: asset.name,
    contextSnippet: `[api] ${asset.name}: ${asset.uri}\n${asset.description ?? ""}${spec}`,
  };
}

function resolveDatabase(asset: AgentAsset): ResolvedAssetContext {
  // Mask credentials in connection string
  const masked = asset.uri.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:****@");
  return {
    assetId: asset.id,
    type: "database",
    name: asset.name,
    contextSnippet: `[database] ${asset.name}: ${masked}\n${asset.description ?? ""}\nNote: Database access requires approval.`,
  };
}

function resolvePrompt(asset: AgentAsset): ResolvedAssetContext {
  let content = "";
  if (existsSync(asset.uri)) {
    const raw = readFileSync(asset.uri, "utf-8");
    content = raw.slice(0, 1500);
    if (raw.length > 1500) content += "\n... (truncated)";
  }
  return {
    assetId: asset.id,
    type: "prompt",
    name: asset.name,
    contextSnippet: `[prompt template] ${asset.name}\n${content}`,
  };
}

function resolveConfig(asset: AgentAsset): ResolvedAssetContext {
  let content = "";
  if (existsSync(asset.uri)) {
    const raw = readFileSync(asset.uri, "utf-8");
    content = raw.slice(0, 1000);
    if (raw.length > 1000) content += "\n... (truncated)";
  }
  return {
    assetId: asset.id,
    type: "config",
    name: asset.name,
    contextSnippet: `[config] ${asset.name}: ${asset.uri}\n${content}`,
  };
}

function resolveMcpServer(asset: AgentAsset): ResolvedAssetContext {
  // Look up runtime MCP state by name (case-insensitive). If the server is
  // already connected at startup we enrich the prompt with the actual tool
  // names/descriptions so the agent knows what it can actually call — closes
  // the gap where mcp_server assets previously produced only metadata text
  // and the agent had to guess whether anything useful was available.
  let statuses: ReturnType<typeof getMcpStatus> = [];
  try {
    statuses = getMcpStatus();
  } catch {
    // MCP not initialized (e.g. early startup / tests) — fall through to
    // the legacy "metadata-only" snippet so asset resolution never crashes.
  }
  const needle = asset.name.toLowerCase();
  const match = statuses.find((s) => s.name.toLowerCase() === needle);

  if (match?.connected) {
    const lines: string[] = [
      `[mcp_server] ${asset.name}: ${asset.uri} (已连接，暴露 ${match.toolCount} 个工具)`,
    ];
    if (asset.description) lines.push(asset.description);
    if (match.tools && match.tools.length > 0) {
      lines.push("可用工具：");
      for (const t of match.tools) {
        lines.push(`  - ${t.name}: ${t.description}`);
      }
    }
    return { assetId: asset.id, type: "mcp_server", name: asset.name, contextSnippet: lines.join("\n") };
  }

  if (match && !match.connected) {
    // Configured but failed to connect — tell the agent not to try these tools.
    const errHint = match.error ? ` (${match.error})` : "";
    return {
      assetId: asset.id,
      type: "mcp_server",
      name: asset.name,
      contextSnippet:
        `[mcp_server] ${asset.name}: ${asset.uri}\n` +
        `⚠ 未连接${errHint} — 此资产声明的工具当前不可用\n${asset.description ?? ""}`,
    };
  }

  // No configured MCP server with this name — the asset is aspirational
  // (user listed it but never wired it into user config). Keep a clear hint
  // rather than silently pretending it's usable.
  return {
    assetId: asset.id,
    type: "mcp_server",
    name: asset.name,
    contextSnippet:
      `[mcp_server] ${asset.name}: ${asset.uri}\n` +
      `⚠ 此 MCP 服务器未在用户配置中注册 — 请在设置中添加后再重启\n${asset.description ?? ""}`,
  };
}

function resolveCustom(asset: AgentAsset): ResolvedAssetContext {
  return {
    assetId: asset.id,
    type: "custom",
    name: asset.name,
    contextSnippet: `[custom] ${asset.name}: ${asset.uri}\n${asset.description ?? ""}`,
  };
}

// ─── Helpers ───────────────────────────────────────────────────

function buildDirTree(dir: string, maxDepth: number, maxEntries: number, depth = 0): string {
  if (depth >= maxDepth) return "";
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return "";
  }

  const indent = "  ".repeat(depth);
  const lines: string[] = [];
  let count = 0;

  // Filter out common noise
  const filtered = entries.filter(
    (e) => !e.startsWith(".") && e !== "node_modules" && e !== "__pycache__" && e !== "dist" && e !== "build"
  );

  for (const entry of filtered) {
    if (count >= maxEntries) {
      lines.push(`${indent}  ... (${filtered.length - count} more)`);
      break;
    }
    const full = join(dir, entry);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) {
        lines.push(`${indent}${entry}/`);
        const sub = buildDirTree(full, maxDepth, maxEntries - count, depth + 1);
        if (sub) lines.push(sub);
      } else {
        lines.push(`${indent}${entry}`);
      }
      count++;
    } catch {
      // skip
    }
  }

  return lines.join("\n");
}

