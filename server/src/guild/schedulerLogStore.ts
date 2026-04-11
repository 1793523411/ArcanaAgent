import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { getAgent } from "./guildManager.js";
import type { GuildSchedulerLogEntry } from "./types.js";

const DATA_DIR = resolve(process.env.DATA_DIR ?? join(process.cwd(), "data"));
const GROUPS_DIR = join(DATA_DIR, "guild", "groups");

export const SCHEDULER_LOG_MAX = 120;

export type { GuildSchedulerLogEntry as SchedulerLogEntry };

interface FileShape {
  entries: GuildSchedulerLogEntry[];
}

function logPath(groupId: string): string {
  return join(GROUPS_DIR, groupId, "schedulerLog.json");
}

function ensureGroupDir(groupId: string): void {
  const dir = join(GROUPS_DIR, groupId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function genId(): string {
  return `sch_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function formatDispatchedMessage(agentId: string, taskTitle: string, confidence: number): string {
  const agent = getAgent(agentId);
  const name = agent?.name ?? agentId.slice(0, 8);
  const pct = `${Math.round(confidence * 100)}%`;
  return `自治调度：「${taskTitle}」→ ${name}（置信度 ${pct}）`;
}

function isValidEntry(x: unknown): x is GuildSchedulerLogEntry {
  if (x === null || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.at === "string" &&
    typeof o.groupId === "string" &&
    typeof o.message === "string" &&
    (o.kind === "dispatched" || o.kind === "stalled")
  );
}

export function getSchedulerLog(groupId: string): GuildSchedulerLogEntry[] {
  const p = logPath(groupId);
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as FileShape;
    if (!raw || !Array.isArray(raw.entries)) return [];
    return raw.entries.filter(isValidEntry).slice(0, SCHEDULER_LOG_MAX);
  } catch {
    return [];
  }
}

function saveLog(groupId: string, entries: GuildSchedulerLogEntry[]): void {
  ensureGroupDir(groupId);
  writeFileSync(logPath(groupId), JSON.stringify({ entries }, null, 2));
}

export function appendSchedulerDispatched(
  groupId: string,
  at: string,
  taskId: string,
  agentId: string,
  taskTitle: string,
  confidence: number,
): GuildSchedulerLogEntry {
  const entry: GuildSchedulerLogEntry = {
    id: genId(),
    at,
    kind: "dispatched",
    groupId,
    taskId,
    agentId,
    taskTitle,
    confidence,
    message: formatDispatchedMessage(agentId, taskTitle, confidence),
  };
  const prev = getSchedulerLog(groupId);
  const next = [entry, ...prev].slice(0, SCHEDULER_LOG_MAX);
  saveLog(groupId, next);
  return entry;
}

export function appendSchedulerStalled(
  groupId: string,
  at: string,
  openTaskCount: number,
  message: string,
): GuildSchedulerLogEntry {
  const entry: GuildSchedulerLogEntry = {
    id: genId(),
    at,
    kind: "stalled",
    groupId,
    openTaskCount,
    message,
  };
  const prev = getSchedulerLog(groupId);
  const next = [entry, ...prev].slice(0, SCHEDULER_LOG_MAX);
  saveLog(groupId, next);
  return entry;
}

export function clearSchedulerLog(groupId: string): void {
  const p = logPath(groupId);
  if (!existsSync(p)) return;
  try {
    writeFileSync(p, JSON.stringify({ entries: [] }, null, 2));
  } catch {
    // ignore
  }
}
