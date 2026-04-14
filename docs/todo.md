# Guild 模式 — 待办事项

## 竞标算法长期优化

> 详细分析见 `docs/GUILD_BIDDING_LOGIC.md`

### P0 — 可观测性 & 冷启动

- [x] **scoreBreakdown UI 展示**：已在 DetailPanel 投标区实现可折叠展开打分细节
- [x] **successRate 先验**：新 Agent 默认 0.5，已通过 Laplace 平滑实现（`successRatePrior` config）

### P1 — 语义匹配（根治语义失效）

- [x] **Embedding 替换字面 overlap**：给 Agent 定义和任务各算向量，cosine 相似度替换 `assetScore + skillScore`
  - 使用 `Xenova/multilingual-e5-small` 本地 embedding，复用项目已有的 HuggingFace 依赖
  - `embeddingScorer.ts`：懒加载模型，缓存 Agent 向量，调度前 warmup → 同步 bidding 查缓存
  - 语义匹配激活时吸收 asset(0.35) + skill(0.20) = 0.55 权重，assetBonus 自动关闭
  - 收益：根本解决"查资料" vs "langgraph 资料"语义等价但字面不匹配的问题
- [x] **LLM 评分器**：用轻量模型（haiku）根据 Agent systemPrompt + 任务描述打 0-10 分
  - 比 embedding 更懂语境，代价是每任务 +1 次 LLM 调用
  - 适合小组规模（<10 agents）
  - 实现：`llmScorer.ts`，使用 deepseek-chat，10s 超时，缓存 per (agentId, taskId)
  - 集成：bidding.ts 优先级 LLM > embedding > token，语义模式下 assetBonus 关闭
  - 调度器和 routes 均在 bid 前 warmup，bid 后清缓存

### P2 — 打分公平性

- [x] **负载衰减改为实时负载**：改为基于当前 working 状态 + 近期活跃度，不再用 lifetime 累计
- [x] **资产打分 top-k 聚合**：取 top-3 资产得分平均，多个相关资产的 Agent 不再被忽略
- [x] **assetBonus 去重**：P1 embedding 激活时 assetBonus 自动关闭，语义匹配已吸收该信号

### P3 — 健壮性

- [x] **跨 group 去重锁**：`biddingInFlight` Set 防止同一任务并发竞标
- [x] **中文分词**：`splitTokens()` CJK bigram 分词，已集成到所有竞标 tokenization 路径
- [x] **Fallback 改为"不分配 + 通知"**：suggestedAgent > 唯一空闲 > stalled 通知（不再随机分配）

## Phase 5 前端体验打磨

- [x] **发布需求默认 kind=requirement**：默认勾选"作为需求"，可取消切换为 adhoc
- [x] **任务面板 DAG 依赖图**：requirement 详情面板展示子任务依赖关系图（@xyflow/react）
- [x] **Workspace 面板**：协作工作区 + 全屏查看
- [x] **scoreBreakdown 竞标详情**：已在 DetailPanel 投标区实现可折叠展开
- [x] **需求分组展示**：已完成列按 requirement 分组
- [x] **等待依赖标记**：blockedByDeps 指示器
- [x] **需求组排序优化**：正在运行的需求排在最上面
