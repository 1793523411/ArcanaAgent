import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseMessage } from "@langchain/core/messages";
import {
  streamChatCompletionsWithReasoning,
  type StreamReasoningResult,
} from "@arcana-agent/core";
import type { ModelConfig } from "./types.js";

export type ChatModel = ChatOpenAI | ChatAnthropic;

export interface ModelAdapter {
  readonly modelId: string;
  supportsReasoningStream(): boolean;
  getLLM(): ChatModel;
  streamSingleTurn(
    messages: BaseMessage[],
    onToken: (token: string) => void,
    onReasoningToken: (token: string) => void,
    tools?: Array<Record<string, unknown>>,
    abortSignal?: AbortSignal
  ): Promise<StreamReasoningResult>;
}

export type { StreamReasoningResult };
export type { ToolCallResult, TokenUsage } from "@arcana-agent/core";

class OpenAICompatibleAdapter implements ModelAdapter {
  readonly modelId: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly _reasoning: boolean;
  private readonly _temperature?: number;
  private readonly _maxTokens?: number;
  private _llm?: ChatModel;

  constructor(config: ModelConfig) {
    this.modelId = config.modelId;
    this.baseUrl = config.baseUrl ?? "https://api.openai.com/v1";
    this.apiKey = config.apiKey;
    this._reasoning = config.reasoning ?? false;
    this._temperature = config.temperature;
    this._maxTokens = config.maxTokens;
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
        temperature: this._temperature ?? (this._reasoning ? 1 : 0),
        ...(this._maxTokens ? { maxTokens: this._maxTokens } : {}),
      });
    }
    return this._llm;
  }

  async streamSingleTurn(
    messages: BaseMessage[],
    onToken: (token: string) => void,
    onReasoningToken: (token: string) => void,
    tools?: Array<Record<string, unknown>>,
    abortSignal?: AbortSignal,
  ): Promise<StreamReasoningResult> {
    return streamChatCompletionsWithReasoning(
      this.baseUrl,
      this.apiKey,
      this.modelId,
      messages,
      onToken,
      onReasoningToken,
      tools,
      this._temperature ?? (this._reasoning ? 1 : 0),
      abortSignal,
    );
  }
}

class AnthropicModelAdapter implements ModelAdapter {
  readonly modelId: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly _reasoning: boolean;
  private readonly _temperature?: number;
  private readonly _maxTokens?: number;
  private _llm?: ChatModel;

  constructor(config: ModelConfig) {
    this.modelId = config.modelId;
    this.baseUrl = config.baseUrl ?? "https://api.anthropic.com";
    this.apiKey = config.apiKey;
    this._reasoning = config.reasoning ?? false;
    this._temperature = config.temperature;
    this._maxTokens = config.maxTokens;
  }

  supportsReasoningStream(): boolean {
    return false;
  }

  getLLM(): ChatModel {
    if (!this._llm) {
      if (this._reasoning) {
        this._llm = new ChatAnthropic({
          model: this.modelId,
          anthropicApiKey: this.apiKey,
          anthropicApiUrl: this.baseUrl,
          maxTokens: this._maxTokens ?? 16000,
          temperature: 1,
          thinking: { type: "enabled", budget_tokens: 8000 },
        } as ConstructorParameters<typeof ChatAnthropic>[0]);
      } else {
        this._llm = new ChatAnthropic({
          model: this.modelId,
          anthropicApiKey: this.apiKey,
          anthropicApiUrl: this.baseUrl,
          maxTokens: this._maxTokens ?? 8192,
          temperature: this._temperature ?? 0,
        });
      }
    }
    return this._llm;
  }

  streamSingleTurn(): Promise<StreamReasoningResult> {
    throw new Error("AnthropicAdapter does not support native reasoning stream — use getLLM() stream instead");
  }
}

export function createModelAdapter(config: ModelConfig): ModelAdapter {
  if (config.provider === "anthropic") {
    return new AnthropicModelAdapter(config);
  }
  return new OpenAICompatibleAdapter(config);
}
