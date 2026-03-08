---
name: session-analysis
description: >
  Analyze prompt patterns across all Claude Code sessions. Focuses on what the user *asked* (prompt
  content and recurring patterns), not costs/tokens (that's session-stats) or CLI commands Claude ran
  (that's tool-stats). Use when user asks what they keep asking Claude for, what their most common
  prompts are, what patterns repeat across sessions, what should be a skill but isn't, or wants a
  history/usage overview. Also triggers on "how do I use Claude", "show my prompt history", "what
  should I automate", or any curiosity about cross-session habits.
---

# Session Analysis

Analyze prompt history across all Claude Code sessions.

```
dir = directory containing this file
script = dir + "/session-analysis.py"

// Build flags from user request
flags = ""
if user specified a count:   flags += " --top N"
if user specified a project: flags += " --project <path>"
if user specified a date:    flags += " --since YYYY-MM-DD"

output = Bash(python3 <script> <flags>)
present tables to user
gap_analysis(output)
```

## Gap analysis

Compare the "Top Prompts" table against the skill list in your system context (the `available skills` block in system-reminder messages).

For each recurring prompt pattern:

1. Check if an existing skill handles it. Match by intent, not exact wording: "let's commit" maps to git workflow, "apply /writing-en" maps to writing-en skill.
2. Classify:
   - **Covered**: an existing skill handles this. Name the skill.
   - **Partially covered**: a skill exists but the prompt asks for something beyond it.
   - **Gap**: no skill handles this pattern.
3. Skip low-signal prompts: confirmations ("yes", "yes please"), one-word approvals, and meta-commands ("commit", "push it") that are git workflow, not skill candidates.

Present gaps sorted by frequency. For each gap, include the prompt pattern, count, and a one-line rationale.

Example output:

| Pattern (count)                 | Status  | Skill / Rationale                               |
| ------------------------------- | ------- | ----------------------------------------------- |
| "apply /writing-en to..." (5)   | Covered | writing-en                                      |
| "check the tracker" (3)         | Gap     | project status checking without explicit /vault |
| "let's commit all changes" (28) | Skip    | git workflow, not a skill candidate             |

## Script reference

`session-analysis.py` reads `~/.claude/history.jsonl` (fields: `display`, `pastedContents`, `timestamp`, `project`, `sessionId`).

| Flag                 | Default | Description           |
| -------------------- | ------- | --------------------- |
| `--top N`            | 15      | Items per table       |
| `--project <path>`   | all     | Filter to one project |
| `--since YYYY-MM-DD` | all     | Filter by date        |

Output sections: Summary, Top Projects, Slash Commands, Top Prompts (normalized, min 2 occurrences).
