import { resolve } from "path";
import { realpathSync } from "fs";

export function isPathInWorkspace(pathText: string, workspacePath: string): boolean {
  const workspace = resolve(workspacePath);
  const target = resolve(pathText);
  if (target !== workspace && !target.startsWith(`${workspace}/`)) return false;
  try {
    const realTarget = realpathSync(target);
    const realWorkspace = realpathSync(workspace);
    return realTarget === realWorkspace || realTarget.startsWith(`${realWorkspace}/`);
  } catch {
    // Fail-closed: if we can't verify the real path (e.g. dangling symlink,
    // non-existent intermediate), deny access to be safe.
    return false;
  }
}
