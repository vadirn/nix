# Log Complete

Marks a daily log as complete. Called by SKILL.md with log already read.

```
log_path = "41 projects/block-buster/log-{target_date}.md"

// Gather completed tasks from projects
all_done = Bash(obsidian tasks done verbose)
done_today = do("filter lines containing ({target_date})")

// Build result (## Plan may be empty if user skipped morning)
result_items = do("merge: user's wrap-up message + done_today, match against ## Plan items")
// Items in ## Plan and done → ✓ planned
// Items not in ## Plan but done → ✓ (unplanned)
// Items in ## Plan and not done → ✗

// Compute XP
AskUserQuestion("Лёг вовремя?")
sleep_flag = if yes: "--sleep" else: ""
xp = Bash(vault-cli xp {sleep_flag} {target_date})

// Update log
Edit(log_path) — write ## Result section with result_items
Edit(log_path) — set frontmatter status: complete, xp: {xp}

// Mark project tasks
matched_tasks = do("find project tasks matching ✓ items that aren't already checked")
if matched_tasks:
    AskUserQuestion("Mark these tasks done? {matched_tasks}")
    if confirmed: Edit(project files) — change "- [ ] task" → "- [x] ({target_date}) task"

// Summary
do("show today's XP, streak, level")
```

## Reference

### XP scoring

| Source                | XP          | Condition                           |
| --------------------- | ----------- | ----------------------------------- |
| Had a plan            | +3          | ## Plan had items before completion |
| Completed (planned)   | +2          | Per item from ## Plan marked ✓      |
| Completed (unplanned) | +1          | Per item not in ## Plan marked ✓    |
| Streak                | +streak     | Consecutive days completed (cap 7)  |
| Sleep target          | +3          | Met sleep target                    |

### Task completion format

Project tasks are marked: `- [x] (YYYY-MM-DD) task description`. No community plugin dependency. Greppable by date, human-readable.

### Summary format

```
Today: {xp} XP
Streak: {streak + 1} days
Level: {level} ({cumulative_xp} XP total)
```

Level = total XP across all logs / 50.
