export interface ModelSpec {
  id: string;
  name: string;
  api: string;
  contextWindow: number;
  maxTokens: number;
  input?: string[];
  reasoning?: boolean;
}

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  api: string;
  models: ModelSpec[];
}

export interface ModelConfigResult {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  api: string;
}

export interface ModelConfigProvider {
  loadModelConfig(modelId?: string): ModelConfigResult;
  getModelContextWindow(modelId?: string): number;
  getModelReasoning(modelId?: string): boolean;
}

let _provider: ModelConfigProvider = {
  loadModelConfig(modelId?: string): ModelConfigResult {
    throw new Error("ModelConfigProvider not set. Call setModelConfigProvider() first.");
  },
  getModelContextWindow(): number {
    return 128000;
  },
  getModelReasoning(): boolean {
    return false;
  },
};

export function setModelConfigProvider(provider: ModelConfigProvider): void {
  _provider = provider;
}

export function loadModelConfig(modelId?: string): ModelConfigResult {
  return _provider.loadModelConfig(modelId);
}

export function getModelContextWindow(modelId?: string): number {
  return _provider.getModelContextWindow(modelId);
}

export function getModelReasoning(modelId?: string): boolean {
  return _provider.getModelReasoning(modelId);
}
