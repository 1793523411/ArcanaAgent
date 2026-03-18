Team 模式上下文压缩优化方案                                                       │
│                                                                                   │
│ Context                                                                           │
│                                                                                   │
│ Team 模式下 coordinator 派发多个 subagent 执行任务，每个 task tool 结果最多 3500  │
│ chars（~900 tokens）。存在两层上下文膨胀问题：                                    │
│                                                                                   │
│ - 单轮内：coordinator agent 循环中，每次 LLM call 都会看到之前所有 task 的        │
│ tool_call + ToolMessage，N 个 subagent ≈ N × 900 tokens 纯结果                    │
│ - 跨轮次：会话历史累积多轮 coordinator 交互，每轮都带着完整的 task                │
│ tool_call/ToolMessage 对                                                          │
│                                                                                   │
│ 核心约束：不牺牲 LLM 决策质量，不影响前端展示。                                   │
│                                                                                   │
│ 方案：分层延迟压缩                                                                │
│                                                                                   │
│ 核心思路：task 结果在产生时保持全量，随着"距离"增大逐步压缩。                     │
│                                                                                   │
│ 当前 task 刚返回  →  全量 3500 chars（coordinator 立即可见，质量最高）            │
│ 本轮较早的 task   →  压缩为 ~300 chars 摘要（pruning 时替换，dependsOn            │
│ 仍可取全量）                                                                      │
│ 持久化到历史      →  压缩为 ~150 chars 引用 + 文件路径（完整结果写入 workspace    │
│ 文件）                                                                            │
│                                                                                   │
│ 改动点                                                                            │
│                                                                                   │
│ 1. Subagent 结果持久化到 workspace 文件                                           │
│                                                                                   │
│ 文件: server/src/agent/index.ts — task tool 内部，subagent 完成后（~line 976）    │
│                                                                                   │
│ 在 subagentResults.set() 之后，将完整结果写入 workspace 文件：                    │
│                                                                                   │
│ {workspacePath}/.agents/results/{subagentId}.md                                   │
│                                                                                   │
│ 文件内容：                                                                        │
│ # {subagentName} ({role})                                                         │
│ Prompt: {prompt 前200字}                                                          │
│ ---                                                                               │
│ {完整 summary}                                                                    │
│                                                                                   │
│ 需要从 context 中获取 workspacePath（已有 context.options?.workspacePath）。      │
│                                                                                   │
│ 2. 增强 pruneConversationIfNeeded — 优先压缩 task ToolMessage                     │
│                                                                                   │
│ 文件: server/src/agent/index.ts — pruneConversationIfNeeded 函数（~line 425）     │
│                                                                                   │
│ 在现有 Pass 1 之前，新增 Pass 0: 压缩旧 task 结果：                               │
│                                                                                   │
│ - 遍历所有 ToolMessage，通过 name === "task" 识别 task 结果                       │
│ - 保留最近 2 个 task ToolMessage 不动（coordinator 刚拿到的结果需要全量）         │
│ - 更早的 task ToolMessage 替换为压缩版（保留首 200 chars + subagentId/name        │
│ 元信息）                                                                          │
│ - 压缩后的内容格式：                                                              │
│ [subagentId: xxx] [name: yyy] [role: zzz]                                         │
│ {result 前200字}... [compressed — use dependsOn to access full result]            │
│                                                                                   │
│ 这样 coordinator 后续 LLM call 仍能看到早期 task 的要点，但 token 消耗从 ~900     │
│ 降到 ~100。需要详情时通过 dependsOn 注入全量。                                    │
│                                                                                   │
│ 3. 持久化时压缩 task ToolMessage                                                  │
│                                                                                   │
│ 文件: server/src/api/routes.ts — saveCollectedResults 函数（~line 540）           │
│                                                                                   │
│ 在 appendMessages 之前，遍历 collectedStored，对 tool_calls 中 name 为 task       │
│ 对应的 tool 类型 StoredMessage 做压缩：                                           │
│                                                                                   │
│ - 将 content 替换为：                                                             │
│ [Agent: {name}] Result saved to .agents/results/{subagentId}.md                   │
│ {result 前100字}...                                                               │
│ - 同时压缩对应 AIMessage 中 task tool_call 的 args（prompt 截断到 100 字）        │
│                                                                                   │
│ 4. contextBuilder 加载历史时的 read-back 支持（可选增强）                         │
│                                                                                   │
│ 文件: server/src/agent/contextBuilder.ts                                          │
│                                                                                   │
│ 当 compress 策略生成摘要时，摘要器（summarizer）已经能处理含文件引用的            │
│ system/tool 消息。无需额外改动。如果后续发现摘要质量不足，可以在 summarizer       │
│ 中增加对 .agents/results/ 文件的读取。                                            │
│                                                                                   │
│ 不影响前端的原因                                                                  │
│                                                                                   │
│ 前端 Team Panel 的 subagent 展示完全依赖：                                        │
│ - SSE 流中 type: "subagent" 事件                                                  │
│ - 持久化在 AI message 的 subagents: PersistedSubagentLog[] 字段                   │
│                                                                                   │
│ 这两者都独立于 tool_call/ToolMessage，本方案只修改 ToolMessage 内容，不触碰       │
│ subagent 事件流和 subagents 字段。                                                │
│                                                                                   │
│ 不牺牲质量的原因                                                                  │
│                                                                                   │
│ - 当轮最近的 task 结果：保持全量，coordinator 做综合判断时信息完整                │
│ - 当轮较早的 task 结果：压缩但保留要点（200 chars），且 dependsOn                 │
│ 机制仍可注入全量（从内存 Map 读取）                                               │
│ - 历史轮次的 task 结果：已经不影响当轮决策，压缩到引用级别 + 文件可查             │
│                                                                                   │
│ 修改文件清单                                                                      │
│                                                                                   │
│ ┌───────────────────────────┬───────────────────────────────────────────────────┐ │
│ │           文件            │                       改动                        │ │
│ ├───────────────────────────┼───────────────────────────────────────────────────┤ │
│ │ server/src/agent/index.ts │ 1) task tool 内写 workspace 文件; 2)              │ │
│ │                           │ pruneConversationIfNeeded 新增 Pass 0             │ │
│ ├───────────────────────────┼───────────────────────────────────────────────────┤ │
│ │ server/src/api/routes.ts  │ saveCollectedResults 中压缩 task ToolMessage      │ │
│ └───────────────────────────┴───────────────────────────────────────────────────┘ │
│                                                                                   │
│ 验证方式                                                                          │
│                                                                                   │
│ 1. 在 team 模式下创建会话，让 coordinator 派发 5+ 个 subagent                     │
│ 2. 观察 coordinator 后续 LLM call 的 token 消耗是否降低（可通过 usage 事件确认）  │
│ 3. 确认前端 Team Panel 展示不受影响（subagent 列表、状态、内容正常）              │
│ 4. 发送第二轮用户消息，确认历史加载后 token 占用明显减少                          │
│ 5. 确认 dependsOn 仍然能正确注入前序 agent 的完整结果                             │
│ 6. 检查 workspace 下 .agents/results/ 目录有正确的结果文件   