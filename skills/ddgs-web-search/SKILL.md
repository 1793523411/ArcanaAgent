---
name: ddgs-web-search
description: This skill should be used when users need to search the web for information, find current content, look up news articles, search for images, or find videos. It uses DuckDuckGo's search API to return results in clean, formatted output (text, markdown, or JSON). Use for research, fact-checking, finding recent information, or gathering web resources.
---

# Web Search

Search the web using DuckDuckGo's API to find information across web pages, news articles, images, and videos.

## When to Use This Skill

This skill should be used when users request:
- Web searches for information or resources
- Finding current or recent information online
- Looking up news articles about specific topics
- Searching for images by description or topic
- Finding videos on specific subjects
- Research requiring current web data
- Fact-checking or verification using web sources

## Prerequisites

Install the required dependency:

```bash
pip install ddgs
```

## Core Usage

### Basic Web Search

Execute a web search using the `<SKILL_PATH>/scripts/search.py` tool:

```bash
python <SKILL_PATH>/scripts/search.py "<query>"
```

This returns the top 10 web results with titles, URLs, and descriptions in clean text format.

### Search Types

Specify the search type with `--type`:

- **Web search** (default): `--type web`
- **News articles**: `--type news`
- **Images**: `--type images`
- **Videos**: `--type videos`

Example:
```bash
python <SKILL_PATH>/scripts/search.py "climate change" --type news
```

### Common Options

Control search behavior with these options:

- `--max-results <N>` - Number of results (default: 10)
- `--time-range <d|w|m|y>` - Filter by time (day, week, month, year)
- `--region <code>` - Region-specific results (e.g., `us-en`, `uk-en`)
- `--safe-search <on|moderate|off>` - Safe search level (default: moderate)
- `--format <text|markdown|json>` - Output format (default: text)
- `--output <file>` - Save results to file

Example:
```bash
python <SKILL_PATH>/scripts/search.py "AI news" --type news --time-range w --max-results 15 --format markdown --output ai_news.md
```

### Image Search Filters

When using `--type images`, apply additional filters:

- `--image-size <Small|Medium|Large|Wallpaper>`
- `--image-color <color|Monochrome|Red|Blue|...>`
- `--image-type <photo|clipart|gif|transparent|line>`
- `--image-layout <Square|Tall|Wide>`

### Video Search Filters

When using `--type videos`, apply additional filters:

- `--video-duration <short|medium|long>`
- `--video-resolution <high|standard>`

## Implementation Approach

When handling user search requests:

1. **Identify search intent**: Determine the type of content needed (web, news, images, videos) and time sensitivity
2. **Configure parameters**: Select appropriate `--type`, `--time-range`, `--max-results`, and filters
3. **Choose output format**: Use text for quick reading, markdown for documentation, JSON for processing
4. **Execute search**: Run the search command with configured parameters
5. **Process results**: Read saved files if needed, extract URLs or specific information, combine multiple searches if necessary

## Quick Reference

**Command structure:**
```bash
python <SKILL_PATH>/scripts/search.py "<query>" [options]
```

**Essential options:**
- `-t, --type` - Search type (web, news, images, videos)
- `-n, --max-results` - Maximum results (default: 10)
- `--time-range` - Time filter (d, w, m, y)
- `-r, --region` - Region code (e.g., us-en, uk-en)
- `--safe-search` - Safe search level (on, moderate, off)
- `-f, --format` - Output format (text, markdown, json)
- `-o, --output` - Save to file

**Get full help:**
```bash
python <SKILL_PATH>/scripts/search.py --help
```

## Best Practices

- Use specific search queries for better results
- Apply `--time-range` when currency matters
- Start with 10-20 results, adjust as needed
- Use `--output` to preserve important searches
- Choose JSON format for programmatic processing
- Space out searches to avoid rate limiting

## Additional Resources

For detailed examples, advanced use cases, and troubleshooting, refer to:
- `references/usage_examples.md` - Comprehensive usage patterns and examples
- `references/advanced_usage.md` - Advanced techniques and multi-search workflows
- `references/troubleshooting.md` - Common issues and solutions

## Resources

### scripts/search.py

The main search tool implementing DuckDuckGo search functionality with support for multiple search types, flexible filtering, multiple output formats, and file output capabilities.
