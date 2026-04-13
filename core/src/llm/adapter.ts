import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { loadModelConfig, getModelReasoning } from "../config/models.js";
import { streamChatCompletionsWithReasoning } from "./streamWithReasoning.js";
import type { StreamReasoningResult, ToolCallResult } from "./streamWithReasoning.js";
import type { BaseMessage } from "@langchain/core/messages";

export type { ToolCallResult };
export type { StreamReasoningResult };

export type ChatModel = ChatOpenAI | ChatAnthropic;

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
  private readonly _reasoning: boolean;
  private _llm?: ChatModel;

  constructor(config: { baseUrl: string; apiKey: string; modelId: string; reasoning: boolean }) {
    this.modelId = config.modelId;
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this._reasoning = config.reasoning;
  }

  supportsReasoningStream(): boolean {
    return this._reasoning;
  }

  getLLM(): ChatModel {
    if (!this._llm) {
      this._llm = new ChatOpenAI({
        model: this.modelId,
        openAIApiKey: this.apiKey,
        configuration: { baseURL: this.baseUrl },
        // reasoning 模型要求 temperature=1
        temperature: this._reasoning ? 1 : 0,
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
      this._reasoning ? 1 : 0,
      abortSignal
    );
  }
}

class AnthropicAdapter implements ModelAdapter {
  readonly modelId: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly _reasoning: boolean;
  private _llm?: ChatModel;

  constructor(config: { baseUrl: string; apiKey: string; modelId: string; reasoning: boolean }) {
    this.modelId = config.modelId;
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this._reasoning = config.reasoning;
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
      if (this._reasoning) {
        // 启用 extended thinking：temperature 必须为 1，budget_tokens 建议 >= 1024
        this._llm = new ChatAnthropic({
          model: this.modelId,
          anthropicApiKey: this.apiKey,
          anthropicApiUrl: this.baseUrl,
          maxTokens: 16000,
          temperature: 1,
          thinking: { type: "enabled", budget_tokens: 8000 },
        } as ConstructorParameters<typeof ChatAnthropic>[0]);
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
const ADAPTER_CACHE_MAX_SIZE = 16;

export function getModelAdapter(modelId?: string): ModelAdapter {
  // Use the original modelId (may include provider prefix) as cache key
  // to avoid collisions between same model IDs from different providers
  const cacheKey = modelId ?? "__default__";
  const cached = adapterCache.get(cacheKey);
  if (cached) {
    // Move to end to maintain LRU order (Map iterates in insertion order)
    adapterCache.delete(cacheKey);
    adapterCache.set(cacheKey, cached);
    return cached;
  }

  const { baseUrl, apiKey, modelId: resolved, api } = loadModelConfig(modelId);
  const reasoning = getModelReasoning(modelId);
  const adapter: ModelAdapter =
    api === "anthropic-messages"
      ? new AnthropicAdapter({ baseUrl, apiKey, modelId: resolved, reasoning })
      : new OpenAICompatibleAdapter({ baseUrl, apiKey, modelId: resolved, reasoning });

  // Evict oldest entry if cache exceeds max size (simple LRU)
  if (adapterCache.size >= ADAPTER_CACHE_MAX_SIZE) {
    const oldest = adapterCache.keys().next().value;
    if (oldest !== undefined) adapterCache.delete(oldest);
  }
  adapterCache.set(cacheKey, adapter);
  return adapter;
}
