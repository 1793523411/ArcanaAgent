import { ChatOpenAI } from "@langchain/openai";
import { loadModelConfig } from "../config/models.js";

const cache = new Map<string, ChatOpenAI>();

export function getLLM(modelId?: string): ChatOpenAI {
  const { baseUrl, apiKey, modelId: resolved } = loadModelConfig(modelId);
  let llm = cache.get(resolved);
  if (!llm) {
    llm = new ChatOpenAI({
      model: resolved,
      openAIApiKey: apiKey,
      configuration: {
        baseURL: baseUrl,
      },
      temperature: 0,
    });
    cache.set(resolved, llm);
  }
  return llm;
}
