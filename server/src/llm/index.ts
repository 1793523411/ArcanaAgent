import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { loadModelConfig } from "../config/models.js";

type ChatModel = ChatOpenAI | ChatAnthropic;

const cache = new Map<string, ChatModel>();

export function getLLM(modelId?: string): ChatModel {
  const { baseUrl, apiKey, modelId: resolved, api } = loadModelConfig(modelId);
  let llm = cache.get(resolved);
  if (!llm) {
    if (api === "anthropic-messages") {
      llm = new ChatAnthropic({
        model: resolved,
        anthropicApiKey: apiKey,
        anthropicApiUrl: baseUrl,
        maxTokens: 8192,
        temperature: 0,
      });
    } else {
      llm = new ChatOpenAI({
        model: resolved,
        openAIApiKey: apiKey,
        configuration: {
          baseURL: baseUrl,
        },
        temperature: 0,
      });
    }
    cache.set(resolved, llm);
  }
  return llm;
}
