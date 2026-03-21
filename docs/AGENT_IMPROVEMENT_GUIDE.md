# Agent 能力改进指南

> 基于对当前代码库的全面审计，对比 Cursor、Claude Code、Devin、Aider、OpenHands 等主流 AI 工具，整理出的能力差距分析与改进路线图。

---

## 一、当前能力全景

| 能力 | 状态 | 说明 |
|------|------|------|
| 流式对话 | ✅ 完整 | OpenAI / Anthropic / 火山引擎，支持推理链（extended thinking） |
| 工具调用 | ✅ 完整 | 13 个内置工具 + MCP 扩展，支持并行执行 |
| 多 Agent 协作 | ✅ 完整 | 协调者 + 子 Agent，依赖链，DAG 可视化 |
| 审批安全 | ✅ 完整 | 内置危险模式 + 自定义正则规则，异步审批流（5 分钟超时） |
| 自动规划 | ✅ 完整 | 自动生成 3-10 步计划 + 验收标准跟踪 |
| 上下文管理 | ✅ 完整 | Token 感知裁剪 / 压缩 / 摘要，多策略切换 |
| 定时任务 | ✅ 完整 | Cron 调度 + 依赖图 + 执行历史 |
| 代码搜索 | ⚠️ 基础 | 仅 ripgrep 文本搜索，无语义理解 |
| 网页搜索 / 抓取 | ⚠️ 间接 | 通过 Skill 脚本实现，非 agent 原生可调用 tool |
| 图片理解 | ⚠️ 有限 | 依赖模型原生视觉能力，无专用分析工具 |
| RAG / 语义搜索 | ❌ 缺失 | 无向量索引，无 embedding |
| 自动修复循环 | ⚠️ 被动 | 写文件后跑一次诊断，agent 不会主动驱动"改-测-修"循环 |

---

## 二、与主流工具的差距分析

### 差距 1：缺少代码库索引

**对标产品**：Cursor（代码库 embedding 索引）、Claude Code（符号级搜索）

**当前情况**：
- 仅有 `search_code` 工具（ripgrep 文本匹配）
- 无法回答"这个接口在哪里被调用"、"这个类的继承关系"等结构性问题
- 大型项目中 agent 经常找不到关键代码或返回过多无关结果

**影响**：agent 在复杂代码库中表现不佳的最主要原因之一。

**改进方向**：
- 方案 A：集成 Tree-sitter 进行符号提取（函数、类、导入关系），建立轻量级符号索引
- 方案 B：使用 embedding 模型对代码块建向量索引，支持语义搜索
- 方案 C：集成已有的 LSP（Language Server Protocol）获取跳转、引用等能力

---

### 差距 2：文件编辑能力不够鲁棒

**对标产品**：Cursor（apply 模糊匹配）、Aider（基于 diff 的编辑）

**当前情况**：
- `edit_file` 采用精确字符串 search-and-replace
- 依赖 LLM 精确输出原文，一旦有空白、缩进等微小偏差就匹配失败
- 失败后需重试，浪费 token 和时间

**影响**：agent 编辑文件的成功率不高，尤其在长文件中。

**改进方向**：
- 支持行号范围定位（`startLine`-`endLine`），减少对精确匹配的依赖
- 引入模糊匹配算法（如 Levenshtein 距离 / 最长公共子序列），容忍微小差异
- 支持 unified diff 格式输入，让 LLM 输出标准 diff 而非整段替换

---

### 差距 3：缺少原生 Web 搜索工具

**对标产品**：ChatGPT（内置搜索）、Perplexity（搜索原生）、Claude（web search tool）

**当前情况**：
- Web 搜索和网页抓取通过 Skill 脚本间接实现（`ddgs-web-search`、`playwright-web-capture`）
- Agent 不知道这些能力的存在，无法主动决定何时搜索
- 需要用户显式触发 skill

**影响**：agent 无法主动查文档、查 API 用法、查错误信息的解决方案。

**改进方向**：
- 将 web_search 提升为内置 tool（直接封装 DuckDuckGo API 或 Serper API）
- 将 web_fetch / web_read 提升为内置 tool（获取指定 URL 内容并转 Markdown）
- 在 system prompt 中引导 agent 遇到不确定的问题时主动搜索

---

### 差距 4：子 Agent 上下文传递粗糙

**对标产品**：Devin（结构化环境状态）、CrewAI（任务上下文对象）

**当前情况**：
- 子 Agent 之间靠纯文本摘要传递上下文
- 每个依赖最多 16K 字符，总计 64K 字符上限
- 无结构化信息（如修改了哪些文件、测试结果、关键变量等）

**影响**：复杂多步流水线中，后续 agent 经常丢失关键上下文，重复犯错。

**改进方向**：
- 定义结构化上下文协议（如 `{ files_changed: [], test_results: {}, key_decisions: [] }`）
- 子 Agent 完成时输出结构化摘要而非自由文本
- 支持共享工作区状态（git diff、文件变更列表）自动注入

---

### 差距 5：缺少沙盒执行环境

**对标产品**：Devin（Docker 沙盒）、OpenHands（Docker 沙盒）、E2B（云端沙盒）

**当前情况**：
- `run_command` 直接在宿主机执行，通过正则黑名单拦截危险命令
- 黑名单覆盖有限，无法防御所有风险（如 `curl | sh`、`pip install` 恶意包等）
- 无法为 agent 提供一个"随便折腾"的安全环境

**影响**：安全上限低，不敢让 agent 做激进操作（如自动安装依赖、运行未知脚本）。

**改进方向**：
- 方案 A：集成 Docker，每个会话在容器内执行命令
- 方案 B：集成 E2B 等云端沙盒服务
- 方案 C：使用 `nsjail` / `firejail` 等轻量级沙盒限制文件系统和网络访问

---

### 差距 6：缺少主动"改-测-修"循环

**对标产品**：Claude Code（自驱测试循环）、Cursor Agent（自动运行测试）

**当前情况**：
- Auto-Verification 仅在 `write_file` / `edit_file` 后触发一次诊断（tsc、eslint 等）
- Agent 不会主动运行测试来验证改动
- 没有"改代码 → 跑测试 → 看报错 → 修复 → 再跑测试"的自驱循环

**影响**：agent 写完代码就结束，不会自主验证正确性，输出质量不稳定。

**改进方向**：
- 在 system prompt 中明确指导：每次代码修改后必须运行相关测试
- 在 tool 层面实现：`edit_file` / `write_file` 完成后自动触发 `test_runner`
- 实现 verify-fix 循环：诊断失败 → 自动修复 → 重新诊断，最多 N 轮

---

## 三、改进优先级路线图

### P0 — 低成本高收益（建议立即实施）

| 改进项 | 预估工作量 | 预期收益 |
|--------|-----------|----------|
| web_search 提升为内置 tool | 1-2 天 | agent 能主动查文档/查错误，能力跃升明显 |
| edit_file 增加行号定位 + 模糊匹配 | 2-3 天 | 编辑成功率从 ~70% 提升到 ~95% |
| system prompt 加入"改完跑测试"指导 | 0.5 天 | 零代码改动即可提升输出质量 |

### P1 — 中等投入显著提升（短期内实施）

| 改进项 | 预估工作量 | 预期收益 |
|--------|-----------|----------|
| 自动 verify-fix 循环 | 3-5 天 | 从"写完就丢"到"写完验证"，质量大幅提升 |
| 子 Agent 结构化上下文协议 | 3-5 天 | 多 Agent 协作准确率提升，减少上下文丢失 |
| 轻量级代码符号索引（Tree-sitter） | 5-7 天 | agent 理解代码结构的能力质变 |

### P2 — 较大投入长期收益（中期规划）

| 改进项 | 预估工作量 | 预期收益 |
|--------|-----------|----------|
| Docker 沙盒执行环境 | 1-2 周 | 安全性质变，可以放开 agent 执行权限 |
| 代码向量索引 + 语义搜索 | 1-2 周 | 大型代码库中 agent 的理解和定位能力质变 |
| web_fetch 内置 tool（URL → Markdown） | 2-3 天 | agent 可以主动阅读文档页面和 API 参考 |

---

## 四、已发现并修复的问题

在审计过程中，已修复以下与 agent 工具配置不一致的问题：

1. **`AGENT_GENERATE_PROMPT`**（`server/src/api/routes.ts`）
   - 移除了不存在的工具：`web_search`、`calculator`、`get_time`
   - 补全了缺失的 9 个实际工具

2. **`BASE_SYSTEM_PROMPT`**（`server/src/agent/index.ts`）
   - 修正了工具列表引用，移除 `calculator`、`get_time`

3. **内置 Agent 定义**（`server/src/storage/agentDefs.ts`）
   - Planner agent 的 `allowedTools` 移除 `calculator`、`get_time`
   - Reviewer agent 的 `allowedTools` 移除 `calculator`、`get_time`

---

## 五、总结

当前 agent 在**对话能力、工具调用、多 Agent 协作、安全审批**方面已经有不错的基础架构。核心短板在于：

1. **信息获取能力弱**（无主动搜索、无代码语义索引）— 导致 agent "不够聪明"
2. **代码编辑不够鲁棒**（精确匹配容易失败）— 导致 agent "做事不靠谱"
3. **缺少自驱验证循环**（写完不测试）— 导致 agent "做完不检查"

优先解决这三个问题，agent 的表现会有质的飞跃。
