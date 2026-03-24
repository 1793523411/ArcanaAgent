import { BaseMessage, AIMessage, ToolMessage, HumanMessage } from "@langchain/core/messages";
import { estimateBaseMessageTokens } from "../lib/tokenizer.js";
import { serverLogger } from "../lib/logger.js";
import { MAX_CONVERSATION_TOKENS } from "./messageUtils.js";

/**
 * Prune conversation messages when total token count exceeds the cap.
 * Strategy:
 *   1. Compress old ToolMessage contents (keep the most recent ones intact).
 *   2. If still over limit, truncate tool_call args inside old AIMessages.
 *   3. If still over limit, drop oldest non-system message pairs as last resort.
 */
export function pruneConversationIfNeeded(messages: BaseMessage[], tokenCap = MAX_CONVERSATION_TOKENS): BaseMessage[] {
  const total = estimateBaseMessageTokens(messages);
  if (total <= tokenCap) return messages;

  const cloned = [...messages];
  let currentTotal = total;

  // --- Pass 0: compress old task ToolMessage results ---
  // Task tool results are large (~3500 chars each). Compress all but the last 2
  // to a short summary so the coordinator retains key info at much lower cost.
  const taskToolIndices: number[] = [];
  for (let i = 0; i < cloned.length; i++) {
    const msg = cloned[i];
    if (msg._getType() === "tool" && (msg as unknown as { name?: string }).name === "task") {
      taskToolIndices.push(i);
    }
  }
  const protectedTaskCount = 2;
  const compressibleTasks = taskToolIndices.slice(0, Math.max(0, taskToolIndices.length - protectedTaskCount));
  for (const idx of compressibleTasks) {
    if (currentTotal <= tokenCap) break;
    const msg = cloned[idx];
    const content = typeof msg.content === "string" ? msg.content : "";
    if (content.length <= 250) continue; // already short enough
    // Extract metadata header if present: [subagentId: xxx] [name: yyy] [role: zzz]
    const headerMatch = content.match(/^(\[subagentId:.*?\]\s*\[name:.*?\]\s*\[role:.*?\])/);
    const header = headerMatch ? headerMatch[1] : "";
    const body = header ? content.slice(header.length).trim() : content;
    const compressed = header
      ? `${header}\n${body.slice(0, 200)}... [compressed — use dependsOn to access full result]`
      : `${body.slice(0, 200)}... [compressed — use dependsOn to access full result]`;
    const toolMsg = msg as ToolMessage;
    cloned[idx] = new ToolMessage({
      content: compressed,
      tool_call_id: toolMsg.tool_call_id,
      name: (toolMsg as unknown as { name?: string }).name,
    });
    currentTotal = estimateBaseMessageTokens(cloned);
  }

  if (currentTotal <= tokenCap) return cloned;

  // --- Pass 1: compress old ToolMessage contents ---
  const toolIndices: number[] = [];
  for (let i = 0; i < cloned.length; i++) {
    if (cloned[i]._getType() === "tool") toolIndices.push(i);
  }

  // Keep the last 4 tool results intact; compress the rest
  const protectedCount = 4;
  const compressible = toolIndices.slice(0, Math.max(0, toolIndices.length - protectedCount));

  for (const idx of compressible) {
    if (currentTotal <= tokenCap) break;
    const msg = cloned[idx];
    const content = typeof msg.content === "string" ? msg.content : "";
    const headLen = Math.min(100, content.length);
    const tailLen = Math.min(100, Math.max(0, content.length - headLen));
    const marker = ` ... [pruned ${content.length - headLen - tailLen} chars] ... `;
    if (content.length <= headLen + marker.length + tailLen) continue;
    const summary = content.slice(0, headLen) + marker + (tailLen > 0 ? content.slice(-tailLen) : "");
    const toolMsg = msg as ToolMessage;
    cloned[idx] = new ToolMessage({
      content: summary,
      tool_call_id: toolMsg.tool_call_id,
      name: (toolMsg as unknown as { name?: string }).name,
    });
    currentTotal = estimateBaseMessageTokens(cloned);
  }

  if (currentTotal <= tokenCap) return cloned;

  // --- Pass 2: truncate tool_call args inside old AIMessages ---
  // Keep the last 4 AI messages intact; truncate args in earlier ones.
  const aiIndices: number[] = [];
  for (let i = 0; i < cloned.length; i++) {
    if (cloned[i]._getType() === "ai") aiIndices.push(i);
  }
  const compressibleAi = aiIndices.slice(0, Math.max(0, aiIndices.length - 4));
  for (const idx of compressibleAi) {
    if (currentTotal <= tokenCap) break;
    const msg = cloned[idx] as AIMessage;
    const toolCalls = (msg as unknown as { tool_calls?: Array<{ id: string; name: string; args: unknown }> }).tool_calls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) continue;
    type RawToolCall = { id: string; name: string; args: Record<string, unknown>; type?: "tool_call" };
    const truncatedCalls = (toolCalls as RawToolCall[]).map((tc) => {
      const argStr = JSON.stringify(tc.args ?? {});
      if (argStr.length <= 200) return tc;
      return { ...tc, args: { _truncated: argStr.slice(0, 200) + "... [truncated]" } };
    });
    cloned[idx] = new AIMessage({
      content: typeof msg.content === "string" ? msg.content : "",
      tool_calls: truncatedCalls,
    });
    currentTotal = estimateBaseMessageTokens(cloned);
  }

  if (currentTotal <= tokenCap) return cloned;

  // --- Pass 3: drop oldest non-system message groups as last resort ---
  // We must drop messages in coherent groups to preserve the AI↔Tool pairing
  // that LLM APIs require (every tool_call must have a matching ToolMessage).
  // A "group" is: consecutive run of [Human?, AI(with tool_calls), Tool, Tool, ...].
  serverLogger.warn(
    `[prune] Pass 1+2 insufficient (${currentTotal} tokens > ${tokenCap} cap). Dropping oldest messages.`
  );
  while (currentTotal > tokenCap) {
    // Find the first non-system message
    const startIdx = cloned.findIndex((m) => m._getType() !== "system");
    if (startIdx < 0) break; // only system messages left

    // Determine the group to drop starting at startIdx
    let endIdx = startIdx; // inclusive
    const startType = cloned[startIdx]._getType();

    if (startType === "human") {
      // Drop human + any immediately following AI + its tool messages
      endIdx = startIdx;
      if (endIdx + 1 < cloned.length && cloned[endIdx + 1]._getType() === "ai") {
        endIdx++;
        // Also drop trailing tool messages that belong to this AI's tool_calls
        while (endIdx + 1 < cloned.length && cloned[endIdx + 1]._getType() === "tool") {
          endIdx++;
        }
      }
    } else if (startType === "ai") {
      // Drop AI + its trailing tool messages
      endIdx = startIdx;
      while (endIdx + 1 < cloned.length && cloned[endIdx + 1]._getType() === "tool") {
        endIdx++;
      }
    } else if (startType === "tool") {
      // Orphaned tool message(s) — drop consecutive tools
      endIdx = startIdx;
      while (endIdx + 1 < cloned.length && cloned[endIdx + 1]._getType() === "tool") {
        endIdx++;
      }
    } else {
      // Unknown type — drop single message
      endIdx = startIdx;
    }

    const dropCount = endIdx - startIdx + 1;
    const droppedTokens = estimateBaseMessageTokens(cloned.slice(startIdx, endIdx + 1));
    cloned.splice(startIdx, dropCount);
    currentTotal -= droppedTokens;
  }

  return cloned;
}
