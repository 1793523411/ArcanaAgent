<div align="center">

# Rule Agent

### Your Self-Hosted AI Agent Platform

**Conversations. Automation. Code Intelligence. Team Collaboration.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/1793523411/rule-agent/pulls)

<br/>

*An open-source, full-stack AI agent platform that combines interactive chat, intelligent task scheduling, deep code understanding, and multi-agent team collaboration — all through a beautiful web interface.*

<br/>

[Quick Start](#-quick-start) &bull; [Features](#-features) &bull; [Architecture](#-architecture) &bull; [API Reference](#-api-reference) &bull; [Configuration](#-configuration) &bull; [Contributing](#-contributing)

</div>

---

## Why Rule Agent?

Most AI chat tools are stateless and isolated. **Rule Agent** is different — it's a persistent, self-hosted platform where AI agents can:

- **Read, write, and understand your codebase** with semantic search and AST-based indexing
- **Execute scheduled tasks** with cron expressions, dependencies, and webhook integrations
- **Work as a team** — multiple agents collaborating with role-based access control
- **Stay within context** using intelligent compression that summarizes old messages automatically
- **Be extended** with custom skills, MCP servers, and any OpenAI-compatible LLM

Think of it as your private AI command center for development and automation.

---

## Quick Start

### Install & Run

```bash
# Install globally
npm install -g rule-agent

# Start the server
rule-agent start

# Open the web UI
rule-agent open
```

That's it. The web UI opens at `http://localhost:3001`.

### From Source

```bash
git clone https://github.com/1793523411/rule-agent.git
cd rule-agent
npm install && npm run build
npm run dev    # Backend :3001 + Frontend :5173 with hot reload
```

### Configure Your LLM

On first run, edit `~/.rule-agent/models.json` with your API key:

```jsonc
{
  "models": {
    "providers": {
      "openai": {
        "baseUrl": "https://api.openai.com/v1",
        "apiKey": "sk-...",
        "api": "openai-completions",
        "models": [
          { "id": "gpt-4o", "name": "GPT-4o", "contextWindow": 128000, "maxTokens": 4096 }
        ]
      }
    }
  }
}
```

> Supports **OpenAI**, **Anthropic**, **VolcEngine (Doubao)**, and any **OpenAI-compatible** endpoint.

---

## Features

### AI Agent Conversations

Interactive chat with streaming responses, multi-turn context, and real-time tool execution.

- **15+ built-in tools** — file I/O, code search, git operations, web search, test runner, and more
- **Planning mode** — agents break down complex tasks into step-by-step plans with reasoning
- **Artifact system** — code and files are separated from the conversation for clean readability
- **Context compression** — automatically summarizes old messages to stay within token limits

### Code Intelligence

Go beyond simple text search. Rule Agent understands your code structure.

| Strategy | How It Works | Best For |
|----------|-------------|----------|
| **Vector Search** | LanceDB embeddings with semantic similarity | "Find functions related to authentication" |
| **Repomap** | AST parsing + PageRank to find key symbols | Understanding code structure and relationships |
| **Ripgrep** | Fast regex-based text search (fallback) | Exact string/pattern matching |

The system auto-detects which strategy works best for your project.

### Scheduled Tasks & Automation

Automate recurring workflows with a full-featured task scheduler.

```
Type            Description                           Example
────────────────────────────────────────────────────────────────
Conversation    Send prompts to AI conversations      Daily code review
Webhook         HTTP requests (Feishu, Slack, etc.)   Post daily report to Slack
Skill           Execute custom skill packages         Run web scraper nightly
System          Cleanup, backup operations             Weekly log rotation
```

- **Cron expressions** — `0 9 * * 1-5` (weekdays at 9am)
- **One-time tasks** — execute at a specific UTC time
- **Task dependencies** — chain tasks into orchestrated workflows
- **AI-powered payloads** — use model output in webhook requests
- **Full execution history** with audit trail

### Multi-Agent Teams

Create teams of specialized agents that collaborate on complex tasks.

- **Role-based agents** — each with custom system prompts and tool restrictions
- **Approval workflows** — human-in-the-loop for sensitive operations
- **Visual workflow editor** — drag-and-drop team interaction design
- **Round-based execution** — structured collaboration with task handoffs

### Extensibility

- **Custom Skills** — upload ZIP packages with `SKILL.md` definitions
- **MCP Integration** — Model Context Protocol for custom tool servers
- **Multi-Provider LLM** — switch between providers from the UI
- **REST API** — full programmatic access to all features

---

## Architecture

```
rule-agent/
├── cli.js                  # CLI entry point (start/stop/status/logs)
├── server/                 # Express.js + LangGraph backend
│   ├── src/
│   │   ├── agent/          # Core agent logic (state graphs, planning, roles)
│   │   ├── tools/          # 15+ tool implementations
│   │   ├── scheduler/      # Cron engine + task executor
│   │   ├── index-strategy/ # Vector / Repomap / Ripgrep search
│   │   ├── llm/            # Multi-provider LLM adapter
│   │   ├── mcp/            # Model Context Protocol integration
│   │   ├── skills/         # Skill discovery & loading
│   │   └── api/            # REST API routes
│   └── public/             # Built frontend assets
├── web/                    # React + TypeScript frontend
│   └── src/
│       ├── components/     # Chat, Sidebar, Artifacts, Scheduler UI
│       └── App.tsx         # Router & layout
├── skills/                 # Built-in skills
│   ├── ddgs-web-search/    # DuckDuckGo web search
│   ├── playwright-web-capture/  # Web scraping & screenshots
│   └── novelty-driven-planning/ # AI planning strategy
└── config/                 # Configuration templates
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| **Agent Framework** | LangGraph (StateGraph + ToolNode) |
| **Backend** | Express.js, TypeScript, node-cron |
| **Frontend** | React 18, Tailwind CSS v4, Monaco Editor |
| **Code Parsing** | tree-sitter (TypeScript, Python, JavaScript) |
| **Vector Search** | LanceDB |
| **Flow Diagrams** | XYFlow |
| **UI Primitives** | Radix UI |

---

## CLI Reference

```bash
rule-agent start              # Start the server (default port 3001)
rule-agent stop               # Stop the server
rule-agent restart             # Restart the server
rule-agent status              # Check if running
rule-agent logs                # View server logs
rule-agent open                # Open web UI in browser

# Environment variables
PORT=8080 rule-agent start               # Custom port
DATA_DIR=/path/to/data rule-agent start  # Custom data directory
```

---

## API Reference

### Conversations

```bash
POST   /api/conversations                    # Create conversation
GET    /api/conversations                    # List conversations
GET    /api/conversations/:id/messages       # Get messages
POST   /api/conversations/:id/messages       # Send message (SSE streaming)
POST   /api/conversations/:id/messages/sync  # Send message (synchronous)
POST   /api/conversations/:id/compress       # Force context compression
POST   /api/conversations/:id/index-build    # Build code index
DELETE /api/conversations/:id                # Delete conversation
```

### Scheduled Tasks

```bash
POST   /api/scheduled-tasks                  # Create task
GET    /api/scheduled-tasks                  # List tasks
PUT    /api/scheduled-tasks/:id              # Update task
DELETE /api/scheduled-tasks/:id              # Delete task
POST   /api/scheduled-tasks/:id/execute      # Execute manually
POST   /api/scheduled-tasks/:id/toggle       # Enable/disable
GET    /api/scheduled-executions              # Execution history
```

### Configuration & Skills

```bash
GET    /api/config                           # Get configuration
PUT    /api/config                           # Update configuration
GET    /api/models                           # Available LLM models
GET    /api/skills                           # List skills
POST   /api/skills                           # Upload skill (ZIP)
```

### Teams & Agents

```bash
GET    /api/agents                           # List agent definitions
POST   /api/agents                           # Create agent
GET    /api/teams                            # List teams
POST   /api/teams                            # Create team
GET    /api/approvals                        # Pending approvals
POST   /api/approvals/:id/decide             # Approve/reject action
```

---

## Configuration

All configuration lives in `~/.rule-agent/`:

```
~/.rule-agent/
├── models.json          # LLM provider settings & API keys
├── user-config.json     # Preferences (tools, MCP servers, context strategy)
├── server.pid           # Process ID
└── server.log           # Server logs
```

### User Config Example

```json
{
  "enabledToolIds": ["read_file", "write_file", "run_command", "search_code"],
  "mcpServers": [],
  "modelId": "gpt-4o",
  "context": {
    "strategy": "compress",
    "tokenThresholdPercent": 75,
    "compressKeepRecent": 20
  }
}
```

> For the full configuration guide, see [CONFIGURATION.md](./CONFIGURATION.md).

---

## Development

### Prerequisites

- Node.js >= 18.0.0
- npm

### Commands

```bash
npm run dev              # Start dev mode (backend + frontend with hot reload)
npm run build            # Production build
npm run test             # Run tests
npm run test:watch       # Watch mode
```

### Development Mode

```bash
npm run dev
# Backend  → http://localhost:3001
# Frontend → http://localhost:5173 (proxies API to backend)
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Server won't start | `rule-agent logs` to check errors |
| Port already in use | `PORT=8080 rule-agent start` |
| Permission errors | `chmod +x cli.js` |
| Context too long | Increase `tokenThresholdPercent` or switch to `compress` strategy |
| Index build slow | Use `repomap` strategy for large repos instead of `vector` |

---

## Roadmap

- [ ] Plugin marketplace for community skills
- [ ] WebSocket real-time collaboration
- [ ] Multi-user authentication & permissions
- [ ] Docker deployment with one-click setup
- [ ] Mobile-responsive UI improvements
- [ ] Agent memory & long-term knowledge base

---

## Contributing

Contributions are welcome! Whether it's bug fixes, new features, documentation, or skills — we'd love your help.

1. Fork the repository
2. Create your feature branch (`git checkout -b feat/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feat/amazing-feature`)
5. Open a Pull Request

---

## License

[MIT](LICENSE) - Use it however you want.

---

<div align="center">

**If you find Rule Agent useful, give it a star!**

Built with LangGraph, React, and TypeScript.

</div>
