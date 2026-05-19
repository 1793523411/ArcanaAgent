agent 产物感知 — handoff 校验：执行前注入 system prompt 的硬约束已上线（agentExecutor.ts:196-198 + memoryManager 缓存），但 handoffParser.ts:66-67 目前只解析了 `inputsConsumed`，没做"实际覆盖了别人/自己之前的产物却没声明 → 抛错"的校验。补这块就能把"未声明直接覆盖视为错误"从一句 prompt 文字变成真正的运行时门槛。

------

我觉得小组也可以用AI创建，并且需要的agent也一并创建，不然都不知道咋组件agent，流水线模板也支持AI创建，根据已已有的agent，当然也能创建新的的agent如果当前已有的agent不满足，甚至可以fork并修改agent

AI生成流水线不能预览图
节点验收失败了咋办，现在就尬在那里了，不应该反过来push到agent嘛
感觉guild的harness做得不好，得做好点
竞标和指派现在用起来有问题吗？竞标好像点不动
现在模板都是在一起的，需要按小组做归类嘛
验收断言可以让用配置会不会好点

------

# Planning / Plan tracker — UX 减肥（2026-05-19 讨论）

**现象**：Claude Opus 4.7 + adaptive thinking 下，问一个 30 秒能讲完的解谜类问题（如"三开关三灯"），会被强制走完整 plan 流程，输出 5 步标题 + 流程图 + 多张表格 + 底部 10 行"验收清单"。从用户体验视角看是典型的 AI Slop：信息密度过载、关键答案被埋、有大量"元层语言"（"明确题目条件与约束""引入关键观察维度"）、叙事曲线反了（应该先抛答案再讲为什么，而不是先讲框架）、底部验收清单把用户从"读者"变成"评审"。

**根因**：不是模型的锅，是我们的 harness 把它逼出来的。`server/src/agent/planning.ts`：
- `shouldPlanByText` 触发条件太宽：`actionLike || normalized.length >= 24` —— 任何 ≥24 字的问题都会触发 plan
- `PLAN_REQUEST_PROMPT` 强制要求 `each step must include 1-3 acceptance checks` —— 模型会把 acceptance_checks 也吐到用户面输出
- adaptive thinking + high effort 会"完全照单全收"plan 框架，对每个 step 做深度推理

**改进方向（按 ROI 排序）**：

- [ ] **低代价高收益**：把 `shouldPlanByText` 改成只在出现明确 action 信号时触发，去掉 `|| normalized.length >= 24` 兜底；再加一个反向"提问/解谜"关键词白名单（为什么/怎么解释/谜题/推理/算一下/证明/计算）→ 直接跳过 plan
- [ ] **低代价**：在 `buildSystemPrompt` 末尾加 TL;DR 要求 —— 对直接提问类问题，先用 1-2 句话给结论，再展开推理；不要把内部思考步骤直接作为用户面章节
- [ ] **中等代价**：在 system prompt 里明确 `acceptance_checks` **仅用于内部进度跟踪**，不要在最终回答里再列一份清单给用户（消除底部验收清单这种"AI 自证"段落）
- [ ] **中等代价**：增加问题分类（轻量正则即可）作为 `conversationMode` 的细分 —— 谜题/解释/概念问题走简洁叙述模式，编码/工具任务走当前 plan 流程，闲聊走 short-circuit
- [ ] **高代价但终极**：plan 走内部 channel，user-facing channel 只输出最终答案；plan 进度面板从 reasoning 内容里 parse。需要改 stream 分流

**约束**：以上改动都不能影响 agent/coding 类工作流（那些必须继续走 plan + tool 流程）。验收方式：跑一遍现有 197 个 server 测试 + 手动测 3 种典型问题（谜题 / 编码任务 / 闲聊）的输出形态。
