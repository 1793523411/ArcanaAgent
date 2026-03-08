import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), "data");
const CONFIG_PATH = join(DATA_DIR, "user-config.json");

export type McpServerConfig =
  | {
      name: string;
      transport: "stdio";
      command: string;
      args: string[];
      env?: Record<string, string>;
    }
  | {
      name: string;
      transport: "streamablehttp";
      url: string;
      headers?: Record<string, string>;
    };

export type ContextStrategy = "compress" | "trim";

export interface ContextStrategyConfig {
  strategy: ContextStrategy;
  /** 截断策略：保留最近 N 条非 system 消息 */
  trimToLast: number;
  /** 当估算 token 超过模型上下文窗口的此比例（%）时触发策略。例如 75 表示 75% */
  tokenThresholdPercent: number;
  /** 压缩策略：保留最近 N 条原文，其余做摘要 */
  compressKeepRecent: number;
}

export interface UserConfig {
  enabledToolIds: string[];
  mcpServers: McpServerConfig[];
  modelId?: string;
  context?: ContextStrategyConfig;
}

const defaultContext: ContextStrategyConfig = {
  strategy: "compress",
  trimToLast: 20,
  tokenThresholdPercent: 75,
  compressKeepRecent: 20,
};

const defaultConfig: UserConfig = {
  enabledToolIds: ["calculator", "get_time", "echo", "run_command", "read_file"],
  mcpServers: [],
  context: defaultContext,
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
    const ctx = parsed.context && typeof parsed.context === "object" ? parsed.context : defaultContext;
    return {
      enabledToolIds: Array.isArray(parsed.enabledToolIds) ? parsed.enabledToolIds : (Array.isArray((parsed as { enabledSkillIds?: string[] }).enabledSkillIds) ? (parsed as { enabledSkillIds: string[] }).enabledSkillIds : defaultConfig.enabledToolIds),
      mcpServers: Array.isArray(parsed.mcpServers) ? parsed.mcpServers : defaultConfig.mcpServers,
      modelId: typeof parsed.modelId === "string" ? parsed.modelId : undefined,
      context: {
        strategy: ctx.strategy === "compress" || ctx.strategy === "trim" ? ctx.strategy : defaultContext.strategy,
        trimToLast: typeof ctx.trimToLast === "number" && ctx.trimToLast > 0 ? ctx.trimToLast : defaultContext.trimToLast,
        tokenThresholdPercent: typeof ctx.tokenThresholdPercent === "number" && ctx.tokenThresholdPercent > 0 && ctx.tokenThresholdPercent <= 100 ? ctx.tokenThresholdPercent : defaultContext.tokenThresholdPercent,
        compressKeepRecent: typeof ctx.compressKeepRecent === "number" && ctx.compressKeepRecent > 0 ? ctx.compressKeepRecent : defaultContext.compressKeepRecent,
      },
    };
  } catch {
    return { ...defaultConfig };
  }
}

export function saveUserConfig(config: UserConfig): void {
  ensureDataDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}
