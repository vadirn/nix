# Extract URLs from File

## Inputs

- `file_path`: path to the file to extract URLs from

## Steps

1. Check if `file_path` exists. If not, tell the user the file doesn't exist and stop.
2. Read the file at `file_path`.
3. Grep the file contents for URLs using pattern `https?://[^\s"'>)]+`.
4. Deduplicate the matched URLs, preserving order.
5. Write the unique URLs to `urls.txt` in the current directory, one per line.
6. Report how many unique URLs were saved.
