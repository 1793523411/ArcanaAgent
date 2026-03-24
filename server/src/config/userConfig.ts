import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 开发模式使用项目 data/ 目录，生产模式使用用户主目录
const isDev = process.env.IS_DEV === 'true';
const DATA_DIR = resolve(process.env.DATA_DIR ?? (isDev
  ? join(__dirname, "../../../data")
  : join(homedir(), ".arcana-agent")));

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
  /** 是否保存工具调用结果到上下文（包含完整输出），关闭则只保存摘要到 toolLogs */
  saveToolMessages?: boolean;
}

export interface PromptTemplate {
  id: string;
  name: string;
  content: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlanningConfig {
  enabled: boolean;
  streamProgress: boolean;
}

export interface ApprovalRule {
  id: string;
  name: string;
  pattern: string;
  operationType: "run_command" | "write_file" | "edit_file";
  enabled: boolean;
}

export const defaultApprovalRules: ApprovalRule[] = [
  {
    id: "builtin_kill_port",
    name: "禁止 kill 3000/3001 端口",
    pattern: "(kill.*30(00|01))|(30(00|01).*kill)|(fuser\\s+-k\\s+30(00|01))",
    operationType: "run_command",
    enabled: true,
  },
];

export type CodeIndexStrategy = "none" | "repomap" | "vector";

export interface UserConfig {
  enabledToolIds: string[];
  mcpServers: McpServerConfig[];
  modelId?: string;
  context?: ContextStrategyConfig;
  planning?: PlanningConfig;
  templates?: PromptTemplate[];
  approvalRules?: ApprovalRule[];
  /** Code index strategy. undefined = auto-detect recommended */
  codeIndexStrategy?: CodeIndexStrategy;
}

const defaultContext: ContextStrategyConfig = {
  strategy: "compress",
  trimToLast: 20,
  tokenThresholdPercent: 75,
  compressKeepRecent: 20,
  saveToolMessages: true,  // 默认开启，保存完整工具输出到上下文
};

const defaultConfig: UserConfig = {
  enabledToolIds: ["get_time", "run_command", "read_file"],
  mcpServers: [],
  context: defaultContext,
  planning: {
    enabled: true,
    streamProgress: true,
  },
  templates: [],
  approvalRules: [...defaultApprovalRules],
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
    const planningRaw = parsed.planning && typeof parsed.planning === "object" ? parsed.planning : undefined;
    const templates = Array.isArray(parsed.templates) ? parsed.templates : [];
    const approvalRulesRaw = Array.isArray(parsed.approvalRules) ? parsed.approvalRules : undefined;
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
      planning: {
        enabled: typeof planningRaw?.enabled === "boolean" ? planningRaw.enabled : true,
        streamProgress: typeof planningRaw?.streamProgress === "boolean" ? planningRaw.streamProgress : true,
      },
      templates: templates.reduce<PromptTemplate[]>((acc, item) => {
        if (!item || typeof item !== "object") return acc;
        const tmpl = item as Partial<PromptTemplate>;
        if (typeof tmpl.id !== "string" || typeof tmpl.name !== "string" || typeof tmpl.content !== "string") return acc;
        acc.push({
          id: tmpl.id,
          name: tmpl.name,
          content: tmpl.content,
          description: typeof tmpl.description === "string" ? tmpl.description : undefined,
          createdAt: typeof tmpl.createdAt === "string" ? tmpl.createdAt : new Date().toISOString(),
          updatedAt: typeof tmpl.updatedAt === "string" ? tmpl.updatedAt : new Date().toISOString(),
        });
        return acc;
      }, []),
      approvalRules: approvalRulesRaw
        ? approvalRulesRaw.reduce<ApprovalRule[]>((acc, item) => {
            if (!item || typeof item !== "object") return acc;
            const rule = item as Partial<ApprovalRule>;
            if (typeof rule.id !== "string" || typeof rule.name !== "string" || typeof rule.pattern !== "string") return acc;
            const opType = rule.operationType;
            if (opType !== "run_command" && opType !== "write_file" && opType !== "edit_file") return acc;
            acc.push({
              id: rule.id,
              name: rule.name,
              pattern: rule.pattern,
              operationType: opType,
              enabled: typeof rule.enabled === "boolean" ? rule.enabled : true,
            });
            return acc;
          }, [])
        : [...defaultApprovalRules],
      codeIndexStrategy: (() => {
        const val = (parsed as Record<string, unknown>).codeIndexStrategy;
        if (val === "none" || val === "repomap" || val === "vector") return val;
        return undefined;
      })(),
    };
  } catch {
    return { ...defaultConfig };
  }
}

export function saveUserConfig(config: UserConfig): void {
  ensureDataDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}
