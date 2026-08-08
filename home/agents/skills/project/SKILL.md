---
name: project
description: >
  Vault project operations, routed by verb. `/project` (or `/project state`) reads a project's scratchpad, maps, tracks, and tickets, then reports what is active, what is stale, and what is ready to pick up — read-only. `/project setup` scaffolds the vault project folder and wires the current repo via `.vault.config.json`. Triggers: `/project`, "state of the project", "where does <project> stand", "what's active on this project", "what's stale", "project overview", "set up a new project", "wire this repo to the vault", «состояние проекта», «что сейчас по проекту». Route elsewhere: resuming one track → `/track`; advancing one map → `/map`; filing or listing tickets → `/vault ticket` and `/vault tickets`; a stakeholder-facing update → `/brief`; the vault-wide project list → `/vault projects`.
---

# Project

Two acts over one vault project.

- **state** — report what the project holds right now. Reads every artifact's frontmatter. Writes nothing.
- **setup** — scaffold the project folder, and wire the current repo to it.

State is the default. A bare `/project` reports state.

## Dispatch

```
dir = skill base directory

if args name a setup intent ("setup", "new project", "wire this repo", "scaffold"):
    Read(dir/references/setup.md)
    do("follow setup procedure")

else:                                   // bare `/project`, "state", or a project name
    Read(dir/references/state.md)
    do("follow state procedure")
```

## Reference

| File                  | Purpose |
| --------------------- | ------- |
| `references/state.md` | Report a project's current state: active, stale, parked, ready, blocked. Read-only, then routes. |
| `references/setup.md` | Create the vault project folder and write `.vault.config.json` in the current repo. |

Projects live at `<vault_root>/41 projects/<project>/`. Both procedures resolve the project through `vault-query config`, which walks up from cwd to find `<repo>/.vault.config.json`.
