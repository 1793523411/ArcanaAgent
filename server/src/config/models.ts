import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 开发模式使用项目配置，生产模式使用用户主目录配置
const isDev = process.env.IS_DEV === 'true';
const configPath = isDev
  ? join(__dirname, "../../../config/models.json")
  : join(homedir(), ".rule-agent", "models.json");

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
  supportsImage?: boolean;
  supportsReasoning?: boolean;
}

export function listModels(): ModelInfo[] {
  const raw = readFileSync(configPath, "utf-8");
  const json = JSON.parse(raw) as { models?: { providers?: Record<string, ProviderConfig> } };
  const providers = json.models?.providers ?? {};
  const out: ModelInfo[] = [];
  for (const [provider, cfg] of Object.entries(providers)) {
    const c = cfg as ProviderConfig;
    for (const m of c.models ?? []) {
      const input = Array.isArray((m as { input?: string[] }).input) ? (m as { input: string[] }).input : [];
      out.push({
        id: m.id,
        name: m.name,
        provider,
        supportsImage: input.includes("image"),
        supportsReasoning: (m as { reasoning?: boolean }).reasoning === true,
      });
    }
  }
  return out;
}

export function loadModelConfig(modelId?: string): { baseUrl: string; apiKey: string; modelId: string; api: string } {
  const raw = readFileSync(configPath, "utf-8");
  const json = JSON.parse(raw) as {
    models: { providers: Record<string, ProviderConfig> };
  };
  const providers = json.models.providers ?? {};
  let model: ModelSpec | undefined;
  let providerCfg: ProviderConfig | undefined;
  if (modelId) {
    for (const [_, cfg] of Object.entries(providers)) {
      const c = cfg as ProviderConfig;
      const found = c.models?.find((m) => m.id === modelId);
      if (found) {
        model = found;
        providerCfg = c;
        break;
      }
    }
  }
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
  const raw = readFileSync(configPath, "utf-8");
  const json = JSON.parse(raw) as { models?: { providers?: Record<string, ProviderConfig> } };
  const providers = json.models?.providers ?? {};
  let model: ModelSpec | undefined;
  if (modelId) {
    for (const cfg of Object.values(providers)) {
      const c = cfg as ProviderConfig;
      const found = c.models?.find((m) => m.id === modelId);
      if (found) {
        model = found;
        break;
      }
    }
  }
  if (!model) {
    const volc = providers.volcengine as ProviderConfig | undefined;
    model = volc?.models?.[0];
  }
  return model?.contextWindow ?? 128000;
}

/** 模型是否支持思考（返回 reasoning_content） */
export function getModelReasoning(modelId?: string): boolean {
  const raw = readFileSync(configPath, "utf-8");
  const json = JSON.parse(raw) as { models?: { providers?: Record<string, ProviderConfig> } };
  const providers = json.models?.providers ?? {};
  let model: ModelSpec | undefined;
  if (modelId) {
    for (const cfg of Object.values(providers)) {
      const c = cfg as ProviderConfig;
      const found = c.models?.find((m) => m.id === modelId);
      if (found) {
        model = found;
        break;
      }
    }
  }
  if (!model) {
    const volc = providers.volcengine as ProviderConfig | undefined;
    model = volc?.models?.[0];
  }
  return (model as ModelSpec | undefined)?.reasoning === true;
}
