import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, extname } from "path";
import type { AgentAsset } from "./types.js";

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

  // Build a shallow directory tree (max 3 levels, max 100 entries)
  const tree = buildDirTree(uri, 3, 100);
  const readmePath = findReadme(uri);
  let readmeSnippet = "";
  if (readmePath) {
    const content = readFileSync(readmePath, "utf-8");
    readmeSnippet = `\n\nREADME:\n${content.slice(0, 500)}${content.length > 500 ? "\n..." : ""}`;
  }

  return {
    assetId: asset.id,
    type: "repo",
    name: asset.name,
    contextSnippet: `[repo] ${asset.name}: ${uri}\n${asset.description ?? ""}\n\nStructure:\n${tree}${readmeSnippet}`,
  };
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
  return {
    assetId: asset.id,
    type: "mcp_server",
    name: asset.name,
    contextSnippet: `[mcp_server] ${asset.name}: ${asset.uri}\n${asset.description ?? ""}`,
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

function findReadme(dir: string): string | null {
  const names = ["README.md", "readme.md", "README", "README.txt"];
  for (const name of names) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}
