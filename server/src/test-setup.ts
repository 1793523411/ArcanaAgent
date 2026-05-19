import { mkdirSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Each vitest worker gets its own DATA_DIR so parallel test files don't
// race on the shared "guild" directory during beforeEach/afterEach cleanup.
const poolId = process.env.VITEST_POOL_ID ?? process.pid.toString();
const TEST_DATA_DIR = join(tmpdir(), `arcana-agent-test-data-${poolId}`);
process.env.DATA_DIR = TEST_DATA_DIR;
if (!existsSync(TEST_DATA_DIR)) {
  mkdirSync(TEST_DATA_DIR, { recursive: true });
}

/**
 * Robustly remove the guild test directory. Uses maxRetries to handle
 * transient ENOTEMPTY errors caused by macOS filesystem operations
 * (Spotlight indexing, .DS_Store creation) that create files during
 * the recursive walk.
 */
export function cleanGuildDir(): void {
  try {
    rmSync(join(TEST_DATA_DIR, "guild"), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // Best-effort: if cleanup still fails after retries, ignore — the
    // next test's beforeEach will try again.
  }
}
