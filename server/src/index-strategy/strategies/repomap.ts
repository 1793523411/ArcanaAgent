import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, relative, extname } from "path";
import type { IndexStrategy, IndexStatus, SearchResult, SearchOptions } from "../types.js";

// Dynamic imports for optional dependencies
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ParserClass: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let LanguageClass: any = null;
let tsWasmPath: string | null = null;
let jsWasmPath: string | null = null;

interface PagerankInstance {
  link(source: string, target: string, weight?: number): void;
  rank(alpha: number, epsilon: number, callback: (node: string, rank: number) => void): void;
  reset(): void;
}

let pagerankInstance: PagerankInstance | null = null;

async function loadDependencies(): Promise<boolean> {
  try {
    const TreeSitter = await import("web-tree-sitter");
    // web-tree-sitter exports { Parser, Language, ... } — no default export
    ParserClass = TreeSitter.Parser ?? TreeSitter.default;
    LanguageClass = TreeSitter.Language ?? null;
    if (!ParserClass) {
      return false;
    }
    await ParserClass.init();

    // Locate WASM files from tree-sitter-typescript package
    const { createRequire } = await import("module");
    const require = createRequire(import.meta.url);
    const { join: joinPath, dirname } = await import("path");
    const { existsSync } = await import("fs");

    // Use package.json to reliably find the package root
    const tsPkgJson = require.resolve("tree-sitter-typescript/package.json");
    const tsPkgDir = dirname(tsPkgJson);
    const tsWasm = joinPath(tsPkgDir, "tree-sitter-typescript.wasm");

    let jsWasmFinal: string | null = null;
    try {
      const jsPkgJson = require.resolve("tree-sitter-javascript/package.json");
      const jsPkgDir = dirname(jsPkgJson);
      const jsWasm = joinPath(jsPkgDir, "tree-sitter-javascript.wasm");
      if (existsSync(jsWasm)) jsWasmFinal = jsWasm;
    } catch { /* no JS wasm available */ }

    tsWasmPath = existsSync(tsWasm) ? tsWasm : null;
    jsWasmPath = jsWasmFinal;

    const pr = await import("pagerank.js");
    pagerankInstance = ((pr as Record<string, unknown>).default ?? pr) as PagerankInstance;
    return true;
  } catch {
    return false;
  }
}

const NOISE_DIRS = new Set([
  "node_modules", ".git", "__pycache__", ".next", ".nuxt",
  "dist", "build", ".agents", ".venv", "venv", "vendor",
  "target", ".cache", "coverage",
]);

const SUPPORTED_EXTENSIONS: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
};

interface SymbolDef {
  name: string;
  type: "function" | "class" | "interface" | "type" | "constant" | "method" | "export";
  line: number;
  rank: number;
}

interface FileIndex {
  mtime: number;
  symbols: SymbolDef[];
}

interface RepomapCache {
  version: number;
  createdAt: string;
  files: Record<string, FileIndex>;
  edges: Array<{ from: string; to: string; weight: number }>;
}

function getWasmPathForFile(ext: string): string | null {
  const lang = SUPPORTED_EXTENSIONS[ext];
  if (!lang) return null;
  switch (lang) {
    case "typescript": return tsWasmPath;
    case "javascript": return jsWasmPath;
    default: return null;
  }
}

function collectSourceFiles(
  currentPath: string,
  maxFiles: number,
  depth: number = 0,
): string[] {
  if (depth > 8) return [];
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(currentPath);
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.startsWith(".") || NOISE_DIRS.has(entry)) continue;
    if (results.length >= maxFiles) break;
    const fullPath = join(currentPath, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      const sub = collectSourceFiles(fullPath, maxFiles - results.length, depth + 1);
      results.push(...sub);
    } else {
      const ext = extname(entry).toLowerCase();
      if (SUPPORTED_EXTENSIONS[ext]) {
        results.push(fullPath);
      }
    }
    if (results.length >= maxFiles) break;
  }
  return results;
}

function extractSymbolsFromTree(tree: { rootNode: TreeNode }): SymbolDef[] {
  const symbols: SymbolDef[] = [];
  const visit = (node: TreeNode) => {
    const type = node.type;
    // TypeScript / JavaScript
    if (type === "function_declaration" || type === "function_definition") {
      const nameNode = node.childForFieldName?.("name");
      if (nameNode) {
        symbols.push({ name: nameNode.text, type: "function", line: node.startPosition.row + 1, rank: 0 });
      }
    } else if (type === "class_declaration" || type === "class_definition") {
      const nameNode = node.childForFieldName?.("name");
      if (nameNode) {
        symbols.push({ name: nameNode.text, type: "class", line: node.startPosition.row + 1, rank: 0 });
      }
    } else if (type === "interface_declaration") {
      const nameNode = node.childForFieldName?.("name");
      if (nameNode) {
        symbols.push({ name: nameNode.text, type: "interface", line: node.startPosition.row + 1, rank: 0 });
      }
    } else if (type === "type_alias_declaration") {
      const nameNode = node.childForFieldName?.("name");
      if (nameNode) {
        symbols.push({ name: nameNode.text, type: "type", line: node.startPosition.row + 1, rank: 0 });
      }
    } else if (type === "lexical_declaration" || type === "variable_declaration") {
      // const / let / var declarations
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child?.type === "variable_declarator") {
          const nameNode = child.childForFieldName?.("name");
          if (nameNode) {
            symbols.push({ name: nameNode.text, type: "constant", line: node.startPosition.row + 1, rank: 0 });
          }
        }
      }
    } else if (type === "export_statement") {
      // Recurse into exported declarations
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) visit(child);
      }
      return; // Don't recurse normally for export_statement
    } else if (type === "method_definition") {
      const nameNode = node.childForFieldName?.("name");
      if (nameNode) {
        symbols.push({ name: nameNode.text, type: "method", line: node.startPosition.row + 1, rank: 0 });
      }
    }
    // Recurse into children (but not too deep)
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) visit(child);
    }
  };
  visit(tree.rootNode);
  return symbols;
}

interface TreeNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  childCount: number;
  child(index: number): TreeNode | null;
  childForFieldName?(name: string): TreeNode | null;
}

function findSymbolReferences(
  content: string,
  allSymbolNames: Set<string>,
): string[] {
  const found: string[] = [];
  for (const name of allSymbolNames) {
    // Simple word boundary check
    if (content.includes(name)) {
      // Verify it's a word boundary match
      const regex = new RegExp(`\\b${name.replace(/[.*+?^${}()|\\[\]\\\\]/g, "\\$&")}\\b`);
      if (regex.test(content)) {
        found.push(name);
      }
    }
  }
  return found;
}

export class RepomapStrategy implements IndexStrategy {
  readonly type = "repomap" as const;
  private workspacePath: string = "";
  private cache: RepomapCache | null = null;
  private ready: boolean = false;
  private depsLoaded: boolean = false;
  private error?: string;

  /** Try to restore state from the on-disk cache without rebuilding.
   *  Called lazily on first getStatus / search when cache is null. */
  tryLoadFromDisk(workspacePath: string): boolean {
    if (this.cache) return true;
    const cachePath = join(workspacePath, ".agents", "index", "repomap.json");
    if (!existsSync(cachePath)) return false;
    try {
      const parsed = JSON.parse(readFileSync(cachePath, "utf-8")) as RepomapCache;
      if (parsed.version !== 1) return false;
      const fileCount = parsed.files ? Object.keys(parsed.files).length : 0;
      if (fileCount === 0) return false;
      this.cache = parsed;
      this.workspacePath = workspacePath;
      this.ready = true;
      this.error = undefined;
      return true;
    } catch {
      return false;
    }
  }

  async checkDependencies(): Promise<{ ready: boolean; missing: string[] }> {
    const missing: string[] = [];
    try {
      await import("web-tree-sitter");
    } catch { missing.push("web-tree-sitter"); }
    try {
      await import("tree-sitter-typescript");
    } catch { missing.push("tree-sitter-typescript"); }
    try {
      await import("pagerank.js");
    } catch { missing.push("pagerank.js"); }
    return { ready: missing.length === 0, missing };
  }

  async buildIndex(workspacePath: string): Promise<void> {
    this.workspacePath = workspacePath;
    if (!this.depsLoaded) {
      this.depsLoaded = await loadDependencies();
      if (!this.depsLoaded || !ParserClass) {
        this.error = "web-tree-sitter dependencies not available";
        this.ready = false;
        return;
      }
    }

    // Try to load cached index
    const cachePath = join(workspacePath, ".agents", "index", "repomap.json");
    let existingCache: RepomapCache | null = null;
    if (existsSync(cachePath)) {
      try {
        existingCache = JSON.parse(readFileSync(cachePath, "utf-8")) as RepomapCache;
        if (existingCache.version !== 1) existingCache = null;
      } catch {
        existingCache = null;
      }
    }

    const sourceFiles = collectSourceFiles(workspacePath, 3000);
    const parser = new ParserClass();
    // Cache loaded languages to avoid reloading WASM for each file
    const langCache = new Map<string, unknown>();
    const filesIndex: Record<string, FileIndex> = {};
    const symbolOwners: Map<string, Set<string>> = new Map(); // symbolName -> set of files
    const allSymbolNames: Set<string> = new Set();

    // Phase 1: Parse all files and extract symbols
    for (const fullPath of sourceFiles) {
      const relPath = relative(workspacePath, fullPath);
      const ext = extname(fullPath).toLowerCase();
      const wasmPath = getWasmPathForFile(ext);
      if (!wasmPath) continue;

      let mtime: number;
      try {
        mtime = statSync(fullPath).mtimeMs;
      } catch {
        continue;
      }

      // Check cache
      if (existingCache?.files[relPath] && existingCache.files[relPath].mtime === mtime) {
        filesIndex[relPath] = existingCache.files[relPath];
        for (const sym of existingCache.files[relPath].symbols) {
          if (!symbolOwners.has(sym.name)) symbolOwners.set(sym.name, new Set());
          symbolOwners.get(sym.name)!.add(relPath);
          allSymbolNames.add(sym.name);
        }
        continue;
      }

      let content: string;
      try {
        content = readFileSync(fullPath, "utf-8");
      } catch {
        continue;
      }

      try {
        let lang = langCache.get(wasmPath);
        if (!lang) {
          lang = await LanguageClass.load(wasmPath);
          langCache.set(wasmPath, lang);
        }
        parser.setLanguage(lang as Parameters<typeof parser.setLanguage>[0]);
        const tree = parser.parse(content);
        const symbols = extractSymbolsFromTree(tree);
        filesIndex[relPath] = { mtime, symbols };
        for (const sym of symbols) {
          if (!symbolOwners.has(sym.name)) symbolOwners.set(sym.name, new Set());
          symbolOwners.get(sym.name)!.add(relPath);
          allSymbolNames.add(sym.name);
        }
      } catch {
        // Parsing failed for this file, skip
        filesIndex[relPath] = { mtime, symbols: [] };
      }
    }

    // Phase 2: Build reference graph
    const edges: Array<{ from: string; to: string; weight: number }> = [];

    for (const fullPath of sourceFiles) {
      const relPath = relative(workspacePath, fullPath);
      if (!filesIndex[relPath]) continue;
      let content: string;
      try {
        content = readFileSync(fullPath, "utf-8");
      } catch {
        continue;
      }
      const refs = findSymbolReferences(content, allSymbolNames);
      const edgeWeights: Record<string, number> = {};
      for (const refName of refs) {
        const owners = symbolOwners.get(refName);
        if (!owners) continue;
        for (const owner of owners) {
          if (owner !== relPath) {
            edgeWeights[owner] = (edgeWeights[owner] ?? 0) + 1;
          }
        }
      }
      for (const [target, weight] of Object.entries(edgeWeights)) {
        edges.push({ from: relPath, to: target, weight });
      }
    }

    // Phase 3: Run PageRank
    if (pagerankInstance && edges.length > 0) {
      try {
        pagerankInstance.reset();
        for (const edge of edges) {
          pagerankInstance.link(edge.from, edge.to, edge.weight);
        }
        const ranks: Record<string, number> = {};
        pagerankInstance.rank(0.85, 0.0001, (node: string, rank: number) => {
          ranks[node] = rank;
        });
        // Apply ranks to symbols
        for (const [filePath, fileIndex] of Object.entries(filesIndex)) {
          const fileRank = ranks[filePath] ?? 0;
          for (const sym of fileIndex.symbols) {
            sym.rank = fileRank;
          }
        }
      } catch {
        // PageRank failed, leave ranks at 0
      }
    }

    this.cache = {
      version: 1,
      createdAt: new Date().toISOString(),
      files: filesIndex,
      edges,
    };
    this.ready = true;
    this.error = undefined;

    // Persist cache
    try {
      const cacheDir = join(workspacePath, ".agents", "index");
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(cachePath, JSON.stringify(this.cache, null, 2));
    } catch {
      // Non-critical
    }
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    if (!this.cache) return [];
    const maxResults = options?.maxResults ?? 10;
    const queryLower = query.toLowerCase();
    const results: SearchResult[] = [];

    // Search in symbols
    for (const [file, fileIndex] of Object.entries(this.cache.files)) {
      if (options?.fileGlob) {
        // Simple glob matching: escape regex special chars, then convert * to .*
        const escaped = options.fileGlob.replace(/[.+^${}()|\\[\]\\\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
        try {
          if (!new RegExp(escaped).test(file)) continue;
        } catch {
          // Invalid pattern, skip filter
        }
      }
      for (const sym of fileIndex.symbols) {
        const nameLower = sym.name.toLowerCase();
        let score = 0;
        if (nameLower === queryLower) {
          score = 1.0;
        } else if (nameLower.includes(queryLower)) {
          score = 0.8;
        } else if (queryLower.includes(nameLower)) {
          score = 0.6;
        } else {
          continue;
        }
        // Weight by PageRank
        score = score * 0.7 + sym.rank * 0.3;
        results.push({
          file,
          line: sym.line,
          content: `${sym.type} ${sym.name}`,
          score: Math.min(1.0, score),
          symbol: sym.name,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, maxResults);
  }

  async getSnapshot(maxTokens: number = 2048): Promise<string> {
    if (!this.cache) return "No index built. Run project_index build first.";

    // Collect all symbols, sorted by rank
    const allSymbols: Array<{ file: string; sym: SymbolDef }> = [];
    for (const [file, fileIndex] of Object.entries(this.cache.files)) {
      for (const sym of fileIndex.symbols) {
        allSymbols.push({ file, sym });
      }
    }
    allSymbols.sort((a, b) => b.sym.rank - a.sym.rank);

    // Build snapshot within token budget
    const maxChars = maxTokens * 4;
    const lines: string[] = ["## Repo Map (by importance)", ""];
    let chars = lines.join("\n").length;

    // Group by file, keeping ranked order
    const fileGroups = new Map<string, SymbolDef[]>();
    for (const { file, sym } of allSymbols) {
      if (!fileGroups.has(file)) fileGroups.set(file, []);
      fileGroups.get(file)!.push(sym);
    }

    // Sort files by their best symbol rank
    const sortedFiles = [...fileGroups.entries()].sort((a, b) => {
      const aMax = Math.max(...a[1].map(s => s.rank));
      const bMax = Math.max(...b[1].map(s => s.rank));
      return bMax - aMax;
    });

    for (const [file, symbols] of sortedFiles) {
      const symbolStr = symbols.map(s => `${s.name}(${s.type})`).join(", ");
      const line = `${file}: ${symbolStr}`;
      if (chars + line.length + 1 > maxChars) {
        lines.push("... (truncated to fit token budget)");
        break;
      }
      lines.push(line);
      chars += line.length + 1;
    }

    return lines.join("\n");
  }

  getStatus(): IndexStatus {
    return {
      strategy: "repomap",
      ready: this.ready,
      fileCount: this.cache ? Object.keys(this.cache.files).length : 0,
      lastUpdated: this.cache?.createdAt,
      error: this.error,
    };
  }

  async incrementalUpdate(changedFiles: string[]): Promise<void> {
    if (!this.cache || !this.workspacePath) return;
    // Re-run full build for now — incremental optimization can be added later
    await this.buildIndex(this.workspacePath);
  }
}
