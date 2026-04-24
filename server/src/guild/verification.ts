/**
 * Harness-level verification of a task's structured acceptance assertions.
 *
 * Separate from `acceptanceCriteria` (which is prose the agent reads and
 * tries to honor): this module runs deterministic checks *against the
 * agent's actual output* and refuses to mark a task complete if the
 * advertised deliverables don't exist. This is the core Harness-
 * Engineering principle applied to completion: verification belongs to
 * code, not to the model's self-report.
 *
 * Assertion types implemented here:
 *   - file_exists: the ref resolves to a real regular file under `cwd`.
 *   - file_contains: the ref exists AND its text content contains the
 *     given pattern (substring by default; regex when `regex: true`).
 *
 * Path traversal is blocked by resolving `ref` under `cwd` and rejecting
 * any path that escapes the root — the same trick `safeReadFile` uses.
 */

import { existsSync, statSync, readFileSync, realpathSync } from "fs";
import { resolve } from "path";
import type { AcceptanceAssertion } from "./types.js";

export interface VerificationResult {
  ok: boolean;
  failures: VerificationFailure[];
}

export interface VerificationFailure {
  assertion: AcceptanceAssertion;
  reason: string;
}

/** Cap on read size for file_contains — LLM-authored tasks rarely need to
 *  assert against huge files; a cap keeps verification fast and bounds RAM. */
const MAX_READ_BYTES = 2 * 1024 * 1024;

/** Regex-mode hardening caps. Pattern strings reach us from two lightly-trusted
 *  sources — LLM-generated pipelines and manually-authored task templates —
 *  so a malicious `(a+)+` against a large file could block the event loop
 *  (ReDoS). Since Node's built-in `RegExp` has no timeout, we rely on:
 *    1. hard pattern-length cap
 *    2. a conservative static ReDoS sniff (nested quantifiers, backrefs)
 *    3. content slice cap applied ONLY to the regex path (substring match
 *       doesn't backtrack so the full file is fine there). */
const MAX_REGEX_PATTERN_LEN = 500;
const MAX_REGEX_CONTENT_BYTES = 512 * 1024; // 512KB window for regex.test

/** Conservative ReDoS static check. Catches the common backtracking shapes —
 *  nested quantifiers like `(a+)+` / `(.+)*` and backreferences — without
 *  parsing the full regex grammar. Not exhaustive; see `MAX_REGEX_CONTENT_BYTES`
 *  and `MAX_REGEX_PATTERN_LEN` as the defense-in-depth layers. */
function isLikelyReDoSPattern(pattern: string): boolean {
  if (pattern.length > MAX_REGEX_PATTERN_LEN) return true;
  // Any group that (a) contains a quantifier inside and (b) is itself
  // quantified — covers (a+)+, (.+)*, (a*)+, ([^)]+)+ etc.
  if (/\([^)]*[+*?][^)]*\)[+*?{]/.test(pattern)) return true;
  // Backreferences amplify ambiguity and combine with quantifiers badly.
  if (/\\[1-9]/.test(pattern)) return true;
  return false;
}

/** Run the full list of assertions against `cwd`. Returns ok=true iff every
 *  assertion passed; otherwise `failures` contains one entry per failing
 *  assertion (including the assertion itself so the UI can link back). */
export function runAcceptanceAssertions(
  assertions: AcceptanceAssertion[] | undefined,
  cwd: string,
): VerificationResult {
  if (!assertions || assertions.length === 0) return { ok: true, failures: [] };
  const absRoot = resolve(cwd);
  const failures: VerificationFailure[] = [];
  for (const a of assertions) {
    const failure = checkOne(a, absRoot);
    if (failure) failures.push({ assertion: a, reason: failure });
  }
  return { ok: failures.length === 0, failures };
}

function checkOne(assertion: AcceptanceAssertion, absRoot: string): string | null {
  const resolved = resolveSafe(absRoot, assertion.ref);
  if (!resolved) return `路径越界或不合法：${assertion.ref}`;
  if (!existsSync(resolved)) return `文件不存在：${assertion.ref}`;
  let stat;
  try {
    stat = statSync(resolved);
  } catch (e) {
    return `无法读取文件：${assertion.ref} (${String(e)})`;
  }
  if (!stat.isFile()) return `目标不是普通文件：${assertion.ref}`;

  if (assertion.type === "file_exists") return null;

  // file_contains
  let content: string;
  try {
    if (stat.size > MAX_READ_BYTES) {
      return `文件过大无法验证 contains：${assertion.ref} (${stat.size} bytes > ${MAX_READ_BYTES})`;
    }
    content = readFileSync(resolved, "utf-8");
  } catch (e) {
    return `无法读取文件内容：${assertion.ref} (${String(e)})`;
  }
  const pattern = assertion.pattern;
  if (assertion.regex) {
    if (isLikelyReDoSPattern(pattern)) {
      return `正则被拒绝（可能引发 ReDoS 或超长）：/${truncate(pattern, 60)}/`;
    }
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (e) {
      return `无效正则表达式：/${pattern}/ (${String(e)})`;
    }
    // Slice the content for regex-mode only — substring match is linear
    // so the full file is fine above; here we bound backtracking cost.
    const target = content.length > MAX_REGEX_CONTENT_BYTES
      ? content.slice(0, MAX_REGEX_CONTENT_BYTES)
      : content;
    if (!re.test(target)) return `内容未命中正则 /${pattern}/：${assertion.ref}`;
    return null;
  }
  if (!content.includes(pattern)) {
    return `内容未包含子串 "${truncate(pattern, 60)}"：${assertion.ref}`;
  }
  return null;
}

/** Resolve a relative ref under root; return null if it escapes (symlinks
 *  included). Matches the defense in safeReadFile + getGuildArtifactFile. */
function resolveSafe(absRoot: string, ref: string): string | null {
  const abs = resolve(absRoot, ref);
  if (!abs.startsWith(absRoot + "/") && abs !== absRoot) return null;
  if (!existsSync(abs)) return abs; // existence check later — may legitimately be missing
  try {
    const realRoot = realpathSync(absRoot);
    const realAbs = realpathSync(abs);
    if (!realAbs.startsWith(realRoot + "/") && realAbs !== realRoot) return null;
  } catch {
    return null;
  }
  return abs;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** Format failures for display in result.summary / scheduler log.
 *  Example: "验收未通过：(1) 文件不存在：final.md (2) 内容未命中正则..." */
export function formatFailures(failures: VerificationFailure[]): string {
  if (failures.length === 0) return "";
  const lines = failures.map((f, i) => `(${i + 1}) ${f.reason}`);
  return `验收未通过：\n${lines.join("\n")}`;
}
