import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { createAIMessageWithReasoning } from "../lib/messages.js";
import { estimateBaseMessageTokens } from "../lib/tokenizer.js";
import { pruneConversationIfNeeded } from "./pruning.js";

describe("pruneConversationIfNeeded", () => {
  it("preserves reasoning metadata when rebuilding old tool-call AI messages", () => {
    const firstAi = createAIMessageWithReasoning({
      content: " ",
      reasoningContent: "deepseek thinking metadata",
      tool_calls: [{
        id: "call_1",
        name: "read_file",
        args: { path: "README.md", query: "x".repeat(5000) },
      }],
    });
    const messages = [
      new HumanMessage("start"),
      firstAi,
      new ToolMessage({ content: "result", tool_call_id: "call_1", name: "read_file" }),
      new HumanMessage("follow up 1"),
      new AIMessage("ok 1"),
      new HumanMessage("follow up 2"),
      new AIMessage("ok 2"),
      new HumanMessage("follow up 3"),
      new AIMessage("ok 3"),
      new HumanMessage("follow up 4"),
      new AIMessage("ok 4"),
    ];

    const pruned = pruneConversationIfNeeded(messages, estimateBaseMessageTokens(messages) - 500);
    const rebuiltAi = pruned.find((msg) => (
      msg._getType() === "ai" && Array.isArray((msg as AIMessage).tool_calls)
    )) as AIMessage | undefined;

    expect(rebuiltAi?.additional_kwargs?.reasoning_content).toBe("deepseek thinking metadata");
    expect(JSON.stringify(rebuiltAi?.tool_calls?.[0]?.args ?? {}).length).toBeLessThan(1000);
  });
});
