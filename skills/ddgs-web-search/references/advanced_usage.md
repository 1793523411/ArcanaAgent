# Advanced Usage

Advanced techniques and multi-search workflows for the web-search skill.

## Combining Multiple Searches

Gather comprehensive information by combining search types:

```bash
# Web overview
python scripts/search.py "topic" --max-results 15 --output topic_web.txt

# Recent news
python scripts/search.py "topic" --type news --time-range w --output topic_news.txt

# Images
python scripts/search.py "topic" --type images --max-results 20 --output topic_images.txt

# Videos
python scripts/search.py "topic" --type videos --max-results 10 --output topic_videos.txt
```

This approach provides a comprehensive view across different content types.

## Programmatic Processing

Use JSON output for automated processing:

```bash
# Search and save as JSON
python scripts/search.py "research topic" --format json --output results.json

# Then process with another script
python analyze_results.py results.json
```

JSON format is ideal for:
- Extracting specific fields (URLs, titles, descriptions)
- Filtering results based on criteria
- Integrating with other tools and workflows
- Building automated research pipelines

## Building a Knowledge Base

Create searchable documentation from web results:

```bash
# Search multiple related topics
python scripts/search.py "topic1" --format markdown --output kb/topic1.md
python scripts/search.py "topic2" --format markdown --output kb/topic2.md
python scripts/search.py "topic3" --format markdown --output kb/topic3.md
```

Benefits:
- Organized collection of research materials
- Easy to search and reference later
- Markdown format integrates well with documentation tools
- Can be version controlled with git

## Multi-Stage Research Workflow

### Stage 1: Initial Discovery

Start with broad searches to understand the landscape:

```bash
python scripts/search.py "broad topic" --max-results 30 --output 01_discovery.txt
```

### Stage 2: Focused Investigation

Based on initial findings, conduct focused searches:

```bash
python scripts/search.py "specific aspect 1" --max-results 20 --output 02_aspect1.txt
python scripts/search.py "specific aspect 2" --max-results 20 --output 02_aspect2.txt
```

### Stage 3: Current Developments

Find recent news and updates:

```bash
python scripts/search.py "topic news" --type news --time-range m --max-results 25 --output 03_current.txt
```

### Stage 4: Visual Resources

Gather relevant images and videos:

```bash
python scripts/search.py "topic" --type images --max-results 30 --output 04_images.txt
python scripts/search.py "topic tutorial" --type videos --max-results 15 --output 04_videos.txt
```

## Region-Specific Research

Compare results across different regions:

```bash
# US perspective
python scripts/search.py "global topic" --region us-en --output us_view.txt

# UK perspective
python scripts/search.py "global topic" --region uk-en --output uk_view.txt

# Worldwide perspective
python scripts/search.py "global topic" --region wt-wt --output global_view.txt
```

Useful for:
- Understanding regional differences in coverage
- Identifying region-specific resources
- Comparing perspectives on global topics

## Time-Series Analysis

Track how search results change over time:

```bash
# Day 1
python scripts/search.py "evolving topic" --time-range d --format json --output day1.json

# Day 2
python scripts/search.py "evolving topic" --time-range d --format json --output day2.json

# Day 3
python scripts/search.py "evolving topic" --time-range d --format json --output day3.json
```

Compare the JSON files to identify:
- New sources appearing
- Changes in coverage
- Emerging trends

## Comprehensive Image Collection

Gather diverse image sets with different filters:

```bash
# Large photos
python scripts/search.py "subject" --type images --image-type photo --image-size Large --output images_large.txt

# Transparent graphics
python scripts/search.py "subject" --type images --image-type transparent --output images_transparent.txt

# Specific color
python scripts/search.py "subject" --type images --image-color Blue --output images_blue.txt

# Specific layout
python scripts/search.py "subject" --type images --image-layout Wide --output images_wide.txt
```

## Video Research Strategy

Find videos with specific characteristics:

```bash
# Short tutorials
python scripts/search.py "how to topic" --type videos --video-duration short --max-results 20 --output videos_short.txt

# Long-form content
python scripts/search.py "topic documentary" --type videos --video-duration long --max-results 15 --output videos_long.txt

# High quality
python scripts/search.py "topic" --type videos --video-resolution high --max-results 20 --output videos_hq.txt
```

## Batch Processing Pattern

Create a script to automate multiple searches:

```bash
#!/bin/bash

TOPICS=("topic1" "topic2" "topic3")
OUTPUT_DIR="research_output"

mkdir -p "$OUTPUT_DIR"

for topic in "${TOPICS[@]}"; do
    echo "Searching: $topic"
    
    # Web search
    python scripts/search.py "$topic" --max-results 15 \
        --output "$OUTPUT_DIR/${topic}_web.txt"
    
    # News search
    python scripts/search.py "$topic" --type news --time-range w \
        --output "$OUTPUT_DIR/${topic}_news.txt"
    
    # Image search
    python scripts/search.py "$topic" --type images --max-results 10 \
        --output "$OUTPUT_DIR/${topic}_images.txt"
    
    echo "Completed: $topic"
    echo ""
done

echo "All searches completed!"
```

## Competitive Analysis

Research competitors or alternatives:

```bash
# Company/product information
python scripts/search.py "company name" --max-results 25 --format markdown --output company_info.md

# Recent news
python scripts/search.py "company name news" --type news --time-range m --output company_news.txt

# Product comparisons
python scripts/search.py "company vs competitors" --max-results 20 --output comparisons.txt

# User reviews
python scripts/search.py "company name reviews" --time-range y --max-results 30 --output reviews.txt
```

## Academic Research Pipeline

Comprehensive academic research workflow:

```bash
# 1. Literature overview
python scripts/search.py "research topic survey" --max-results 30 --output 01_literature.txt

# 2. Recent publications
python scripts/search.py "research topic 2024 2025" --time-range y --max-results 40 --output 02_recent.txt

# 3. Key researchers
python scripts/search.py "research topic authors" --max-results 20 --output 03_researchers.txt

# 4. Conference proceedings
python scripts/search.py "research topic conference" --time-range y --max-results 25 --output 04_conferences.txt

# 5. Related datasets
python scripts/search.py "research topic dataset" --max-results 20 --output 05_datasets.txt

# 6. Tutorial videos
python scripts/search.py "research topic tutorial" --type videos --max-results 15 --output 06_tutorials.txt
```

## Market Intelligence Gathering

Comprehensive market research:

```bash
# Market overview
python scripts/search.py "market name overview 2025" --max-results 30 --format markdown --output market_overview.md

# Industry news
python scripts/search.py "market name" --type news --time-range m --max-results 40 --output market_news.txt

# Key players
python scripts/search.py "market name companies" --max-results 25 --output market_players.txt

# Trends and forecasts
python scripts/search.py "market name trends forecast" --time-range y --max-results 30 --output market_trends.txt

# Investment activity
python scripts/search.py "market name investment funding" --time-range y --max-results 25 --output market_investment.txt
```

## Content Aggregation

Build content collections for specific purposes:

```bash
# Blog post research
python scripts/search.py "topic best practices" --max-results 20 --output blog_best_practices.txt
python scripts/search.py "topic examples" --max-results 20 --output blog_examples.txt
python scripts/search.py "topic case studies" --max-results 15 --output blog_case_studies.txt

# Presentation materials
python scripts/search.py "topic statistics" --max-results 15 --output pres_statistics.txt
python scripts/search.py "topic" --type images --image-type photo --max-results 30 --output pres_images.txt
python scripts/search.py "topic infographic" --type images --max-results 20 --output pres_infographics.txt
```

## Quality Control Strategies

### Cross-Reference Verification

Search the same topic with different queries to verify consistency:

```bash
python scripts/search.py "topic definition" --max-results 10 --output verify_def.txt
python scripts/search.py "what is topic" --max-results 10 --output verify_what.txt
python scripts/search.py "topic explained" --max-results 10 --output verify_explained.txt
```

Compare results to identify:
- Consistent information across sources
- Conflicting claims requiring further investigation
- Most authoritative sources

### Temporal Verification

Check both recent and historical information:

```bash
# Recent information
python scripts/search.py "topic" --time-range w --max-results 15 --output recent.txt

# Broader historical context
python scripts/search.py "topic" --max-results 15 --output historical.txt
```

Helps identify:
- Recent changes or updates
- Long-standing facts vs. new developments
- Evolution of understanding over time
