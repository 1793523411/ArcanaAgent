import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runAcceptanceAssertions, formatFailures } from "./verification.js";

// Each test gets its own cwd under tmpdir so symlink / path-traversal cases
// can be set up cleanly without polluting sibling runs.
let CWD: string;

beforeEach(() => {
  CWD = join(tmpdir(), `verification-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(CWD, { recursive: true });
});

afterEach(() => {
  if (existsSync(CWD)) rmSync(CWD, { recursive: true, force: true });
});

describe("runAcceptanceAssertions", () => {
  it("returns ok when no assertions are given", () => {
    const v = runAcceptanceAssertions(undefined, CWD);
    expect(v.ok).toBe(true);
    expect(v.failures).toEqual([]);
  });

  it("returns ok for file_exists when the file is present", () => {
    writeFileSync(join(CWD, "final.md"), "# hi");
    const v = runAcceptanceAssertions([{ type: "file_exists", ref: "final.md" }], CWD);
    expect(v.ok).toBe(true);
  });

  it("fails file_exists when the ref is missing", () => {
    const v = runAcceptanceAssertions([{ type: "file_exists", ref: "missing.md" }], CWD);
    expect(v.ok).toBe(false);
    expect(v.failures).toHaveLength(1);
    expect(v.failures[0].reason).toMatch(/不存在/);
  });

  it("fails when the ref resolves to a directory, not a file", () => {
    mkdirSync(join(CWD, "a-folder"));
    const v = runAcceptanceAssertions([{ type: "file_exists", ref: "a-folder" }], CWD);
    expect(v.ok).toBe(false);
    expect(v.failures[0].reason).toMatch(/不是普通文件/);
  });

  it("rejects path traversal via '..'", () => {
    const v = runAcceptanceAssertions([{ type: "file_exists", ref: "../../../etc/passwd" }], CWD);
    expect(v.ok).toBe(false);
    expect(v.failures[0].reason).toMatch(/越界/);
  });

  it("rejects symlinks that escape the cwd", () => {
    const outside = join(tmpdir(), `outside-${Date.now()}`);
    writeFileSync(outside, "secret");
    try {
      symlinkSync(outside, join(CWD, "link"));
      const v = runAcceptanceAssertions([{ type: "file_exists", ref: "link" }], CWD);
      expect(v.ok).toBe(false);
    } finally {
      if (existsSync(outside)) rmSync(outside);
    }
  });

  it("file_contains passes on a substring match", () => {
    writeFileSync(join(CWD, "final.md"), "This report covers the Q3 results.");
    const v = runAcceptanceAssertions([{ type: "file_contains", ref: "final.md", pattern: "Q3 results" }], CWD);
    expect(v.ok).toBe(true);
  });

  it("file_contains fails when the substring is absent", () => {
    writeFileSync(join(CWD, "final.md"), "totally unrelated text");
    const v = runAcceptanceAssertions([{ type: "file_contains", ref: "final.md", pattern: "mandatory section" }], CWD);
    expect(v.ok).toBe(false);
    expect(v.failures[0].reason).toMatch(/未包含/);
  });

  it("file_contains with regex=true matches by regex", () => {
    writeFileSync(join(CWD, "results.json"), '{"price": 123.45}');
    const v = runAcceptanceAssertions(
      [{ type: "file_contains", ref: "results.json", pattern: '"price"\\s*:\\s*\\d+', regex: true }],
      CWD,
    );
    expect(v.ok).toBe(true);
  });

  it("returns a clear reason for invalid regex patterns", () => {
    writeFileSync(join(CWD, "x.txt"), "content");
    const v = runAcceptanceAssertions(
      [{ type: "file_contains", ref: "x.txt", pattern: "[unclosed", regex: true }],
      CWD,
    );
    expect(v.ok).toBe(false);
    expect(v.failures[0].reason).toMatch(/无效正则/);
  });

  it("aggregates multiple failures — one entry per assertion", () => {
    writeFileSync(join(CWD, "one.md"), "hello");
    const v = runAcceptanceAssertions(
      [
        { type: "file_exists", ref: "one.md" },                         // passes
        { type: "file_exists", ref: "two.md" },                         // fails
        { type: "file_contains", ref: "one.md", pattern: "goodbye" },   // fails
      ],
      CWD,
    );
    expect(v.ok).toBe(false);
    expect(v.failures).toHaveLength(2);
  });
});

describe("formatFailures", () => {
  it("returns empty string for no failures", () => {
    expect(formatFailures([])).toBe("");
  });

  it("numbers each failure line", () => {
    const text = formatFailures([
      { assertion: { type: "file_exists", ref: "a" }, reason: "r1" },
      { assertion: { type: "file_exists", ref: "b" }, reason: "r2" },
    ]);
    expect(text).toContain("(1) r1");
    expect(text).toContain("(2) r2");
    expect(text).toMatch(/^验收未通过/);
  });
});
