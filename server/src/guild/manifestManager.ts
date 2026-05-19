import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, renameSync, unlinkSync } from "fs";
import { join, relative } from "path";
import type { ArtifactManifestEntry } from "./types.js";

const MANIFEST_FILE = ".manifest.json";

export type ArtifactManifest = Record<string, ArtifactManifestEntry>;

function manifestPath(dir: string): string {
  return join(dir, MANIFEST_FILE);
}

// Per-directory mutation queue. Serializes readManifest→mutate→writeManifest
// so two concurrent reconcile() calls against the same dir cannot clobber
// each other. Keyed by the manifest file's absolute path.
const dirLocks = new Map<string, Promise<void>>();

function withDirLock<T>(dir: string, fn: () => T | Promise<T>): Promise<T> {
  const key = manifestPath(dir);
  const prev = dirLocks.get(key) ?? Promise.resolve();
  const run = prev.then(() => Promise.resolve().then(fn));
  // Swallow errors in the chain head so one failure doesn't poison later waiters.
  dirLocks.set(key, run.then(() => undefined, () => undefined));
  return run;
}

export function readManifest(dir: string): ArtifactManifest {
  const p = manifestPath(dir);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as ArtifactManifest;
  } catch {
    return {};
  }
}

export function writeManifest(dir: string, manifest: ArtifactManifest): void {
  // Atomic replace: write to a temp file in the same dir, then rename. A crash
  // mid-write leaves the previous manifest intact instead of a truncated JSON.
  const target = manifestPath(dir);
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  try {
    renameSync(tmp, target);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw e;
  }
}

export function updateManifestEntry(
  dir: string,
  filePath: string,
  taskId: string,
  agentId: string,
): Promise<void> {
  return withDirLock(dir, () => {
    const manifest = readManifest(dir);
    const now = new Date().toISOString();
    const existing = manifest[filePath];
    if (existing) {
      existing.modifiedBy.push({ taskId, agentId, at: now });
    } else {
      manifest[filePath] = {
        createdBy: { taskId, agentId, at: now },
        modifiedBy: [],
      };
    }
    writeManifest(dir, manifest);
  });
}

/** Scan a directory for files and update manifest entries for any new/modified files
 *  that appeared since the last snapshot.
 *
 *  Attribution policy under concurrency: if a file already has a createdBy
 *  entry in the manifest, this task never overwrites it — it only appends to
 *  modifiedBy. So two tasks completing near-simultaneously can only fight over
 *  ordering, not misattribute creation. */
export function reconcileManifest(
  dir: string,
  taskId: string,
  agentId: string,
  snapshotBefore: Map<string, number>,
): Promise<void> {
  return withDirLock(dir, () => {
    if (!existsSync(dir)) return;
    const manifest = readManifest(dir);
    const now = new Date().toISOString();
    let changed = false;

    const walk = (d: string) => {
      let entries: string[] = [];
      try { entries = readdirSync(d); } catch { return; }
      for (const name of entries) {
        if (name.startsWith(".")) continue;
        const full = join(d, name);
        let st;
        try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) {
          walk(full);
        } else if (st.isFile()) {
          const rel = relative(dir, full);
          const prevMtime = snapshotBefore.get(rel);
          const curMtime = st.mtimeMs;
          const isNewOnDisk = prevMtime === undefined;
          const wasModified = prevMtime !== undefined && curMtime > prevMtime;
          if (!isNewOnDisk && !wasModified) continue;

          const existing = manifest[rel];
          if (!existing) {
            // No prior claim — this task creates the record.
            manifest[rel] = {
              createdBy: { taskId, agentId, at: now },
              modifiedBy: [],
            };
          } else {
            // Someone already claimed createdBy (could be a concurrent task
            // that finished first). Don't overwrite; record the touch.
            existing.modifiedBy.push({ taskId, agentId, at: now });
          }
          changed = true;
        }
      }
    };

    walk(dir);
    if (changed) writeManifest(dir, manifest);
  });
}

/** Take a snapshot of file mtimes in a directory for later reconciliation. */
export function snapshotDir(dir: string): Map<string, number> {
  const result = new Map<string, number>();
  if (!existsSync(dir)) return result;

  const walk = (d: string) => {
    let entries: string[] = [];
    try { entries = readdirSync(d); } catch { return; }
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const full = join(d, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile()) {
        result.set(relative(dir, full), st.mtimeMs);
      }
    }
  };

  walk(dir);
  return result;
}
