# Troubleshooting

Common issues and solutions for the web-search skill.

## Installation Issues

### Missing Dependency Error

**Problem:**
```
Error: Missing required dependency: No module named 'ddgs'
```

**Solution:**
Install the required dependency:
```bash
pip install ddgs
```

If using a virtual environment, ensure it's activated first:
```bash
source venv/bin/activate  # On macOS/Linux
venv\Scripts\activate     # On Windows
pip install ddgs
```

### Import Error After Installation

**Problem:**
```
ImportError: cannot import name 'DDGS' from 'ddgs'
```

**Solution:**
The package may be outdated. Update to the latest version:
```bash
pip install --upgrade ddgs
```

## Search Issues

### No Results Found

**Problem:**
Search returns "No results found" for a query.

**Possible Causes and Solutions:**

1. **Query too specific or contains typos**
   - Try broader search terms
   - Check spelling
   - Remove special characters

2. **Time range too restrictive**
   - Remove `--time-range` filter
   - Use a broader time range (e.g., `m` instead of `d`)

3. **Region-specific limitations**
   - Try `--region wt-wt` for worldwide results
   - Remove region filter entirely

**Example:**
```bash
# Too restrictive
python scripts/search.py "very specific niche topic" --time-range d --region us-en

# Better approach
python scripts/search.py "niche topic" --max-results 20
```

### Timeout Errors

**Problem:**
```
Error performing text search: timeout
```

**Possible Causes and Solutions:**

1. **Network connectivity issues**
   - Check internet connection
   - Try again after a moment
   - Check if DuckDuckGo is accessible in your region

2. **Temporary service unavailability**
   - Wait a few minutes and retry
   - The search service may be experiencing high load

3. **Firewall or proxy issues**
   - Check firewall settings
   - Configure proxy if required
   - Try from a different network

**Example:**
```bash
# Retry with a simpler query
python scripts/search.py "simple query"
```

### Rate Limiting

**Problem:**
Multiple rapid searches fail or return errors.

**Solution:**
Space out searches to avoid rate limiting:

```bash
# Bad: Rapid successive searches
python scripts/search.py "query1"
python scripts/search.py "query2"
python scripts/search.py "query3"

# Good: Add delays between searches
python scripts/search.py "query1"
sleep 2
python scripts/search.py "query2"
sleep 2
python scripts/search.py "query3"
```

Or use a script with built-in delays:
```bash
#!/bin/bash
for query in "query1" "query2" "query3"; do
    python scripts/search.py "$query"
    sleep 3  # Wait 3 seconds between searches
done
```

## Output Issues

### Unexpected Results

**Problem:**
Search results don't match expectations or seem irrelevant.

**Possible Causes and Solutions:**

1. **DuckDuckGo's algorithm differences**
   - DuckDuckGo's results may differ from Google
   - Try refining the query with more specific terms
   - Use quotes for exact phrases: `"exact phrase"`

2. **Region affecting results**
   - Specify or change the `--region` parameter
   - Use `--region wt-wt` for worldwide results

3. **Safe search filtering**
   - Adjust `--safe-search` setting if appropriate
   - Options: `on`, `moderate`, `off`

**Example:**
```bash
# More specific query
python scripts/search.py "machine learning python tutorial" --max-results 20

# Exact phrase search
python scripts/search.py '"neural networks" introduction' --max-results 15
```

### Encoding Issues

**Problem:**
Special characters or non-ASCII text displays incorrectly.

**Solution:**
The script uses UTF-8 encoding by default. If issues persist:

1. **Check terminal encoding:**
   ```bash
   # On macOS/Linux
   echo $LANG
   # Should show UTF-8
   ```

2. **Use JSON format for problematic characters:**
   ```bash
   python scripts/search.py "query with special chars" --format json --output results.json
   ```

3. **Redirect output to file:**
   ```bash
   python scripts/search.py "query" --output results.txt
   ```

### File Output Issues

**Problem:**
Output file not created or contains unexpected content.

**Possible Causes and Solutions:**

1. **Permission denied**
   - Check write permissions for the output directory
   - Use an absolute path or ensure the directory exists

2. **Directory doesn't exist**
   - The script creates parent directories automatically
   - Verify the path is correct

3. **Format mismatch**
   - File format is determined by `--format`, not file extension
   - Use `--format json` for JSON output, even if file ends in `.txt`

**Example:**
```bash
# Ensure directory exists
mkdir -p output/research

# Correct format specification
python scripts/search.py "query" --format json --output output/research/results.json
```

## Image Search Issues

### Limited Image Results

**Problem:**
Image search returns fewer results than expected.

**Possible Causes and Solutions:**

1. **Filters too restrictive**
   - Remove or relax filters (size, color, type, layout)
   - Try without filters first

2. **Query too specific**
   - Use broader search terms
   - Remove modifiers like "high quality" or "professional"

**Example:**
```bash
# Too restrictive
python scripts/search.py "rare specific image" --type images --image-size Wallpaper --image-color Blue --image-type photo

# Better approach
python scripts/search.py "specific image" --type images --max-results 30
```

### Missing Image URLs

**Problem:**
Some image results don't include direct image URLs.

**Solution:**
This is expected behavior - some images may only have thumbnail URLs or source page URLs. The script includes all available information:
- Direct image URL (if available)
- Thumbnail URL
- Source website

Access what's available and visit the source website for the full image if needed.

## Video Search Issues

### Limited Video Results

**Problem:**
Video search returns fewer results than expected.

**Possible Causes and Solutions:**

1. **DuckDuckGo's video index is smaller than YouTube's**
   - This is a limitation of the search provider
   - Results primarily come from major video platforms

2. **Filters reducing results**
   - Remove duration or resolution filters
   - Try broader search terms

**Example:**
```bash
# Broader search
python scripts/search.py "topic tutorial" --type videos --max-results 30
```

## News Search Issues

### Old News Results

**Problem:**
News search returns outdated articles despite time filter.

**Solution:**
Ensure the `--time-range` parameter is set correctly:

```bash
# Correct usage
python scripts/search.py "topic" --type news --time-range d  # Past day
python scripts/search.py "topic" --type news --time-range w  # Past week
```

Note: The time range depends on when articles were indexed, not just published.

### Missing News Results

**Problem:**
News search returns no results for a current topic.

**Possible Causes and Solutions:**

1. **Topic not yet indexed**
   - Very recent events may not be indexed yet
   - Try again in a few hours

2. **Query too specific**
   - Use broader terms
   - Remove quotes and modifiers

**Example:**
```bash
# Too specific
python scripts/search.py "exact headline text" --type news

# Better approach
python scripts/search.py "main topic keywords" --type news --time-range w
```

## Performance Issues

### Slow Search Execution

**Problem:**
Searches take a long time to complete.

**Possible Causes and Solutions:**

1. **Large result count**
   - Reduce `--max-results` value
   - Start with 10-20 results

2. **Network latency**
   - Check internet connection speed
   - Try from a different network

3. **Multiple concurrent searches**
   - Run searches sequentially instead of in parallel
   - Add delays between searches

**Example:**
```bash
# Faster with fewer results
python scripts/search.py "query" --max-results 10
```

## General Troubleshooting Steps

When encountering any issue:

1. **Verify installation:**
   ```bash
   python -c "from ddgs import DDGS; print('OK')"
   ```

2. **Test with simple query:**
   ```bash
   python scripts/search.py "test"
   ```

3. **Check script help:**
   ```bash
   python scripts/search.py --help
   ```

4. **Enable verbose output:**
   The script prints search parameters to stderr. Check these to verify your command is correct.

5. **Try minimal command:**
   ```bash
   python scripts/search.py "simple query"
   ```
   Then add options one at a time to identify the problem.

## Getting Help

If issues persist:

1. **Check the ddgs library documentation:**
   - Visit the library's GitHub page
   - Check for known issues or updates

2. **Verify Python version:**
   ```bash
   python --version
   ```
   Ensure you're using Python 3.7 or later.

3. **Test network access:**
   ```bash
   curl -I https://duckduckgo.com
   ```
   Verify you can reach DuckDuckGo.

4. **Review error messages:**
   - Read the full error message carefully
   - Check stderr output for diagnostic information
   - Look for specific error codes or messages

## Known Limitations

Be aware of these inherent limitations:

1. **Search quality depends on DuckDuckGo's index**
   - Results may differ from other search engines
   - Some specialized content may be better found elsewhere

2. **No advanced search operators**
   - Unlike Google, DuckDuckGo doesn't support `site:`, `filetype:`, etc.
   - Use more specific keywords instead

3. **Rate limiting**
   - Excessive searches may be throttled
   - Space out requests appropriately

4. **Image and video search limitations**
   - Smaller index than specialized services
   - Some filters may significantly reduce results

5. **No API authentication**
   - No way to increase rate limits
   - No priority access or guaranteed availability

6. **Regional availability**
   - Service may not be available in all regions
   - Results may vary by location

## Best Practices to Avoid Issues

1. **Start simple, then refine:**
   - Begin with basic queries
   - Add filters incrementally

2. **Use appropriate result counts:**
   - Start with 10-20 results
   - Increase only if needed

3. **Space out searches:**
   - Add delays between multiple searches
   - Avoid rapid-fire requests

4. **Save important results:**
   - Use `--output` to preserve results
   - Don't rely on re-running searches for the same data

5. **Choose the right search type:**
   - Use `--type news` for current events
   - Use `--type images` for visual content
   - Use web search for general information

6. **Test queries first:**
   - Run a quick test with low `--max-results`
   - Verify results before running large searches
