/**
 * Shared dangerous command detection — single source of truth.
 * Used by both run_command tool and backgroundManager.
 */

const DANGEROUS_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)?\/\s*$/,
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/\s*$/,
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\/\s*$/,
  /\brm\s+-rf\s+\/(\s|$|\*)/,
  /\brm\s+-fr\s+\/(\s|$|\*)/,
  /\bmkfs\b/,
  /\bdd\s+.*\bof=\/dev\/[sh]d/,
  /\b:(){ :\|:& };:/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\binit\s+0\b/,
  /\bhalt\b/,
  />\s*\/dev\/[sh]d/,
  /\bchmod\s+-R\s+777\s+\/\s*$/,
  /\bchown\s+-R\s+.*\s+\/\s*$/,
  /\bformat\s+[cCdD]:/,
];

/**
 * Check if a command matches any dangerous pattern.
 * @returns An error message if dangerous, null if safe.
 */
export function isDangerous(command: string): string | null {
  const trimmed = command.trim();
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmed)) {
      return `Blocked: this command matches a dangerous pattern (${pattern.source}). If you really need this, ask the user to run it manually.`;
    }
  }
  return null;
}
