import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "fs";
import { join, resolve } from "path";
import type { AgentMemory, MemoryType, GuildTask, TaskResult } from "./types.js";
import { guildEventBus } from "./eventBus.js";

const DATA_DIR = resolve(process.env.DATA_DIR ?? join(process.cwd(), "data"));
const GUILD_DIR = join(DATA_DIR, "guild");
const AGENTS_DIR = join(GUILD_DIR, "agents");

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function genId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function memoryBaseDir(agentId: string): string {
  return join(AGENTS_DIR, agentId, "memory");
}

function memoryTypeDir(agentId: string, type: MemoryType): string {
  const typeMap: Record<MemoryType, string> = {
    experience: "experiences",
    knowledge: "knowledge",
    preference: "preferences",
  };
  return join(memoryBaseDir(agentId), typeMap[type]);
}

function indexPath(agentId: string): string {
  return join(memoryBaseDir(agentId), "index.json");
}

/** Migrate a v1 record (no v/strength/pinned/updatedAt) to v2 in-place. */
function migrate(m: AgentMemory | (Partial<AgentMemory> & { id: string })): AgentMemory {
  const anyM = m as Partial<AgentMemory> & { id: string };
  return {
    id: anyM.id,
    type: anyM.type ?? "experience",
    title: anyM.title ?? "(untitled)",
    summary: anyM.summary,
    content: anyM.content ?? "",
    tags: anyM.tags ?? [],
    relatedAssets: anyM.relatedAssets,
    sourceTaskId: anyM.sourceTaskId,
    groupId: anyM.groupId,
    strength: anyM.strength ?? 1,
    pinned: anyM.pinned ?? false,
    createdAt: anyM.createdAt ?? new Date().toISOString(),
    updatedAt: anyM.updatedAt ?? anyM.createdAt ?? new Date().toISOString(),
    accessCount: anyM.accessCount ?? 0,
    lastAccessedAt: anyM.lastAccessedAt,
    v: 2,
  };
}

// Cache loaded indexes across calls; invalidate via file mtime so external
// writers (tests, ad-hoc edits) still get picked up automatically.
const indexCache = new Map<string, { mtimeMs: number; memories: AgentMemory[] }>();

function loadIndex(agentId: string): AgentMemory[] {
  const p = indexPath(agentId);
  if (!existsSync(p)) {
    indexCache.delete(agentId);
    return [];
  }
  try {
    const mtimeMs = statSync(p).mtimeMs;
    const cached = indexCache.get(agentId);
    if (cached && cached.mtimeMs === mtimeMs) return cached.memories.map((m) => ({ ...m }));
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Array<Partial<AgentMemory> & { id: string }>;
    const memories = raw.map(migrate);
    indexCache.set(agentId, { mtimeMs, memories });
    return memories;
  } catch {
    return [];
  }
}

function saveIndex(agentId: string, memories: AgentMemory[]): void {
  ensureDir(memoryBaseDir(agentId));
  const p = indexPath(agentId);
  writeFileSync(p, JSON.stringify(memories, null, 2));
  try {
    indexCache.set(agentId, { mtimeMs: statSync(p).mtimeMs, memories });
  } catch {
    indexCache.delete(agentId);
  }
}

// ─── CRUD ───────────────────────────────────────────────────────

export interface SaveMemoryParams {
  type: MemoryType;
  title: string;
  summary?: string;
  content: string;
  tags: string[];
  relatedAssets?: string[];
  sourceTaskId?: string;
  groupId?: string;
  pinned?: boolean;
  strength?: number;
}

export function saveMemory(agentId: string, params: SaveMemoryParams): AgentMemory {
  const memories = loadIndex(agentId);
  const now = new Date().toISOString();

  // Dedup: an experience with the same (type, title) is almost certainly a
  // repeat of work the agent has done before — bump strength + refresh
  // content/timestamp instead of accumulating near-identical rows that
  // pollute future memory recall and bloat the prompt context. Only applies
  // to experience memories where titles like "Completed: 写产品介绍" recur
  // verbatim; knowledge/preference titles tend to be unique by design but
  // we apply the same rule for consistency. Pinned existing memories are
  // never overwritten.
  const dupIdx = memories.findIndex(
    (m) => m.type === params.type && m.title === params.title && !m.pinned,
  );
  if (dupIdx >= 0) {
    const existing = memories[dupIdx];
    existing.summary = params.summary ?? existing.summary;
    existing.content = params.content;
    existing.tags = Array.from(new Set([...(existing.tags ?? []), ...params.tags]));
    existing.relatedAssets = params.relatedAssets ?? existing.relatedAssets;
    existing.sourceTaskId = params.sourceTaskId ?? existing.sourceTaskId;
    existing.groupId = params.groupId ?? existing.groupId;
    existing.strength = (existing.strength ?? 1) + (params.strength ?? 1);
    existing.updatedAt = now;
    saveIndex(agentId, memories);
    // Refresh markdown file so disk + index stay in sync.
    const dir = memoryTypeDir(agentId, existing.type);
    ensureDir(dir);
    const filePath = join(dir, `${existing.id}.md`);
    const front: string[] = [
      `# ${existing.title}`,
      ``,
      existing.summary ? `> ${existing.summary}\n` : "",
      existing.content,
      ``,
      `---`,
      `Tags: ${existing.tags.join(", ")}`,
      `Created: ${existing.createdAt}`,
      `Updated: ${existing.updatedAt} (reinforced ×${existing.strength})`,
    ];
    if (existing.sourceTaskId) front.push(`Source task: ${existing.sourceTaskId}`);
    if (existing.groupId) front.push(`Group: ${existing.groupId}`);
    writeFileSync(filePath, front.filter(Boolean).join("\n") + "\n");
    guildEventBus.emit({ type: "agent_memory_settled", agentId, memoryId: existing.id });
    return existing;
  }

  const memory: AgentMemory = {
    id: genId("mem"),
    type: params.type,
    title: params.title,
    summary: params.summary,
    content: params.content,
    tags: params.tags,
    relatedAssets: params.relatedAssets,
    sourceTaskId: params.sourceTaskId,
    groupId: params.groupId,
    strength: params.strength ?? 1,
    pinned: params.pinned ?? false,
    createdAt: now,
    updatedAt: now,
    accessCount: 0,
    v: 2,
  };
  memories.push(memory);
  saveIndex(agentId, memories);

  // Also write individual markdown file for human browsing.
  const dir = memoryTypeDir(agentId, params.type);
  ensureDir(dir);
  const filePath = join(dir, `${memory.id}.md`);
  const front: string[] = [
    `# ${params.title}`,
    ``,
    params.summary ? `> ${params.summary}\n` : "",
    params.content,
    ``,
    `---`,
    `Tags: ${params.tags.join(", ")}`,
    `Created: ${now}`,
  ];
  if (params.sourceTaskId) front.push(`Source task: ${params.sourceTaskId}`);
  if (params.groupId) front.push(`Group: ${params.groupId}`);
  writeFileSync(filePath, front.filter(Boolean).join("\n") + "\n");

  guildEventBus.emit({ type: "agent_memory_settled", agentId, memoryId: memory.id });
  return memory;
}

export function getMemories(
  agentId: string,
  query?: { types?: MemoryType[]; tags?: string[]; groupId?: string; limit?: number },
): AgentMemory[] {
  let memories = loadIndex(agentId);
  if (query?.types && query.types.length > 0) {
    memories = memories.filter((m) => query.types!.includes(m.type));
  }
  if (query?.groupId) {
    memories = memories.filter((m) => m.groupId === query.groupId || !m.groupId);
  }
  if (query?.tags && query.tags.length > 0) {
    const tagSet = new Set(query.tags.map((t) => t.toLowerCase()));
    memories = memories.filter((m) => m.tags.some((t) => tagSet.has(t.toLowerCase())));
  }
  // Pinned first, then by strength + recency.
  memories.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const strDelta = (b.strength ?? 0) - (a.strength ?? 0);
    if (strDelta !== 0) return strDelta;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
  if (query?.limit) memories = memories.slice(0, query.limit);
  return memories;
}

export function deleteMemory(agentId: string, memoryId: string): boolean {
  const memories = loadIndex(agentId);
  const idx = memories.findIndex((m) => m.id === memoryId);
  if (idx < 0) return false;
  memories.splice(idx, 1);
  saveIndex(agentId, memories);
  return true;
}

/** Increment strength and persist. Use when an agent successfully reuses a memory. */
export function reinforceMemory(agentId: string, memoryId: string, delta = 1): AgentMemory | null {
  const memories = loadIndex(agentId);
  const m = memories.find((x) => x.id === memoryId);
  if (!m) return null;
  m.strength = Math.min(10, (m.strength ?? 0) + delta);
  m.updatedAt = new Date().toISOString();
  saveIndex(agentId, memories);
  return m;
}

/** Prune weak, unpinned memories when an agent's memory grows past maxItems. */
export function pruneWeakMemories(agentId: string, maxItems = 500): number {
  const memories = loadIndex(agentId);
  if (memories.length <= maxItems) return 0;
  // Keep pinned + top strength/recency entries.
  const scored = memories.map((m) => ({
    m,
    keepScore: (m.pinned ? 1e9 : 0) + (m.strength ?? 0) * 10 + (m.accessCount ?? 0),
  }));
  scored.sort((a, b) => b.keepScore - a.keepScore);
  const kept = scored.slice(0, maxItems).map((s) => s.m);
  const dropped = memories.length - kept.length;
  saveIndex(agentId, kept);
  return dropped;
}

const CJK_RE = /[\u3400-\u9fff\uF900-\uFAFF]/;
const CJK_RE_G = /[\u3400-\u9fff\uF900-\uFAFF]/g;

/** Produce search tokens: whitespace-split Latin words + CJK character bigrams.
 *  Bigrams matter because `"部署失败"`-style Chinese queries otherwise degrade
 *  to a single-token substring match and miss closely related memories. */
function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens = new Set<string>();
  for (const w of lower.split(/[\s,;.!?，。；！？、"'`()\[\]{}<>]+/)) {
    // Extract Latin-only substring (strip ALL CJK chars) so mixed words like
    // "test测试" still contribute "test" as a Latin token.
    const latin = w.replace(CJK_RE_G, "");
    if (latin.length >= 2) tokens.add(latin);
  }
  // CJK bigrams — walk contiguous runs of CJK chars.
  let run = "";
  const flush = () => {
    if (run.length >= 2) {
      for (let i = 0; i + 1 < run.length; i++) tokens.add(run.slice(i, i + 2));
    }
    run = "";
  };
  for (const ch of lower) {
    if (CJK_RE.test(ch)) run += ch;
    else flush();
  }
  flush();
  return Array.from(tokens);
}

/** Count non-overlapping occurrences of `needle` in `haystack` (both lowercased). */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

/** Search memories with field-weighted token matching.
 *  Title/tags are strongest signals, summary next, content weakest per hit.
 *  Persists access-count increments so frequently-useful memories surface faster. */
export function searchRelevant(agentId: string, taskDescription: string, limit = 10): AgentMemory[] {
  const memories = loadIndex(agentId);
  if (memories.length === 0) return [];
  const tokens = tokenize(taskDescription);
  if (tokens.length === 0) return [];

  const scored: Array<{ memory: AgentMemory; score: number }> = [];
  for (const m of memories) {
    const title = m.title.toLowerCase();
    const summary = (m.summary ?? "").toLowerCase();
    const content = m.content.toLowerCase();
    const tagText = m.tags.join(" ").toLowerCase();

    let score = 0;
    let matchedTokens = 0;
    for (const tk of tokens) {
      const hTitle = countOccurrences(title, tk);
      const hTags = countOccurrences(tagText, tk);
      const hSummary = countOccurrences(summary, tk);
      const hContent = countOccurrences(content, tk);
      if (hTitle || hTags || hSummary || hContent) matchedTokens++;
      // Weighted: title 4x, tags 2.5x, summary 1.5x, content 1x (content capped per-field to avoid length bias).
      score += hTitle * 4 + hTags * 2.5 + hSummary * 1.5 + Math.min(hContent, 3);
    }
    if (score === 0) continue;
    // Coverage boost: matching many distinct tokens beats spamming the same token.
    score += matchedTokens * 0.5;

    const ageDays = (Date.now() - new Date(m.createdAt).getTime()) / (1000 * 60 * 60 * 24);
    const recencyBoost = Math.max(0, 1 - ageDays / 60); // half-life ~2 months
    score += recencyBoost * 0.5;
    score += Math.min((m.accessCount ?? 0) / 10, 0.5);
    score += Math.min((m.strength ?? 0) / 10, 0.5);
    if (m.pinned) score += 0.5;
    scored.push({ memory: m, score });
  }

  if (scored.length === 0) return [];
  scored.sort((a, b) => b.score - a.score);
  const hits = scored.slice(0, limit);

  // Persist access bumps once per call so lookups compound usefully over time.
  const now = new Date().toISOString();
  for (const h of hits) {
    h.memory.accessCount = (h.memory.accessCount ?? 0) + 1;
    h.memory.lastAccessedAt = now;
  }
  saveIndex(agentId, memories);

  return hits.map((h) => h.memory);
}

/** Auto-generate experience memory after task completion. Uses the structured
 *  handoff (if present) as the summary so the memory captures what the agent
 *  *actually did*, not just the raw output blob. */
export function settleTaskMemory(
  agentId: string,
  task: GuildTask,
  result: TaskResult,
): AgentMemory[] {
  const tags = [
    ...task.title.split(/\s+/).filter((w) => w.length > 2).slice(0, 5),
    task.priority,
    task.groupId,
  ];

  const handoffSummary = result.handoff?.summary;
  const summary = handoffSummary && handoffSummary.length > 0
    ? handoffSummary
    : compact(result.summary);

  const contentLines: string[] = [];
  contentLines.push(`## Task`);
  contentLines.push(`${task.title}`);
  contentLines.push(``);
  contentLines.push(task.description);
  if (task.acceptanceCriteria) {
    contentLines.push(``);
    contentLines.push(`**Acceptance**: ${task.acceptanceCriteria}`);
  }
  contentLines.push(``);
  contentLines.push(`## Result`);
  // Use the structured handoff summary (one-line, what was done) as the
  // canonical "Result". Storing the full verbose result.summary here means
  // future memory recall feeds the agent its own bloated past output as a
  // template, which Doubao mini then copies verbatim — kills any prompt
  // attempt to slim the writing style. Keep handoff summary or fall back
  // to the first 200 chars of result.summary as a last resort.
  contentLines.push(handoffSummary && handoffSummary.length > 0 ? handoffSummary : compact(result.summary).slice(0, 200));
  if (result.handoff?.artifacts?.length) {
    contentLines.push(``);
    contentLines.push(`## Artifacts`);
    for (const a of result.handoff.artifacts) {
      const desc = a.description ? ` — ${a.description}` : "";
      contentLines.push(`- ${a.kind}: \`${a.ref}\`${desc}`);
    }
  }
  if (result.handoff?.openQuestions?.length) {
    contentLines.push(``);
    contentLines.push(`## Open Questions`);
    for (const q of result.handoff.openQuestions) contentLines.push(`- ${q}`);
  }
  if (result.agentNotes) {
    contentLines.push(``);
    contentLines.push(`## Notes`);
    contentLines.push(result.agentNotes);
  }

  const experienceMemory = saveMemory(agentId, {
    type: "experience",
    title: `Completed: ${task.title}`,
    summary,
    content: contentLines.join("\n"),
    tags,
    sourceTaskId: task.id,
    groupId: task.groupId,
    strength: 1,
  });

  const created: AgentMemory[] = [experienceMemory];

  // Create knowledge/preference memories declared in handoff
  if (result.handoff?.memories) {
    for (const m of result.handoff.memories) {
      const mem = saveMemory(agentId, {
        type: m.type,
        title: m.title,
        content: m.content,
        tags: [...(m.tags ?? []), task.groupId],
        sourceTaskId: task.id,
        groupId: task.groupId,
        strength: 1,
      });
      created.push(mem);
    }
  }

  return created;
}

/** Back-compat alias — old call sites still use `settleExperience`. */
export const settleExperience = settleTaskMemory;

function compact(s: string): string {
  const trimmed = s.replace(/\s+/g, " ").trim();
  return trimmed.length > 400 ? `${trimmed.slice(0, 400)}…` : trimmed;
}
