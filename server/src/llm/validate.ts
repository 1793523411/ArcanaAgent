/**
 * 模型验证模块 — 轻量级探测模型连通性、工具调用支持等能力。
 * 验证时禁用 reasoning/thinking 以最大化速度。
 * 验证结果持久化到 data/model-validations.json。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { loadModelConfig, listProvidersRaw } from "../config/models.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = process.env.IS_DEV === 'true';
const DATA_DIR = resolve(process.env.DATA_DIR ?? (isDev
  ? join(__dirname, "../../../data")
  : join(homedir(), ".arcana-agent")));
const VALIDATIONS_PATH = join(DATA_DIR, "model-validations.json");

export interface ValidationResult {
  modelId: string;       // "provider:rawId"
  provider: string;
  modelName: string;
  status: "success" | "error" | "warning";
  connectivity: boolean;
  toolUse: boolean;
  latencyMs: number;
  error?: string;
  validatedAt?: string;  // ISO timestamp
}

const TIMEOUT_MS = 60000;

/** 用于测试 tool calling 的最小工具定义 */
const TEST_TOOL_OPENAI = {
  type: "function" as const,
  function: {
    name: "get_current_time",
    description: "Get the current server time. Must be called to answer time-related questions.",
    parameters: { type: "object", properties: {}, required: [] },
  },
};

const TEST_TOOL_ANTHROPIC = {
  name: "get_current_time",
  description: "Get the current server time. Must be called to answer time-related questions.",
  input_schema: { type: "object", properties: {} },
};

const TEST_PROMPT = "What time is it right now? Use the get_current_time tool to check.";

/**
 * 验证单个模型
 */
export async function validateModel(compositeId: string): Promise<ValidationResult> {
  const colonIdx = compositeId.indexOf(":");
  const providerName = colonIdx > 0 ? compositeId.slice(0, colonIdx) : "unknown";
  const rawModelId = colonIdx > 0 ? compositeId.slice(colonIdx + 1) : compositeId;

  const providers = listProvidersRaw();
  const providerCfg = providers[providerName];
  const modelSpec = providerCfg?.models?.find((m) => m.id === rawModelId);
  const modelName = modelSpec?.name ?? rawModelId;

  const base: Omit<ValidationResult, "status" | "connectivity" | "toolUse" | "latencyMs"> = {
    modelId: compositeId, provider: providerName, modelName,
  };

  let cfg: { baseUrl: string; apiKey: string; modelId: string; api: string };
  try {
    cfg = loadModelConfig(compositeId);
  } catch (e) {
    return { ...base, status: "error", connectivity: false, toolUse: false, latencyMs: 0, error: `Config error: ${e}` };
  }

  const isAnthropic = cfg.api === "anthropic-messages";
  const start = Date.now();

  try {
    if (isAnthropic) {
      return await validateAnthropic(cfg, base, start);
    } else {
      return await validateOpenAI(cfg, base, start);
    }
  } catch (e) {
    const latencyMs = Date.now() - start;
    const errMsg = e instanceof Error ? e.message : String(e);
    // 区分超时与其他错误
    const isTimeout = errMsg.includes("abort") || errMsg.includes("timeout");
    return { ...base, status: "error", connectivity: !isTimeout, toolUse: false, latencyMs, error: isTimeout ? `Timeout (${TIMEOUT_MS}ms)` : errMsg };
  }
}

/** OpenAI-compatible API 验证 — 不启用 reasoning，最小 token */
async function validateOpenAI(
  cfg: { baseUrl: string; apiKey: string; modelId: string },
  base: Omit<ValidationResult, "status" | "connectivity" | "toolUse" | "latencyMs">,
  start: number,
): Promise<ValidationResult> {
  const url = `${cfg.baseUrl}/chat/completions`;

  // 新版 OpenAI 模型要求 max_completion_tokens，旧版/兼容 API 使用 max_tokens
  // 先尝试 max_completion_tokens，若 400 报错则回退到 max_tokens
  // 不设置 temperature — 部分模型（如 GPT-5）不支持 temperature=0
  const baseBody = {
    model: cfg.modelId,
    messages: [{ role: "user", content: TEST_PROMPT }],
    tools: [TEST_TOOL_OPENAI],
  };

  let resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ ...baseBody, max_completion_tokens: 100 }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  // 如果 400 且提到 max_completion_tokens 不支持，用 max_tokens 重试
  if (resp.status === 400) {
    const errText = await resp.text().catch(() => "");
    if (errText.includes("max_completion_tokens")) {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ ...baseBody, max_tokens: 100 }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } else {
      // 其他 400 错误直接返回
      const latencyMs = Date.now() - start;
      return { ...base, status: "error", connectivity: true, toolUse: false, latencyMs, error: `HTTP 400: ${errText.slice(0, 200)}` };
    }
  }

  const latencyMs = Date.now() - start;
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    return { ...base, status: "error", connectivity: true, toolUse: false, latencyMs, error: `HTTP ${resp.status}: ${text.slice(0, 200)}` };
  }

  const json = await resp.json() as {
    choices?: Array<{ message?: { content?: string; tool_calls?: unknown[] } }>;
  };
  const msg = json.choices?.[0]?.message;
  const hasToolCall = Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0;
  const hasContent = typeof msg?.content === "string" && msg.content.length > 0;

  if (!hasToolCall && !hasContent) {
    return { ...base, status: "warning", connectivity: true, toolUse: false, latencyMs, error: "Empty response" };
  }

  return {
    ...base,
    status: "success",
    connectivity: true,
    toolUse: hasToolCall,
    latencyMs,
    error: !hasToolCall ? "No tool calling support" : undefined,
  };
}

/** Anthropic Messages API 验证 — 不启用 thinking，最小 token */
async function validateAnthropic(
  cfg: { baseUrl: string; apiKey: string; modelId: string },
  base: Omit<ValidationResult, "status" | "connectivity" | "toolUse" | "latencyMs">,
  start: number,
): Promise<ValidationResult> {
  let url = cfg.baseUrl.replace(/\/+$/, "");
  if (!url.endsWith("/v1")) url += "/v1";
  url += "/messages";

  // 不启用 thinking — 验证速度优先
  const body = {
    model: cfg.modelId,
    max_tokens: 50,
    messages: [{ role: "user", content: TEST_PROMPT }],
    tools: [TEST_TOOL_ANTHROPIC],
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const latencyMs = Date.now() - start;
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    return { ...base, status: "error", connectivity: true, toolUse: false, latencyMs, error: `HTTP ${resp.status}: ${text.slice(0, 200)}` };
  }

  const json = await resp.json() as {
    content?: Array<{ type: string; text?: string; name?: string }>;
  };
  const blocks = json.content ?? [];
  const hasToolUse = blocks.some((b) => b.type === "tool_use");
  const hasText = blocks.some((b) => b.type === "text" && b.text && b.text.length > 0);

  if (!hasToolUse && !hasText) {
    return { ...base, status: "warning", connectivity: true, toolUse: false, latencyMs, error: "Empty response" };
  }

  return {
    ...base,
    status: "success",
    connectivity: true,
    toolUse: hasToolUse,
    latencyMs,
    error: !hasToolUse ? "No tool calling support" : undefined,
  };
}

/**
 * 验证多个模型（并发，限制最多 3 个同时）并持久化结果
 */
export async function validateModels(modelIds: string[]): Promise<ValidationResult[]> {
  const CONCURRENCY = 3;
  const results: ValidationResult[] = [];
  for (let i = 0; i < modelIds.length; i += CONCURRENCY) {
    const batch = modelIds.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map((id) => validateModel(id)));
    results.push(...batchResults);
  }
  // 持久化
  const stored = loadValidationResults();
  for (const r of results) {
    stored[r.modelId] = { ...r, validatedAt: new Date().toISOString() };
  }
  saveValidationResults(stored);
  return results;
}

/**
 * 验证所有配置的模型
 */
export async function validateAllModels(): Promise<ValidationResult[]> {
  const providers = listProvidersRaw();
  const ids: string[] = [];
  for (const [name, cfg] of Object.entries(providers)) {
    for (const m of cfg.models ?? []) {
      ids.push(`${name}:${m.id}`);
    }
  }
  return validateModels(ids);
}

// ─── Validation Result Persistence ──────────────────────

/** 加载已保存的验证结果 */
export function loadValidationResults(): Record<string, ValidationResult> {
  try {
    if (!existsSync(VALIDATIONS_PATH)) return {};
    const raw = readFileSync(VALIDATIONS_PATH, "utf-8");
    return JSON.parse(raw) as Record<string, ValidationResult>;
  } catch {
    return {};
  }
}

/** 保存验证结果 */
function saveValidationResults(data: Record<string, ValidationResult>): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(VALIDATIONS_PATH, JSON.stringify(data, null, 2), "utf-8");
}

/** 清除指定 provider 下所有模型的验证结果（provider 配置变更时调用） */
export function clearProviderValidations(providerName: string): void {
  const stored = loadValidationResults();
  let changed = false;
  for (const key of Object.keys(stored)) {
    if (key.startsWith(`${providerName}:`)) {
      delete stored[key];
      changed = true;
    }
  }
  if (changed) saveValidationResults(stored);
}
