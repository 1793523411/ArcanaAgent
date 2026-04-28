import { readdirSync, statSync, readFileSync, existsSync, realpathSync } from "fs";
import { join, resolve, relative, extname } from "path";

export interface FileTreeNode {
  name: string;
  path: string; // relative to the browse root
  isDir: boolean;
  size?: number; // only for files
  ext?: string;  // only for files
  children?: FileTreeNode[];
}

const MAX_DEPTH = 10;
const IGNORE = new Set([".DS_Store", "Thumbs.db", ".git", "node_modules"]);

/**
 * Recursively scan a directory and return a tree structure.
 * All paths are relative to `rootDir`.
 */
export function scanDirectory(rootDir: string, maxDepth = MAX_DEPTH): FileTreeNode[] {
  if (!existsSync(rootDir)) return [];
  return scanInner(rootDir, rootDir, 0, maxDepth);
}

function scanInner(rootDir: string, currentDir: string, depth: number, maxDepth: number): FileTreeNode[] {
  if (depth >= maxDepth) return [];
  try {
    const entries = readdirSync(currentDir, { withFileTypes: true });
    const nodes: FileTreeNode[] = [];
    // Dirs first, then files, alphabetically
    const dirs = entries.filter(e => e.isDirectory() && !IGNORE.has(e.name)).sort((a, b) => a.name.localeCompare(b.name));
    const files = entries.filter(e => e.isFile() && !IGNORE.has(e.name)).sort((a, b) => a.name.localeCompare(b.name));

    for (const d of dirs) {
      const fullPath = join(currentDir, d.name);
      const relPath = relative(rootDir, fullPath);
      const children = scanInner(rootDir, fullPath, depth + 1, maxDepth);
      nodes.push({ name: d.name, path: relPath, isDir: true, children });
    }
    for (const f of files) {
      const fullPath = join(currentDir, f.name);
      const relPath = relative(rootDir, fullPath);
      try {
        const st = statSync(fullPath);
        nodes.push({ name: f.name, path: relPath, isDir: false, size: st.size, ext: extname(f.name).toLowerCase() });
      } catch {
        nodes.push({ name: f.name, path: relPath, isDir: false, ext: extname(f.name).toLowerCase() });
      }
    }
    return nodes;
  } catch {
    return [];
  }
}

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB — images are base64-inlined so allow a bit more.
const MAX_PDF_SIZE = 10 * 1024 * 1024; // 10MB — PDFs inlined as base64 data URL for iframe rendering.
const BINARY_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".tar", ".gz", ".bin", ".exe", ".dll", ".so", ".woff", ".woff2", ".ttf", ".eot"]);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico"]);
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon",
};

export interface SafeReadResult {
  content: string | null;
  size: number;
  ext: string;
  binary: boolean;
  /** Data URL (e.g. "data:image/png;base64,...") when the file is an inlineable image. */
  dataUrl?: string;
}

/**
 * Safely read a file within a root directory. Returns null if path traversal is detected.
 */
export function safeReadFile(rootDir: string, filePath: string): SafeReadResult | null {
  const absRoot = resolve(rootDir);
  const absFile = resolve(rootDir, filePath);
  // Path traversal protection — require a trailing separator so that e.g.
  // rootDir "/data/agents/agt_abc" doesn't accept "/data/agents/agt_abcdef/…".
  if (!absFile.startsWith(absRoot + "/") && absFile !== absRoot) return null;
  if (!existsSync(absFile)) return null;
  // Follow symlinks and re-check to prevent symlink-based traversal
  const realRoot = realpathSync(absRoot);
  const realFile = realpathSync(absFile);
  if (!realFile.startsWith(realRoot + "/") && realFile !== realRoot) return null;

  try {
    const st = statSync(absFile);
    if (!st.isFile()) return null;
    const ext = extname(filePath).toLowerCase();
    const binary = BINARY_EXTS.has(ext);

    // Inline images as base64 data URLs so the UI can render <img src=...>.
    if (IMAGE_EXTS.has(ext) && st.size <= MAX_IMAGE_SIZE) {
      const buf = readFileSync(absFile);
      const dataUrl = `data:${IMAGE_MIME[ext] ?? "application/octet-stream"};base64,${buf.toString("base64")}`;
      return { content: null, size: st.size, ext, binary: true, dataUrl };
    }

    // Inline PDFs as base64 data URLs so the UI can render <iframe src=...>.
    if (ext === ".pdf" && st.size <= MAX_PDF_SIZE) {
      const buf = readFileSync(absFile);
      const dataUrl = `data:application/pdf;base64,${buf.toString("base64")}`;
      return { content: null, size: st.size, ext, binary: true, dataUrl };
    }

    if (binary || st.size > MAX_FILE_SIZE) {
      return { content: null, size: st.size, ext, binary: true };
    }
    const content = readFileSync(absFile, "utf-8");
    return { content, size: st.size, ext, binary: false };
  } catch {
    return null;
  }
}
