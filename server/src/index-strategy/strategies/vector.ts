import { readdirSync, statSync, readFileSync, mkdirSync, existsSync } from "fs";
import { join, relative, extname } from "path";
import type { IndexStrategy, IndexStatus, SearchResult, SearchOptions } from "../types.js";

// Dynamic imports for optional dependencies
let lancedb: typeof import("@lancedb/lancedb") | null = null;
let pipeline: ((task: string, model?: string) => Promise<EmbeddingPipeline>) | null = null;

interface EmbeddingPipeline {
  (texts: string[], options?: { pooling: string; normalize: boolean }): Promise<{ tolist(): number[][] }>;
}

async function loadDependencies(): Promise<boolean> {
  try {
    lancedb = await import("@lancedb/lancedb");
    const transformers = await import("@huggingface/transformers");
    pipeline = (transformers as Record<string, unknown>).pipeline as typeof pipeline;
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

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt", ".rb", ".php",
  ".c", ".cpp", ".h", ".hpp", ".cs", ".swift", ".vue", ".svelte",
  ".md", ".txt", ".json", ".yaml", ".yml", ".toml",
]);

interface ChunkRecord {
  file: string;
  startLine: number;
  endLine: number;
  text: string;
  mtime: number;
  vector: number[];
}

const CHUNK_LINES = 60;
const CHUNK_OVERLAP = 30;
const DEFAULT_MODEL = "Xenova/multilingual-e5-small";

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
      if (CODE_EXTENSIONS.has(ext)) {
        results.push(fullPath);
      }
    }
    if (results.length >= maxFiles) break;
  }
  return results;
}

function chunkFile(content: string, file: string, mtime: number): Array<Omit<ChunkRecord, "vector">> {
  const lines = content.split("\n");
  const chunks: Array<Omit<ChunkRecord, "vector">> = [];
  for (let start = 0; start < lines.length; start += CHUNK_LINES - CHUNK_OVERLAP) {
    const end = Math.min(start + CHUNK_LINES, lines.length);
    const text = lines.slice(start, end).join("\n").trim();
    if (text.length < 10) continue; // Skip near-empty chunks
    chunks.push({
      file,
      startLine: start + 1,
      endLine: end,
      text: text.slice(0, 2000), // Cap chunk size
      mtime,
    });
    if (end >= lines.length) break;
  }
  return chunks;
}

export class VectorStrategy implements IndexStrategy {
  readonly type = "vector" as const;
  private workspacePath: string = "";
  private ready: boolean = false;
  private depsLoaded: boolean = false;
  private error?: string;
  private fileCount: number = 0;
  private lastUpdated?: string;
  private embedder: EmbeddingPipeline | null = null;
  private db: unknown = null;
  private table: unknown = null;

  /** Try to reconnect to an existing LanceDB on disk without full rebuild. */
  async tryLoadFromDisk(workspacePath: string): Promise<boolean> {
    if (this.ready && this.table) return true;
    const dbPath = join(workspacePath, ".agents", "index", "vectors");
    const tablePath = join(dbPath, "chunks.lance");
    if (!existsSync(tablePath)) return false;
    try {
      if (!this.depsLoaded) {
        this.depsLoaded = await loadDependencies();
        if (!this.depsLoaded || !lancedb || !pipeline) return false;
      }
      // Initialize embedding model (needed for search queries)
      if (!this.embedder) {
        this.embedder = await pipeline!("feature-extraction", DEFAULT_MODEL);
      }
      this.db = await lancedb!.connect(dbPath);
      const dbConn = this.db as { openTable(name: string): Promise<unknown> };
      this.table = await dbConn.openTable("chunks");
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
      await import("@lancedb/lancedb");
    } catch { missing.push("@lancedb/lancedb"); }
    try {
      await import("@huggingface/transformers");
    } catch { missing.push("@huggingface/transformers"); }
    return { ready: missing.length === 0, missing };
  }

  async buildIndex(workspacePath: string): Promise<void> {
    this.workspacePath = workspacePath;
    if (!this.depsLoaded) {
      this.depsLoaded = await loadDependencies();
      if (!this.depsLoaded || !lancedb || !pipeline) {
        this.error = "LanceDB or transformers dependencies not available";
        this.ready = false;
        return;
      }
    }

    try {
      // Initialize embedding model
      if (!this.embedder) {
        this.embedder = await pipeline!("feature-extraction", DEFAULT_MODEL);
      }

      // Open or create LanceDB database
      const dbPath = join(workspacePath, ".agents", "index", "vectors");
      mkdirSync(dbPath, { recursive: true });
      this.db = await lancedb!.connect(dbPath);

      // Collect and chunk files
      const sourceFiles = collectSourceFiles(workspacePath, 3000);
      this.fileCount = sourceFiles.length;
      const allChunks: Array<Omit<ChunkRecord, "vector">> = [];

      for (const fullPath of sourceFiles) {
        const relPath = relative(workspacePath, fullPath);
        let mtime: number;
        try {
          mtime = statSync(fullPath).mtimeMs;
        } catch {
          continue;
        }
        let content: string;
        try {
          content = readFileSync(fullPath, "utf-8");
        } catch {
          continue;
        }
        const chunks = chunkFile(content, relPath, mtime);
        allChunks.push(...chunks);
      }

      if (allChunks.length === 0) {
        this.ready = true;
        this.lastUpdated = new Date().toISOString();
        return;
      }

      // Generate embeddings in batches
      const BATCH_SIZE = 32;
      const records: ChunkRecord[] = [];

      for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
        const batch = allChunks.slice(i, i + BATCH_SIZE);
        const texts = batch.map(c => `passage: ${c.text}`);
        try {
          const output = await this.embedder!(texts, { pooling: "mean", normalize: true });
          const vectors = output.tolist();
          for (let j = 0; j < batch.length; j++) {
            records.push({
              ...batch[j],
              vector: vectors[j],
            });
          }
        } catch {
          // Skip failed batch
        }
      }

      if (records.length > 0) {
        // Create or overwrite the table
        const dbConn = this.db as { createTable(name: string, data: unknown[], opts?: { mode: string }): Promise<unknown> };
        this.table = await dbConn.createTable("chunks", records, { mode: "overwrite" });
      }

      this.ready = true;
      this.lastUpdated = new Date().toISOString();
      this.error = undefined;
    } catch (e) {
      this.error = `Failed to build vector index: ${e instanceof Error ? e.message : String(e)}`;
      this.ready = false;
    }
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    if (!this.ready || !this.embedder || !this.table) return [];
    const maxResults = options?.maxResults ?? 10;

    try {
      // Generate query embedding (e5 models need "query: " prefix)
      const output = await this.embedder!([`query: ${query}`], { pooling: "mean", normalize: true });
      const queryVector = output.tolist()[0];

      // Search in LanceDB
      const tbl = this.table as {
        search(vector: number[]): { limit(n: number): { toArray(): Promise<Array<{ file: string; startLine: number; endLine: number; text: string; _distance: number }>> } };
      };
      const results = await tbl.search(queryVector).limit(maxResults).toArray();

      return results.map((r) => ({
        file: r.file,
        line: r.startLine,
        content: r.text.slice(0, 200),
        score: Math.max(0, 1 - (r._distance ?? 0)), // Convert distance to similarity
        symbol: undefined,
      }));
    } catch {
      return [];
    }
  }

  async getSnapshot(maxTokens: number = 2048): Promise<string> {
    if (!this.workspacePath) return "No workspace set. Run project_index build first.";

    // Reuse NoneStrategy's simple file tree approach for snapshot
    const { NoneStrategy } = await import("./none.js");
    const fallback = new NoneStrategy();
    await fallback.buildIndex(this.workspacePath);
    const baseSnapshot = await fallback.getSnapshot(maxTokens - 100);

    const vectorInfo = this.ready
      ? `\n\n## Vector Index\nStatus: ready | Indexed files: ${this.fileCount}`
      : "\n\n## Vector Index\nStatus: not built";

    return baseSnapshot + vectorInfo;
  }

  getStatus(): IndexStatus {
    return {
      strategy: "vector",
      ready: this.ready,
      fileCount: this.fileCount,
      lastUpdated: this.lastUpdated,
      error: this.error,
    };
  }

  async incrementalUpdate(changedFiles: string[]): Promise<void> {
    if (!this.workspacePath) return;
    // Full rebuild for now — incremental can be optimized later
    await this.buildIndex(this.workspacePath);
  }
}
