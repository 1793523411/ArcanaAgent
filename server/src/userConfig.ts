import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), "data");
const CONFIG_PATH = join(DATA_DIR, "user-config.json");

export interface McpServerConfig {
  name: string;
  transport: "stdio";
  command: string;
  args: string[];
}

export interface UserConfig {
  enabledSkillIds: string[];
  mcpServers: McpServerConfig[];
  modelId?: string;
}

const defaultConfig: UserConfig = {
  enabledSkillIds: ["calculator", "get_time", "echo"],
  mcpServers: [],
};

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function loadUserConfig(): UserConfig {
  ensureDataDir();
  if (!existsSync(CONFIG_PATH)) {
    return { ...defaultConfig };
  }
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<UserConfig>;
    return {
      enabledSkillIds: Array.isArray(parsed.enabledSkillIds) ? parsed.enabledSkillIds : defaultConfig.enabledSkillIds,
      mcpServers: Array.isArray(parsed.mcpServers) ? parsed.mcpServers : defaultConfig.mcpServers,
      modelId: typeof parsed.modelId === "string" ? parsed.modelId : undefined,
    };
  } catch {
    return { ...defaultConfig };
  }
}

export function saveUserConfig(config: UserConfig): void {
  ensureDataDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}
