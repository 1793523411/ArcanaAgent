import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 开发模式使用项目配置，生产模式使用用户主目录配置
const isDev = process.env.IS_DEV === 'true';
const configPath = isDev
  ? join(__dirname, "../../../config/models.json")
  : join(homedir(), ".arcana-agent", "models.json");

export interface ModelSpec {
  id: string;
  name: string;
  api: string;
  contextWindow: number;
  maxTokens: number;
  input?: string[];
  /** 是否支持深度思考（返回 reasoning_content） */
  reasoning?: boolean;
}

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  api: string;
  models: ModelSpec[];
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  maxTokens: number;
  supportsImage?: boolean;
  supportsReasoning?: boolean;
}

/** 读取 providers 配置 */
function readProviders(): Record<string, ProviderConfig> {
  const raw = readFileSync(configPath, "utf-8");
  const json = JSON.parse(raw) as { models?: { providers?: Record<string, ProviderConfig> } };
  return json.models?.providers ?? {};
}

/**
 * 解析模型标识符并查找模型。
 * 支持 "provider:rawId" 复合格式（精准匹配 provider）和 "rawId" 兼容格式（遍历所有 provider 取第一个匹配）。
 */
function resolveModel(
  modelId: string | undefined,
  providers: Record<string, ProviderConfig>
): { model: ModelSpec; providerCfg: ProviderConfig; providerName: string } | undefined {
  if (!modelId) return undefined;

  // 复合 key: "provider:rawId"
  const colonIdx = modelId.indexOf(":");
  if (colonIdx > 0) {
    const providerName = modelId.slice(0, colonIdx);
    const rawId = modelId.slice(colonIdx + 1);
    const cfg = providers[providerName];
    if (cfg) {
      const found = cfg.models?.find((m) => m.id === rawId);
      if (found) return { model: found, providerCfg: cfg, providerName };
    }
  }

  // 兼容: 无前缀时遍历所有 provider 取第一个匹配
  for (const [providerName, cfg] of Object.entries(providers)) {
    const c = cfg as ProviderConfig;
    const found = c.models?.find((m) => m.id === modelId);
    if (found) return { model: found, providerCfg: c, providerName };
  }
  return undefined;
}

export function listModels(): ModelInfo[] {
  const providers = readProviders();
  const out: ModelInfo[] = [];
  for (const [provider, cfg] of Object.entries(providers)) {
    const c = cfg as ProviderConfig;
    for (const m of c.models ?? []) {
      const input = Array.isArray((m as { input?: string[] }).input) ? (m as { input: string[] }).input : [];
      out.push({
        id: `${provider}:${m.id}`,
        name: m.name,
        provider,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        supportsImage: input.includes("image"),
        supportsReasoning: (m as { reasoning?: boolean }).reasoning === true,
      });
    }
  }
  return out;
}

export function loadModelConfig(modelId?: string): { baseUrl: string; apiKey: string; modelId: string; api: string } {
  const providers = readProviders();
  const resolved = resolveModel(modelId, providers);
  let model = resolved?.model;
  let providerCfg = resolved?.providerCfg;
  if (!model || !providerCfg) {
    const volc = providers.volcengine as ProviderConfig | undefined;
    providerCfg = volc;
    model = volc?.models?.[0];
  }
  if (!model || !providerCfg) throw new Error("No model configured");
  const apiKey = process.env.VOLCENGINE_API_KEY ?? providerCfg.apiKey;
  return {
    baseUrl: providerCfg.baseUrl,
    apiKey,
    modelId: model.id,
    api: model.api || providerCfg.api || "openai-completions",
  };
}

/** 获取模型的上下文窗口大小（token 数） */
export function getModelContextWindow(modelId?: string): number {
  const providers = readProviders();
  const resolved = resolveModel(modelId, providers);
  const model = resolved?.model ?? (providers.volcengine as ProviderConfig | undefined)?.models?.[0];
  return model?.contextWindow ?? 128000;
}

/** 模型是否支持思考（返回 reasoning_content） */
export function getModelReasoning(modelId?: string): boolean {
  const providers = readProviders();
  const resolved = resolveModel(modelId, providers);
  const model = resolved?.model ?? (providers.volcengine as ProviderConfig | undefined)?.models?.[0];
  return (model as ModelSpec | undefined)?.reasoning === true;
}
