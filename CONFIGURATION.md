# Configuration Guide

## Configuration Files Location

All configuration files are stored in your home directory under `~/.rule-agent/`:

```
~/.rule-agent/
├── models.json          # AI model providers and API keys
├── user-config.json     # User preferences (auto-created)
├── server.pid           # Server process ID (auto-created)
└── server.log           # Server logs (auto-created)
```

**Platform-specific paths:**
- **macOS/Linux**: `/Users/your-username/.rule-agent/`
- **Windows**: `C:\Users\your-username\.rule-agent\`

## First Time Setup

### 1. Install Rule Agent

```bash
npm install -g rule-agent
```

### 2. First Start

When you run `rule-agent start` for the first time, it will create a configuration template:

```bash
rule-agent start
```

Output:
```
⚙️  First time setup: Creating configuration file...
✅ Configuration file created!
📝 Location: /Users/you/.rule-agent/models.json
⚠️  You need to configure at least one model provider before using Rule Agent.
```

### 3. Configure Your API Keys

Edit the configuration file:

```bash
# macOS/Linux
nano ~/.rule-agent/models.json
# or use your preferred editor
code ~/.rule-agent/models.json
vim ~/.rule-agent/models.json

# Windows
notepad %USERPROFILE%\.rule-agent\models.json
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
rule-agent start
rule-agent open   # Opens in browser
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
PORT=8080 rule-agent start

# Custom data directory (overrides ~/.rule-agent)
DATA_DIR=/custom/path rule-agent start

# Volcengine API key (overrides models.json)
VOLCENGINE_API_KEY=your-key rule-agent start
```

## Editing Configuration While Running

You can edit configuration files while the server is running, but you need to restart for changes to take effect:

```bash
rule-agent restart
```

## Backup Your Configuration

Your API keys are stored in `~/.rule-agent/models.json`. Make sure to:

1. **Never commit this file to git** (it contains secrets)
2. **Backup regularly** if you have complex configurations
3. **Keep it secure** with appropriate file permissions

```bash
# Backup your config
cp ~/.rule-agent/models.json ~/.rule-agent/models.json.backup

# Restore from backup
cp ~/.rule-agent/models.json.backup ~/.rule-agent/models.json
```

## Troubleshooting

### "Configuration file not found"

The template should be auto-created. If not, check:

```bash
ls -la ~/.rule-agent/
```

If empty, reinstall:

```bash
npm uninstall -g rule-agent
npm install -g rule-agent
```

### "API key invalid"

Check your API key in `~/.rule-agent/models.json`:

```bash
cat ~/.rule-agent/models.json | grep apiKey
```

Make sure there are no extra spaces or quotes.

### "Models not loading"

Check the server logs:

```bash
rule-agent logs
# or
tail -50 ~/.rule-agent/server.log
```

### Reset to defaults

Remove the config and restart:

```bash
rm ~/.rule-agent/models.json
rule-agent start
# This will recreate the template
```

## Getting Help

- View CLI help: `rule-agent --help`
- Check status: `rule-agent status`
- View logs: `rule-agent logs`
- GitHub Issues: https://github.com/yourusername/rule-agent/issues
