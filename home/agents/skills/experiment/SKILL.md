---
name: experiment
description: >
  Test an existing thing's behavior against a falsifiable claim and capture the result as a structured record in the vault. Triggers: /experiment, "run an experiment", "test this claim", "verify whether", "does X actually", "check if X works", "is X true", "falsifiable claim". Skip when building a new artifact (use /prototype), interrogating plan logic (use /probe), or rating confidence in a recommendation (use /grade).
---

# Experiment

Capture harness; the falsifiability and sandbox doctrine lives in the vault note `Experiment`, loaded at invocation — never run from memory of it.

## Parameters

- `claim` (required): one falsifiable sentence naming the behavior under test.

```
// Load doctrine
note_path = Bash(vault-query get "Experiment")
if note_path missing or ambiguous: do("report the error to the user"); stop

// (parallel)
doctrine_intro = Bash(vault-query read <note_path> 0)
falsifiability = Bash(vault-query read <note_path> "Falsifiability")
sandbox = Bash(vault-query read <note_path> "Sandbox choice")
if any read errors: do("report the exact error and note_path to the user"); stop

// Claim gate
claim = <args> or AskUserQuestion("State the claim to test. One sentence, falsifiable.")
falsifiable = do("apply the <falsifiability> test to <claim>")
if not falsifiable: do("explain why and stop; suggest a sharpened restatement if possible")

// Method
method = AskUserQuestion("Describe the method: the exact command, query, or procedure
    that will decide the verdict. One sentence.")
do("restate claim, method, and expected verdict shape (exit code, output text, diff, timing);
    ask user to confirm or correct")

// Execute
do("run the method in the smallest reproducible sandbox, chosen per the <sandbox> cascade;
    record raw output verbatim")

// Verdict
verdict = do("classify the outcome as confirmed / refuted / inconclusive; write one paragraph:
    what was observed, what it means for the claim, any caveats")

// Capture
cfg = Bash(vault-query config)
if cfg errors: do("surface 'no vault configured' and skip Capture")
vault_root = cfg.vault_root
if vault_root is empty or null: do("surface 'vault_root not set' and skip Capture")
Bash(mkdir -p "<vault_root>/35 experiments")

slug = do("derive kebab-case slug from claim, 3–6 words capturing the predicate")
date = Bash(date +%Y-%m-%d)

description_line = do("one-line summary of the claim, ≤ 80 chars")
if cfg contains project_path:
    project_wikilink = do("read <cfg.project_path>/context.md and copy the '[[...]]'
        wikilink from the 'Project note:' line; if file absent or line missing, set to null")
else:
    project_wikilink = null

// Build record — see Reference §Record template
template = Read(<vault_root>/templates/Experiment.md)
if Read fails: template = do("instantiate inline from the shape in Reference §Record template; note 'instantiated from inline fallback' in the Execution field")
record = do("instantiate template:
    - drop the `template: true` line
    - replace the `verdict:` multi-value picker list with the single chosen verdict
    - set description, date, project (omit line if null)
    - fill each body section (## Claim, ## Method, ## Execution, ## Verdict, ## Open)
      with the corresponding content under its heading
    - leave the ## Glossary section's pinned rows (Claim, Method, Execution, Verdict, Open)
      verbatim; append domain-specific terms that surfaced during the experiment as
      un-pinned rows below them (bold-Term reserved for pinned anchors)
    - drop the ## Open section entirely if there are no unresolved questions")
record_path = <vault_root>/35 experiments/<date>-<slug>.md
Bash(write <record> to <record_path>.tmp)
Bash(mv <record_path>.tmp <record_path>)

// Auto-link to active track
if project_wikilink is not null:
    tracks = Bash(vault-query tracks --view Active --format json)

    if tracks is empty:
        track_path = null
    elif tracks has exactly one row:
        track_path = <cfg.project_path>/<tracks[0].Track>.md
    else:
        options = [for t in tracks: { label: t.Track, description: t.Status + " · " + t.Description }]
        selected = AskUserQuestion("Multiple active tracks. Which one should this experiment link to?
            (or skip to link none)", options, singleSelect=true, allowSkip=true)
        track_path = skipped ? null : <cfg.project_path>/<selected.Track>.md

    if track_path is not null:
        track_content = Read(<track_path>)
        do("locate or create '## Experiments' section — see Reference §Auto-link rule for position")
        link_line = "- [[35 experiments/<date>-<slug>|<claim summary>]] — <verdict>"
        updated_content = do("append link_line under ## Experiments in <track_content>")
        Bash(write <updated_content> to <track_path>.tmp)
        Bash(mv <track_path>.tmp <track_path>)
```

## Reference

### Doctrine loading

- `vault-query get "Experiment"` resolves the doctrine note; the exact basename match `00 inbox/Experiment.md` is the intended target — experiment records under `35 experiments/` are dated slugs and do not match the bare name. If resolution is ambiguous, retry with `vault-query get "00 inbox/Experiment"`.
- Structured reads load only the intro definition (address `0`), the falsifiability test, and the sandbox cascade, keeping the note's frontmatter out of context.
- Fail loud, never improvise: on any resolution or address error the doctrine has moved or its headings were renamed — a gate reconstructed from memory looks like success while silently degrading the contract. The section headings `Falsifiability` / `Sandbox choice` are part of this wrapper's contract with the note.

### Record template

The authoritative template lives in the vault at `<vault_root>/templates/Experiment.md` (read by Step 5 via `vault-query config`). The shape below mirrors that file; update both if either changes.

```markdown
---
type: experiment
description: <one-line claim summary>
verdict: confirmed | refuted | inconclusive
date: YYYY-MM-DD
project: "[[<project wikilink>]]" # omit line if no project resolved
---

## Glossary

Rows whose **Term** is bolded are pinned: text, position, and presence are fixed, and update passes must not edit them. Append un-pinned rows for working vocabulary; refine an existing un-pinned term by appending a new row with the sharpened wording rather than rewording in place.

| Term          | Definition                                                            |
| ------------- | --------------------------------------------------------------------- |
| **Claim**     | The falsifiable predicate under test, stated as one sentence.         |
| **Method**    | The exact procedure (command, query, steps) that decides the verdict. |
| **Execution** | Raw output of running the method, verbatim, no commentary.            |
| **Verdict**   | One of: `confirmed`, `refuted`, `inconclusive`.                       |
| **Open**      | Unresolved questions this experiment raises but does not answer.      |

## Claim

## Method

## Execution

## Verdict

## Open
```

The Glossary ships with five pinned rows — Claim, Method, Execution, Verdict, Open — that fix the meaning of the record's structural sections. Append un-pinned rows for any domain-specific vocabulary the experiment introduces. Shares the format and bold-as-pinned convention with `/track` and `/glossary`.

### Frontmatter schema

| Field         | Required | Value                                     |
| ------------- | -------- | ----------------------------------------- |
| `type`        | yes      | always `experiment`                       |
| `description` | yes      | one-line claim summary, ≤ 80 chars        |
| `verdict`     | yes      | `confirmed`, `refuted`, or `inconclusive` |
| `date`        | yes      | ISO date `YYYY-MM-DD`                     |
| `project`     | no       | wikilink from `<project_path>/context.md` |

### Auto-link rule

The auto-link step appends one line to an active track's `## Experiments` section. The section is inserted after `## Decisions` and before `## Backlog` if it does not already exist. The link format is:

```
- [[35 experiments/YYYY-MM-DD-<slug>|<claim summary>]] — <verdict>
```

The step requires both a resolved `project_path` (from `vault-query config`) and at least one active track. If either is absent, the step is skipped silently. If multiple active tracks exist, the user picks one or skips.
