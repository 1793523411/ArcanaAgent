import { mkdirSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * Vitest globalSetup runs in the main process BEFORE any workers spawn.
 * Setting DATA_DIR here ensures workers inherit it via process.env, so
 * module-level `const DATA_DIR = resolve(process.env.DATA_DIR ?? ...)`
 * in guild source files picks up the test directory instead of the
 * shell-level ~/.arcana-agent/data.
 */
export function setup() {
  const dir = join(tmpdir(), "arcana-agent-test-data");
  process.env.DATA_DIR = dir;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
