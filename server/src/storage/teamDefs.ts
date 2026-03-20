import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, resolve } from "path";

const DATA_DIR = resolve(process.env.DATA_DIR ?? join(process.cwd(), "data"));
const TEAMS_FILE = join(DATA_DIR, "teams.json");

export interface TeamDef {
  id: string;
  name: string;
  description: string;
  agents: string[];
  coordinatorPrompt?: string;
  builtIn: boolean;
}

const BUILT_IN_TEAMS: TeamDef[] = [
  {
    id: "default",
    name: "Dev Team",
    description: "默认开发团队：包含 Planner、Coder、Reviewer、Tester",
    agents: ["planner", "coder", "reviewer", "tester"],
    builtIn: true,
  },
];

function load(): TeamDef[] {
  if (!existsSync(TEAMS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(TEAMS_FILE, "utf-8")) as TeamDef[];
  } catch {
    return [];
  }
}

function save(teams: TeamDef[]): void {
  writeFileSync(TEAMS_FILE, JSON.stringify(teams, null, 2));
}

/** Ensure built-in teams exist. Call once at startup. */
export function ensureBuiltInTeams(): void {
  const existing = load();
  const existingIds = new Set(existing.map((t) => t.id));
  let changed = false;
  for (const builtin of BUILT_IN_TEAMS) {
    if (!existingIds.has(builtin.id)) {
      existing.push(builtin);
      changed = true;
    }
  }
  if (changed || existing.length === 0) {
    save(existing);
  }
}

export function listTeamDefs(): TeamDef[] {
  ensureBuiltInTeams();
  return load();
}

export function getTeamDef(id: string): TeamDef | null {
  const teams = listTeamDefs();
  return teams.find((t) => t.id === id) ?? null;
}

export function createTeamDef(
  data: Omit<TeamDef, "id" | "builtIn">
): TeamDef {
  const teams = load();
  const id = `team_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const def: TeamDef = { ...data, id, builtIn: false };
  teams.push(def);
  save(teams);
  return def;
}

export function updateTeamDef(
  id: string,
  data: Partial<Omit<TeamDef, "id" | "builtIn">>
): TeamDef | null {
  const teams = load();
  const idx = teams.findIndex((t) => t.id === id);
  if (idx < 0) return null;
  teams[idx] = { ...teams[idx], ...data };
  save(teams);
  return teams[idx];
}

export function deleteTeamDef(id: string): boolean {
  const teams = load();
  const idx = teams.findIndex((t) => t.id === id);
  if (idx < 0) return false;
  if (teams[idx].builtIn) return false; // cannot delete built-in
  teams.splice(idx, 1);
  save(teams);
  return true;
}
