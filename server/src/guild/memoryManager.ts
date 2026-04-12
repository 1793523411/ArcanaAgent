import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
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

function loadIndex(agentId: string): AgentMemory[] {
  const p = indexPath(agentId);
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Array<Partial<AgentMemory> & { id: string }>;
    return raw.map(migrate);
  } catch {
    return [];
  }
}

function saveIndex(agentId: string, memories: AgentMemory[]): void {
  ensureDir(memoryBaseDir(agentId));
  writeFileSync(indexPath(agentId), JSON.stringify(memories, null, 2));
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

/** Search memories by keyword matching against title, summary, content, and tags.
 *  Persists access-count increments — the v1 version mutated in-memory only. */
export function searchRelevant(agentId: string, taskDescription: string, limit = 10): AgentMemory[] {
  const memories = loadIndex(agentId);
  const keywords = taskDescription
    .toLowerCase()
    .split(/[\s,;.!?]+/)
    .filter((w) => w.length > 2);

  const scored = memories.map((m) => {
    const text = `${m.title} ${m.summary ?? ""} ${m.content} ${m.tags.join(" ")}`.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (text.includes(kw)) score++;
    }
    const ageDays = (Date.now() - new Date(m.createdAt).getTime()) / (1000 * 60 * 60 * 24);
    const recencyBoost = Math.max(0, 1 - ageDays / 60); // half-life ~2 months
    score += recencyBoost * 0.5;
    score += Math.min((m.accessCount ?? 0) / 10, 0.5);
    score += Math.min((m.strength ?? 0) / 10, 0.5);
    if (m.pinned) score += 0.5;
    return { memory: m, score };
  });

  const hits = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (hits.length === 0) return [];

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
): AgentMemory {
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
  contentLines.push(result.summary);
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

  return saveMemory(agentId, {
    type: "experience",
    title: `Completed: ${task.title}`,
    summary,
    content: contentLines.join("\n"),
    tags,
    sourceTaskId: task.id,
    groupId: task.groupId,
    strength: 1,
  });
}

/** Back-compat alias — old call sites still use `settleExperience`. */
export const settleExperience = settleTaskMemory;

function compact(s: string): string {
  const trimmed = s.replace(/\s+/g, " ").trim();
  return trimmed.length > 400 ? `${trimmed.slice(0, 400)}…` : trimmed;
}
