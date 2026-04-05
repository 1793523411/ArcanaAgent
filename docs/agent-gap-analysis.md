# ArcanaAgent vs Claude Code — 差距分析与优化建议

> 分析日期：2026-04-05
> 基于 Claude Code 512K 行源码的生产级架构模式对标

---

## 总览评分

| 维度 | ArcanaAgent | Claude Code | 差距 |
|------|:-----------:|:-----------:|:----:|
| **Agent Loop** | ★★★★ | ★★★★★ | 小 |
| **Tool System** | ★★★★ | ★★★★★ | 小 |
| **Context Management** | ★★★★ | ★★★★★ | 小 |
| **Security/Governance** | ★★★★ | ★★★★★ | 小 |
| **Multi-Agent** | ★★★☆ | ★★★★☆ | 小 |
| **Knowledge/Skills** | ★★★☆ | ★★★★☆ | 小 |
| **Harness (独有)** | ★★★★ | N/A | ArcanaAgent 领先 |

---

## 一、Agent Loop — 缺少结构化恢复路径

### 现状

LangGraph `StateGraph` + `shouldContinue` 条件边，标准的 ReAct 模式。

### 关键差距

1. **没有 Continue Site 机制**。Claude Code 有 7 个恢复站点（collapse_drain、reactive_compact、escalate、recovery 等），每个都是"改变环境条件后重新进入循环"。当前 loop 只有一条路：tool_calls → 执行 → 回到 LLM。当上下文爆了或模型出错时，没有分级恢复。

2. **没有结构化终止枚举**。Claude Code 定义了 10+ 种终止原因（completed、max_turns、prompt_too_long、model_error…），`shouldContinue` 只区分"有 tool_calls"和"没有"。这导致无法精确诊断 agent 为什么停了。

3. **缺少流式中间状态**。虽然有 `streamAgentWithTokens` 做 token streaming，但循环状态没有被 yield 出来。Claude Code 的 AsyncGenerator 在每个 continue site 都 yield 状态，让调用者能观察和干预。

### 优化建议

```
优先级 P0: 给 agent loop 加终止原因枚举
优先级 P1: 加至少 3 个 continue site:
  - context_overflow → 触发压缩后重试
  - model_error → 降级模型或压缩上下文后重试
  - tool_error_cascade → 取消并行工具后重试
```

---

## 二、Context Management — 最大差距

### 现状

2-pass 压缩（先压 task tool results → 再压一般 tool results → 最后丢弃最早消息）。

### 关键差距

1. **没有 Microcompact（零成本清理）**。Claude Code 有不调 LLM 的 Microcompact 层——基于时间（>1h 的工具结果直接清空）和缓存（已编辑文件的旧读取结果清空）。当前每次压缩都在字符串层面截断，丢信息但不省 token。

2. **没有 Session Memory（压缩幸存记忆）**。Claude Code 在压缩时保留一个结构化的 Session Memory（请求、概念、文件、错误、任务、进度），压缩后重新注入。当前压缩是有损的——压完就忘了。

3. **没有 9 段结构化摘要模板**。Claude Code 压缩时用 9 段模板引导 LLM 生成高质量摘要（request_summary、key_concepts、files_modified、errors_encountered…）。当前 `summarizer.ts` 只是通用摘要。

4. **阈值过于粗糙**。使用 `tokenThresholdPercent: 75%` 单一阈值，Claude Code 用 93% 触发 auto-compact，还有 diminishing returns 检测（连续 3 轮 <500 token 增量则停止）。

### 优化建议

```
优先级 P0: 加 Microcompact 层（零 LLM 成本）
  - 超过 N 轮前的 tool results → 只保留前 200 字符摘要
  - 已被后续 write 覆盖的 read_file 结果 → 清空
  - 这一层不调 LLM，纯规则，放在每次 LLM 调用前执行

优先级 P0: 加 Session Memory
  - 压缩前提取结构化摘要（当前目标、已修改文件、关键决策、遇到的错误）
  - 压缩后作为 system message 重新注入
  - 这是防止"50 轮后 agent 不知道自己在干什么"的关键

优先级 P1: 将压缩阈值提到 90%+
  - 75% 太早压缩，浪费了 25% 的有效窗口
```

---

## 三、Tool System — 缺少执行管线和并发控制

### 现状

21 个工具 + Zod schema + RBAC + 审批门控 + 危险命令检测。基础已经不错。

### 关键差距

1. **没有读写锁语义**。工具全部串行执行（LangGraph ToolNode 默认行为）。Claude Code 区分只读工具（可并行）和写入工具（独占），读写锁大幅提升多工具场景效率。

2. **没有 Fail-Closed 默认值**。Claude Code 新工具默认 `isConcurrencySafe: false`，必须显式声明。当前工具没有这个元数据。

3. **工具执行管线不完整**。Claude Code 有 9 步管线（schema validation → semantic validation → speculative classifier → backfill → hooks → permission → execution → truncation → post-hooks），缺少 semantic validation（检查工具参数语义合理性）和 pre/post hooks。

4. **缺少工具结果的生命周期管理**。工具结果产生后就一直占上下文，没有基于"这个结果还有用吗"的清理机制。

### 优化建议

```
优先级 P1: 给每个工具加 isReadOnly 标记
  - read_file, search_code, list_files, git_operations(status/diff/log) → true
  - 读工具可并行执行，写工具互斥

优先级 P2: 加 Pre/Post Hook 支持
  - PreToolUse: 在工具执行前拦截（可修改参数、阻止执行）
  - PostToolUse: 在工具执行后处理（通知、日志、触发后续动作）
  - 先支持 shell command hook 类型，后续扩展
```

---

## 四、Security/Governance — 缺少纵深防御

### 现状

工具级 RBAC + 审批规则 + 工作区隔离 + 危险命令检测。单层但覆盖面够。

### 关键差距

1. **只有 2 层防御**（工具 RBAC + 命令模式匹配），Claude Code 有 6 层。缺少的关键层：
   - **AI 分类器层**：用 LLM 判断操作意图是否安全（模式匹配搞不定的模糊情况）
   - **Bypass-immune 层**：即使用户明确说"跳过安全检查"，某些操作仍然强制阻止（`.git` 目录写入、credential 文件等）

2. **审批规则只有 regex 匹配**，没有上下文感知。比如"在测试目录执行 rm -rf"和"在根目录执行 rm -rf"风险完全不同，但当前规则无法区分。

3. **没有文件系统沙箱**。`isPathInWorkspace` 只检查路径前缀，没有 symlink 解析、`../` 逃逸检测等。

### 优化建议

```
优先级 P1: 加 Bypass-immune 层
  - 无论用户如何配置，以下操作永远需要确认：
    - 写入 .git/ 目录
    - 写入 .env / credentials 文件
    - force push
    - rm -rf 在工作区根目录
  - 这些规则不能被 approval rules 覆盖

优先级 P2: 路径验证加固
  - resolve symlinks 后再做路径检查
  - 检测 ../ 逃逸
  - 规范化路径后再比较
```

---

## 五、ArcanaAgent 的独特优势 — Harness 系统

Harness（EvalGuard + LoopDetector + Replanner + HarnessDriver）是 Claude Code **没有的**能力，是一个很好的差异化特性。

### 改进方向

1. **EvalGuard 可以更轻量**。目前每步都调 LLM 评估，成本高。可以改为：
   - 简单步骤（read_file、search）→ 跳过 eval
   - 写入/命令步骤 → 轻量 eval（只检查是否报错）
   - 关键步骤 → 完整 LLM eval

2. **LoopDetector 的 trigram 相似度可以和 context 联动**。检测到循环时，不只是通知 Replanner，还应该触发 context 压缩——很多循环是因为上下文太长导致模型"忘了"已经试过的方法。

3. **HarnessDriver 的 outer retry 应该注入更结构化的失败摘要**。目前注入的是文本摘要，建议改为结构化的 JSON（failed_steps、error_types、attempted_approaches），让模型更容易避开已失败的路径。

---

## 六、其他改进建议

| 领域 | 建议 | 优先级 |
|------|------|--------|
| **配置合并** | 当前只有 2 层（默认 + 用户），Claude Code 有 7 层。至少加项目级（`.arcana/config.json`）让不同项目有不同配置 | P1 |
| **缓存前缀稳定性** | system prompt 每次都重新拼接 MCP 工具描述，顺序可能变化，浪费 prompt cache。固定内置工具排序，MCP 工具追加在末尾 | P1 |
| **CLAUDE.md 等价物** | skill 系统很好，但缺少项目级别的自动加载知识。加一个 `.arcana/AGENT.md` 自动注入 system prompt | P2 |
| **工具结果截断** | 统一 32KB 截断，Claude Code 按工具类型差异化（代码搜索保留更多、命令输出截断更激进） | P2 |
| **诊断即工具** | auto-diagnostic 耦合在 write_file 内部，建议抽成独立工具让模型主动调用 | P2 |

---

## 优化路线图

> 状态更新：2026-04-05

### Phase 1 — 高价值低成本

| 改进项 | 预估工作量 | 效果 | 状态 |
|--------|-----------|------|------|
| 加 Microcompact 层 | ~100 行 | 零 LLM 成本提升上下文效率 | ✅ 已完成 |
| 加 Session Memory | ~150 行 | 防止压缩后失忆 | ✅ 已完成 |
| 加终止原因枚举 | ~30 行 | 提升可观测性 | ✅ 已完成 |
| 加 Bypass-immune 安全层 | ~50 行 | 关键安全兜底 | ✅ 已完成 |

### Phase 2 — 中等投入

| 改进项 | 预估工作量 | 效果 | 状态 |
|--------|-----------|------|------|
| 加 Continue Site 恢复机制 | ~200 行 | 提升长任务成功率 | ✅ 已完成 |
| 工具 isReadOnly 标记 + 读写并发 | ~100 行 | 提升多工具效率 | ✅ 已完成 |
| Harness EvalGuard 分级策略 | ~60 行 | 降低 Harness 成本 | ✅ 已完成 |
| Task 结果智能压缩 | ~40 行 | 防止多子 Agent 场景信息丢失 | ✅ 已完成 |
| 项目级配置 .arcana/config.json | ~80 行 | 多项目差异化配置 | ⬜ 未开始 |

### Phase 3 — 长期优化

| 改进项 | 预估工作量 | 效果 | 状态 |
|--------|-----------|------|------|
| Pre/Post Hook 拦截器系统 | ~200 行 | 可扩展的工具生命周期 | ⬜ 未开始 |
| 缓存前缀稳定性排序 | ~50 行 | 节省 prompt cache 费用 | ⬜ 未开始 |
| AI 分类器安全层 | ~150 行 | 覆盖 regex 搞不定的模糊安全场景 | ⬜ 未开始 |
| 结构化摘要模板（9 段） | ~100 行 | 提升压缩后信息保留质量 | ⬜ 未开始 |

### 已完成改进明细

<details>
<summary>点击展开详细改动清单</summary>

**Microcompact 层** (`server/src/agent/microcompact.ts` 新文件)
- 规则 1: 已被后续 write/edit 覆盖的 read_file 结果 → 标记 stale
- 规则 2: 超过 6 轮前的工具结果 → 只保留前 200 字符
- 规则 3: 连续 3+ 次同名工具错误 → 折叠为摘要
- 集成点: `pruning.ts` 在 token 检查前执行

**Session Memory** (`summarizer.ts` + `contextBuilder.ts`)
- 6 段结构化摘要模板（当前目标/关键决策/已修改文件/遇到的错误/进行中的任务/重要上下文）
- 摘要作为 system message 注入，不会被 trim 策略删除

**终止原因枚举** (`messageUtils.ts` + `index.ts`)
- StopReason 类型: completed | max_rounds | aborted | harness_abort | context_overflow | model_error | tool_error_cascade | empty_response
- 所有退出路径均 yield stop reason

**Bypass-immune 安全层** (`riskDetection.ts` + `toolBuilder.ts`)
- 写入 .git/、.env、credentials/pem/key 文件 → 无条件阻止
- force push (`--force` / `-f`)、根目录 rm -rf → 无条件阻止
- 路径验证加固: realpathSync 解析 symlink
- read_file 添加 workspace 路径限制

**Continue Site 恢复** (`index.ts` 双路径)
- model_error: 最多 3 次重试，第 2 次起压缩上下文，指数退避
- tool_error_cascade: 批量工具 >50% 失败时注入恢复提示，连续 3 轮终止
- 双路径（reasoning stream + LangChain fallback）均已覆盖

**读写并发** (`tools/index.ts` + `index.ts`)
- READ_ONLY_TOOLS 集合标记只读工具
- executeToolCalls 拆分读/写/task 三组: 读+task 并行，写串行

**EvalGuard 分级** (`harness/evalGuard.ts` + `harness/middleware.ts`)
- skip: 纯只读工具步骤，跳过 LLM eval
- lightweight: 写入无错误，规则检查
- full: 有错误或无工具证据，完整 LLM eval

**Task 结果智能压缩** (`pruning.ts`)
- 头尾保留策略: 前 200 字符(上下文) + 后 200 字符(结论)，替代暴力截断
- 保留 metadata header + subagentId，附加全量结果文件路径指引
- Pass 1 跳过 task 结果，避免 Pass 0 压缩后被二次截断

</details>

---

## 竞品对比视角

| 维度 | ArcanaAgent | Claude Code | Cursor | GitHub Copilot |
|------|------------|------------|--------|---------------|
| Agent Loop | LangGraph StateGraph + Continue Site 恢复 | while(true) + 7 continue sites | 不公开 | 不公开 |
| 工具系统 | 21 内置 + MCP + 读写并发 | 43+ 内置 + MCP | 内置编辑 + 终端 | 内置编辑 + 终端 |
| 权限模型 | RBAC + 审批规则 + Bypass-immune | 5 模式 + 7 级规则 + AI 分类器 | 编辑器级沙盒 | GitHub 权限 |
| 上下文管理 | Microcompact + 3-pass 压缩 + Session Memory | 4 级压缩 + Session Memory | .cursorrules + 索引 | copilot-instructions.md |
| 多 Agent | 子 Agent + Team 模式 | 5 种 Agent + Swarm 编排 | 8 并行 Agent (worktree) | 单 Agent |
| 执行监控 | **Harness 系统** | 无 | 无 | 无 |
| 定时任务 | **Scheduler 系统** | 无内置（依赖 cron hook） | 无 | 无 |

---

## 核心结论

1. **Context Management 差距已大幅缩小** — Microcompact + Session Memory + Task 智能压缩已实现，从 ★★ 提升到 ★★★★。剩余差距主要在 9 段结构化摘要模板（Phase 3）。

2. **Harness 系统是独特优势** — EvalGuard 分级策略已优化（skip/lightweight/full），降低了 eval 成本。LoopDetector + Replanner 的组合在开源 agent 中少见，值得继续深化。

3. **安全模型已升级为纵深防御** — Bypass-immune 层 + symlink 路径解析 + read_file workspace 限制已实现。剩余差距在 AI 分类器层（Phase 3）。

4. **Agent Loop 已具备状态机恢复能力** — Continue Site（model_error 重试 + tool_error_cascade 检测）+ StopReason 枚举已实现。双路径（reasoning stream + LangChain fallback）均已覆盖。

5. **剩余优化集中在 Phase 3** — Pre/Post Hook、缓存前缀稳定性、AI 分类器、9 段摘要模板。这些是锦上添花的长期优化，当前系统已具备生产级基础能力。
