## Extract URLs flow

```
// Guard
if not file exists: stop("File doesn't exist")

// Extract and deduplicate
urls = Bash(grep -oE 'https?://[^ ]+' <file> | sort -u)
if no urls: stop("No URLs found")

Write(urls.txt, urls)
```

## Reference

### URL extraction

- Pattern: `https?://[^ ]+` matches http and https URLs
- `sort -u` deduplicates and sorts alphabetically
