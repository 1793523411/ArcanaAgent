import { describe, expect, it } from "vitest";
import { createAIMessageWithReasoning, langChainToStored, storedToLangChain } from "./messages.js";

describe("reasoning message metadata", () => {
  it("keeps reasoning_content on tool-call AI messages", () => {
    const msg = createAIMessageWithReasoning({
      content: " ",
      reasoningContent: "look up current facts",
      tool_calls: [{ id: "call_1", name: "web_search", args: { query: "deepseek" } }],
    });

    expect(msg.additional_kwargs?.reasoning_content).toBe("look up current facts");
    expect(msg.tool_calls?.[0]?.name).toBe("web_search");
  });

  it("round-trips stored reasoningContent through LangChain AI messages", () => {
    const restored = storedToLangChain({
      type: "ai",
      content: " ",
      reasoningContent: "must be sent back",
      tool_calls: [{ id: "call_1", name: "read_file", args: "{\"path\":\"README.md\"}" }],
    });

    expect(restored._getType()).toBe("ai");
    expect(restored.additional_kwargs?.reasoning_content).toBe("must be sent back");

    const stored = langChainToStored(restored);
    expect(stored.reasoningContent).toBe("must be sent back");
  });
});
