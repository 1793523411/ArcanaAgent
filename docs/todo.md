# Guild 模式 — 待办事项

## 竞标算法长期优化

> 详细分析见 `docs/GUILD_BIDDING_LOGIC.md`

### P0 — 可观测性 & 冷启动

- [ ] **scoreBreakdown UI 展示**：TaskCard / DetailPanel 可折叠展开竞标详情（asset/memory/skill/success/ownerBonus/loadPenalty/threshold 各维度得分）
  - 类型已有 `ScoreBreakdown`，bid 里已存 `scoreBreakdown` 字段，前端未展示
- [x] **successRate 先验**：新 Agent 默认 0.5，已通过 Laplace 平滑实现（`successRatePrior` config）

### P1 — 语义匹配（根治语义失效）

- [ ] **Embedding 替换字面 overlap**：给 Agent 定义和任务各算向量，cosine 相似度替换 `assetScore + skillScore`
  - 可选方案：本地 embedding（如 text-embedding-3-small）或服务端调用
  - 收益：根本解决"查资料" vs "langgraph 资料"语义等价但字面不匹配的问题
- [ ] **LLM 评分器**：用轻量模型（haiku）根据 Agent systemPrompt + 任务描述打 0-10 分
  - 比 embedding 更懂语境，代价是每任务 +1 次 LLM 调用
  - 适合小组规模（<10 agents）

### P2 — 打分公平性

- [ ] **负载衰减改为实时负载**：当前用 `stats.tasksCompleted`（lifetime 累计），老 Agent 永久被压分。应改为"正在执行 + 近 N 分钟完成数"
- [ ] **资产打分 top-k 聚合**：目前只取最高单资产得分，10 个强相关资产和 1 个效果一样。改为 top-3 平均或加权求和
- [ ] **assetBonus 去重**：资产同时贡献 40% 权重和 +0.15 bonus，存在双倍计分

### P3 — 健壮性

- [ ] **跨 group 去重锁**：Agent 属于多 group 时，两个调度器可能同时 autoBid，需加进程内锁
- [ ] **中文分词**：当前按空格/标点切词，中文整句变成一个 token。若做了 embedding 则不需要
- [ ] **Fallback 改为"不分配 + 通知"**：避免强制随机分配污染 successRate，给用户手动指派按钮

## Phase 5 前端体验打磨

- [x] **发布需求默认 kind=requirement**：默认勾选"作为需求"，可取消切换为 adhoc
- [x] **任务面板 DAG 依赖图**：requirement 详情面板展示子任务依赖关系图（@xyflow/react）
- [x] **Workspace 面板**：协作工作区 + 全屏查看
- [x] **scoreBreakdown 竞标详情**：已在 DetailPanel 投标区实现可折叠展开
- [x] **需求分组展示**：已完成列按 requirement 分组
- [x] **等待依赖标记**：blockedByDeps 指示器
- [x] **需求组排序优化**：正在运行的需求排在最上面
