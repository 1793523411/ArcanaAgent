import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = join(__dirname, "../../../config/models.json");

export interface ModelSpec {
  id: string;
  name: string;
  api: string;
  contextWindow: number;
  maxTokens: number;
  input?: string[];
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
      });
    }
  }
  return out;
}

export function loadModelConfig(modelId?: string): { baseUrl: string; apiKey: string; modelId: string } {
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
