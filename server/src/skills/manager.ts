import { readdirSync, readFileSync, mkdirSync, existsSync, rmSync, writeFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import AdmZip from "adm-zip";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(process.env.DATA_DIR ?? join(process.cwd(), "data"));
const SKILLS_DIR = resolve(join(DATA_DIR, "skills"));
/** 项目根目录下的默认 skills（随仓库提交，不被 git 忽略） */
const BUILTIN_SKILLS_DIR = resolve(join(__dirname, "..", "..", "..", "skills"));

export interface SkillMeta {
  name: string;
  description: string;
  /** skill 目录的绝对路径 */
  dirPath: string;
  /** 是否来自用户上传（可删除）；否则为内置/示例 */
  userUploaded?: boolean;
}

export interface SkillFull extends SkillMeta {
  /** SKILL.md 去掉 frontmatter 后的完整 body 内容 */
  body: string;
}

const FRONTMATTER_REG = /^---\r?\n([\s\S]*?)\r?\n---/;
const NAME_REG = /^name:\s*["']?([^"'\n]+)["']?\s*$/m;
/** description 整行内容（可能含引号），用 .+ 避免在内容中的 " 处截断 */
const DESC_LINE_REG = /^description:\s*(.+)$/m;

function parseSkillMd(content: string): { name: string; description: string; body: string } | null {
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

function safeName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(name) && name.length <= 64;
}

function ensureSkillsDir(): void {
  if (!existsSync(SKILLS_DIR)) {
    mkdirSync(SKILLS_DIR, { recursive: true });
  }
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

/** 列出所有 skill：先内置（.agents/skills），再用户上传（data/skills），同名时用户上传覆盖显示 */
export function listSkills(): SkillMeta[] {
  ensureSkillsDir();
  const builtin = listSkillsFromDir(BUILTIN_SKILLS_DIR, false);
  const user = listSkillsFromDir(SKILLS_DIR, true);
  const byName = new Map<string, SkillMeta>();
  for (const s of builtin) byName.set(s.name, s);
  for (const s of user) byName.set(s.name, s);
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/** 列出所有 skill 的完整信息（含 body 和目录路径），同名时用户上传覆盖内置 */
export function listFullSkills(): SkillFull[] {
  ensureSkillsDir();
  const builtin = listFullSkillsFromDir(BUILTIN_SKILLS_DIR, false);
  const user = listFullSkillsFromDir(SKILLS_DIR, true);
  const byName = new Map<string, SkillFull>();
  for (const s of builtin) byName.set(s.name, s);
  for (const s of user) byName.set(s.name, s);
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 生成注入 Agent 系统提示的完整 Skill 上下文。
 * 包含每个 skill 的完整 SKILL.md body，并将 <SKILL_PATH> 替换为实际目录路径。
 * 模型可通过 run_command tool 执行 skill 中引用的脚本。
 */
export function getSkillCatalogForAgent(): string {
  const skills = listSkills();
  if (skills.length === 0) return "";
  const lines = skills.map((s) => `- \`${s.name}\` (dir: \`${s.dirPath}\`): ${s.description || "(no description)"}`);
  return [
    "\n\n## Available Skills",
    "",
    "You have access to the following skills. If the task matches a skill, call `load_skill` with the exact skill name before executing the task.",
    "Only load skills that are relevant to the current task.",
    "When executing skill scripts via run_command, always set working_directory to the skill's directory shown in parentheses.",
    "",
    ...lines,
  ].join("\n");
}

export function getSkillContentForAgent(name: string): string {
  const skill = listFullSkills().find((s) => s.name === name);
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

export function getSkillContextForAgent(): string {
  return getSkillCatalogForAgent();
}

/**
 * 从 zip 安装 skill。zip 结构需为：
 * - 根目录下有一个文件夹，且该文件夹内包含 SKILL.md；或
 * - 根目录下直接包含 SKILL.md
 * 安装到 data/skills/<name>/
 */
export function installSkillFromZip(zipBuffer: Buffer): { name: string; description: string } {
  ensureSkillsDir();
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();

  let skillName: string | null = null;
  let skillMdContent: string | null = null;
  const rootNames = new Set<string>();

  for (const e of entries) {
    if (e.isDirectory) continue;
    const path = e.entryName.replace(/\/$/, "");
    const parts = path.split("/");
    rootNames.add(parts[0]);
    if (parts[parts.length - 1] === "SKILL.md") {
      const content = e.getData().toString("utf-8");
      const parsed = parseSkillMd(content);
      if (parsed && safeName(parsed.name)) {
        skillName = parsed.name;
        skillMdContent = content;
        break;
      }
    }
  }

  if (!skillName || !skillMdContent) {
    throw new Error("ZIP 中未找到有效的 SKILL.md（需包含 name 与 description 的 YAML frontmatter）");
  }

  const targetDir = join(SKILLS_DIR, skillName);
  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true });
  }
  mkdirSync(targetDir, { recursive: true });

  const description = parseSkillMd(skillMdContent)?.description ?? "";

  for (const e of entries) {
    if (e.isDirectory) continue;
    const path = e.entryName.replace(/\/$/, "");
    const parts = path.split("/");
    let relativePath: string;
    if (parts.length === 1) {
      relativePath = parts[0];
    } else if (parts.length > 1) {
      const first = parts[0];
      if (rootNames.size === 1 && first !== "SKILL.md") {
        relativePath = parts.slice(1).join("/");
      } else {
        relativePath = path;
      }
    } else {
      continue;
    }
    const destPath = join(targetDir, relativePath);
    const destDir = join(destPath, "..");
    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true });
    }
    const data = e.getData();
    if (Buffer.isBuffer(data)) {
      writeFileSync(destPath, data);
    }
  }

  if (!existsSync(join(targetDir, "SKILL.md"))) {
    writeFileSync(join(targetDir, "SKILL.md"), skillMdContent, "utf-8");
  }

  return { name: skillName, description };
}

/** 删除用户上传的 skill */
export function deleteSkill(name: string): void {
  if (!safeName(name)) throw new Error("Invalid skill name");
  const targetDir = join(SKILLS_DIR, name);
  if (!existsSync(targetDir)) {
    throw new Error("Skill not found");
  }
  rmSync(targetDir, { recursive: true });
}
