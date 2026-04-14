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
const BINARY_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".tar", ".gz", ".bin", ".exe", ".dll", ".so", ".woff", ".woff2", ".ttf", ".eot"]);

/**
 * Safely read a file within a root directory. Returns null if path traversal is detected.
 */
export function safeReadFile(rootDir: string, filePath: string): { content: string | null; size: number; ext: string; binary: boolean } | null {
  const absRoot = resolve(rootDir);
  const absFile = resolve(rootDir, filePath);
  // Path traversal protection (textual check first, then symlink-aware)
  if (!absFile.startsWith(absRoot)) return null;
  if (!existsSync(absFile)) return null;
  // Follow symlinks and re-check to prevent symlink-based traversal
  const realRoot = realpathSync(absRoot);
  const realFile = realpathSync(absFile);
  if (!realFile.startsWith(realRoot)) return null;

  try {
    const st = statSync(absFile);
    if (!st.isFile()) return null;
    const ext = extname(filePath).toLowerCase();
    const binary = BINARY_EXTS.has(ext);

    if (binary || st.size > MAX_FILE_SIZE) {
      return { content: null, size: st.size, ext, binary: true };
    }
    const content = readFileSync(absFile, "utf-8");
    return { content, size: st.size, ext, binary: false };
  } catch {
    return null;
  }
}
