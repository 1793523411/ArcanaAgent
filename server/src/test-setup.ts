import { mkdirSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TEST_DATA_DIR = join(tmpdir(), "rule-agent-test-data");
process.env.DATA_DIR = TEST_DATA_DIR;
if (!existsSync(TEST_DATA_DIR)) {
  mkdirSync(TEST_DATA_DIR, { recursive: true });
}
