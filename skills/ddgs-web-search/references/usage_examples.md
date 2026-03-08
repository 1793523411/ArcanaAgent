# Usage Examples

Comprehensive usage patterns and examples for the web-search skill.

## Basic Usage Patterns

### Simple Web Search

```bash
python scripts/search.py "python tutorials"
```

Returns the top 10 web results with titles, URLs, and descriptions.

### Limiting Results

```bash
python scripts/search.py "machine learning frameworks" --max-results 20
```

Get more comprehensive results by increasing the limit.

### Time Range Filtering

```bash
python scripts/search.py "artificial intelligence news" --time-range w
```

**Time range options:**
- `d` - Past day
- `w` - Past week
- `m` - Past month
- `y` - Past year

## Search Type Examples

### News Search

```bash
python scripts/search.py "climate change" --type news --time-range w --max-results 15
```

News results include:
- Article title
- Source publication
- Publication date
- URL
- Article summary/description

### Image Search

Basic image search:
```bash
python scripts/search.py "sunset over mountains" --type images --max-results 20
```

With size filter:
```bash
python scripts/search.py "landscape photos" --type images --image-size Large
```

With color filter:
```bash
python scripts/search.py "abstract art" --type images --image-color Blue
```

With type filter:
```bash
python scripts/search.py "icons" --type images --image-type transparent
```

With layout filter:
```bash
python scripts/search.py "wallpapers" --type images --image-layout Wide
```

Image results include:
- Image title
- Image URL (direct link)
- Thumbnail URL
- Source website
- Dimensions (width x height)

### Video Search

Basic video search:
```bash
python scripts/search.py "python tutorial" --type videos --max-results 15
```

With duration filter:
```bash
python scripts/search.py "cooking recipes" --type videos --video-duration short
```

With resolution filter:
```bash
python scripts/search.py "documentary" --type videos --video-resolution high
```

Video results include:
- Video title
- Publisher/channel
- Duration
- Publication date
- Video URL
- Description

## Region-Specific Search

```bash
python scripts/search.py "local news" --region us-en --type news
```

**Common region codes:**
- `us-en` - United States (English)
- `uk-en` - United Kingdom (English)
- `ca-en` - Canada (English)
- `au-en` - Australia (English)
- `de-de` - Germany (German)
- `fr-fr` - France (French)
- `wt-wt` - Worldwide (default)

## Safe Search Control

```bash
python scripts/search.py "medical information" --safe-search on
```

**Options:**
- `on` - Strict filtering
- `moderate` - Balanced filtering (default)
- `off` - No filtering

## Output Formats

### Text Format (Default)

```bash
python scripts/search.py "quantum computing"
```

Output:
```
1. Page Title Here
   URL: https://example.com/page
   Brief description of the page content...

2. Another Result
   URL: https://example.com/another
   Another description...
```

### Markdown Format

```bash
python scripts/search.py "quantum computing" --format markdown
```

Output:
```markdown
## 1. Page Title Here

**URL:** https://example.com/page

Brief description of the page content...

## 2. Another Result

**URL:** https://example.com/another

Another description...
```

### JSON Format

```bash
python scripts/search.py "quantum computing" --format json
```

Output:
```json
[
  {
    "title": "Page Title Here",
    "href": "https://example.com/page",
    "body": "Brief description of the page content..."
  },
  {
    "title": "Another Result",
    "href": "https://example.com/another",
    "body": "Another description..."
  }
]
```

## Saving Results to File

```bash
python scripts/search.py "artificial intelligence" --output ai_results.txt
python scripts/search.py "AI news" --type news --format markdown --output ai_news.md
python scripts/search.py "AI research" --format json --output ai_data.json
```

The file format is determined by the `--format` flag, not the file extension.

## Common Usage Patterns

### Research on a Topic

Gather comprehensive information about a subject:

```bash
# Get overview from web
python scripts/search.py "machine learning basics" --max-results 15 --output ml_web.txt

# Get recent news
python scripts/search.py "machine learning" --type news --time-range m --output ml_news.txt

# Find tutorial videos
python scripts/search.py "machine learning tutorial" --type videos --max-results 10 --output ml_videos.txt
```

### Current Events Monitoring

Track news on specific topics:

```bash
python scripts/search.py "climate summit" --type news --time-range d --format markdown --output daily_climate_news.md
```

### Finding Visual Resources

Search for images with specific criteria:

```bash
python scripts/search.py "data visualization examples" --type images --image-type photo --image-size Large --max-results 25 --output viz_images.txt
```

### Fact-Checking

Verify information with recent sources:

```bash
python scripts/search.py "specific claim to verify" --time-range w --max-results 20
```

### Academic Research

Find resources on scholarly topics:

```bash
python scripts/search.py "quantum entanglement research" --time-range y --max-results 30 --output quantum_research.txt
```

### Market Research

Gather information about products or companies:

```bash
python scripts/search.py "electric vehicle market 2025" --max-results 20 --format markdown --output ev_market.md
python scripts/search.py "EV news" --type news --time-range m --output ev_news.txt
```
