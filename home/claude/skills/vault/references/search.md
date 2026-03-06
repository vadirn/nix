# qmd — Vault Search Reference

## When to Use qmd vs obsidian-cli

**Use qmd** for content discovery: semantic search, keyword search, hybrid queries.
qmd indexes markdown files independently and works without Obsidian running.

**Use obsidian-cli** for CRUD, graph traversal, tags, properties, tasks, bases, backlinks.

Rule of thumb: finding content by meaning or keywords = qmd. Everything else = obsidian-cli or file tools.

## Execution

Always run via bunx. No global install needed:

```sh
bunx @tobilu/qmd <command> [options]
```

## Search Commands

Three search modes, ordered by quality:

### `search` — BM25 keyword search

Fast lexical matching. Best for exact terms, names, specific phrases.

```sh
bunx @tobilu/qmd search "exact phrase or keyword" -c vault
bunx @tobilu/qmd search "project standup notes" -c vault -n 10
```

### `vsearch` — vector (semantic) search

Finds conceptually similar content even without keyword overlap.

```sh
bunx @tobilu/qmd vsearch "how to handle authentication" -c vault
bunx @tobilu/qmd vsearch "meeting about Q4 planning" -c vault -n 5
```

### `query` — hybrid search with reranking (best quality)

Combines BM25 + vector search, then reranks results. Use this as default when quality matters.

```sh
bunx @tobilu/qmd query "weekly review process" -c vault
bunx @tobilu/qmd query "delegation framework" -c vault -n 10 --json
```

## Retrieval Commands

### `get` — retrieve a single document

```sh
bunx @tobilu/qmd get "path/to/note.md" -c vault
```

### `multi-get` — retrieve multiple documents

```sh
bunx @tobilu/qmd multi-get "note1.md" "note2.md" -c vault
```

## Output Flags

| Flag          | Effect                            |
| ------------- | --------------------------------- |
| `--json`      | JSON output (for parsing)         |
| `--files`     | File paths only (no content)      |
| `--all`       | Return all results (no limit)     |
| `-n <number>` | Limit number of results           |
| `--min-score` | Filter by minimum relevance score |

## Index Maintenance

```sh
bunx @tobilu/qmd status -c vault          # check status
bunx @tobilu/qmd update                    # re-index all collections
bunx @tobilu/qmd embed -c vault            # rebuild vector embeddings
```

## Tips

- Default to `query` for general searches: best results.
- Use `search` for exact keyword matching or speed.
- Use `vsearch` when the user describes a concept but may not know the exact terms.
- Combine `--files` with search to get paths, then read files for full content.
- Use `-n` to limit results and reduce noise. Default is usually 10.
