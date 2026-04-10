import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { StructuredToolInterface } from "@langchain/core/tools";

export interface SkillMeta {
  name: string;
  description: string;
  dirPath: string;
  userUploaded?: boolean;
}

export interface SkillFull extends SkillMeta {
  body: string;
}

const FRONTMATTER_REG = /^---\r?\n([\s\S]*?)\r?\n---/;
const NAME_REG = /^name:\s*["']?([^"'\n]+)["']?\s*$/m;
const DESC_LINE_REG = /^description:\s*(.+)$/m;

export function parseSkillMd(content: string): { name: string; description: string; body: string } | null {
  const match = content.match(FRONTMATTER_REG);
  if (!match) return null;
  const fm = match[1];
  const nameMatch = fm.match(NAME_REG);
  const name = nameMatch ? nameMatch[1].trim() : "";
  if (!name) return null;
  const descMatch = fm.match(DESC_LINE_REG);
  let description = descMatch ? descMatch[1].trim() : "";
  if (description && ((description.startsWith('"') && description.endsWith('"')) || (description.startsWith("'") && description.endsWith("'")))) {
    description = description.slice(1, -1).trim();
  }
  const body = content.slice(match[0].length).trim();
  return { name, description, body };
}

export function safeName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(name) && name.length <= 64;
}

function listSkillsFromDir(dir: string, userUploaded: boolean): SkillMeta[] {
  if (!existsSync(dir)) return [];
  const result: SkillMeta[] = [];
  const dirs = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const d of dirs) {
    const skillPath = join(dir, d.name);
    const skillMdPath = join(skillPath, "SKILL.md");
    if (!existsSync(skillMdPath)) continue;
    try {
      const content = readFileSync(skillMdPath, "utf-8");
      const parsed = parseSkillMd(content);
      if (parsed && safeName(parsed.name)) {
        result.push({ name: parsed.name, description: parsed.description, dirPath: skillPath, userUploaded });
      }
    } catch {
      // skip invalid
    }
  }
  return result;
}

function listFullSkillsFromDir(dir: string, userUploaded: boolean): SkillFull[] {
  if (!existsSync(dir)) return [];
  const result: SkillFull[] = [];
  const dirs = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const d of dirs) {
    const skillPath = join(dir, d.name);
    const skillMdPath = join(skillPath, "SKILL.md");
    if (!existsSync(skillMdPath)) continue;
    try {
      const content = readFileSync(skillMdPath, "utf-8");
      const parsed = parseSkillMd(content);
      if (parsed && safeName(parsed.name)) {
        result.push({
          name: parsed.name,
          description: parsed.description,
          body: parsed.body,
          dirPath: skillPath,
          userUploaded,
        });
      }
    } catch {
      // skip invalid
    }
  }
  return result;
}

function loadSingleSkill(dirPath: string, userUploaded: boolean): SkillFull | null {
  const skillMdPath = join(dirPath, "SKILL.md");
  if (!existsSync(skillMdPath)) return null;
  try {
    const content = readFileSync(skillMdPath, "utf-8");
    const parsed = parseSkillMd(content);
    if (parsed && safeName(parsed.name)) {
      return { name: parsed.name, description: parsed.description, body: parsed.body, dirPath, userUploaded };
    }
  } catch { /* skip */ }
  return null;
}

export function loadSkillsFromDirs(dirs: string[], userUploaded = false): SkillFull[] {
  const byName = new Map<string, SkillFull>();
  for (const dir of dirs) {
    const direct = loadSingleSkill(dir, userUploaded);
    if (direct) {
      byName.set(direct.name, direct);
    } else {
      const skills = listFullSkillsFromDir(dir, userUploaded);
      for (const s of skills) byName.set(s.name, s);
    }
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function loadSkillsFromMetas(metas: SkillMeta[]): SkillFull[] {
  const results: SkillFull[] = [];
  for (const meta of metas) {
    const skillMdPath = join(meta.dirPath, "SKILL.md");
    if (!existsSync(skillMdPath)) continue;
    try {
      const content = readFileSync(skillMdPath, "utf-8");
      const parsed = parseSkillMd(content);
      if (parsed) {
        results.push({ ...meta, body: parsed.body });
      }
    } catch { /* skip */ }
  }
  return results;
}

export function listSkillsMerged(builtinDir: string, userDir: string): SkillMeta[] {
  const builtin = listSkillsFromDir(builtinDir, false);
  const user = listSkillsFromDir(userDir, true);
  const byName = new Map<string, SkillMeta>();
  for (const s of builtin) byName.set(s.name, s);
  for (const s of user) byName.set(s.name, s);
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function listFullSkillsMerged(builtinDir: string, userDir: string): SkillFull[] {
  const builtin = listFullSkillsFromDir(builtinDir, false);
  const user = listFullSkillsFromDir(userDir, true);
  const byName = new Map<string, SkillFull>();
  for (const s of builtin) byName.set(s.name, s);
  for (const s of user) byName.set(s.name, s);
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function buildSkillCatalog(skills: SkillMeta[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((s) => `- \`${s.name}\` (dir: \`${s.dirPath}\`): ${s.description || "(no description)"}`);
  return [
    "\n\n## Available Skills (NOT tools — cannot be called directly)",
    "",
    "Skills are NOT tools. You CANNOT call a skill name as a tool.",
    "To use a skill, you MUST first call the `load_skill` tool with the skill name.",
    "The `load_skill` tool will return instructions and context for the skill.",
    "Only load skills that are relevant to the current task.",
    "When executing skill scripts via run_command, always set working_directory to the skill's directory shown in parentheses.",
    "",
    ...lines,
  ].join("\n");
}

export function getSkillContentForAgent(skills: SkillFull[], name: string): string {
  const skill = skills.find((s) => s.name === name);
  if (!skill) {
    return `Error: Unknown skill '${name}'.`;
  }
  const resolvedBody = skill.body.replace(/<SKILL_PATH>/g, skill.dirPath);
  return [
    `<skill name="${skill.name}">`,
    `<skill_directory>${skill.dirPath}</skill_directory>`,
    `<important>`,
    `When executing any scripts from this skill, ALWAYS set working_directory to "${skill.dirPath}" in the run_command call.`,
    `All script paths shown below are absolute paths. Use them exactly as shown.`,
    `If a script references relative paths (e.g., ./images/, ./output/), they are relative to the skill directory above.`,
    `</important>`,
    resolvedBody,
    `</skill>`,
  ].join("\n");
}

export function createLoadSkillTool(skills: SkillFull[]): StructuredToolInterface {
  return tool(
    (input: { name: string }) => {
      const name = input.name.trim();
      if (!name) return "Error: Skill name is required.";
      return getSkillContentForAgent(skills, name);
    },
    {
      name: "load_skill",
      description:
        "Load the full instructions of a skill by exact name. " +
        "Use this before executing a task that matches an available skill.",
      schema: z.object({
        name: z.string().describe("Exact skill name from Available Skills list"),
      }),
    }
  ) as unknown as StructuredToolInterface;
}
