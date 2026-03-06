# Start — resume or begin a session

## Pseudocode

```
incomplete = Bash(vault-cli checkpoints Incomplete)

if incomplete is not empty:
    selected = AskUserQuestion(incomplete, multiSelect=true)  // include "All" option
    for each in selected:
        show "## Progress" and "## Next"
else:
    done = Bash(vault-cli checkpoints Done)
    print "All checkpoints done." if done is not empty else "First session."

ask "What to work on?"
```

## Reference

### Querying checkpoints

Use `vault-cli checkpoints <view>` which calls `obsidian base:query` under the hood.

Views: `Incomplete`, `Done`, `All`, `Stats`.

Empty result = no checkpoints in that view.

Fallback (Obsidian offline): vault-cli falls back to grep on checkpoint files.

### Presenting checkpoints

Use `AskUserQuestion` with `multiSelect: true`. Each option label: `description` field (fall back to filename if missing). Include an "All" option.

Read selected checkpoints. Show `## Progress` and `## Next` from each.
