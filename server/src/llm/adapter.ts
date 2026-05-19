import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { loadModelConfig, getModelReasoningConfig } from "../config/models.js";
import type { ModelReasoningConfig, ReasoningEffort } from "../config/models.js";
import { streamChatCompletionsWithReasoning } from "./streamWithReasoning.js";
import type { StreamReasoningResult, ToolCallResult } from "./streamWithReasoning.js";
import type { BaseMessage } from "@langchain/core/messages";

export type { ToolCallResult };
export type { StreamReasoningResult };

export type ChatModel = ChatOpenAI | ChatAnthropic;

interface AnthropicAdaptiveThinking {
  type: "adaptive";
  display: "summarized";
}

interface AnthropicOutputConfig {
  effort: ReasoningEffort;
}

interface AnthropicReasoningOptions {
  maxTokens: number;
  temperature: 1;
  thinking: { type: "enabled"; budget_tokens: number };
  invocationKwargs?: Record<string, unknown>;
}

export interface ModelAdapter {
  readonly modelId: string;
  /** 是否支持原生 reasoning 流式输出（OpenAI 兼容且 reasoning: true 的模型） */
  supportsReasoningStream(): boolean;
  /** 获取 LangChain 模型实例 */
  getLLM(): ChatModel;
  /** 流式调用单轮对话（仅 reasoning 路径使用） */
  streamSingleTurn(
    messages: BaseMessage[],
    onToken: (token: string) => void,
    onReasoningToken: (token: string) => void,
    tools?: Array<Record<string, unknown>>,
    abortSignal?: AbortSignal
  ): Promise<StreamReasoningResult>;
}

class OpenAICompatibleAdapter implements ModelAdapter {
  readonly modelId: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly reasoning: ModelReasoningConfig;
  private _llm?: ChatModel;

  constructor(config: { baseUrl: string; apiKey: string; modelId: string; reasoning: ModelReasoningConfig }) {
    this.modelId = config.modelId;
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.reasoning = config.reasoning;
  }

  supportsReasoningStream(): boolean {
    return this.reasoning.enabled;
  }

  getLLM(): ChatModel {
    if (!this._llm) {
      this._llm = new ChatOpenAI({
        model: this.modelId,
        openAIApiKey: this.apiKey,
        configuration: { baseURL: this.baseUrl },
        // reasoning 模型要求 temperature=1
        temperature: this.reasoning.enabled ? 1 : 0,
      });
    }
    return this._llm;
  }

  streamSingleTurn(
    messages: BaseMessage[],
    onToken: (token: string) => void,
    onReasoningToken: (token: string) => void,
    tools?: Array<Record<string, unknown>>,
    abortSignal?: AbortSignal
  ): Promise<StreamReasoningResult> {
    // reasoning 模型要求 temperature=1
    return streamChatCompletionsWithReasoning(
      this.baseUrl, this.apiKey, this.modelId, messages, onToken, onReasoningToken, tools,
      this.reasoning.enabled ? 1 : 0,
      abortSignal
    );
  }
}

/**
 * Build Anthropic-specific options for the underlying LangChain ChatAnthropic call.
 *
 * ⚠️  Version-coupling notice (@langchain/anthropic ^0.3.34):
 *   For "adaptive" mode we exploit two pieces of internal LangChain behaviour:
 *     1. The constructor only opts into the extended-thinking validation branch
 *        when `thinking.type === "enabled"` (see chat_models.js `invocationParams`).
 *     2. `invocationParams()` spreads `thinking: this.thinking` first, then
 *        `...this.invocationKwargs` — so the spread order lets our adaptive
 *        thinking payload override the placeholder.
 *   The Anthropic SDK type (BetaThinkingConfigParam) currently only has
 *   "enabled" | "disabled"; `{ type: "adaptive", display: "summarized" }` is
 *   forwarded as-is (Record<string, any>) and only accepted by Anthropic
 *   endpoints that support adaptive thinking (Claude Opus 4.7+).
 *   If the package is upgraded to 0.4.x or beyond, re-verify spread order and
 *   the adaptive thinking schema before shipping. The version is pinned to
 *   `~0.3.34` in package.json to avoid silent regressions.
 */
export function buildAnthropicReasoningOptions(reasoning: ModelReasoningConfig): AnthropicReasoningOptions {
  if (reasoning.mode === "adaptive") {
    const thinking: AnthropicAdaptiveThinking = { type: "adaptive", display: "summarized" };
    const outputConfig: AnthropicOutputConfig = { effort: reasoning.effort };
    return {
      maxTokens: 16000,
      temperature: 1,
      // Placeholder: LangChain 0.3.x only enters its "thinking enabled" branch
      // for this legacy shape; the real payload is supplied via invocationKwargs.
      thinking: { type: "enabled", budget_tokens: 1024 },
      invocationKwargs: {
        thinking,
        output_config: outputConfig,
      },
    };
  }

  return {
    maxTokens: 16000,
    temperature: 1,
    thinking: { type: "enabled", budget_tokens: reasoning.budgetTokens },
  };
}

class AnthropicAdapter implements ModelAdapter {
  readonly modelId: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly reasoning: ModelReasoningConfig;
  private _llm?: ChatModel;

  constructor(config: { baseUrl: string; apiKey: string; modelId: string; reasoning: ModelReasoningConfig }) {
    this.modelId = config.modelId;
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.reasoning = config.reasoning;
  }

  supportsReasoningStream(): boolean {
    // Anthropic 的 thinking 内容通过 LangChain ChatAnthropic 的 content blocks 原生返回
    // (content 数组中 type="thinking" 的块)，不需要像 OpenAI 兼容模型那样绕过 LangChain。
    // OpenAI 兼容模型的 reasoning_content 是独立字段，LangChain ChatOpenAI 不透传，
    // 所以才需要 streamWithReasoning.ts 直接调原生 HTTP API。
    //
    // [优化方向] 如果未来要统一为生产级架构，可以给 AnthropicAdapter 也实现
    // streamSingleTurn()（直接调 Anthropic /v1/messages SSE），这样就能删除
    // index.ts 中的 LangChain fallback 路径 (路径 2)，将两套 ~200 行的重复循环
    // 合并为一套，降低维护成本。当前方案功能无损，优先级不高。
    return false;
  }

  getLLM(): ChatModel {
    if (!this._llm) {
      if (this.reasoning.enabled) {
        const reasoningOptions = buildAnthropicReasoningOptions(this.reasoning);
        this._llm = new ChatAnthropic({
          model: this.modelId,
          anthropicApiKey: this.apiKey,
          anthropicApiUrl: this.baseUrl,
          ...reasoningOptions,
        });
      } else {
        this._llm = new ChatAnthropic({
          model: this.modelId,
          anthropicApiKey: this.apiKey,
          anthropicApiUrl: this.baseUrl,
          maxTokens: 8192,
          temperature: 0,
        });
      }
    }
    return this._llm;
  }

  streamSingleTurn(): Promise<StreamReasoningResult> {
    throw new Error("AnthropicAdapter does not support native reasoning stream — use getLLM() instead");
  }
}

const adapterCache = new Map<string, ModelAdapter>();

export function getModelAdapter(modelId?: string): ModelAdapter {
  // Use the original modelId (may include provider prefix) as cache key
  // to avoid collisions between same model IDs from different providers
  const cacheKey = modelId ?? "__default__";
  const cached = adapterCache.get(cacheKey);
  if (cached) return cached;

  const { baseUrl, apiKey, modelId: resolved, api } = loadModelConfig(modelId);
  const reasoning = getModelReasoningConfig(modelId);
  const adapter: ModelAdapter =
    api === "anthropic-messages"
      ? new AnthropicAdapter({ baseUrl, apiKey, modelId: resolved, reasoning })
      : new OpenAICompatibleAdapter({ baseUrl, apiKey, modelId: resolved, reasoning });

  adapterCache.set(cacheKey, adapter);
  return adapter;
}
