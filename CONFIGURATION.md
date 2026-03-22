# Configuration Guide

## Configuration Files Location

All configuration files are stored in your home directory under `~/.arcana-agent/`:

```
~/.arcana-agent/
├── models.json          # AI model providers and API keys
├── user-config.json     # User preferences (auto-created)
├── server.pid           # Server process ID (auto-created)
└── server.log           # Server logs (auto-created)
```

**Platform-specific paths:**
- **macOS/Linux**: `/Users/your-username/.arcana-agent/`
- **Windows**: `C:\Users\your-username\.arcana-agent\`

## First Time Setup

### 1. Install ArcanaAgent

```bash
npm install -g arcana-agent
```

### 2. First Start

When you run `arcana-agent start` for the first time, it will create a configuration template:

```bash
arcana-agent start
```

Output:
```
⚙️  First time setup: Creating configuration file...
✅ Configuration file created!
📝 Location: /Users/you/.arcana-agent/models.json
⚠️  You need to configure at least one model provider before using ArcanaAgent.
```

### 3. Configure Your API Keys

Edit the configuration file:

```bash
# macOS/Linux
nano ~/.arcana-agent/models.json
# or use your preferred editor
code ~/.arcana-agent/models.json
vim ~/.arcana-agent/models.json

# Windows
notepad %USERPROFILE%\.arcana-agent\models.json
```

### 4. Update API Keys

Replace placeholders with your actual API keys:

```json
{
  "models": {
    "providers": {
      "volcengine": {
        "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
        "apiKey": "YOUR_VOLCENGINE_API_KEY",  // ← Replace this
        "api": "openai-completions",
        "models": [
          {
            "id": "YOUR_MODEL_ENDPOINT_ID",    // ← Replace this
            "name": "doubao-seed-2-0-pro",
            // ... rest of config
          }
        ]
      },
      "openai": {
        "baseUrl": "https://api.openai.com/v1",
        "apiKey": "YOUR_OPENAI_API_KEY",       // ← Replace this
        "api": "openai-completions",
        "models": [
          {
            "id": "gpt-4o",
            "name": "GPT-4o",
            // ... rest of config
          }
        ]
      }
    }
  }
}
```

### 5. Start Again

After configuring your API keys:

```bash
arcana-agent start
arcana-agent open   # Opens in browser
```

## Configuration Options

### models.json

This file configures AI model providers. You can add multiple providers:

- **volcengine**: VolcEngine/Doubao models
- **openai**: OpenAI models (GPT-4, GPT-3.5, etc.)
- **anthropic**: Claude models (requires Anthropic-compatible endpoint)
- **custom**: Any OpenAI-compatible API

**Required fields for each provider:**
- `baseUrl`: API endpoint URL
- `apiKey`: Your API key
- `api`: API type (`openai-completions` or `anthropic-messages`)
- `models`: Array of model configurations

**Required fields for each model:**
- `id`: Model ID or endpoint ID
- `name`: Display name
- `api`: API type for this specific model
- `contextWindow`: Maximum context length (tokens)
- `maxTokens`: Maximum output tokens
- `input`: Array of supported input types (`["text"]` or `["text", "image"]`)
- `reasoning`: Whether model supports reasoning/thinking mode

### user-config.json

This file is auto-created and stores user preferences. You can edit it directly or use the web UI settings page.

**Example:**

```json
{
  "enabledToolIds": ["calculator", "get_time", "read_file"],
  "mcpServers": [],
  "modelId": "gpt-4o",
  "context": {
    "strategy": "compress",
    "trimToLast": 20,
    "tokenThresholdPercent": 75,
    "compressKeepRecent": 20
  }
}
```

**Fields:**
- `enabledToolIds`: List of enabled tools/skills
- `mcpServers`: MCP (Model Context Protocol) server configurations
- `modelId`: Default model to use
- `context`: Context management strategy

## Environment Variables

You can override default settings with environment variables:

```bash
# Custom port
PORT=8080 arcana-agent start

# Custom data directory (overrides ~/.arcana-agent)
DATA_DIR=/custom/path arcana-agent start

# Volcengine API key (overrides models.json)
VOLCENGINE_API_KEY=your-key arcana-agent start
```

## Editing Configuration While Running

You can edit configuration files while the server is running, but you need to restart for changes to take effect:

```bash
arcana-agent restart
```

## Backup Your Configuration

Your API keys are stored in `~/.arcana-agent/models.json`. Make sure to:

1. **Never commit this file to git** (it contains secrets)
2. **Backup regularly** if you have complex configurations
3. **Keep it secure** with appropriate file permissions

```bash
# Backup your config
cp ~/.arcana-agent/models.json ~/.arcana-agent/models.json.backup

# Restore from backup
cp ~/.arcana-agent/models.json.backup ~/.arcana-agent/models.json
```

## Troubleshooting

### "Configuration file not found"

The template should be auto-created. If not, check:

```bash
ls -la ~/.arcana-agent/
```

If empty, reinstall:

```bash
npm uninstall -g arcana-agent
npm install -g arcana-agent
```

### "API key invalid"

Check your API key in `~/.arcana-agent/models.json`:

```bash
cat ~/.arcana-agent/models.json | grep apiKey
```

Make sure there are no extra spaces or quotes.

### "Models not loading"

Check the server logs:

```bash
arcana-agent logs
# or
tail -50 ~/.arcana-agent/server.log
```

### Reset to defaults

Remove the config and restart:

```bash
rm ~/.arcana-agent/models.json
arcana-agent start
# This will recreate the template
```

## Getting Help

- View CLI help: `arcana-agent --help`
- Check status: `arcana-agent status`
- View logs: `arcana-agent logs`
- GitHub Issues: https://github.com/yourusername/arcana-agent/issues
