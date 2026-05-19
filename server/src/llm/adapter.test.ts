import { describe, expect, it } from "vitest";
import { buildAnthropicReasoningOptions } from "./adapter.js";
import type { ModelReasoningConfig } from "../config/models.js";

describe("buildAnthropicReasoningOptions", () => {
  it("builds adaptive thinking payload overrides for Claude Opus 4.7 style models", () => {
    const reasoning: ModelReasoningConfig = {
      enabled: true,
      mode: "adaptive",
      effort: "high",
      budgetTokens: 8000,
    };

    expect(buildAnthropicReasoningOptions(reasoning)).toEqual({
      maxTokens: 16000,
      temperature: 1,
      thinking: { type: "enabled", budget_tokens: 1024 },
      invocationKwargs: {
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "high" },
      },
    });
  });

  it("builds manual thinking payloads for older Claude models", () => {
    const reasoning: ModelReasoningConfig = {
      enabled: true,
      mode: "manual",
      effort: "high",
      budgetTokens: 12000,
    };

    expect(buildAnthropicReasoningOptions(reasoning)).toEqual({
      maxTokens: 16000,
      temperature: 1,
      thinking: { type: "enabled", budget_tokens: 12000 },
    });
  });
});
