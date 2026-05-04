# vault-query search

## Usage

```sh
vault-query search <query>           # BM25 full-text search (default)
vault-query search <query> --regex   # regex grep mode
vault-query search <query> --path "20 cards"  # limit to subfolder
vault-query search <query> --context 3        # context lines (regex mode)
```

## When to Use

Use `vault-query search` for content discovery: keyword search, finding files by content.

Use other vault-query commands for structured queries: tags, properties, bases, backlinks, vault-query lint, file listing.

Rule of thumb: finding content by keywords = `vault-query search`. Structured vault queries = other vault-query subcommands. Simple reads/writes = file tools.

## Search Modes

### BM25 (default)

Fast ranked keyword search. Best for exact terms, names, specific phrases.

```sh
vault-query search "impureim sandwich"
vault-query search "project standup"
```

### Regex (--regex)

Grep-style pattern matching with context lines.

```sh
vault-query search "Impureim.*pattern" --regex
vault-query search "test card" --regex --context 1
```

## Tips

- BM25 mode returns results ranked by relevance
- Regex mode shows matching lines with `>` marker and context lines
- Use `--path` to limit search scope to a subfolder
- Combine with `Read` to get full content of matched files
