---
name: session-stats
description: Show cost, lines written, turns-to-edit, and other metrics for the current Claude Code session. Use when the user asks about session cost, token usage, how many turns or edits happened, session duration, or any question about "how much" or "how long" this session has been. Also triggers on "what have I spent", "am I being efficient", or curiosity about API usage patterns.
---

# Session Stats

Run the stats script, then present the results with brief interpretation.

## Step 1: Get the data

```bash
python3 <dir>/session-stats.py --latest --format table
```

`<dir>` is the directory containing this SKILL.md file.

The script reads the JSONL session transcript and outputs a formatted table. If `--format table` is not recognized, fall back to plain `--latest` (JSON output) and format it yourself.

## Step 2: Present results

Show the table as-is. Then add 1-2 sentences of interpretation based on what the user asked:

- **Cost question**: Lead with the dollar amount. Compare to model pricing context if helpful.
- **Efficiency/turns question**: Highlight turns-to-edit ratio. If turns_to_edit is high relative to api_turns, note that most of the session was spent before the first edit.
- **General "show me stats"**: Show the full table, highlight anything notable (high peak context, zero lines written, etc.).

Keep commentary short. The user wants numbers, not essays.
