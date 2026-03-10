# Rule Agent

AI-powered rule engine with scheduled tasks and agent workflows.

## Features

- 🤖 **AI Agent Conversations** - Chat with AI agents powered by multiple LLM providers
- ⏰ **Scheduled Tasks** - Automate tasks with cron-based scheduling
- 🔗 **Webhook Integration** - Connect with external services (Feishu, Slack, etc.)
- 📊 **Task History** - Track and monitor task execution
- 🎯 **Skill System** - Extend functionality with custom skills
- 🌐 **Web UI** - Beautiful web interface for managing everything

## Installation

### Global Installation (Recommended)

```bash
npm install -g rule-agent
```

### From Source

```bash
git clone <your-repo>
cd rule-agent
npm install
npm run build
npm link
```

## CLI Usage

### Start the Server

```bash
rule-agent start
```

This will:
- Start the server on port 3001 (default)
- Create data directory
- Show you the server URL

### Open in Browser

```bash
rule-agent open
```

### Check Status

```bash
rule-agent status
```

### View Logs

```bash
rule-agent logs
```

### Stop the Server

```bash
rule-agent stop
```

### Restart the Server

```bash
rule-agent restart
```

## Configuration

**📖 For detailed configuration guide, see [CONFIGURATION.md](./CONFIGURATION.md)**

### Quick Start Configuration

### Configuration Files Location

All user configuration files are stored in your home directory:

```
~/.rule-agent/
├── models.json          # AI model providers configuration
├── user-config.json     # User preferences (tools, MCP servers, etc.)
├── server.pid           # Server process ID
└── server.log           # Server logs
```

### First Time Setup

When you first run `rule-agent start`, it will create a configuration template at `~/.rule-agent/models.json`. You need to update this file with your API keys.

**Edit the configuration file:**

```bash
# macOS/Linux
nano ~/.rule-agent/models.json
# or
code ~/.rule-agent/models.json

# Windows
notepad %USERPROFILE%\.rule-agent\models.json
```

**Configuration format:**

```json
{
  "models": {
    "providers": {
      "volcengine": {
        "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
        "apiKey": "YOUR_API_KEY_HERE",
        "api": "openai-completions",
        "models": [...]
      },
      "openai": {
        "baseUrl": "https://api.openai.com/v1",
        "apiKey": "YOUR_OPENAI_API_KEY",
        "api": "openai-completions",
        "models": [...]
      }
    }
  }
}
```

Replace `YOUR_API_KEY_HERE` with your actual API keys. You can configure multiple providers and the UI will let you switch between them.

### Data Directory

By default, conversation data and logs are stored in `~/.rule-agent/`. You can change this with the `DATA_DIR` environment variable:

```bash
PORT=8080 rule-agent start          # Custom port
DATA_DIR=/path/to/data rule-agent start  # Custom data directory
```

## API Usage

Once the server is running, you can access the REST API:

### Conversations API

```bash
# Create a conversation
curl -X POST http://localhost:3001/conversations \
  -H "Content-Type: application/json" \
  -d '{"title": "My Conversation"}'

# Send a message
curl -X POST http://localhost:3001/conversations/{id}/messages \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello, AI!"}'

# Get messages
curl http://localhost:3001/conversations/{id}/messages
```

### Scheduled Tasks API

```bash
# Create a task
curl -X POST http://localhost:3001/scheduled-tasks \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Daily Report",
    "type": "webhook",
    "schedule": "0 9 * * *",
    "enabled": true,
    "config": {
      "url": "https://your-webhook-url",
      "useModelOutput": true,
      "prompt": "Generate a daily report"
    }
  }'

# List tasks
curl http://localhost:3001/scheduled-tasks

# Execute a task manually
curl -X POST http://localhost:3001/scheduled-tasks/{id}/execute

# Get execution history
curl http://localhost:3001/scheduled-executions
```

## API Endpoints

### Conversations

- `GET /conversations` - List all conversations
- `POST /conversations` - Create a new conversation
- `GET /conversations/:id` - Get conversation details
- `GET /conversations/:id/messages` - Get conversation messages
- `POST /conversations/:id/messages` - Send a message (streaming SSE)
- `POST /conversations/:id/messages/sync` - Send a message (non-streaming)
- `DELETE /conversations/:id` - Delete a conversation

### Scheduled Tasks

- `GET /scheduled-tasks` - List all tasks
- `POST /scheduled-tasks` - Create a new task
- `GET /scheduled-tasks/:id` - Get task details
- `PUT /scheduled-tasks/:id` - Update a task
- `DELETE /scheduled-tasks/:id` - Delete a task
- `POST /scheduled-tasks/:id/execute` - Execute a task manually
- `POST /scheduled-tasks/:id/toggle` - Enable/disable a task
- `GET /scheduled-tasks/:id/executions` - Get task execution history
- `GET /scheduled-executions` - Get all execution history

### Configuration

- `GET /config` - Get configuration
- `PUT /config` - Update configuration
- `GET /models` - List available AI models

## Scheduled Tasks

### Task Types

1. **Conversation** - Send messages to AI conversations
   ```json
   {
     "type": "conversation",
     "config": {
       "message": "Your prompt here"
     }
   }
   ```

2. **Webhook** - HTTP requests to external APIs
   ```json
   {
     "type": "webhook",
     "config": {
       "url": "https://api.example.com/webhook",
       "method": "POST",
       "useModelOutput": true,
       "prompt": "Generate content"
     }
   }
   ```

3. **Skill** - Execute custom skills
   ```json
   {
     "type": "skill",
     "config": {
       "skillName": "demo",
       "params": {}
     }
   }
   ```

### Cron Schedule Format

```
┌─────────── minute (0 - 59)
│ ┌───────── hour (0 - 23)
│ │ ┌─────── day of month (1 - 31)
│ │ │ ┌───── month (1 - 12)
│ │ │ │ ┌─── day of week (0 - 6)
* * * * *
```

Examples:
- `0 9 * * *` - Every day at 9:00 AM
- `*/5 * * * *` - Every 5 minutes
- `0 0 * * 0` - Every Sunday at midnight
- `0 9 * * 1-5` - Weekdays at 9:00 AM

## Development

### Prerequisites

- Node.js >= 18.0.0
- npm or yarn

### Setup

```bash
npm install
npm run build
```

### Development Mode

```bash
npm run dev
```

This starts:
- Backend on `http://localhost:3001`
- Frontend on `http://localhost:5173` (with API proxy)

### Project Structure

```
rule-agent/
├── cli.js              # CLI entry point
├── server/            # Backend
│   ├── src/          # TypeScript source
│   ├── dist/         # Compiled JavaScript
│   └── public/       # Frontend static files (after build)
├── web/              # Frontend (React + TypeScript)
│   └── src/
├── skills/           # Custom skills
└── data/            # Data directory (auto-created)
```

## Configuration File

Location: `data/user-config.json` (or `~/.rule-agent/user-config.json` in production)

Example:

```json
{
  "llm": {
    "provider": "openai",
    "apiKey": "your-api-key",
    "baseUrl": "https://api.openai.com/v1",
    "defaultModel": "gpt-4"
  },
  "enabledToolIds": ["calculator", "get_time"],
  "mcpServers": []
}
```

## Troubleshooting

### Server won't start

```bash
rule-agent status      # Check status
rule-agent logs        # View error logs
rule-agent restart     # Restart server
```

### Port already in use

```bash
PORT=8080 rule-agent start
```

### Permission errors

```bash
chmod +x cli.js
```

## License

MIT

## Contributing

Contributions welcome! Please submit a Pull Request.
