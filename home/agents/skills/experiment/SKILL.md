---
name: experiment
description: >
  Test an existing thing's behavior against a falsifiable claim and capture the result as a
  structured record in the vault. Triggers: /experiment, "run an experiment", "test this claim",
  "verify whether", "does X actually", "check if X works", "is X true", "falsifiable claim".
  Skip when building a new artifact (use /prototype), interrogating plan logic (use /probe),
  or rating confidence in a recommendation (use /grade).
---

# Experiment

## Parameters

- `claim` (required): one falsifiable sentence naming the behavior under test.

```
// Step 1 — Claim gate
claim = parse from <args> or AskUserQuestion("State the claim to test. One sentence, falsifiable.")

// Falsifiability test: "the same method on twin systems wouldn't produce the same verdict"
// A claim passes if a specific method applied to a second identical system could yield a
// different result — i.e., the outcome is not predetermined by definition or wording alone.
falsifiable = do("apply the falsifiability test: would the same method on twin systems
    be capable of producing the opposite verdict? yes → proceed; no → stop")
if not falsifiable:
    do("stop with explanation: the claim is not falsifiable because [reason];
        suggest a sharpened restatement if possible")

// Step 2 — Method declaration
method = AskUserQuestion("Describe the method: the exact command, query, or procedure
    that will decide the verdict. One sentence.")
do("restate: claim, method, and expected verdict shape (e.g. exit code, output text,
    file diff, timing); ask user to confirm or correct")

// Step 3 — Execute
do("run the method in the smallest reproducible sandbox — see ## Reference → Sandbox choice;
    record raw output verbatim")

// Step 4 — Verdict classification
verdict = do("classify the outcome as one of: confirmed / refuted / inconclusive;
    write one paragraph: what was observed, what it means for the claim, any caveats")

// Step 5 — Capture

// Resolve vault root
cfg = Bash(vault-query config)
// cfg → { vault_root, project_path? }
// If vault-query errors (no vault configured), surface the error and skip the capture step

vault_root = cfg.vault_root
Bash(mkdir -p "<vault_root>/35 experiments")

// Build slug from claim: kebab-case, 3–6 words capturing the predicate
slug = do("derive slug from claim, kebab-case, 3–6 words, e.g.
    'oxfmt 0.52.0 reformats .md in place' → 'oxfmt-reformats-md-in-place'")
date = today in YYYY-MM-DD format
filename = <date>-<slug>.md

// Build optional frontmatter fields
description_line = do("one-line summary of the claim, ≤ 80 chars")
if cfg contains project_path:
    project_wikilink = do("read <cfg.project_path>/context.md and copy the '[[...]]'
        wikilink from the 'Project note:' line; if file absent or line missing, set to null")
else:
    project_wikilink = null

tags = do("suggest 1–3 kebab-case tags from: tool-behavior, config, performance,
    api, cli, format, nix, shell; add none if no clear fit")

// Write record
Write(<vault_root>/35 experiments/<filename>)
// Record shape: see ## Reference → Record template

// Auto-link to active track (v1 scope)
if project_wikilink is not null:
    tracks = Bash(vault-query tracks --view Active --format json)
    // Returns [] when the project has no active tracks; errors with "no project
    // resolved" when no .vault.config.json is found above cwd. The
    // project_wikilink guard above already rules out the error case.

    // Pick a track or skip
    if tracks is empty (parsed JSON is []):
        track_path = null
    elif tracks has exactly one row:
        track_path = <cfg.project_path>/<tracks[0].Track>.md
    else:
        options = [for t in tracks: { label: t.Track, description: t.Status + " · " + t.Description }]
        selected = AskUserQuestion("Multiple active tracks. Which one should this experiment link to?
            (or skip to link none)", options, singleSelect=true, allowSkip=true)
        track_path = skipped ? null : <cfg.project_path>/<selected.Track>.md

    // Append the link
    if track_path is not null:
        do("Read(track_path)")
        do("locate or create '## Experiments' section: it belongs after '## Decisions'
            and before '## Backlog'; if the section is absent, insert a blank '## Experiments'
            heading in that position")
        link_line = "- [[35 experiments/<date>-<slug>|<claim summary>]] — <verdict>"
        do("append link_line under ## Experiments, producing <updated_content>")
        Bash("printf '%s' \"$updated_content\" > \"$track_path.tmp\" && mv \"$track_path.tmp\" \"$track_path\"")
```

## Reference

### Record template

```markdown
---
type: experiment
description: <one-line claim summary>
verdict: confirmed | refuted | inconclusive
date: YYYY-MM-DD
project: "[[<project wikilink>]]"   # omit line if no project resolved
tags: [<tag>, ...]                  # omit line if no tags
---

## Glossary

Rows whose **Term** is bolded are pinned: text, position, and presence are fixed. Pinned rows describe load-bearing anchors a cold reader must resolve before reading the Claim. Append un-pinned rows for working vocabulary; refine an existing un-pinned term by appending a new row with the sharpened wording rather than rewording in place.

| Term | Definition |
| ---- | ---------- |

## Claim

<claim verbatim>

## Method

<method verbatim>

## Execution

<raw output or transcript, verbatim>

## Verdict

<one paragraph: what was observed, what it means, caveats>

## Open

<optional: unresolved questions this experiment raises>
```

The Glossary section is written unconditionally as part of the template. For simple experiments with no domain-specific terms, it remains an empty table — a slot for hand-editing if a term turns out to need a permanent anchor later. Shares the format and bold-as-pinned convention with `/track` and `/glossary`.

### Frontmatter schema

| Field         | Required | Value                                                  |
| ------------- | -------- | ------------------------------------------------------ |
| `type`        | yes      | always `experiment`                                    |
| `description` | yes      | one-line claim summary, ≤ 80 chars                    |
| `verdict`     | yes      | `confirmed`, `refuted`, or `inconclusive`              |
| `date`        | yes      | ISO date `YYYY-MM-DD`                                  |
| `project`     | no       | wikilink from `<project_path>/context.md`              |
| `tags`        | no       | list of kebab-case strings                             |

### Falsifiability test

A claim is falsifiable if and only if: running the same method on twin systems (identical setup, identical inputs) could produce the opposite verdict. The test fails — and the skill stops — when the claim is decided by its wording alone (tautology), too vague for any single method to decide it, or asks "is X good" without a measurable criterion.

Examples:

- Fails: "does oxfmt work" — no method can decide this; restate as a specific predicate.
- Passes: "oxfmt 0.52.0 reformats `.md` files in place producing valid GFM" — a specific version, a specific file type, a specific output criterion; a second run on a twin system with `.md` files lacking valid GFM could refute it.

### Sandbox choice

Use the smallest sandbox that still answers the question without contaminating the host (or being contaminated by it). Reproducibility from the record alone — months later, possibly on a different machine — is the criterion that promotes Docker; without that need, lighter runners are usually right.

**Cascade, first match wins:**

1. **Host itself under test?** (Claude Code, hooks, nix config, macOS APIs, the editor) → **host execution**. Record the host runtime version (commit SHA, nix-darwin generation, settings.json state) in the Method field — a re-run after an update silently tests a different thing otherwise.
2. **Writes that persist outside `$TMPDIR` and are shared across sessions?** (`~/.config`, `~/.cache`, `~/.npm`, `~/Library/`, Keychain, `launchctl`, OS packages) → **Docker**. Containment is the point. If the claim is platform-specific, Docker on macOS gives a Linux verdict — note the scope in the Verdict field.
3. **Will the record be re-run from cold storage later?** (months out, different machine, future Claude session) → **Docker** with a pinned image tag (`node:22.11.0`, never `:latest`). Reproducibility is the real reason.
4. **Otherwise — single-process, user-level, contained to `$TMPDIR`, one-shot verdict** → lightest available runner:
   - npm-native binary → `bunx --bun <pkg>@<version>` (the `bunfig.toml` 7-day minimum-release-age guard applies; pass `--minimum-release-age=0` and document it in the Method field if the pin is fresher).
   - nixpkgs derivation → `nix run nixpkgs#<pkg>`.
   - Neither registry has the tool → host execution, Method field notes the experiment is not portable to a clean machine.

Experiments needing network access, GPU, privileged syscalls, multi-process orchestration, or persistent volumes across runs sit outside this cascade — Docker with capability-specific flags, documented in the Method field.

Whichever runner is chosen, the Execution field captures the exact invocation verbatim so the experiment is reproducible from the record alone.

### Auto-link rule

The auto-link step appends one line to an active track's `## Experiments` section. The section is inserted after `## Decisions` and before `## Backlog` if it does not already exist. The link format is:

```
- [[35 experiments/YYYY-MM-DD-<slug>|<claim summary>]] — <verdict>
```

The step requires both a resolved `project_path` (from `vault-query config`) and at least one active track. If either is absent, the step is skipped silently. If multiple active tracks exist, the user picks one or skips.
