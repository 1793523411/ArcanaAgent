# ArcanaAgent 生产级改造规划

> 基于 Agent-Architect 5 层框架（Loop / Tools / Knowledge / Context / Governance）对现状做 gap 分析后产出的改造路线图。
>
> **目标**：从"自用型 self-hosted demo"升级为"可对外部署、可多租户、可审计、可运维"的生产级 Agent 平台。
>
> 作用域假设：继续以 **Node.js + Express + LangGraph** 为主栈；前端暂不重构；存储短期内仍以 JSON 文件为主，生产部署切 Postgres/SQLite。

---

## 0. TL;DR

| 阶段 | 名称 | 工时估算 | 解决问题 |
|---|---|---|---|
| **P0** | Security Hardening | 1.5 周 | 无鉴权、SSRF、凭证落盘、审计空白 |
| **P1** | Reliability & Harness 补强 | 2 周 | 单模型挂停服、崩溃丢数据、Prompt 冗长、双路径漂移 |
| **P2** | Observability & Cost Control | 1.5 周 | 无 metrics/tracing、无配额、无成本归因 |
| **P3** | Scale & Persistence | 2-3 周 | 无持久记忆、无多租户、JSON 扩展性天花板 |

**合计**：~2 人月。P0 完成前禁止暴露到公网；P0+P1 完成即可内部团队生产使用；P2+P3 完成后可考虑对外 SaaS。

---

## P0 · Security Hardening（阻断性，必须先修）

### P0-1 HTTP 鉴权 & 最小权限

**现状**：`server/src/index.ts:104` 所有 API 裸跑，任何能访问 `:3001` 的客户端都能：
- 读写任意 conversation
- 执行 `run_command` / `write_file`
- 读 / 写 `~/.arcana-agent/models.json`（含 provider apiKey）
- 触发 scheduler / guild 自动化

**改造**
1. 新增 `server/src/auth/` 模块：
   - `authMiddleware.ts` — 支持三种模式（互斥，由 `user-config.json` 选）：
     - `none`（仅当 `HOST=127.0.0.1` 且 `NODE_ENV=development` 时允许，其他情形启动即拒）
     - `api-key`（Bearer token，key 存 `~/.arcana-agent/auth.json`，bcrypt hash，首次启动自动生成并打印到日志仅一次）
     - `oauth-proxy`（信任上游反向代理注入的 `X-User-*` 头，适合 Cloudflare Access / Pomerium 前置场景）
   - `principals.ts` — `Principal { userId, role, quotas }`，挂到 `req.user`。
2. 按路由分组打 middleware：
   - 读类（conversations list / get / artifacts）→ `requireAuth`
   - 写 / 执行类（messages / run_command / scheduler / guild）→ `requireAuth + requireRole('member')`
   - 配置类（providers / agents / teams / skills upload）→ `requireRole('admin')`
3. CORS 白名单化：`cors({ origin: config.cors.allowedOrigins, credentials: true })`，默认仅同源。

**验收**
- `curl http://host:3001/api/conversations` 未带鉴权 → `401`。
- 非 admin 用户调 `POST /api/models/providers` → `403`。
- 启动日志出现 "Auth mode: api-key, key printed once above. Store safely."

**新文件**：`server/src/auth/authMiddleware.ts`、`server/src/auth/principals.ts`、`docs/auth-setup.md`。

---

### P0-2 审计日志（Audit Log）

**现状**：`serverLogger` 只打 info/warn/error，无结构化审计事件；approval 决策、高危工具调用、配置变更无不可篡改记录。

**改造**
1. 新增 `server/src/audit/` 模块：
   - `auditLogger.ts` — 单例，事件 schema：
     ```ts
     interface AuditEvent {
       ts: string;            // ISO8601
       actor: { userId: string; role: string } | { system: string };
       action: string;        // "tool.run_command" / "approval.decide" / "config.providers.update" …
       target: { kind: string; id: string };
       context: { conversationId?: string; subagentId?: string; requestId?: string };
       outcome: "success" | "blocked" | "error" | "approved" | "rejected";
       meta: Record<string, unknown>;  // tool args hash、risk reason、diff 摘要
     }
     ```
   - 双写：append 到 `~/.arcana-agent/audit.log`（JSONL，按日轮转）+ 内存环形 buffer 供 `/api/audit` 读取。
2. 接入点：
   - `approvalManager.resolveRequest` → action=`approval.decide`
   - `wrapToolWithApproval` 执行完毕 → action=`tool.{name}`, outcome=success/blocked
   - `isBypassImmune` 命中 → outcome=blocked
   - Config / Agent / Team CRUD → action=`config.*`
3. 敏感字段脱敏：`apiKey`、`content_base64`、`content` 长度 > 1KB 仅记 `sha256 + len`。

**验收**
- 触发一次 approval 否决，`audit.log` 出现两条事件（request_created + rejected）。
- Admin 页面新增 "Audit" 标签，可按 actor / action / outcome 过滤近 1000 条。

---

### P0-3 SSRF / 凭证外泄防护

**现状**：`fetch_url` / `web_search` 对 URL 无任何 host 过滤；`POST /api/models/providers` 允许写任意 `baseUrl`；`claude_code` 工具起子进程继承环境变量。

**改造**
1. 新建 `server/src/lib/urlGuard.ts`：
   - 解析 URL → DNS lookup → 拒绝 `127.0.0.0/8`, `169.254.0.0/16`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `::1`, `fc00::/7`, `fe80::/10`, `metadata.google.internal`, `100.100.100.200`（阿里云元数据）。
   - 对 redirect 跟随递归校验（防 DNS rebinding 用 resolved IP 校验，不仅看 hostname）。
   - 默认仅允许 `http/https`；白名单 scheme 可配置。
2. `fetch_url` / `web_search` / MCP HTTP transport / model provider 请求全部走 urlGuard。
3. Provider 注册鉴权 + baseUrl 白名单（默认 `api.openai.com` / `api.anthropic.com` / `ark.cn-beijing.volces.com` 等；自定义需 admin + 警告）。
4. API key 存储加密：使用系统 keychain（macOS Keychain / libsecret / Windows Credential Manager），或至少用机器绑定的 `crypto.scrypt` + 机器 ID 对称加密后落盘；`models.json` 只存密文。
5. `claude_code` 子进程清空敏感 env（`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` 不继承，除非显式 allowlist），cwd 强制限制在 conversation workspace。

**验收**
- `fetch_url("http://169.254.169.254/latest/meta-data/")` → `[blocked] SSRF: target resolves to metadata IP`。
- `models.json` 中 apiKey 字段为 `enc:v1:...` 密文。

---

### P0-4 Rate Limit / 请求硬限

**现状**：无 rate limit；`express.json({ limit: "10mb" })` 但未限路由深度；SSE 长连接无 per-user 并发限制。

**改造**
1. 引入 `express-rate-limit` + `rate-limit-redis`（若有 Redis）：
   - 全局：100 req / 分钟 / IP
   - 写类路由：30 / 分钟 / user
   - LLM 触发类（`/messages`）：10 并发 / user，超出 429
2. SSE 连接：per-user 最多 3 条活跃连接，超出关闭最旧。
3. 文件上传 `postSkillsUpload` 强校验：zip 内条数 ≤ 100、总解压体积 ≤ 50MB、禁止 `..` / 绝对路径（zip slip 防护）。

**验收**
- 并发 15 个 `/messages` 同 user → 10 条进入，5 条 429。
- 上传恶意 zip（含 `../../../etc/passwd`）→ 拒绝，audit 记录。

---

## P1 · Reliability & Harness 补强

### P1-1 Continue-Site 补全 + Model Fallback Chain

**现状**：仅 `model_error` / `tool_error_cascade` 两个 continue-site；模型挂了只能重试同一个 provider。

**改造**
1. 新增 continue-site：
   - `context_overflow`：检测到 HTTP 400 "context_length_exceeded" / token 超窗 → 触发 `pruneConversationIfNeeded(state, cap * 0.5)` 强压缩后重入循环。
   - `rate_limited`：检测 HTTP 429 / provider 限流错误 → 指数退避 + 切换到备用 modelId。
   - `permission_denied`：approval 被拒 → 注入 HumanMessage 告知 agent 换一条路径（而非整轮终止）。
2. Model fallback chain 配置：
   ```jsonc
   "modelFallback": {
     "gpt-4o": ["gpt-4o-mini", "claude-haiku-4-5"],
     "claude-opus-4-7": ["claude-sonnet-4-6"]
   }
   ```
   - `adapter.streamSingleTurn` 抛连续 2 次失败 → 降级到 chain 下一个。
   - 降级事件写 audit + 推 SSE（前端 toast 提示）。
3. `maxRounds=500` 降到 100，并引入 per-round 硬超时（默认 5 分钟），超时触发 `tool_timeout` continue-site。

**验收**
- 模拟 OpenAI 503 → 日志出现 `[fallback] gpt-4o → gpt-4o-mini`，对话继续。
- 人造超长上下文 → `context_overflow` continue-site 触发，压缩后成功回复。

---

### P1-2 双路径合并（消除 200 行重复循环）

**现状**：`server/src/agent/index.ts` 路径 1（reasoning stream）与路径 2（LangChain stream）业务逻辑 ~95% 一致但分两份维护，作者自己在注释里标了 TODO。

**改造**
1. 给 `AnthropicAdapter` 实现 `streamSingleTurn(messages, onToken, onReasoning, tools, signal)`：通过 Anthropic SDK content blocks 原生提取 `thinking` 块 + `tool_use` 块，返回与 OpenAI 版本同结构的 `{ content, reasoningContent, toolCalls, usage }`。
2. 统一走路径 1，删除路径 2 的循环体（保留 LangChain 依赖用于 `getLLM().bindTools()` 做 tools 描述转换即可，不再用它的 `stream()`）。
3. 抽 `runAgentLoop(adapter, messages, tools, handlers, signal)` 作为唯一 Agent Loop 入口，`streamAgentWithTokens` 退化为薄适配层。

**验收**
- `server/src/agent/index.ts` 总行数下降 ≥ 200。
- 覆盖率测试中两个 provider 走同一份循环代码路径。

---

### P1-3 Graceful Shutdown + Scheduler Recovery

**现状**：`app.listen` 未挂 SIGTERM/SIGINT；被 `kill` 时 background tasks、approval pending、scheduler 正在执行的任务、Guild 自主 agent 都会丢状态。

**改造**
1. 新增 `server/src/lib/shutdown.ts`：
   - 注册 `SIGTERM` / `SIGINT` 处理器。
   - 按顺序优雅关闭：
     1. 停止接收新请求（`server.close()`）
     2. 取消所有 approval pending（`approvalManager.cancelAll()`）
     3. 对所有活跃 SSE 连接发 `event: shutdown`
     4. 停 `schedulerManager` + `guildAutonomousScheduler`（等当前 execution 结束，最多 30s）
     5. 等 background tasks 完成或 `SIGKILL` 它们
     6. flush audit log / 持久化内存态
     7. `process.exit(0)`
   - 硬超时 60s，到点强制退出。
2. Scheduler 重启恢复：`storage` 层给 `schedulerExecutions` 加 `status=running` 标记，启动时扫描 → 将非终态记录标记为 `interrupted` + audit 告警。
3. 进程级 `unhandledRejection` / `uncaughtException` 挂 handler 写 audit 后退出（配合 PM2 / systemd 自动拉起）。

**验收**
- `kill -TERM <pid>` → 日志出现 "Graceful shutdown: step 1/6…"，60s 内退出，无 orphan approval。
- 模拟崩溃重启 → 之前 running 中的 scheduler 执行记录被标记 interrupted。

---

### P1-4 原子写 + 存储层抽象

**现状**：`storage/index.ts` 主路径是 `writeFileSync(path, JSON.stringify(...))`；`guild/atomicFs.ts` 有原子写但未全局启用。

**改造**
1. 扩展 `atomicFs.ts` → `server/src/lib/atomicFs.ts`（移出 guild）：
   - `writeJsonAtomic(path, obj)` = 写 tmp → fsync → rename。
   - 全部 `storage/*.ts` 的 `writeFileSync` 切换到此函数。
2. 新增 `server/src/storage/backend.ts` 接口：
   ```ts
   interface StorageBackend {
     readJson<T>(key: string): Promise<T | null>;
     writeJson<T>(key: string, value: T): Promise<void>;
     list(prefix: string): Promise<string[]>;
     delete(key: string): Promise<void>;
     lock(key: string): Promise<() => void>;  // for concurrent writes
   }
   ```
   - 默认实现 `FileBackend`（现状）；预留 `SqliteBackend` / `PostgresBackend` 供 P3 使用。
3. 对 conversations / messages 引入写锁（同 conversationId 串行化）。

**验收**
- 人造 kill-9 瞬间写 messages.json → 重启后文件完整（无半截 JSON）。

---

### P1-5 System Prompt 瘦身 + 按需加载

**现状**：`BASE_SYSTEM_PROMPT` ~110 行、`buildSystemPrompt` 无条件拼接 team/enhancements/env/workspace/index/mcp/skill/claudeCode 所有段，估算 2500+ token。

**改造**
1. 将 `BASE_SYSTEM_PROMPT` 拆分为 **核心身份（< 400 token）** + **命名片段**（`communication_rules` / `tool_strategy` / `background_rules` / `auto_verification` / `safety` / `context_awareness` …）。
2. `buildSystemPrompt` 根据启用的工具 / 模式动态拼接：
   - 没启用 `background_run` → 不注入 `background_rules`
   - 没启用 `project_*` → 不注入 `index_strategy`
   - 非 team 模式 → 不注入 `team_mode_rules`
3. 引入 prompt cache 稳定前缀：
   - 顺序固定：`[identity][safety][tools_schema（按 name 排序）][mcp_tools][skills][env][workspace][conversation_specific]`
   - 前 5 段拼接后 hash，作为 cache key；未变更时走 Anthropic `cache_control` / OpenAI prompt cache。
4. 给 `systemPrompt.ts` 加单元测试：断言核心身份 ≤ 400 token，完整 prompt ≤ 1800 token（用 `estimateTextTokens`）。

**验收**
- 默认模式 system prompt token 数下降 ≥ 30%。
- 连续两次请求（system prompt 未变）的 `prompt_tokens_cached_ratio`（Anthropic）≥ 0.8。

---

## P2 · Observability & Cost Control

### P2-1 OpenTelemetry 接入

**现状**：只有 `serverLogger`，无 trace / metrics；无法回答 "昨天 p95 延迟 / 失败率 / 每模型成本分布"。

**改造**
1. 引入 `@opentelemetry/sdk-node` + `@opentelemetry/auto-instrumentations-node`：
   - HTTP 自动埋点（req → trace_id）
   - 手动埋点关键 span：`agent.loop.round`、`tool.{name}`、`llm.call`（属性：model, prompt_tokens, completion_tokens, stop_reason）
   - trace_id 通过 SSE `event: trace` 透传给前端，debug 时可跳到 Grafana Tempo 查完整链路
2. Metrics：
   - Counter: `agent_tool_calls_total{name,outcome}`
   - Histogram: `agent_round_duration_seconds{model}`
   - Gauge: `agent_active_conversations`
   - Counter: `llm_tokens_total{model,kind=prompt|completion}`
3. 导出器：OTLP gRPC（默认 `http://localhost:4317`，可配置）；无 collector 时退化为 stdout JSON。
4. `/metrics` endpoint（Prometheus text format）作为兜底。

**验收**
- Jaeger UI 可看到一次 `/messages` 请求的完整调用树（http → agent.loop × N → tool.* → llm.call）。
- `curl /metrics` 返回 `agent_tool_calls_total` 等指标。

---

### P2-2 成本追踪 & 配额

**现状**：`usageTokens` 已记录，但未反向约束；无 per-user / per-conversation / per-day 配额；无成本归因。

**改造**
1. 新增 `server/src/cost/` 模块：
   - `pricing.ts` — 每个 model 的 `{ promptUsd, completionUsd, cachedPromptUsd }` 表，按百万 token 计价。
   - `costTracker.ts` — 每次 llm.call 完成后累加到（userId, conversationId, model, day）维度，存 `~/.arcana-agent/cost.jsonl`（后续迁 DB）。
2. Quota 配置：
   ```jsonc
   "quotas": {
     "perUserDailyUsd": 5.0,
     "perConversationUsd": 1.0,
     "perUserMaxConcurrent": 3
   }
   ```
   - 进入 Agent Loop 前预检查；超限直接 429 + audit。
   - 接近阈值（80%）SSE 推送 warning 事件，前端提示用户。
3. Admin 看板：`/api/cost/summary?from=...&to=...&groupBy=user|model|day` 返回聚合数据。

**验收**
- 日均成本 $5 的 user 在第 6 次贵模型请求时被拒，前端提示 "quota exceeded, resets at midnight UTC"。
- Admin 页面显示过去 7 天按 model 切分的成本饼图。

---

### P2-3 错误分级 & 告警

**改造**
1. 定义错误等级（Critical / Error / Warn / Info），挂到 `serverLogger` + audit：
   - **Critical**：auth 模块崩溃、存储写失败、scheduler 启动失败
   - **Error**：LLM 连续失败导致对话终止、bypass_immune 被尝试绕过、SSRF 尝试
   - **Warn**：单次 tool 失败、approval 超时、rate limit 命中
2. Critical / Error 事件触发 webhook（Feishu / Slack / PagerDuty，复用现有 scheduler webhook payload 机制）。
3. `/api/health` 扩展为 `/api/livez` + `/api/readyz`（readyz 检查 DB/storage/ MCP 可达）。

**验收**
- 人为制造存储写失败 → 告警 webhook 收到 Feishu 卡片消息；readyz 返回 503。

---

## P3 · Scale & Persistence

### P3-1 Session Memory（跨对话持久记忆）

**现状**：主 agent 对话压缩后信息永久丢失；Guild 的 `memoryManager` 只服务 agent 角色级经验检索。

**改造**
1. 对齐 Claude Code 四级压缩第 4 级：
   - 每次对话达到某个里程碑（对话结束 / 触发 Full Compact）时，调用 LLM 生成结构化 Session Memory：
     ```md
     # Conversation <id> Memory
     ## User Intent
     ## Key Decisions
     ## Artifacts Produced
     ## Open Questions
     ## Referenced Files
     ```
   - 存 `~/.arcana-agent/session-memory/{conversationId}.md`，体积上限 5KB。
2. 新对话启动时：
   - 根据 user id + 最近 10 条 conversation 的 session-memory，做语义召回（复用 LanceDB / 或简单 BM25）。
   - 匹配度 > 阈值的注入为 system prompt 的 `<prior_sessions>` 段。
3. 提供 `/api/memory/prune` 允许 user 手动删除。

**验收**
- 新开对话提问 "继续昨天那个 xxx 的问题" → agent 能引用昨天的 artifacts / 决策。

---

### P3-2 存储迁移：JSON → SQLite（单机）/ Postgres（集群）

**现状**：conversation / messages / scheduler / guild / cost 全是 JSON 文件，大数据量下 list / query 性能崩溃，无事务。

**改造**
1. 基于 P1-4 的 `StorageBackend` 接口，实现 `SqliteBackend`（`better-sqlite3`），schema：
   - `conversations(id, user_id, meta_json, created_at, updated_at)`
   - `messages(id, conversation_id, seq, role, content, tool_calls_json, usage_json, created_at)` — 核心热路径表
   - `audit_events(id, ts, actor_user_id, action, outcome, meta_json)` — 索引 (actor, ts), (action, ts)
   - `cost_events(id, user_id, conversation_id, model, prompt_tokens, completion_tokens, cost_usd, ts)`
   - `scheduled_tasks` / `guild_*`
2. 提供一次性迁移脚本 `scripts/migrate-json-to-sqlite.ts`，含 dry-run + rollback。
3. `DATABASE_URL` 环境变量：`sqlite://path` 或 `postgres://...`，后者走 `pg` 驱动共用同一 interface。

**验收**
- 1000 条 conversation 场景下 `GET /api/conversations` p95 从 > 500ms 降到 < 50ms。
- 迁移脚本 dry-run 输出预期变更，实际迁移保留原 JSON 作为备份。

---

### P3-3 Multi-Tenant 隔离

**现状**：没有 user / org 概念，workspace 按 conversationId 分，guild 资产跨 conversation 共享。

**改造**
1. 引入 `users` / `orgs` 表，conversation / agent / team / skill / pipeline 所有主体表加 `owner_user_id` / `org_id`。
2. 查询层默认 scope 到 `req.user.orgId`；admin 可跨 org 查询但必须留 audit。
3. 前端侧栏按 org 切换，URL path 加 `/o/{orgSlug}/`。
4. Skill / MCP 注册分三档：
   - **built-in**：随版本发布
   - **org-shared**：org admin 安装
   - **user-private**：个人上传
5. Workspace 路径：`~/.arcana-agent/data/orgs/{orgId}/conversations/{convId}/`。

**验收**
- User A 无法看到 / 访问 User B（不同 org）的 conversation / artifact / skill。
- Admin 后台展示 per-org 资源使用量。

---

### P3-4 Scale-out：Queue + Worker

**现状**：单进程 Express，LLM 长请求直接跑在 req handler 中；跨实例无协调。

**改造（选做，当单机撑不住时启用）**
1. 引入 BullMQ（Redis-backed）：
   - `/messages` 不再直接执行 Agent Loop，而是投递到 `agent-jobs` queue，立刻返回 jobId。
   - 同进程或独立 worker 进程消费 queue，执行结果写回 DB + 推 SSE（通过 Redis pub/sub 广播到持有 SSE 连接的前端网关）。
2. Scheduler / Guild 自主调度同样走 queue，保证崩溃后任务不丢。
3. 部署形态：
   - `web` 进程（N 个）：处理 HTTP / SSE
   - `worker` 进程（M 个）：消费 agent-jobs / scheduler-jobs
   - 独立 Redis + Postgres

**验收**
- 压测：单 web + 4 worker 下支撑 50 并发对话 p95 < 10s。
- 杀掉任一 worker，任务由其他 worker 接管，无任务丢失。

---

## 跨阶段工程卫生

- [ ] **`CHANGELOG.md`** 按阶段更新，每个 P0/P1 变更列出 breaking change。
- [ ] **配置迁移脚本**：user-config schema 升级时自动迁移 + 备份旧版。
- [ ] **e2e 测试**：新增 `server/test/e2e/` 目录，覆盖 auth / quota / SSRF / graceful-shutdown / fallback-chain 至少各 1 条黑盒用例。
- [ ] **feature flag**：P2/P3 能力通过 `features.{name}=on|off` 灰度，避免一次性变更。
- [ ] **文档同步**：新增 `docs/deployment-guide.md`（生产部署 checklist）、`docs/security-model.md`（威胁模型 + 边界说明）。

---

## 不做什么（显式排除）

| 项 | 理由 |
|---|---|
| 全量改写为 Nest/Fastify | 没有明显收益，迁移成本高 |
| 自研 Agent Framework 替代 LangGraph | LangGraph 已够用；继续借力社区 |
| 同步实现 WebSocket 替换 SSE | SSE 够用；WS 仅在多用户协同编辑场景再议（README roadmap 已列） |
| 一上来就上 Kubernetes | 单机 + PM2/systemd 足以支撑前 1000 用户；K8s 等 P3-4 后再议 |
| 插件市场 | README roadmap 项，优先级低于生产硬性需求 |

---

## 里程碑验收（合并条件）

每个阶段结束前，以下清单必须全绿才能合并主分支：

**P0 DoD**
- [ ] 未鉴权请求 100% 被拒（除 livez / readyz）
- [ ] 审计日志覆盖全部高危操作
- [ ] `npm run test:security` 全绿（新增）
- [ ] 外部渗透 checklist（OWASP Top 10 相关项）过一遍

**P1 DoD**
- [ ] 模型主挂测试：主 provider 故障注入 30 分钟，对话成功率 ≥ 95%
- [ ] 崩溃恢复测试：kill-9 后重启，scheduler 执行历史一致
- [ ] System prompt token 数 / cache 命中率达标
- [ ] 双路径合并后旧测试 100% 通过

**P2 DoD**
- [ ] Jaeger / Prometheus 可视化就绪
- [ ] 配额触发能正确 429 并在前端提示
- [ ] Webhook 告警能收到 1 次 Critical 事件

**P3 DoD**
- [ ] 1000 conversation 数据量下核心 API p95 达标
- [ ] Multi-tenant 隔离测试（跨 org 零泄漏）
- [ ] 迁移脚本可 dry-run、可 rollback

---

*Last updated: 2026-04-17*
