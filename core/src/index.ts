export { setLogger } from "./lib/logger.js";
export type { Logger, LogLevel } from "./lib/logger.js";
export { serverLogger } from "./lib/logger.js";

export { setModelConfigProvider, loadModelConfig, getModelContextWindow, getModelReasoning } from "./config/models.js";
export type { ModelSpec, ProviderConfig, ModelConfigResult, ModelConfigProvider } from "./config/models.js";

export { tools, isReadOnlyTool, getToolsByIds, listToolIds } from "./tools/index.js";
export type { ToolId } from "./tools/index.js";

export { getModelAdapter } from "./llm/adapter.js";
export type { ModelAdapter, ChatModel, ToolCallResult } from "./llm/adapter.js";
export { getLLM } from "./llm/index.js";
export { streamChatCompletionsWithReasoning } from "./llm/streamWithReasoning.js";
export type { StreamReasoningResult, ToolCallResult as StreamToolCallResult, TokenUsage } from "./llm/streamWithReasoning.js";

export { estimateTextTokens, estimateBaseMessageTokens, estimateMessageTokens, estimateContextTokens } from "./lib/tokenizer.js";
export type { StoredMessage } from "./lib/tokenizer.js";

export { buildPlanningPrelude, extractPlanSteps } from "./agent/planning.js";
export type { PlanStep } from "./agent/planning.js";
export { createRuntimePlanSteps, summarizeToolEvidence, isErrorEvidence, applyEvidenceToPlan, computeCurrentStep, forceCompletePlan } from "./agent/planTracker.js";
export type { RuntimePlanStep } from "./agent/planTracker.js";

export { pruneConversationIfNeeded } from "./agent/pruning.js";
export { applyMicrocompact } from "./agent/microcompact.js";

export type { StopReason } from "./agent/messageUtils.js";
export {
  getTextFromChunk,
  getTextFromMessage,
  getReasoningFromMessage,
  getReasoningFromChunk,
  getLastAssistantText,
  buildBackgroundResultMessage,
  stringifyToolArgs,
  safeParseArgs,
  truncateToolResult,
  resolveConversationTokenCap,
  createSubagentId,
  deriveSubagentName,
  MAX_SINGLE_TOOL_RESULT_CHARS,
  MAX_CONVERSATION_TOKENS,
  NO_VISIBLE_OUTPUT_MESSAGE,
  FINAL_ONLY_PROMPT,
  MAX_TOOL_CALL_ROUNDS_MESSAGE,
  WRITE_FILE_SCHEMA_HINT,
  getWriteFileArgsError,
} from "./agent/messageUtils.js";

export { isPathInWorkspace } from "./lib/pathUtils.js";

export { approvalManager } from "./agent/approvalManager.js";
export { backgroundManager } from "./agent/backgroundManager.js";

export {
  parseSkillMd,
  safeName,
  loadSkillsFromDirs,
  loadSkillsFromMetas,
  listSkillsMerged,
  listFullSkillsMerged,
  buildSkillCatalog,
  getSkillContentForAgent,
  createLoadSkillTool,
} from "./skills/manager.js";
export type { SkillMeta, SkillFull } from "./skills/manager.js";

export { LoopDetector } from "./agent/harness/loopDetector.js";
export { evaluateStepCompletion, determineEvalTier, lightweightEval } from "./agent/harness/evalGuard.js";
export { generateReplan, mergeReplanIntoSteps, buildReplanInjectionMessage } from "./agent/harness/replanner.js";
export { HarnessMiddleware } from "./agent/harness/middleware.js";
export { buildEnhancementsPrompt } from "./agent/harness/harnessPrompt.js";
export { DEFAULT_HARNESS_CONFIG } from "./agent/harness/types.js";
export type { HarnessConfig, HarnessEvent, EvalResult, LoopDetectionResult, MiddlewareResult, ReplanDecision, ExecutionEnhancementsConfig } from "./agent/harness/types.js";
