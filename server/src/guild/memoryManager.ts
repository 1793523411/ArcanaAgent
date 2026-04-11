import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
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

function loadIndex(agentId: string): AgentMemory[] {
  const p = indexPath(agentId);
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, "utf-8")) as AgentMemory[]; } catch { return []; }
}

function saveIndex(agentId: string, memories: AgentMemory[]): void {
  ensureDir(memoryBaseDir(agentId));
  writeFileSync(indexPath(agentId), JSON.stringify(memories, null, 2));
}

// ─── CRUD ───────────────────────────────────────────────────────

export function saveMemory(agentId: string, params: {
  type: MemoryType;
  title: string;
  content: string;
  tags: string[];
  relatedAssets?: string[];
}): AgentMemory {
  const memories = loadIndex(agentId);
  const now = new Date().toISOString();
  const memory: AgentMemory = {
    id: genId("mem"),
    type: params.type,
    title: params.title,
    content: params.content,
    tags: params.tags,
    relatedAssets: params.relatedAssets,
    createdAt: now,
    accessCount: 0,
  };
  memories.push(memory);
  saveIndex(agentId, memories);

  // Also write individual memory file
  const dir = memoryTypeDir(agentId, params.type);
  ensureDir(dir);
  const filePath = join(dir, `${memory.id}.md`);
  const content = `# ${params.title}\n\n${params.content}\n\n---\nTags: ${params.tags.join(", ")}\nCreated: ${now}\n`;
  writeFileSync(filePath, content);

  guildEventBus.emit({ type: "agent_memory_settled", agentId, memoryId: memory.id });
  return memory;
}

export function getMemories(agentId: string, query?: {
  types?: MemoryType[];
  tags?: string[];
  limit?: number;
}): AgentMemory[] {
  let memories = loadIndex(agentId);
  if (query?.types && query.types.length > 0) {
    memories = memories.filter((m) => query.types!.includes(m.type));
  }
  if (query?.tags && query.tags.length > 0) {
    const tagSet = new Set(query.tags.map((t) => t.toLowerCase()));
    memories = memories.filter((m) =>
      m.tags.some((t) => tagSet.has(t.toLowerCase()))
    );
  }
  // Sort by recency and access count
  memories.sort((a, b) => {
    const timeScore = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    const accessScore = (b.accessCount - a.accessCount) * 1000 * 60 * 60; // weight access count
    return timeScore + accessScore;
  });
  if (query?.limit) {
    memories = memories.slice(0, query.limit);
  }
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

/** Search memories by keyword matching against title, content, and tags */
export function searchRelevant(agentId: string, taskDescription: string, limit = 10): AgentMemory[] {
  const memories = loadIndex(agentId);
  const keywords = taskDescription
    .toLowerCase()
    .split(/[\s,;.!?]+/)
    .filter((w) => w.length > 2);

  const scored = memories.map((m) => {
    const text = `${m.title} ${m.content} ${m.tags.join(" ")}`.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (text.includes(kw)) score++;
    }
    // Boost by access count and recency
    const ageDays = (Date.now() - new Date(m.createdAt).getTime()) / (1000 * 60 * 60 * 24);
    const recencyBoost = Math.max(0, 1 - ageDays / 30); // decay over 30 days
    score += recencyBoost * 0.5;
    score += Math.min(m.accessCount / 10, 0.5);
    return { memory: m, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => {
      // Increment access count
      s.memory.accessCount++;
      s.memory.lastAccessedAt = new Date().toISOString();
      return s.memory;
    });
}

/** Auto-generate experience memory after task completion */
export function settleExperience(agentId: string, task: GuildTask, result: TaskResult): AgentMemory {
  const tags = [
    task.title.split(/\s+/).filter((w) => w.length > 2).slice(0, 5),
    task.priority,
    task.groupId,
  ].flat();

  return saveMemory(agentId, {
    type: "experience",
    title: `Completed: ${task.title}`,
    content: [
      `## Task`,
      task.description,
      ``,
      `## Result`,
      result.summary,
      result.agentNotes ? `\n## Notes\n${result.agentNotes}` : "",
    ].join("\n"),
    tags,
    relatedAssets: undefined,
  });
}
