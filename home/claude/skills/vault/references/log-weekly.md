# Log Weekly

All operations on the weekly log file. Called by SKILL.md after reading the current week's file.

```
week_file = already read by SKILL.md

// Determine what user wants
action = do("parse user intent: add task, complete task, move from backlog, update projects, mark sleep, or general update")

if action == "add task":
    Edit(week_file) — append "- [ ] {task} [[project]]" to ## Tasks

elif action == "complete task":
    today = date
    Edit(week_file) — change "- [ ] {task}" → "- [x] (today) {task}" in ## Tasks

elif action == "backlog":
    Edit(week_file) — add/remove items in ## Backlog

elif action == "projects":
    Edit(week_file) — update ## Projects list with [[project]] wikilinks

elif action == "sleep":
    today = date
    Edit(week_file) — add today to sleep: [] list in frontmatter

else:
    do("help user with their request using the weekly log")
```

## Reference

### XP scoring

| Source         | XP               | Logic                                                        |
| -------------- | ---------------- | ------------------------------------------------------------ |
| Completed tasks | +1 each         | `- [x]` count in ## Tasks                                    |
| Backlog tasks   | -1 each         | `- [x]` count in ## Backlog (penalty for completing backlog instead of planned tasks) |
| Full coverage  | +N (next Monday) | N = projects in ## Projects; all must have a linked `- [x]` task. Bonus lands on Monday of the following week. |
| Sleep streak   | +1..+7/day       | Consecutive days in `sleep: []` across weekly files. Day 1 → +1, day 2 → +2, ..., day 7+ → +7. |

### Task format

Tasks in ## Tasks: `- [ ] description [[project]]` or `- [x] (YYYY-MM-DD) description [[project]]`.

The `(YYYY-MM-DD)` date on completed tasks is used for per-day XP attribution in the calendar view.

### Activity

Activity is auto-appended by the post-commit hook. Each entry prefixed with `YYYY-MM-DD-HH-MM` (no date headings).

### Weekly file

One file per ISO week: `YYYY-wWW.md` in `41 projects/block-buster/`.
Created by `vault-cli log-init` with frontmatter: `week`, `start`, `end`, `sleep: []`.

The `sleep` field is a YAML list of ISO dates: `sleep: [2026-03-10, 2026-03-11]`. The sleep action appends today's date to this list.
