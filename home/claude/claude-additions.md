## Bash (Claude Code)

The shell sandbox uses a permission allowlist. Single commands match allowlist entries; chained commands (`&&`, `||`, `;`) bypass them and trigger prompts. Prefer one command per call.

## Memory

Before saving anything to memory, suggest the save to the user (what, which type, one-line summary) and wait for confirmation. Then save.
