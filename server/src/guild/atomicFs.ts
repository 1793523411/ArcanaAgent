import { writeFileSync, renameSync, unlinkSync } from "fs";
import { dirname, join } from "path";

/**
 * Write a file atomically: stage content to a sibling temp file then rename
 * over the target. POSIX `rename(2)` is atomic for same-filesystem targets —
 * readers see either the old file or the new one, never a half-written one.
 *
 * Used to guard RMW persistence sites (task list JSON, workspace markdown)
 * against crash-mid-write corruption. Within-process concurrency is already
 * serialized by Node's single-threaded event loop because these paths use
 * only synchronous fs APIs.
 */
export function atomicWriteFileSync(target: string, content: string): void {
  const tmp = join(dirname(target), `.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, target);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}
