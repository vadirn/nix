# Log Save

Creates or updates a daily log. Called by SKILL.md with target_date already resolved.

```
log_path = "41 projects/block-buster/log-{target_date}.md"

// Gather project tasks for context
tasks = Bash(obsidian tasks todo verbose)

if log exists:
    do("append new items to ## Plan with '(unplanned)' marker")
    Edit(log_path)
else:
    Bash(vault-cli log-init {target_date})
    plan_items = do("parse user's freeform message into plan items, match against project tasks")
    Edit(log_path) — add plan_items to ## Plan
    do("show created plan, show related project tasks as context from tasks output")
```

## Reference

### Log template

Source of truth: `$VAULT_ROOT/templates/Daily Log.md`. Created by `vault-cli log-init`.

### Fuzzy matching

Plan items match project tasks conversationally: "допилю сайдбар" matches `- [ ] Sidebar layout`. Show matched tasks so user can confirm.

### Mid-day additions

Append to `## Plan` with `(unplanned)` marker. E.g. `- fix deploy bug (unplanned)`.
