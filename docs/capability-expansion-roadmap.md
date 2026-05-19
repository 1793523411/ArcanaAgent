# ArcanaAgent 能力扩展规划

> 在 `production-readiness-roadmap.md` 之外的另一条主线：**让 Agent 能做更多事**，而非"把现有能力做得更稳"。
>
> 两条路线并行推进，互为补充：生产化解决"能不能部署出去"，能力扩展解决"凭什么比 LangChain / Dify / Coze 强"。
>
> 作用域假设：沿用现有 Node.js + LangGraph + React 栈；Tier 1 三项不依赖 P0/P1，Tier 2 开始建议在 P0（鉴权）之后做。

---

## 0. TL;DR

能力增长按四档推进，越往上差异化越强、风险越高：

| Tier | 主题 | 能力跃迁 | 工时 |
|---|---|---|---|
| **T1** | 基础能力扩展 | Agent 从"会用工具"→"会用计算机" | 4-5 周 |
| **T2** | 生态 & 平台化 | 从"单 agent"→"可编排的 agent 操作系统" | 4-6 周 |
| **T3** | Self-Improvement | 从"静态 prompt"→"可度量 + 可自进化" | 3-4 周 |
| **T4** | 前沿赌注 | 差异化壁垒，做对即护城河 | 视选项 |

**我的推荐路径**：T1.1（Computer Use）+ T1.2（代码沙箱）+ T1.3（多模态）→ T2.1（连接器）+ T2.2（Pipeline 升级）→ T3.1（Eval Harness）+ T1.4（Long-term Memory）。这条路径用 ~10 周把 agent 能力值从 60 分拉到 90 分，再用 T3 的评估闭环锁住质量增长。

---

## Tier 1 · 基础能力扩展（放大 agent 解决问题的物理边界）

### T1.1 Computer Use / Browser Agent

**定位**：Agent 能像人一样"看屏幕、点按钮、填表单"，彻底绕开"这个服务没开放 API"的死路。

**能力跃迁示例**
- "帮我把淘宝订单导出为表格"（没 API）
- "在公司内网 OA 提一个请假单"
- "批量在 GitHub 给 100 个 issue 打 label"（远比调 REST 慢但零代码）

**技术方案**
1. 新增 tools：`browser_open` / `browser_navigate` / `browser_click` / `browser_type` / `browser_screenshot` / `browser_wait` / `browser_scroll` / `browser_eval_js`。
2. 后端用 Playwright + `chromium` headless（CI）或 headful（本地 debug 模式），每个 conversation 独立 context（cookie 隔离）。
3. 每次 action 后自动 screenshot 回传模型，模型视觉推理下一步动作。接 Claude 4.7 的 `computer_use` 工具协议 / OpenAI `computer-use-preview`。
4. 桌面级（非仅浏览器）：通过 VNC / `pyautogui` container 暴露，后续升级。
5. Action 队列带 delay（人类节奏）+ 失败自动截图 debug。

**难点**
- Screenshot 成本高（每次 50-200KB base64 图片），需要 token budget 管理 → 只在动作节点截图，不在 scroll 等连续操作中截。
- 反爬 / 风控绕过 = 灰色地带，必须尊重 robots / ToS → 工具层加入"target domain 白名单"配置。
- 长流程失败恢复：支持 "checkpoint" 机制，每 N 步保存 DOM snapshot + URL，失败时从最近 checkpoint 重试。

**codebase 锚点**
- 已有 `skills/playwright-web-capture`，复用 Playwright 依赖。
- 新建 `server/src/tools/browser/`，模块化 per-action 文件。
- Frontend 新建 "Browser" 面板：实时回放 agent 操作（screenshot 时间轴 + action log），类 Browserbase 效果。

**DoD**
- [ ] 10 个经典 benchmark 任务（WebArena 子集）成功率 ≥ 60%
- [ ] 一次完整流程的 screenshot 总 token 消耗 ≤ 单次对话预算的 30%
- [ ] 会话结束自动清理 browser context（内存 / cookie）

**工时**：2 周（1 周 tool + 1 周 UI 回放）

---

### T1.2 代码执行沙箱（E2B / Firecracker / Docker）

**定位**：把 `run_command` 拆成 host 模式（受限）+ sandbox 模式（完全隔离），sandbox 默认，让 agent 敢跑任意 pip 包、任意 npm 包、任意语言。

**能力跃迁示例**
- 数据分析：agent 跑 pandas + matplotlib 生成图表回传 base64
- 爬虫：agent 装 scrapy + playwright 抓网站
- ML：agent 跑 scikit-learn 训小模型验证假设
- CTF / 安全研究：跑不信任的二进制

**技术方案**
1. 集成 **E2B**（推荐，现成服务）或自建 **Firecracker MicroVM**（完全自主）或 **Docker-in-Docker**（简单但隔离弱）。
2. 新 tool `run_command_sandbox`：
   - input：`{ command, language: "python|bash|node|...", timeout_ms, files?: {...} }`
   - 挂载：workspace 目录 `/workspace` 可读写，其他只读
   - 网络：默认 allowlist（PyPI / npm / huggingface），可配 full / none
   - 输出：stdout + stderr + artifact 文件列表（自动同步回 conversation workspace）
3. 沙箱池：预热 3-5 个 container 待命，启动延迟 < 1s。
4. 原 `run_command` 改名 `run_command_host`，限制更严（仅已声明工作区 + 已加白命令）。
5. `background_run` 全部迁移到 sandbox（已有的 dev server 启动场景也从 host 迁出）。

**难点**
- 沙箱启动冷启 2-5s → 预热池。
- 产物文件同步：sandbox 关闭前把 `/workspace` 改动 tar 回 host workspace。
- 网络策略：默认允许"常见包管理器"需要维护白名单，更严时按 domain allowlist。
- 成本：E2B 按分钟计费；自建 Firecracker 需要 Linux host（容器化部署需 /dev/kvm 挂载）。

**codebase 锚点**
- `run_command.ts` 已有 dangerous-pattern 拦截，新 sandbox tool 与之解耦。
- `background_manager` / `background_run` 改成沙箱池管理器。
- Skill 执行（`load_skill` + `run_command`）全部切到 sandbox，消除"skill 污染 host 环境"风险。

**DoD**
- [ ] 连续执行 100 条 `pip install + run` 命令，host 环境零污染
- [ ] 沙箱启动 p50 < 1.5s，p95 < 3s
- [ ] 触发 `rm -rf /` / `fork bomb` 在 sandbox 内无法影响 host

**工时**：1.5 周（用 E2B） / 3 周（自建 Firecracker）

---

### T1.3 多模态输入（图片 / PDF / 音视频）

**定位**：用户能直接贴截图、扔设计稿、上传论文、丢录音让 agent 处理。

**能力跃迁示例**
- "看这个 bug 截图"→ agent 识别 error + 定位代码
- "这张 Figma 设计稿转成 React 组件"
- "这篇 PDF 帮我总结核心观点 + 提 10 个批判性问题"
- "这段会议录音提炼 action items"

**技术方案**
1. 附件上传已有（`conversations/:id/attachments`），扩展 MIME 白名单：`image/*, application/pdf, audio/*, video/mp4`。
2. 消息构造层改造（`adapter.streamSingleTurn` + LangChain 消息转换）：
   - 图片：直接转 Anthropic `image` content block / OpenAI `image_url` block。
   - PDF：用 `pdf-parse` 抽文本 + 图片，图片入 vision；超大 PDF 分块（每块 ≤ 20 页）。
   - 音频：先 STT（Whisper API / 本地 whisper.cpp）转文本注入。
   - 视频：`ffmpeg` 抽关键帧（每秒 1 帧 → K-means 去重到 20 帧）+ 音轨 STT。
3. 前端 ChatInput：支持粘贴 / 拖拽上传，显示缩略图。
4. 新增 tool `analyze_attachment`：主动让 agent 引用某个附件做深度分析（vision 二次 pass）。

**难点**
- Token 成本：一张 1024×768 图 ~1500 token，多图对话快速吃爆预算 → 触发压缩时优先丢早期图片（保留 caption 文本）。
- Provider 差异：不是所有模型都支持 vision → adapter 层声明 `supportsVision() / supportsPdf() / supportsAudio()`，不支持时降级为"文本抽取 + 文字描述注入"。
- 视频抽帧策略：不同场景最优帧数不同 → 参数化。

**codebase 锚点**
- `adapter.ts` 加 `capabilities` 字段；`pruning.ts` 增加"图片 token 估算 + 按 age 丢图"逻辑。
- 新建 `server/src/media/`：`pdfExtractor.ts` / `audioTranscriber.ts` / `videoSampler.ts`。
- Message 持久化 schema 扩展：保留 attachment 引用而非内联 base64。

**DoD**
- [ ] 对话中粘贴截图 → agent 在 200ms 内确认收到，3s 内开始分析
- [ ] 20 页 PDF 问答 benchmark 准确率 ≥ baseline RAG
- [ ] 5 分钟会议录音端到端总结用时 ≤ 30s

**工时**：1.5 周

---

### T1.4 Long-term Memory（跨会话持久记忆）

**定位**：超越 session summary，形成带 embedding 召回的个人知识库 + 偏好档案 + 实体关系。

**能力跃迁示例**
- 新对话直接继承上周讨论结论，不用重复交代背景
- "我之前给你看过那个 bug 还记得吗" → 召回到当时对话
- Agent 知道你的技术栈偏好、代码风格、禁区

**技术方案**
1. **Memory 类型**（参照 Claude Code、Cursor、Mem0）：
   - `user_profile`：角色、技术栈、偏好（"user 是资深 Go 工程师，讨厌注释过多"）
   - `project_facts`：项目级事实（"ArcanaAgent 用 LangGraph + Express，storage 是 JSON"）
   - `episodic`：历史对话浓缩（"2026-03-15 讨论了 auth 方案，结论是走 api-key"）
   - `procedural`：用户纠正过的 agent 行为（"user 不喜欢 agent 主动加 emoji"）
2. 写入时机：
   - 显式：`remember` tool（agent 主动，人类可撤销 / 编辑）
   - 隐式：对话结束时跑 `memorySummarizer`（LLM 从最近对话提取 3 类更新候选 → 人类一键批准）
3. 召回：
   - 新对话启动注入 `user_profile`（恒定）+ 近 30 天 episodic top-K（语义召回）
   - Agent 可显式调 `search_memory` 工具深挖
4. 清理：
   - `forget` tool（user / agent 都可调）
   - Auto decay：6 个月未被召回的 episodic 降权，1 年自动归档
5. 存储：
   - `~/.arcana-agent/memory/{userId}/profile.json` + `episodic.jsonl` + `lance-db/`
   - P3-2 迁 SQLite 后改表

**难点**
- 污染控制：一条错误记忆会永远误导 agent → 必须可审计 / 可编辑（前端 Memory 管理页）。
- 召回噪音：相关性阈值太低会引入无关背景，太高又想不起来 → 用 LLM rerank top-K。
- 隐私：默认记不记、谁看得到 → `memoryVisibility: private | org-shared | public`。

**codebase 锚点**
- Guild 已有 `memoryManager.ts` + `embeddingScorer.ts`（agent 经验级），主 agent 直接复用同一基础设施。
- 接入点：`buildSystemPrompt()` 拼入 `<prior_memory>` 段；对话结束 hook 调用 `memorySummarizer`。
- 前端新 tab "Memory"：user_profile 可编辑、episodic 可搜索 / 删除。

**DoD**
- [ ] 新开对话自动召回相关记忆，hit rate ≥ 60%（人工评估）
- [ ] user 可在 UI 单条删除任意记忆
- [ ] 错误记忆注入测试：故意写一条错误 profile，verify agent 被 mislead 后 user 可一键修正

**工时**：2 周

---

## Tier 2 · 生态 & 平台化（把 agent 变成基础设施）

### T2.1 一等公民数据连接器（Native Integrations）

**定位**：内置 OAuth + 完整 tool set，用户点一次授权就能让 agent 在其 SaaS 账户里干活，不再要求配 MCP。

**第一批目标清单**
| Provider | 价值 | 必备 tools |
|---|---|---|
| GitHub / GitLab | 代码协作 | `repo_search` / `issue_*` / `pr_*` / `commit` / `actions_run` |
| Notion | 文档知识库 | `page_read` / `page_create` / `database_query` |
| Linear / Jira | 任务管理 | `issue_*` / `project_status` |
| Slack / Feishu / DingTalk | 沟通 | `message_send` / `channel_history` / `mention` |
| Google Drive / Docs / Sheets | 文件 | `file_*` / `sheet_*` |
| Gmail / Outlook | 邮件 | `mail_read` / `mail_send` / `mail_search` |
| Postgres / MySQL / BigQuery | 数据库 | `query` / `schema` / `explain` |

**技术方案**
1. 新建 `server/src/integrations/`，每 provider 一个子目录：
   ```
   integrations/
     github/
       oauth.ts         # OAuth flow
       client.ts        # API client with rate limit
       tools/           # tool definitions
       fixtures/        # test data
   ```
2. OAuth 统一入口：`/api/integrations/:provider/authorize` → 跳转 → callback → token 存加密 storage（复用 P0-3 的凭证加密方案）。
3. Tool 动态注册：user 授权后，对应 tools 自动进入该 user 的 toolset。
4. Rate limit 统一：每 provider 实现 `RateLimitedClient` 接口，命中限流自动退避。
5. 配合 Scheduler：让 "每天 9 点把 Linear 里我负责的 P0 issue 汇总到 Slack 私聊" 这种自动化一键跑起来。

**难点**
- OAuth 回调域名 / redirect_uri 管理：self-hosted 场景 user 各自部署 → 支持 `OAUTH_CALLBACK_BASE_URL` 配置，文档清晰指引。
- Token 刷新：每个 provider 刷新周期不同，统一 `refreshIfNeeded()` hook。
- 权限最小化：OAuth scope 选最小集，工具级再二次校验。

**codebase 锚点**
- MCP 基础设施（`mcp/client.ts`）可做 fallback（不想原生集成的 provider 接 MCP server 即可）。
- 前端 Settings → Integrations 页：已授权列表 + 一键撤销。

**DoD**
- [ ] 至少 5 个 provider 完成原生集成
- [ ] 每个 provider 有 README + sample prompt（"帮我把过去一周的 GitHub PR 列出来"）
- [ ] OAuth token 泄漏测试通过（audit + 加密存储验证）

**工时**：3 周（每 provider ~3 天，5 个并行）

---

### T2.2 Pipeline 可视化编排升级

**定位**：把现有 Guild Pipeline 从"可配置的任务链"升级为"非程序员可用的 workflow 编排器"，对标 n8n / Dify 但内嵌 LLM + sub-agent 能力。

**能力跃迁**
- 可视化 DAG 编辑（XYFlow 已有）+ **节点类型系统**（input/output schema，连线自动校验）
- **试运行 + 单步 debug**（每个节点可单独执行 + 查看输入输出）
- **条件分支 / 循环 / 并行**（不止是线性 pipeline）
- **模板市场**（见 T2.3）

**技术方案**
1. 节点类型：
   - `llm_call`：单次 LLM 调用（含 prompt / model / 出参 schema）
   - `tool_call`：调用某个 tool
   - `sub_agent`：启动子 agent（Guild agent / 角色）
   - `code_exec`：跑 sandbox 代码（T1.2 依赖）
   - `http_request`：调外部 API
   - `condition`：if / switch
   - `loop`：forEach / while
   - `human_in_loop`：等审批或输入
2. Schema 系统：每个节点 input/output 用 Zod 定义，编辑器连线时实时类型校验；运行时若前节点输出不符合下节点 input 规格，自动触发适配器 LLM 调用。
3. 运行时：复用 `guild/pipelines.ts` 执行引擎，升级支持分支 / 循环；每个节点执行状态实时推 SSE 到前端高亮。
4. Debug 模式：
   - 节点右键 "Run from here" / "Run until here"
   - 每次运行存快照（输入 + 输出 + 耗时 + cost），可回看 / diff。

**难点**
- 循环 / 条件分支的 schema 类型推导（TypeScript 级静态检查搬到运行时）。
- 版本管理：pipeline 是代码一样的资产，需要 diff / rollback → 引入 `pipeline_versions` 表。
- 多人协作：同一 pipeline 并发编辑，走 CRDT 或锁。

**codebase 锚点**
- `guild/pipelines.ts` + `web/` XYFlow 已有骨架。
- 新增 `server/src/pipeline/nodeTypes/` 存节点定义（schema + executor）。
- 前端 debug 面板：时间轴 + 每节点输入输出详情。

**DoD**
- [ ] 支持 ≥ 8 种节点类型，覆盖"从 GitHub 拉 PR 列表 → LLM 总结 → 发送到 Slack"端到端流程
- [ ] 节点单步 debug 可用
- [ ] Pipeline 版本可 rollback

**工时**：2-3 周

---

### T2.3 Agent / Skill / Pipeline 市场

**定位**：社区可发布 + 安装 agent 定义、skill 包、pipeline 模板，带语义版本。

**技术方案**
1. Registry 协议：
   - 本地 registry（`~/.arcana-agent/registry/`）
   - 官方中心 registry（`registry.arcana-agent.dev`，静态 CDN + index.json）
   - 企业私有 registry（自定义 URL）
2. 包格式：`.arcana` 文件（实际是签名 zip），manifest：
   ```yaml
   name: github-release-summarizer
   version: 1.2.0
   kind: pipeline  # agent | skill | pipeline
   author: ...
   dependencies:
     skills:
       - ddgs-web-search@^2.0
     integrations:
       - github
   signatures:
     - {keyId: ..., sig: ...}
   ```
3. `arcana-agent install <name>` / UI 一键安装 / sandbox 预览运行。
4. 发布者签名 + 消费者 trust-on-first-use。

**难点**
- 恶意包防护：安装前 sandbox 预览 + 声明所需 tools / integrations，user 明确同意。
- 版本冲突解决（两个 agent 依赖同一 skill 的不同版本）。

**codebase 锚点**
- `skills/manager.ts` 已有本地安装 / 校验基础。
- Agent def / Team def / Pipeline def 统一到同一打包格式。

**DoD**
- [ ] 发布 20 个官方包（含 github-release-summarizer / weekly-report-generator 等实用场景）
- [ ] 安装包后能直接在 UI 使用，不重启服务
- [ ] 签名校验失败时拒绝安装

**工时**：2 周（不含官方包内容制作）

---

### T2.4 实时协同会话（Multi-User Collaboration）

**定位**：一个 conversation 多个 user 同时加入，实时看 agent 思考、互相 @、联合决策。

**场景**
- 产品 + 研发 + 设计一起让 agent 出方案
- On-call 多人同时 debug，agent 当"中枢"
- 教学：老师演示，学生实时看 + 补充问题

**技术方案**
1. SSE → WebSocket（双向），消息 broadcast 到 conversation 所有在线 user。
2. Conversation state 用 Yjs/CRDT 同步（消息列表 + 输入区 + 光标位置）。
3. Approval 变成"任一授权人确认"（或按 policy "2/3 多数"）。
4. Presence：显示谁在线 / 在打字。
5. @ 机制：user 可 @ 特定 agent（`@coder`）或 @ 其他 user。

**难点**
- CRDT 实现复杂度：先最简单的 LWW（last-write-wins）→ 后续升级。
- 消息顺序：agent 流式输出 + 多人同时输入，需要 vector clock。

**codebase 锚点**
- SSE 路由改造为 WebSocket（`ws` 库）。
- 消息写入加 `author: { kind: 'user' | 'agent', id: ... }`。

**DoD**
- [ ] 3 人同时加入 conversation，消息顺序一致
- [ ] 任一 user 触发 approval，其他人实时看到决策
- [ ] 离线用户上线后自动补齐 missed messages

**工时**：2 周

---

## Tier 3 · Self-Improvement（让系统自己变强）

### T3.1 Eval Harness（把 prompt / tool 当代码一样做回归）

**定位**：每次改 system prompt、加 tool、调整 Harness 参数，自动跑一组 golden case，diff 对比新旧行为。

**技术方案**
1. 新建 `server/src/eval/`：
   - `cases/` 目录，每个 case 是一个 YAML：
     ```yaml
     name: golden-github-summarize
     input: "帮我把过去一周的 arcana-agent repo PR 总结一下"
     modelId: gpt-4o
     expectations:
       must_call_tools: [github_pr_list, github_pr_diff]
       must_not_call_tools: [run_command]
       final_text_contains: ["PR #", "合并", "reviewer"]
       max_rounds: 5
     ```
   - `runner.ts`：批跑，每个 case 实际调 agent，对比 expectations，输出 diff。
2. CI 集成：每次 PR 改 `systemPrompt.ts` / tool schema / `harness/*` → 自动跑 eval，失败则挡 PR。
3. Dashboard：历史趋势（pass rate / avg rounds / avg cost 随 commit 变化）。
4. 自动扩充 case：从生产错误中（audit log 中的 `tool_error_cascade` / `harness_abort`）自动提取 → 人类 review → 入 golden set。

**难点**
- LLM 非确定性：同输入不同输出 → expectations 用"包含 / 工具调用序列"等结构化断言，不做逐字 match；用 `temperature=0` + seed 提高稳定性。
- 成本：全量跑一次 eval 可能 $5-10 → 分级（PR 必跑快 set / nightly 跑全 set）。

**codebase 锚点**
- `harness/evalGuard.ts` 已有 step-level eval 底子，扩到端到端。
- `vitest` 配置加 `eval` 命名空间。

**DoD**
- [ ] 100+ golden case，覆盖核心工具 / 团队模式 / guild / 多模态
- [ ] PR 自动触发 eval，失败挡 merge
- [ ] Dashboard 显示最近 30 天 pass rate 趋势

**工时**：2 周（骨架）+ 持续投入（case 积累）

---

### T3.2 Agent 自我学习 / 自写工具

**定位**：agent 观察到自己反复失败在某一类任务 → 自动生成改进提案（新 skill / 修改 system prompt / 新记忆条目）→ 人类 review 后启用。

**场景**
- Agent 连续 5 次被 user 纠正"别用 ls，用 list_files" → 自动提议加入 procedural memory
- Agent 发现"每周都被问 GitHub PR 状态" → 提议生成 `github-pr-digest` skill
- Agent 在某工具失败率 > 50% → 提议修改工具 description 或使用场景

**技术方案**
1. Reflection loop（按周 / 按触发条件）：
   - 输入：最近 N 对话的 audit log + 用户纠正（user message 中"不对 / 别这样 / 应该"的信号）+ tool 失败分布
   - 处理：LLM 生成 improvement proposals
   - 输出：类似 PR 的"改进候选"，含 diff + 理由 + 预期收益
2. 人类 review：UI 给每个 proposal `approve / reject / edit`，approved 后生效。
3. 写 skill：配合 T1.2 sandbox，agent 可以生成 + 测试 + 提交 skill 代码。

**难点**
- 防 reward hacking：不能让 agent 把"避免被纠正"当目标 → 纠正类型细分（知识错 vs 风格错 vs 策略错）。
- 人类审查负担：用分类 + 批量 review UI 减负。

**codebase 锚点**
- 依赖 audit log（P0-2）+ Long-term Memory（T1.4）+ sandbox（T1.2）。
- 新建 `server/src/reflection/`：weekly cron 跑、生成 proposals。

**DoD**
- [ ] 每周跑一次 reflection，产出 ≥ 3 条有意义 proposal
- [ ] 50% 以上 proposal 被 approve
- [ ] Reflection 本身的成本 ≤ $1/周

**工时**：2 周

---

### T3.3 Agent 辩论 / 共识（升级 Guild bidding）

**定位**：多 agent 针对同一问题独立给方案 → 互相 critique → 裁判聚合；对"单 agent 单推理容易错"的问题（代码 review / 方案评审 / 诊断）有系统性质量提升。

**技术方案**
1. Guild `bidding.ts` 已有竞标骨架，扩展 `debate` 模式：
   ```
   Round 1 (parallel): 3 个 agent 独立产出方案
   Round 2 (parallel): 每个 agent critique 其他两个
   Round 3: judge agent 聚合 + 产出最终答案（引用具体 critique）
   ```
2. 配置化：pipeline 里一个 `debate` 节点，N / 回合数 / judge 角色可配。
3. 成本 vs 质量 tradeoff：对高价值任务（生产代码 review）开启，日常关闭。

**难点**
- Groupthink：三个 agent 都用同一 base model → 同质化 → 强制用不同 model 或不同 system prompt。
- 成本：一次 debate ≈ 5-7 次常规调用。

**codebase 锚点**
- 现有 `bidding.ts` / `guildManager.ts` 基础良好。
- 前端 debate 可视化：树状展示方案 + critique 关系。

**DoD**
- [ ] 在代码 review benchmark 上，debate 模式比单 agent F1 提升 ≥ 10%
- [ ] 成本超过预算时自动降级为单 agent

**工时**：1.5 周

---

### T3.4 领域化 Agent 预设

**定位**：开箱即用的领域专家：SRE / 数据分析 / 内容运营 / 安全研究 / 法律分析 / 教学助手。

**技术方案**
- 每个预设 = `{ system_prompt, tool_allowlist, default_skills, pipeline_templates, sample_prompts, integrations }`
- `agents/presets/` 目录，YAML 定义，初始化向导引导用户选择。
- 每个预设配一个"能力评估"页面，说明在什么场景下表现好 / 差。

**difficulty**：主要是内容创作 + prompt 调优工作，工程量不大。

**工时**：每个预设 ~3 天，6 个预设 ≈ 2 周

---

## Tier 4 · 前沿赌注（想清楚再做）

### T4.1 Voice 实时对话（OpenAI Realtime / Gemini Live）
- **Upside**：交互形态颠覆，移动 / 车载场景独占。
- **Downside**：WebRTC + 低延迟要求，前后端改造巨大。
- **前置**：T1.1 computer use（语音命令"帮我订机票"才能真的完成）

### T4.2 Knowledge Graph 层
- 从对话 / 文档自动抽实体 + 关系存 Neo4j，agent 查询时 KG + vector 联合召回。
- 比 vector memory 更结构化，适合企业知识管理。
- 前置：T1.4 memory

### T4.3 Verifiable Receipts（可验证执行）
- 每次 tool 执行生成带签名 receipt（工具名 / 入参 hash / 输出 hash / 时间 / 执行方公钥）。
- 用于合规 / 审计 / 跨团队交付证据链。
- 前置：P0-2 audit log

### T4.4 On-Device 推理（Ollama / llama.cpp 适配器）
- 隐私 / 断网 / 成本敏感场景。
- 你的 `adapter.ts` 抽象好，适配成本低，~1 周。

### T4.5 Structured Output 全链路严格化
- OpenAI strict JSON schema / Anthropic tool_choice 强制类型。
- Tool schema Zod → provider schema 自动转换。
- 减少 parse 失败 / 幻觉参数。
- 工时 ~1 周，性价比高，可以提前放到 T1 附加项。

---

## 跨 Tier 工程卫生

- [ ] 每个新能力提供 **demo conversation**（录屏 + sample prompt），降低用户学习门槛。
- [ ] 每个 tier 结束做一次"能力矩阵"更新（README 的 Features 表），向外展示能力扩展。
- [ ] 能力 flag 化（`features.computerUse / features.sandbox / ...`），默认关，beta 用户开启。
- [ ] 新增 `docs/capabilities/` 目录，每个能力一份详细使用指南。

---

## 显式排除 / 暂不做

| 项 | 理由 |
|---|---|
| 自建基础模型 / 大规模 pretrain | 资源黑洞，与项目定位不符 |
| 复制一个 LangChain | 我们是 harness，不是 framework；继续借力 |
| 完整 IDE 替代（Cursor / VSCode 类） | 战线太长；先做好 agent 后端，IDE 侧走插件 |
| 区块链 / 去中心化 / web3 概念 | 除非 Verifiable Receipts（T4.3）有企业级需求，否则不碰 |
| 完全无人 autonomous agent（无人类循环） | 与 approval 的价值观冲突；永远保留 human-in-the-loop 入口 |

---

## 里程碑 & 决策点

**Phase A（T1 完成，~5 周）**
- 决策点：Computer Use / Sandbox / 多模态 三选二还是全做？取决于团队带宽与目标用户画像。
- 能力外观：agent 能处理图文音视频、能用浏览器、能跑任意代码——和 Cursor/Devin 同一量级。

**Phase B（T1+T2.1+T2.2，~10 周）**
- 决策点：是否开放多租户对外？取决于生产化（production-readiness-roadmap）P0+P1 是否也完成。
- 能力外观：和 Dify/Coze 比，多了生产级底座（来自 prod-roadmap）+ 更强的原生能力（computer use / sandbox）。

**Phase C（+T2.3+T3.1+T1.4，~14 周）**
- 决策点：要不要切 SaaS 商业化？
- 能力外观：有社区生态 + 自我演化 + 记忆系统，接近 Claude Code 同级别。

---

## 和 `production-readiness-roadmap.md` 的关系

```
production-readiness-roadmap.md  ← "能不能让别人用"
  P0 Security │ P1 Reliability │ P2 Observability │ P3 Scale

capability-expansion-roadmap.md   ← "值不值得别人用"
  T1 基础能力 │ T2 生态 │ T3 Self-Improvement │ T4 前沿

推荐交织节奏：
  Week 1-2: prod P0（阻断性）
  Week 3-6: prod P1 + cap T1.1 / T1.2 并行
  Week 7-10: prod P2 + cap T1.3 / T1.4
  Week 11-14: cap T2.1 / T2.2
  Week 15+: cap T3.1 + 按需 T4
```

生产化是"能不能活"，能力扩展是"活得值不值"。两条线都需要持续投入；T3（eval + 自进化）是最终把两条线缝合起来的关键闭环。

---

*Last updated: 2026-04-17*
