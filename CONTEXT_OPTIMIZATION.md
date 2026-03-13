# 上下文压缩策略和 Token 计算优化总结

## 问题诊断

### 1. 前端展示 Bug - 上下文占用字段错误

**问题**：前端在 `ChatPanel.tsx:126` 使用 `estimatedTokens` 展示当前 session 的上下文占用。

```typescript
// 修复前
const effectiveSessionTokens = effectiveContextUsage?.estimatedTokens ?? null;
```

`estimatedTokens` 是**请求发送前**的本地估算值，不准确。应该使用 `promptTokens`，这是 API 返回的**真实上下文 token 数**。

**修复**：优先使用 `promptTokens`（API 真实值），回退到 `estimatedTokens`（本地估算）。

```typescript
// 修复后
const effectiveSessionTokens = effectiveContextUsage?.promptTokens ?? effectiveContextUsage?.estimatedTokens ?? null;
```

### 2. 上下文 Token 字段语义说明

后端在 `routes.ts` 中计算了三个不同的 token 值：

1. **promptTokens**：本轮对话所有 LLM 调用的 prompt tokens 总和（用于计费统计）
2. **contextPromptTokens**：第一次 LLM 调用的 prompt tokens（代表上下文体积，用于展示压缩策略效果）
3. **contextMeta.estimatedTokens**：本地算法估算的上下文 token 数（在 API 调用前计算）

**优先级**：真实值（API 返回）> 估算值（本地算法）> 回退到总 promptTokens

**改进**：添加了更清晰的注释说明这三个值的区别和用途。

### 3. 压缩策略优化

#### 原有逻辑的问题

当 compress 策略压缩后仍然超过阈值时，直接回退到 trim 策略，可能过于激进。

#### 优化方案

在回退到 trim 之前，尝试减少保留的 recent 消息数量：

1. 如果压缩后仍超过阈值
2. 且 `recentCount > 10`
3. 减少 `recentCount` 到一半（最少保留 10 条）
4. 重新生成摘要并检查
5. 如果仍然超过，再回退到 trim 策略

```typescript
// 压缩后仍然超过阈值，尝试减少保留的 recent 消息数
if (recentCount > 10) {
  const reducedRecentCount = Math.max(10, Math.floor(recentCount / 2));
  // 使用减少的 recentCount 重新生成压缩结果
  // 如果成功，返回；否则继续回退到 trim
}
```

## 修改文件

1. **web/src/components/ChatPanel.tsx** ✅
   - 添加 `contextUsage` prop 支持
   - 修复上下文占用展示逻辑，优先使用 `promptTokens`
   - 计算 `displayContextUsage` 用于传递给 `ChatInputBar`

2. **server/src/api/routes.ts** ✅
   - 优化 token 计算的注释说明

3. **server/src/agent/contextBuilder.ts** ✅
   - 优化 compress 策略，在回退到 trim 前尝试减少 recentCount

## 压缩策略合理性评估

### 当前策略

1. **full**：全量上下文，未超过阈值时使用
2. **trim**：截断最旧的消息，使用二分法查找合适的保留数量
3. **compress**：压缩旧消息为摘要，保留最近 N 条完整消息

### 合理性

✅ **full 策略**：合理，当上下文未超过阈值时，使用完整消息列表

✅ **trim 策略**：合理，使用二分法快速找到合适的保留消息数量，性能好

✅ **compress 策略**：
- 保留最近消息的完整上下文，同时压缩旧消息
- 使用缓存避免重复调用 summarizer
- 优化后：在回退到 trim 前会尝试减少 recentCount，更智能

### 默认参数

```typescript
const DEFAULT_TRIM_TO_LAST = 20;
const DEFAULT_TOKEN_THRESHOLD_PERCENT = 75;
const DEFAULT_COMPRESS_KEEP_RECENT = 20;
```

这些默认值是合理的：
- 阈值设置为上下文窗口的 75%，留有余地
- 保留最近 20 条消息，对大部分对话足够
- trim 时默认保留 20 条，然后二分查找

## 上下文占用计算合理性

### 后端计算逻辑

1. **promptOverheadTokens**（33-44行）：
   - 从最近的 AI 消息中提取实际 API 返回的 `promptTokens` 和本地估算的 `estimatedTokens`
   - 计算差值作为 overhead：`Math.max(0, prompt - estimated)`
   - 这个 overhead 会加到所有后续估算值上，使估算更准确

2. **adjustEstimatedTokens**：
   - 将本地估算值加上 overhead，更接近真实值

3. **上下文构建**：
   - 先估算全量上下文的 token 数
   - 如果超过阈值，根据策略进行压缩或截断
   - 每次操作后重新估算，确保不超过阈值

✅ 这个计算逻辑是合理的，通过 overhead 修正本地估算值，使其更接近 API 实际消耗。

### 前端展示逻辑

修复后的逻辑：

```typescript
// 1. 优先使用最新 AI 消息的 contextUsage
const latestAiWithContext = [...messages].reverse().find(m => m.type === "ai" && m.contextUsage);
const latestMessageContextUsage = latestAiWithContext?.contextUsage ?? null;

// 2. 优先使用当前流式传输的 contextUsage，否则使用最新消息的
const effectiveContextUsage = contextUsage ?? latestMessageContextUsage ?? null;

// 3. 优先使用 promptTokens（真实值），回退到 estimatedTokens（估算值）
const effectiveSessionTokens = effectiveContextUsage?.promptTokens ?? effectiveContextUsage?.estimatedTokens ?? null;

// 4. 计算两个百分比：相对于窗口 和 相对于阈值
percentByWindow = (sessionTokens / contextWindow) * 100
percentByThreshold = (sessionTokens / thresholdTokens) * 100
```

✅ 这个逻辑是合理的：
- 展示最准确的上下文占用（优先使用 API 返回的真实值）
- 提供两个维度的百分比，帮助用户理解上下文使用情况
- 在流式传输时实时更新，完成后保存到消息记录

## 总结

✅ **已修复**：前端展示上下文占用的 bug，现在正确使用 `promptTokens`

✅ **已优化**：压缩策略在回退到 trim 前会尝试减少 recentCount

✅ **已改进**：添加清晰的注释说明各个 token 字段的含义和用途

✅ **压缩策略合理**：使用缓存、二分查找等优化手段，性能和准确性都很好

✅ **上下文计算合理**：通过 overhead 修正估算值，展示逻辑优先使用真实值
