import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globals: true,
    setupFiles: ["src/test-setup.ts"],
    // globalSetup sets DATA_DIR to a tmpdir path in the main process BEFORE
    // workers spawn, so source module-level `const DATA_DIR = process.env.DATA_DIR`
    // reads the test path instead of the shell's ~/.arcana-agent/data.
    globalSetup: ["src/test-global-setup.ts"],
    // Run test files sequentially. Multiple guild test files share the same
    // DATA_DIR/guild directory and their beforeEach/afterEach do
    // `rmSync(guild, {recursive})`. Running in parallel causes one file's
    // cleanup to destroy another's data mid-test (ENOTEMPTY / ENOENT).
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
});
