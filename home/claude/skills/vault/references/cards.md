# List Cards

Browse and search the card inventory. Finds connections, supporting ideas, and duplicates.

## Process

1. Run `vault-cli cards` to get the full card inventory
2. If a query was provided, analyze all cards against it:
   - **Direct matches** — cards explicitly about the queried topic
   - **Supporting** — cards that provide useful context or building blocks
   - **Unexpected connections** — cards from different domains that relate in non-obvious ways
3. For each match, explain _why_ it connects (1 sentence)
4. If no query, dump the full list grouped by tag

## Output format

### With query

```
## Direct matches
- **Card Title** — description
  Why: [1-sentence explanation of connection]

## Supporting
- **Card Title** — description
  Why: [1-sentence explanation]

## Unexpected connections
- **Card Title** — description
  Why: [1-sentence explanation]
```

Omit empty sections. If nothing matches, say so.

### Without query

Group cards by their primary tag. Within each group, list alphabetically:

```
## Тема/Dev (N cards)
- **Card Title** — description

## Тема/Философия (N cards)
- **Card Title** — description
```

## Notes

- The script outputs one line per card: `Title — description [tags] (ref: Source)`
- Cards in subdirectories are included (e.g. `20 cards/Engineering management/*.md`)
- Use your understanding of the card descriptions + tags to find non-obvious connections
- When finding duplicates, suggest which card to keep or merge
