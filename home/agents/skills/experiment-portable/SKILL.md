---
name: experiment-portable
description: >
  Test an existing thing's behavior against a falsifiable claim and capture the result as a
  standalone Markdown record in the current working directory. Self-contained — no vault, no
  external templates, no project linking. Triggers: /experiment-portable, "portable experiment",
  "run a quick experiment here", "test this claim and save a local report". Skip when building
  a new artifact (use /prototype), interrogating plan logic (use /probe), or rating confidence
  in a recommendation (use /grade).
---

# Experiment (portable)

## Parameters

- `claim` (required): one falsifiable sentence naming the behavior under test.
- `out_dir` (optional): directory to write the record into. Default `./experiments`.

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
out_dir = parse from <args> or "./experiments"
Bash("mkdir -p <out_dir>")

// Build slug from claim: kebab-case, 3–6 words capturing the predicate
slug = do("derive slug from claim, kebab-case, 3–6 words, e.g.
    'oxfmt 0.52.0 reformats .md in place' → 'oxfmt-reformats-md-in-place'")
date = today in YYYY-MM-DD format
filename = <date>-<slug>.md
record_path = <out_dir>/<filename>

description_line = do("one-line summary of the claim, ≤ 80 chars")
tags = do("suggest 1–3 kebab-case tags from: tool-behavior, config, performance,
    api, cli, format, nix, shell; omit the tags line if no clear fit")

// Instantiate from the embedded template (see ## Reference → Record template)
record = do("instantiate the embedded record template:
    - fill frontmatter: type, description, verdict, date, tags (omit tags line if empty)
    - fill each body section (## Claim, ## Method, ## Execution, ## Verdict, ## Open)
      with the corresponding content under its heading
    - leave the ## Glossary section's pinned rows (Claim, Method, Execution, Verdict, Open)
      verbatim; append domain-specific terms that surfaced during the experiment as
      un-pinned rows below them (bold-Term reserved for pinned anchors)
    - drop the ## Open section entirely if there are no unresolved questions")

Bash("write atomically: write record to <record_path>.tmp, then mv <record_path>.tmp <record_path>")
do("report the absolute path of the written file to the user")
```

## Reference

### Record template

This template is the authoritative shape of the output file. It is embedded here — no external file is read.

```markdown
---
type: experiment
description: <one-line claim summary>
verdict: confirmed | refuted | inconclusive
date: YYYY-MM-DD
tags: [<tag>, ...] # omit line if no tags
---

## Glossary

Rows whose **Term** is bolded are pinned: text, position, and presence are fixed. Pinned rows describe load-bearing anchors a cold reader must resolve before reading the Claim. Append un-pinned rows for working vocabulary; refine an existing un-pinned term by appending a new row with the sharpened wording rather than rewording in place.

| Term          | Definition                                                                  |
| ------------- | --------------------------------------------------------------------------- |
| **Claim**     | The falsifiable predicate under test, stated as one sentence.               |
| **Method**    | The exact procedure (command, query, steps) that decides the verdict.       |
| **Execution** | Raw output of running the method, verbatim, no commentary.                  |
| **Verdict**   | One of: `confirmed`, `refuted`, `inconclusive`.                             |
| **Open**      | Unresolved questions this experiment raises but does not answer.            |

## Claim

## Method

## Execution

## Verdict

## Open
```

The Glossary ships with five pinned rows — Claim, Method, Execution, Verdict, Open — that fix the meaning of the record's structural sections. Append un-pinned rows for any domain-specific vocabulary the experiment introduces.

### Frontmatter schema

| Field         | Required | Value                                     |
| ------------- | -------- | ----------------------------------------- |
| `type`        | yes      | always `experiment`                       |
| `description` | yes      | one-line claim summary, ≤ 80 chars        |
| `verdict`     | yes      | `confirmed`, `refuted`, or `inconclusive` |
| `date`        | yes      | ISO date `YYYY-MM-DD`                     |
| `tags`        | no       | list of kebab-case strings                |

### Falsifiability test

A claim is falsifiable if and only if: running the same method on twin systems (identical setup, identical inputs) could produce the opposite verdict. The test fails — and the skill stops — when the claim is decided by its wording alone (tautology), too vague for any single method to decide it, or asks "is X good" without a measurable criterion.

Examples:

- Fails: "does oxfmt work" — no method can decide this; restate as a specific predicate.
- Passes: "oxfmt 0.52.0 reformats `.md` files in place producing valid GFM" — a specific version, a specific file type, a specific output criterion; a second run on a twin system with `.md` files lacking valid GFM could refute it.

### Sandbox choice

Use the smallest sandbox that still answers the question without contaminating the host (or being contaminated by it). Reproducibility from the record alone — months later, possibly on a different machine — is the criterion that promotes Docker; without that need, lighter runners are usually right.

**Cascade, first match wins:**

1. **Host itself under test?** (the editor, hooks, OS config, system APIs) → **host execution**. Record the host runtime version in the Method field — a re-run after an update silently tests a different thing otherwise.
2. **Writes that persist outside `$TMPDIR` and are shared across sessions?** (`~/.config`, `~/.cache`, `~/.npm`, `~/Library/`, Keychain, `launchctl`, OS packages) → **Docker**. Containment is the point. If the claim is platform-specific, Docker on macOS gives a Linux verdict — note the scope in the Verdict field.
3. **Will the record be re-run from cold storage later?** (months out, different machine, future session) → **Docker** with a pinned image tag (`node:22.11.0`, never `:latest`). Reproducibility is the real reason.
4. **Otherwise — single-process, user-level, contained to `$TMPDIR`, one-shot verdict** → lightest available runner:
   - npm-native binary → `bunx --bun <pkg>@<version>`.
   - nixpkgs derivation → `nix run nixpkgs#<pkg>`.
   - Neither registry has the tool → host execution, Method field notes the experiment is not portable to a clean machine.

Experiments needing network access, GPU, privileged syscalls, multi-process orchestration, or persistent volumes across runs sit outside this cascade — Docker with capability-specific flags, documented in the Method field.

Whichever runner is chosen, the Execution field captures the exact invocation verbatim so the experiment is reproducible from the record alone.
