# 第 6 章：规划与 Harness

规划模式让 Agent 在执行任务前先制定步骤计划，然后按计划逐步执行。Harness 是安全护栏系统，包含 eval guard（质量评估）、循环检测和自动重规划。

## Planning 模式

### 启用

```typescript
const agent = createAgent({
  model,
  planningEnabled: true,
  workspacePath: "/path/to/workspace",
});
```

### 工作流程

```
用户消息
    │
    ▼
┌──────────────────┐
│ buildPlanningPrelude() │ ← 生成规划前言提示
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ createRuntimePlanSteps() │ ← LLM 生成执行计划
└────────┬─────────┘
         │
    ┌────┴────┐
    ▼         ▼
 Step 1    Step 2    Step N...
 (LLM+     (LLM+     (LLM+
  Tools)    Tools)    Tools)
    │         │         │
    ▼         ▼         ▼
 plan_update events (每步完成后触发)
         │
         ▼
    stop { reason: "completed" }
```

### 处理 plan_update 事件

```typescript
for await (const event of agent.stream("在项目中添加用户认证功能")) {
  switch (event.type) {
    case "plan_update":
      console.log("\n📋 执行计划:");
      event.steps.forEach((step, i) => {
        const icons = {
          pending: "⬜",
          in_progress: "🔄",
          completed: "✅",
          failed: "❌",
        };
        console.log(`  ${icons[step.status]} ${i + 1}. ${step.title}`);
      });
      break;

    case "token":
      process.stdout.write(event.content);
      break;

    case "tool_call":
      console.log(`\n🔧 ${event.name}`);
      break;

    case "stop":
      console.log(`\n✅ 完成 (${event.reason})`);
      break;
  }
}
```

### 计划步骤的状态流转

```
pending → in_progress → completed
                     → failed
```

每当步骤状态发生变化时，都会发出一个 `plan_update` 事件，包含所有步骤的最新状态。

---

## Harness 安全护栏

Harness 是围绕 Agent 执行循环的安全层，提供三种保护机制：

### 完整配置

```typescript
import { DEFAULT_HARNESS_CONFIG } from "arcana-agent-sdk";

interface HarnessConfig {
  evalEnabled: boolean;            // 启用执行质量评估
  evalSkipReadOnly: boolean;       // 只读工具步骤跳过评估（默认 true）
  loopDetectionEnabled: boolean;   // 启用循环行为检测
  replanEnabled: boolean;          // 启用自动重规划
  autoApproveReplan: boolean;      // 自动批准重规划（默认 false）
  maxReplanAttempts: number;       // 最大重规划次数（默认 3）
  loopWindowSize: number;          // 循环检测滑动窗口大小（默认 6）
  loopSimilarityThreshold: number; // trigram Jaccard 相似度阈值 0-1（默认 0.7）
}
```

### DEFAULT_HARNESS_CONFIG

```typescript
{
  evalEnabled: true,
  evalSkipReadOnly: true,
  loopDetectionEnabled: true,
  replanEnabled: true,
  autoApproveReplan: false,
  maxReplanAttempts: 3,
  loopWindowSize: 6,
  loopSimilarityThreshold: 0.7,
}
```

### System Prompt 增强注入

启用 `harnessConfig` 后，SDK 会自动向 system prompt 注入 Harness 增强指令，使 Agent 感知到中间件的存在：

- **evalEnabled = true** → 注入 Evidence-Driven Execution 指令，要求 Agent 逐步收集可验证证据
- **loopDetectionEnabled = true** → 注入 Loop Detection 提示，告知 Agent 中间件会监控重复模式
- **replanEnabled = true** → 注入 Dynamic Replanning 指令，告知 Agent 计划可能被动态修改

这些指令使得 Agent 的输出更加结构化（如"任务完成清单 + 证据"格式），显著提升 harness 的实际效果。

### 1. Eval Guard（执行质量评估）

在每轮工具调用后评估执行质量：

```typescript
harnessConfig: {
  ...DEFAULT_HARNESS_CONFIG,
  evalEnabled: true,
}
```

评估内容：
- 工具调用是否合理
- 任务进展是否正常
- 是否偏离了原始目标

如果评估不通过，Agent 会收到纠正提示。

### 2. Loop Detection（循环检测）

检测 Agent 是否陷入重复行为：

```typescript
harnessConfig: {
  ...DEFAULT_HARNESS_CONFIG,
  loopDetectionEnabled: true,
}
```

检测逻辑：
- 监控最近 N 轮的工具调用模式
- 如果发现相同的工具调用序列重复出现，注入打破循环的提示
- 严重循环时会触发 `harness_abort`

### 3. Replan（自动重规划）

当执行偏离计划或遇到阻塞时自动重新规划：

```typescript
harnessConfig: {
  ...DEFAULT_HARNESS_CONFIG,
  replanEnabled: true,
  maxReplanAttempts: 2,
}
```

触发条件：
- 连续多步失败
- eval guard 评分过低
- Agent 请求重规划

### 推荐组合

```typescript
// 开发阶段：全部打开
harnessConfig: {
  evalEnabled: true,
  loopDetectionEnabled: true,
  replanEnabled: true,
  maxReplanAttempts: 2,
}

// 生产环境：保守策略
harnessConfig: {
  evalEnabled: false,
  loopDetectionEnabled: true,
  replanEnabled: false,
  maxReplanAttempts: 0,
}

// 简单任务：不需要
harnessConfig: undefined  // 或不传
```

---

## Harness Abort

当 Harness 检测到无法恢复的问题时，会中断 Agent 执行：

```typescript
for await (const event of agent.stream("...")) {
  if (event.type === "stop" && event.reason === "harness_abort") {
    console.log("⚠️ 安全护栏中断了执行");
  }
}
```

---

## Harness 事件监听

启用 `harnessConfig` 后，每轮工具执行后 Harness 中间件会产生事件，通过 `type: "harness"` 实时推送：

```typescript
for await (const event of agent.stream("...")) {
  if (event.type === "harness") {
    const { kind, data } = event.event;
    switch (kind) {
      case "eval":
        // data: EvalResult { stepIndex, verdict, reason }
        // verdict: "pass" | "weak" | "fail" | "inconclusive"
        console.log(`Eval step ${data.stepIndex}: ${data.verdict}`);
        break;
      case "loop_detection":
        // data: LoopDetectionResult { detected, type?, description? }
        // type: "exact_cycle" | "semantic_stall"
        if (data.detected) console.log(`Loop: ${data.description}`);
        break;
      case "replan":
        // data: ReplanDecision { shouldReplan, trigger }
        // trigger: "eval_fail" | "loop_detected" | "none"
        if (data.shouldReplan) console.log(`Replan: ${data.trigger}`);
        break;
    }
  }
}
```

---

## 外层重试（Outer Retry）

当内层 replan 次数耗尽但问题仍未解决时，外层重试驱动器会自动整体重新运行一轮 agent 执行。需配合 `harnessConfig` 使用：

```typescript
const agent = createAgent({
  model,
  planningEnabled: true,
  harnessConfig: {
    ...DEFAULT_HARNESS_CONFIG,
    evalEnabled: true,
    loopDetectionEnabled: true,
    replanEnabled: true,
  },
  outerRetry: {
    maxOuterRetries: 2,       // 最多额外重试 2 次
    autoApproveReplan: true,  // 覆盖 harnessConfig.autoApproveReplan
  },
});
```

### 工作流程

```
stream() 入口
    │
    ▼
┌─────────────────────────┐
│ harness_driver: started  │
└──────────┬──────────────┘
           │
    ┌──────┴──────┐
    ▼              ▼（重试时注入失败摘要）
iteration_start → streamSingleExecution → iteration_end
    │                                         │
    │  检查 eval fail / loop detection        │
    │  ┌──── 未解决 ────┐  ┌── 已解决 ──┐    │
    │  ▼                │  ▼             │    │
    │  下一轮 iteration │  completed     │    │
    │  (注入失败摘要)    │               │    │
    │  ...              │               │    │
    │  max_retries      │               │    │
    └──────────────────┘  └──────────────┘
```

### 监听 Driver 事件

```typescript
for await (const event of agent.stream("...")) {
  if (event.type === "harness_driver") {
    // phase: "started" | "iteration_start" | "iteration_end" | "completed" | "max_retries_reached"
    console.log(`Driver: ${event.phase} (${event.iteration}/${event.maxRetries})`);
  }
}
```

---

## Planning + Harness 完整示例

```typescript
import { createAgent, DEFAULT_HARNESS_CONFIG } from "arcana-agent-sdk";

const agent = createAgent({
  model: {
    provider: "openai",
    apiKey: "sk-xxx",
    modelId: "gpt-4o",
  },
  planningEnabled: true,
  workspacePath: "/path/to/project",
  harnessConfig: {
    ...DEFAULT_HARNESS_CONFIG,
    evalEnabled: true,
    loopDetectionEnabled: true,
    replanEnabled: true,
    maxReplanAttempts: 2,
  },
  outerRetry: { maxOuterRetries: 2, autoApproveReplan: true },
  maxRounds: 50,
});

for await (const event of agent.stream(
  "分析项目结构，找出所有 TODO 注释，创建一个 TODO.md 汇总"
)) {
  switch (event.type) {
    case "plan_update":
      const progress = event.steps.filter(s => s.status === "completed").length;
      const total = event.steps.length;
      console.log(`\n📋 进度: ${progress}/${total}`);
      event.steps.forEach((step, i) => {
        const mark = step.status === "completed" ? "✅" :
                     step.status === "in_progress" ? "🔄" :
                     step.status === "failed" ? "❌" : "⬜";
        console.log(`  ${mark} ${step.title}`);
      });
      break;

    case "token":
      process.stdout.write(event.content);
      break;

    case "tool_call":
      console.log(`\n🔧 ${event.name}`);
      break;

    case "harness":
      console.log(`🔍 [${event.event.kind}]`, JSON.stringify(event.event.data));
      break;

    case "harness_driver":
      console.log(`🚗 [Driver] ${event.phase} (${event.iteration}/${event.maxRetries})`);
      break;

    case "stop":
      const emoji = {
        completed: "✅",
        harness_abort: "⚠️",
        max_rounds: "⏱️",
        tool_error_cascade: "💥",
      }[event.reason] || "🔴";
      console.log(`\n${emoji} 结束: ${event.reason}`);
      break;
  }
}
```

---

## 上下文管理

Planning + Harness 模式下，SDK 的上下文管理更加积极：

### 消息裁剪

当对话消息接近模型上下文窗口时，SDK 会自动进行 5 级渐进式压缩：

1. **Level 1**：微压缩（移除空白和冗余）
2. **Level 2**：工具结果压缩（长输出截断）
3. **Level 3**：工具参数截断（大参数缩短）
4. **Level 4**：消息组删除（移除早期不重要的对话组）
5. **Level 5**：激进压缩（只保留关键上下文）

### 模型错误恢复

连续 2 次模型调用失败时：
1. 上下文压缩到 70% 容量
2. 重试调用
3. 如果仍然失败（3 次），停止并发出 `model_error`

### 最终总结

达到 `maxRounds` 但没有生成文本内容时：
- SDK 自动调用模型生成一段总结，描述已完成的工作
- 避免用户看到空白结果
