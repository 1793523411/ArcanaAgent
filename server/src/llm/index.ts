import { getModelAdapter } from "./adapter.js";
export type { ChatModel } from "./adapter.js";

export function getLLM(modelId?: string) {
  return getModelAdapter(modelId).getLLM();
}
