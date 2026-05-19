import { describe, expect, it } from "vitest";
import { inferAnthropicReasoningMode, resolveModelReasoningConfig, type ModelSpec } from "./models.js";

function makeModel(id: string, patch: Partial<ModelSpec> = {}): ModelSpec {
  return {
    id,
    name: id,
    api: "anthropic-messages",
    contextWindow: 200000,
    maxTokens: 8192,
    reasoning: true,
    ...patch,
  };
}

describe("model reasoning config", () => {
  it("uses adaptive thinking for Claude Opus 4.7", () => {
    expect(inferAnthropicReasoningMode("claude-opus-4-7")).toBe("adaptive");
    expect(resolveModelReasoningConfig(makeModel("claude-opus-4-7"), "anthropic-messages")).toMatchObject({
      enabled: true,
      mode: "adaptive",
      effort: "high",
      budgetTokens: 8000,
    });
  });

  it("keeps older Claude models on manual thinking unless configured otherwise", () => {
    expect(inferAnthropicReasoningMode("claude-sonnet-4-5")).toBe("manual");
    expect(resolveModelReasoningConfig(makeModel("claude-sonnet-4-5"), "anthropic-messages")).toMatchObject({
      enabled: true,
      mode: "manual",
    });
  });

  it("honors explicit reasoning overrides from model config when the target model supports them", () => {
    expect(
      resolveModelReasoningConfig(
        makeModel("claude-opus-4-6", {
          reasoningMode: "manual",
          reasoningEffort: "max",
          reasoningBudgetTokens: 12000,
        }),
        "anthropic-messages"
      )
    ).toEqual({
      enabled: true,
      mode: "manual",
      effort: "max",
      budgetTokens: 12000,
    });
  });

  it("keeps Claude Opus 4.7 on adaptive thinking even if config asks for manual", () => {
    expect(
      resolveModelReasoningConfig(
        makeModel("claude-opus-4-7", {
          reasoningMode: "manual",
          reasoningBudgetTokens: 12000,
        }),
        "anthropic-messages"
      )
    ).toMatchObject({
      enabled: true,
      mode: "adaptive",
      effort: "high",
      budgetTokens: 12000,
    });
  });

  it("does not pass xhigh effort to Anthropic models where it is not supported", () => {
    expect(
      resolveModelReasoningConfig(
        makeModel("claude-sonnet-4-6", {
          reasoningMode: "adaptive",
          reasoningEffort: "xhigh",
        }),
        "anthropic-messages"
      )
    ).toMatchObject({
      mode: "adaptive",
      effort: "high",
    });
  });
});
