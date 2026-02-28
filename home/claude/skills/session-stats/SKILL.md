---
name: session-stats
description: Show cost, lines written, and turns-to-edit for the current Claude Code session.
---

# Session Stats

```
dir = directory containing this file

stats = Bash(f"{dir}/session-stats.py --latest", timeout=10000)
print stats as formatted table
```

## Output fields

- `cost_usd` — estimated API cost
- `lines_written` — total lines from Edit/Write tool calls
- `turns_to_edit` — API turns before first edit
- `api_turns` — total API round-trips
- `duration_min` — session duration in minutes
- `peak_context` — largest input context in a single turn
- `output_tokens` — total output tokens
