# Guild 模式竞标逻辑现状与问题

> 适用代码：`server/src/guild/bidding.ts`
> 最后更新：2026-04-11

## 一、现状：三步流水线

自治调度器（`autonomousScheduler`）发现 open 任务后，对每个任务调用 `autoBid(groupId, task)`，流程如下：

### 步骤 1 — `calculateConfidence(agent, task)`

纯语义/启发式打分，无 LLM 参与。加权求和，最终截断到 `[0, 1]`：

| 维度 | 权重 | 计算方式 |
|---|---|---|
| 资产匹配 | 40% | 遍历 Agent 的 `assets`，把 `name + description + uri` 切词后看有多少落在任务 `title + description` 里。取所有资产中**最高**的命中率 |
| 记忆相关 | 30% | `searchRelevant(agentId, taskText, 5)` 返回的记忆条数 / 5 |
| 技能/Prompt 匹配 | 20% | 任务切词后，有多少词出现在 `systemPrompt + description + skills` 里 |
| 历史成功率 | 10% | `agent.stats.successRate` |

**加成**：如果任一资产的 `name + description` 里包含任务里长度 > 3 的某个词，额外 `+assetBonusWeight`（默认 0.15）。

**惩罚**：`tasksCompleted > 3` 时，整体分乘以 `loadDecayFactor^(n-3)`（默认 `0.9^(n-3)`），抑制同一个 Agent 连续吃单。

> ⚠️ **优先级不参与这一步**。上一轮 CR 修复前，urgent/high 会对分数做乘法，导致大量扎堆 1.0。现在改为只在门控阶段放宽阈值（见下）。

### 步骤 2 — `evaluateTask(agent, task)` 门控

```
threshold = minConfidenceThreshold(默认 0.3) + priorityDelta
priorityDelta = { urgent: -0.1, high: -0.05, medium: 0, low: +0.05 }
threshold = clamp(threshold, 0.1, 0.95)

if (confidence < threshold) return null
```

另外：Agent 必须是 `idle` 且 `currentTaskId` 为空，否则也 `return null`。

通过门控的 Agent 产出 `TaskBid`，内含 `confidence`、`reasoning`、`estimatedComplexity`、相关资产/记忆 id 列表。

### 步骤 3 — `autoBid` 胜者选择

```ts
const bids = startBidding(groupId, fresh);       // 收集所有有效投标
const winner = selectWinner(bids);               // 取 confidence 最高的

if (winner) {
  assignTask(groupId, taskId, winner.agentId, winner, bids);
  return winner;
}

// 兜底：没人达标但有空闲 Agent → 随机挑一个，confidence=0.1
const idleAgents = getGroupAgents(groupId).filter(a => a.status === "idle" && !a.currentTaskId);
if (idleAgents.length === 0) return null;

const picked = idleAgents[random()];
const fallbackBid = { ...picked, confidence: 0.1, reasoning: "自动回退分配..." };
assignTask(groupId, taskId, picked.id, fallbackBid, [...bids, fallbackBid]);
```

**特点**：任何时候至多写一次磁盘（单次 `assignTask` 或 `updateTask`）。

## 二、已知问题

### P0* — "置信度永远是 10%" 的实际现象（P0 的外部表现）

**观察**：截图里几乎每个任务分配时，投标区都只显示一条 `confidence: 10%` + `reasoning: 自动回退分配：无 Agent 达到竞标门槛，随机选择空闲 Agent`。

**为什么是 10% 而不是别的数**：这是 `autoBid` 里 fallback 路径硬编码的常量：

```ts
// bidding.ts:215
const fallbackBid: TaskBid = {
  agentId: picked.id,
  taskId: fresh.id,
  confidence: 0.1,  // ← 永远是 0.1
  reasoning: "自动回退分配：无 Agent 达到竞标门槛，随机选择空闲 Agent",
  ...
};
```

所以看到 10% = 打分流水线里**没有任何 Agent 达到 `minConfidenceThreshold`**（默认 0.3），系统退回到"随机挑一个空闲 Agent"的兜底路径。

**为什么"几乎永远"达不到 0.3**：这就是 P0 描述的根本原因，把四项权重和典型新 Agent 的得分代入：

| 维度 | 权重 | 典型得分（新 Agent，无丰富定义） | 贡献 |
|---|---|---|---|
| 资产 40% | 0.4 | Agent 很少挂 assets，且就算挂了字面也很难对上任务词 | ~0 |
| 记忆 30% | 0.3 | 新 Agent 没记忆 | 0 |
| 技能 Prompt 20% | 0.2 | systemPrompt 一般写"你是一个 XX Agent"，任务描述里的具体技术词（langgraph、supabase、k8s...）基本不在 prompt 里 | 0 ~ 0.05 |
| 成功率 10% | 0.1 | 新 Agent = 0（冷启动问题，见 P6） | 0 |
| 资产直接命中加成 | — | 需要至少一个资产的词长度 > 3 且出现在任务里 | 0 ~ 0.15 |

典型新 Agent 合计得分：**0 ~ 0.15**，远低于 0.3 阈值 → 每次都走 fallback → 每次都是 10%。

**核心问题**（按影响从大到小）：

1. **打分器是字面 overlap，不是语义理解**
   - "负责查资料" 和 "查 langgraph 资料" 字面只有"查"、"资料"两个字共现，算法看不出这其实是完美匹配
   - 中文还没有分词，整句切出来的 token 几乎不可能命中
   - → 根治方案：embedding 或 LLM judge（见 P0/P1 优化项）

2. **四个维度对新 Agent 全部是零**
   - 记忆 30% + 历史 10% = 40% 的权重在新 Agent 上直接被废掉
   - 剩下只有资产 40% + 技能 20% = 60% 的活跃空间，其中资产又依赖用户手工挂载
   - → 缓解：`successRate` 给 0.5 默认先验，新 Agent 起步 5%（见 P6）

3. **阈值 0.3 太严**
   - 考虑到典型新 Agent 的合计得分上限在 0.15 左右，0.3 几乎是"只有挂了精确资产的 Agent 才能投标"
   - 优先级放宽也只到 `0.3 - 0.1 = 0.2`，依然过不去
   - → 缓解：`setBiddingConfig({ minConfidenceThreshold: 0.15 })`，但治标不治本

4. **Fallback 的 confidence=0.1 是硬编码**
   - 不是算出来的"真实置信度"，纯粹是个占位符
   - 导致 UI 上完全无法区分"某个 Agent 打分 0.08 差一点达标" vs "所有 Agent 打分都是 0"
   - → 改进：fallback bid 应该显示原始打分（哪怕是 0），并标明 `via: "fallback"`，而不是统一 0.1

**快速自检清单**（当你又看到 10% 时，按序检查）：

1. 打印 `calculateConfidence(agent, task)` 看真实分数是多少
2. 打印 `minConfidenceThreshold + priorityDelta` 看门槛
3. 如果真实分数 > 0 但 < 门槛：降阈值或改权重
4. 如果真实分数 = 0：Agent 定义太空 —— 挂资产 / 丰富 prompt
5. 如果算法永远打不出合理分数：换评分器（embedding / LLM judge）

### P0 — 打分算法对语义等价但字面不同的场景失效

**现象**：Agent 名为"负责查资料"、systemPrompt 写"你负责查资料"，接到任务"查下最新的 langgraph 的资料" —— 按人类直觉显然该命中，但实际打分为 0，走 fallback 路径以 confidence=0.1 分配。

**根因**：四个维度全部基于 **字面切词 overlap**：
- 资产 40%：Agent 没有名为"langgraph"的资产 → 0
- 记忆 30%：新 Agent 无历史记忆 → 0
- 技能 20%：systemPrompt 里没"langgraph"这个词 → 0
- 成功率 10%：新 Agent 为 0

结果：0 分 < 0.3 阈值 → 兜底。这意味着**只有当任务描述里的关键词刚好出现在 Agent 定义里时才能打高分**，完全不理解"查资料"和"langgraph 资料"是同义的。

**影响范围**：所有主观描述、跨语言、同义替换、上位概念的任务都会落到 fallback 路径。

### P1 — 切词方式粗糙

- 中文不分词：按 `\s`、`[\s,;.!?]+` 等分隔符切，中文短句经常变成整句一个 token，命中率随机
- 长度过滤 `> 2` 或 `> 3`：阈值拍脑袋，汉字权重被低估
- 重复词没有 TF-IDF 权重，高频停用词和关键信息同权

### P2 — 资产打分只看"最高"的一个

```ts
for (const asset of agent.assets) {
  assetScore = Math.max(assetScore, matchCount / assetWords.length);
}
```

一个 Agent 有 10 个强相关资产和 1 个弱相关资产，打分和只有 1 个最强资产时完全一样。合理的做法是取 top-k 平均或求和后归一化。

### P3 — `assetBonusWeight` 与资产 40% 强耦合，容易双倍计分

当一个资产既贡献 `assetScore`（40% 权重）又触发 `hasDirectAsset` 加成（+0.15），等于同一件事加了两次分。对于持有多个资产的 Agent 更明显。

### P4 — 负载衰减从 `tasksCompleted > 3` 开始，且单调递减

`loadDecayFactor^(recentTasks - 3)` 用的是 `stats.tasksCompleted`（历史累计数），不是真正的"当前负载"。这意味着**老 Agent 永远被压分**，即使现在手头只有一个任务。字段命名 `recentTasks` 误导，实际是 lifetime count。

应该基于：
- 当前正在执行的任务数（现在固定 ≤ 1，将来若支持并发需调整）
- 最近 N 分钟内完成的数量
- 或滑动窗口平均

### P5 — Fallback 掩盖了真正的失败

现在"没人达标"就随机挑一个空闲 Agent 强行分配。好处是任务不会积压；坏处是：

- 用户看不到"打分为什么全员不达标"的信号（日志里只有一行 fallback）
- 分配到错误 Agent 会拖累执行成功率，污染 `stats.successRate`，下一轮打分更差，陷入负反馈
- 没有"请求人工介入 / 生成更合适的 Agent"的出口

### P6 — 历史成功率冷启动无防御

新 Agent `successRate = 0`，直接贡献 `0 * 0.1 = 0`。没有拉普拉斯平滑或默认先验（比如 0.5），导致新 Agent 永远被历史老 Agent 压一头，哪怕描述更匹配。

### P7 — 同一任务可以被反复 autoBid

`autoBid` 开头只检查了终态（in_progress/completed/failed/cancelled），但如果任务是 `open` 状态，调用方并没有去重。`autonomousScheduler` 目前靠 `runningGroups + pendingReruns` 串行化了同 group 的 dispatch，但**不同 group 间共享 Agent 的场景**（Agent 同时属于多个 Group）下，理论上可能被两个 group 的调度器同时评估，导致双写。

> 当前代码假定 Agent 一次只在一个 group 里"干活"，但 `Group.agents` 是多对多，这个前提并不稳固，值得审计。

### P8 — 没有打分可观测性

打分是 4 项加权求和 + 2 项修正，但 `TaskBid.reasoning` 只写一句"持有 N 个相关资产，有 M 条相关经验"。调试时无法知道：
- 四个维度各贡献了多少
- 触发了哪些加成 / 惩罚
- 门控阈值是多少，差多少

建议 bid 结构里加一个 `scoreBreakdown: { asset, memory, skill, success, bonus, decay, threshold }`，UI 可折叠展示。

## 三、优化方向（按成本 / 收益排序）

| 优先级 | 改动 | 成本 | 预期收益 |
|---|---|---|---|
| P0 | 加 `scoreBreakdown` 字段 + UI 展开（可观测） | S | 后续所有优化都要靠它 |
| P0 | 给 `successRate` 加先验（新 Agent 默认 0.5） | XS | 立刻缓解冷启动负反馈 |
| P1 | 用 embedding 替换"任务文本 vs Agent 定义"的字面匹配 | M | 根本解决 P0 语义匹配问题。LLM call / 本地 embedding 都行，给 Agent 定义和任务各算一次向量，cosine 相似度直接替换 `assetScore + skillScore` |
| P1 | 引入"专门的 LLM 评分器" — 由一个轻量模型（haiku）根据 Agent systemPrompt 和任务描述打 0-10 分 | M | 比 embedding 更懂语境，代价是每个任务 +1 次 LLM 调用，对小组可接受 |
| P2 | `currentLoad` 改为"正在执行 + 近期完成" 而非 lifetime count | S | 修正 P4 老 Agent 永久被压的问题 |
| P2 | 资产打分改 top-k 聚合 | S | 修正 P2 |
| P2 | Fallback 改为"不分配 + 发通知 + 记录 stalled 原因"；给用户一个按钮强制指定 Agent | S-M | 修正 P5，避免污染成功率 |
| P3 | 跨 group 去重：autoBid 之前对 `(groupId, taskId)` 加进程内锁 | S | 防 P7 |
| P3 | 中文分词（jieba / 保留整句）或直接 drop 字面匹配这条路 | M | 如果做了 embedding 这个就不需要了 |

## 四、短期建议（不改代码也能缓解）

在现状下，让打分更准的最快办法：

1. **给 Agent 挂相关 assets**：name/description 里写上具体技术栈关键词（"LangChain"、"langgraph"、"向量检索"...）。一个相关资产 = 资产 40% 拉满 + 0.15 直接命中加成。
2. **丰富 systemPrompt**：把 Agent 能处理的任务类型、常见关键词列进去，直接命中技能 20%。
3. **降低 `minConfidenceThreshold`**：通过 `setBiddingConfig` 降到 0.2 或 0.15，让 fallback 减少。代价是低质量匹配增加。

长期还是得做 embedding / LLM 评分器，启发式打分对这类开放域分派任务是有天花板的。

## 五、相关文件

- `server/src/guild/bidding.ts` — 本文档描述的全部逻辑
- `server/src/guild/bidding.test.ts` — 优先级门控的单元测试
- `server/src/guild/autonomousScheduler.ts` — 调用 autoBid 的上游
- `server/src/guild/types.ts` — `TaskBid`、`BiddingConfig` 类型定义
