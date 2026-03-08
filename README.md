# 网页端智能体 (Web Agent)

一个最简单的网页端智能体应用：前端 React + TypeScript，后端 Express + TypeScript，Agent 使用 LangGraph，支持流式/非流式对话、历史会话（文件存储）、上下文压缩、可配置的 Tools，以及符合 SKILL.md 规范的 Demo Skill。

## 功能

- **对话**：创建会话、发送消息、查看历史；数据存于本地文件，会话隔离。
- **上下文**：每个会话单独管理，超过约 30 条消息时自动只保留最近 20 条参与推理（可压缩）。
- **流式 / 非流式**：页面上对话使用流式接口实时展示；另有 `POST /chat` 与 `POST /conversations/:id/messages/sync` 支持非流式调用。
- **Tools**：内置工具（如 `calculator`、`get_time`、`echo`），可在「Tools / MCP」中勾选启用，供 Agent 在对话中调用。
- **Skill**：默认技能在项目根目录 `skills/`（随仓库提交）；用户上传的 ZIP 安装到 `server/data/skills/`，可在设置中管理。
- **模型**：通过 `config/models.json` 配置，默认使用火山引擎（Volcengine）豆包模型；API Key 可用环境变量 `VOLCENGINE_API_KEY` 覆盖。

## 目录结构

```
my_agent/
├── config/
│   └── models.json          # 模型配置（火山引擎等）
├── server/                  # 后端 (Express + LangGraph)
│   └── src/
│       ├── index.ts
│       ├── agent.ts
│       ├── storage.ts
│       ├── tools/           # 可被 Agent 调用的工具 (calculator, get_time, echo)
│       └── ...
├── skills/                 # 默认 Skill（SKILL.md 规范，随仓库提交）
│   └── demo/
│       ├── SKILL.md
│       └── scripts/
├── web/                     # 前端 (Vite + React)
│   └── src/
│       ├── App.tsx
│       ├── api.ts
│       └── ...
├── data/                    # 运行时生成：会话与配置
│   ├── conversations/
│   └── user-config.json
└── prompt.md
```

## 快速开始

### 1. 安装依赖

```bash
cd /Users/cloud/Desktop/my_agent
npm install
cd server && npm install
cd ../web && npm install
```

### 2. 配置模型

已包含 `config/models.json` 中的火山引擎配置。如需使用自己的 API Key，可设置环境变量：

```bash
export VOLCENGINE_API_KEY=你的apiKey
```

### 3. 启动

同时启动后端与前端（推荐）：

```bash
npm run dev
```

或分别启动：

```bash
# 终端 1：后端 http://localhost:3001
npm run dev:server

# 终端 2：前端 http://localhost:5173（代理 /api 到后端）
npm run dev:web
```

浏览器打开 http://localhost:5173 即可使用。

## API 说明

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /conversations | 会话列表 |
| POST | /conversations | 创建会话 |
| GET | /conversations/:id | 会话详情 |
| GET | /conversations/:id/messages | 会话消息列表 |
| POST | /conversations/:id/messages | 发送消息（流式 SSE） |
| POST | /conversations/:id/messages/sync | 发送消息（非流式） |
| POST | /chat | 直接对话（非流式，无需会话 ID） |
| GET | /config | 获取 Skill/MCP 配置 |
| PUT | /config | 更新配置（enabledToolIds、mcpServers） |

## 技术栈

- **前端**：React 18、TypeScript、Vite
- **后端**：Express、TypeScript、LangGraph、@langchain/openai（兼容火山引擎 OpenAI 接口）
- **存储**：文件系统（`data/conversations`、`data/user-config.json`）
