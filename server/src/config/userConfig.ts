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
  // ── High-risk command patterns (可由用户禁用) ──
  // 注：git push --force/f 已由 BYPASS_IMMUNE 永久拦截，无需在此重复
  { id: "builtin_rm_rf", name: "rm -rf / rm -r", pattern: "\\brm\\s+(-[^\\s]*\\s+)*-[^\\s]*r", operationType: "run_command", enabled: true },
  { id: "builtin_rm_recursive", name: "rm --recursive", pattern: "\\brm\\s+.*--recursive", operationType: "run_command", enabled: true },
  { id: "builtin_git_reset_hard", name: "git reset --hard", pattern: "\\bgit\\s+reset\\s+--hard", operationType: "run_command", enabled: true },
  { id: "builtin_drop_table", name: "DROP TABLE/DATABASE", pattern: "\\bDROP\\s+(TABLE|DATABASE)", operationType: "run_command", enabled: true },
  { id: "builtin_delete_from", name: "DELETE FROM", pattern: "\\bDELETE\\s+FROM\\b", operationType: "run_command", enabled: true },
  { id: "builtin_truncate", name: "TRUNCATE TABLE", pattern: "\\bTRUNCATE\\s+TABLE", operationType: "run_command", enabled: true },
  { id: "builtin_git_clean", name: "git clean -f", pattern: "\\bgit\\s+clean\\s+-[^\\s]*f", operationType: "run_command", enabled: true },
  { id: "builtin_chmod_777", name: "chmod 777", pattern: "\\bchmod\\s+777\\b", operationType: "run_command", enabled: true },
  { id: "builtin_kill_9", name: "kill -9", pattern: "\\bkill\\s+-9\\b", operationType: "run_command", enabled: true },
  { id: "builtin_kill_port", name: "禁止 kill 3000/3001 端口", pattern: "(kill.*30(00|01))|(30(00|01).*kill)|(fuser\\s+-k\\s+30(00|01))", operationType: "run_command", enabled: true },
  // ── High-risk write patterns (可由用户禁用) ──
  // 注：.env/.pem/.key/credentials 写入已由 BYPASS_IMMUNE 永久拦截，无需在此重复
  { id: "builtin_write_config_json", name: "写入 config.json", pattern: "config\\.json$", operationType: "write_file", enabled: true },
  { id: "builtin_write_gitignore", name: "写入 .gitignore", pattern: "\\.gitignore$", operationType: "write_file", enabled: true },
];

export type CodeIndexStrategy = "none" | "repomap" | "vector";

export interface ClaudeCodeConfig {
  /** 全局开关，默认 false */
  enabled: boolean;
  /** 使用的模型，如 "sonnet", "opus", "claude-sonnet-4-6" */
  model?: string;
  /** 默认最大轮次 */
  maxTurns?: number;
  /** 限制 Claude Code 可用工具 */
  allowedTools?: string[];
}

export interface ExecutionEnhancementsConfig {
  /** LLM 评估 plan step 完成质量 */
  evalGuard: boolean;
  /** 纯算法检测工具调用循环 */
  loopDetection: boolean;
  /** 失败/循环时动态重规划 */
  replan: boolean;
  /** 自动批准重规划（false 时仅建议） */
  autoApproveReplan: boolean;
  /** 外层重试驱动 */
  outerRetry: boolean;
  /** 最大重规划次数 */
  maxReplanAttempts: number;
  /** 外层最大重试次数 */
  maxOuterRetries: number;
  /** 循环检测滑动窗口大小 */
  loopWindowSize: number;
  /** trigram Jaccard 相似度阈值（0-1） */
  loopSimilarityThreshold: number;
}

export const defaultEnhancements: ExecutionEnhancementsConfig = {
  evalGuard: false,
  loopDetection: false,
  replan: false,
  autoApproveReplan: false,
  outerRetry: false,
  maxReplanAttempts: 3,
  maxOuterRetries: 2,
  loopWindowSize: 6,
  loopSimilarityThreshold: 0.7,
};

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
  /** Claude Code 集成配置 */
  claudeCode?: ClaudeCodeConfig;
  /** 执行增强配置（eval、循环检测、重规划等） */
  enhancements?: ExecutionEnhancementsConfig;
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
        saveToolMessages: typeof ctx.saveToolMessages === "boolean" ? ctx.saveToolMessages : defaultContext.saveToolMessages,
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
      approvalRules: (() => {
        const parsed_rules = approvalRulesRaw
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
          : [...defaultApprovalRules];
        // Ensure all builtin rules are present (migrate new defaults into existing config)
        const existingIds = new Set(parsed_rules.map((r) => r.id));
        for (const builtin of defaultApprovalRules) {
          if (!existingIds.has(builtin.id)) {
            parsed_rules.push({ ...builtin });
          }
        }
        return parsed_rules;
      })(),
      codeIndexStrategy: (() => {
        const val = (parsed as Record<string, unknown>).codeIndexStrategy;
        if (val === "none" || val === "repomap" || val === "vector") return val;
        return undefined;
      })(),
      claudeCode: (() => {
        const raw = (parsed as Record<string, unknown>).claudeCode;
        if (!raw || typeof raw !== "object") return undefined;
        const cc = raw as Record<string, unknown>;
        return {
          enabled: typeof cc.enabled === "boolean" ? cc.enabled : false,
          model: typeof cc.model === "string" ? cc.model : undefined,
          maxTurns: typeof cc.maxTurns === "number" ? cc.maxTurns : undefined,
          allowedTools: Array.isArray(cc.allowedTools) ? cc.allowedTools.filter((t: unknown) => typeof t === "string") : undefined,
        };
      })(),
      enhancements: (() => {
        const raw = (parsed as Record<string, unknown>).enhancements;
        if (!raw || typeof raw !== "object") return undefined;
        const e = raw as Record<string, unknown>;
        const d = defaultEnhancements;
        return {
          evalGuard: typeof e.evalGuard === "boolean" ? e.evalGuard : d.evalGuard,
          loopDetection: typeof e.loopDetection === "boolean" ? e.loopDetection : d.loopDetection,
          replan: typeof e.replan === "boolean" ? e.replan : d.replan,
          autoApproveReplan: typeof e.autoApproveReplan === "boolean" ? e.autoApproveReplan : d.autoApproveReplan,
          outerRetry: typeof e.outerRetry === "boolean" ? e.outerRetry : d.outerRetry,
          maxReplanAttempts: typeof e.maxReplanAttempts === "number" && e.maxReplanAttempts > 0 ? e.maxReplanAttempts : d.maxReplanAttempts,
          maxOuterRetries: typeof e.maxOuterRetries === "number" && e.maxOuterRetries > 0 ? e.maxOuterRetries : d.maxOuterRetries,
          loopWindowSize: typeof e.loopWindowSize === "number" && e.loopWindowSize >= 3 ? e.loopWindowSize : d.loopWindowSize,
          loopSimilarityThreshold: typeof e.loopSimilarityThreshold === "number" && e.loopSimilarityThreshold > 0 && e.loopSimilarityThreshold <= 1 ? e.loopSimilarityThreshold : d.loopSimilarityThreshold,
        };
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

/** 是否启用了任何执行增强功能 */
export function hasAnyEnhancement(e?: ExecutionEnhancementsConfig): boolean {
  if (!e) return false;
  return e.evalGuard || e.loopDetection || e.replan;
}
