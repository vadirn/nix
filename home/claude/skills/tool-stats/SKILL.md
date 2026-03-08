---
name: tool-stats
description: Analyze CLI tool usage across Claude Code sessions. Shows which Bash commands were used, how often, across which projects. Use when user asks about tool usage patterns, "what CLI tools do I use", "what commands did Claude run", session tool history, or Bash command frequency.
---

# Tool Stats

Analyze CLI tool usage from Claude Code session transcripts.

## Step 1: Run the script

```bash
tool-stats [OPTIONS]
```

### Options

- `--project <path>` — Analyze sessions for a specific project (e.g., `--project /Users/vadim/nix`). Default: current working directory.
- `--all` — Analyze all projects.
- `--top N` — Show top N tools (default: 30).
- `--format table|json` — Output format (default: table).

## Step 2: Present results

Show the table. Add 1-2 sentences noting patterns:

- Which tools dominate and why
- Read-only vs destructive tool ratio
- Any surprising or unusual tools
