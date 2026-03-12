const HIDDEN_DIR_NAMES = new Set([
  ".git",
  ".svn",
  ".hg",
  ".idea",
  ".vscode",
  "node_modules",
  "venv",
  ".venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".cache",
  "target",
]);

export function shouldHideArtifactPath(path: string): boolean {
  const parts = path.split("/").filter(Boolean);
  return parts.some((part) => HIDDEN_DIR_NAMES.has(part));
}

export function filterVisibleArtifacts<T extends { path: string }>(artifacts: T[]): T[] {
  return artifacts.filter((item) => !shouldHideArtifactPath(item.path));
}
