# Result handoff template — worker → delegator

What the worker did and what it hands back.

```
# Handoff: result

## Recap
## Modified files
## Decisions
## Backlog
```

Return a result inline in the final message by default; write it to a `mktemp` file and pass the path only when it is bulky.

### Recap discipline

`## Recap` is prose only — no lists, code blocks, tables, or file dumps; structured findings go to `$TMPDIR`, cited by path. Aim for one short paragraph. `## Modified files` lists paths only; `## Decisions` and `## Backlog` are numbered lists.

The prose-only rule keeps inter-agent context small without active compaction: the reader forwards a Recap as-is into the next handoff's `## Context`. The constraint is structural, not numerical — a writer can reliably self-check "is this a paragraph of prose?" but cannot count its own tokens. It catches the actual cause of bloat (structured dumps), which belong in `$TMPDIR`. The discipline applies only to Recap; the other sections keep their structured forms.
