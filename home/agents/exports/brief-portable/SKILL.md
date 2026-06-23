---
name: brief
description: >
  Draft a per-stakeholder status update from real work artifacts, or diagnose a stakeholder
  complaint as a state-gap vs a target-gap before you react. Drafts, never sends. Self-contained
  — no vault, no external config, no extra tools: reads the git repo containing cwd and the
  roster in `<repo-root>/.brief/context.md`; writes only each stakeholder's `last_drafted` there.
  Out of scope: sending, scheduling. Invoke explicitly with /brief.
disable-model-invocation: true
---

# brief

Two acts that close two different gaps between your work and a stakeholder's head:

- **draft** — compose a status update that closes **impression distance**: the gap between the actual state of the work and the stakeholder's model of that state.
- **diagnose** — classify a complaint as a state-gap (report it) or a **target distance** gap (renegotiate it, never report it), so you do not answer a scope objection with a status report.

Read `references/concepts.md` once per session if the impression/target/axis vocabulary is not already loaded; it is the self-contained recap of the two distances and two axes the procedures fix to one meaning each.

The skill **drafts but never sends**. The relational axis — the stakeholder's sense that someone is attending to them — is produced only by the human act of communicating. A draft auto-sent is proof-of-work without proof-of-care, the exact collapse the concept warns against. So every path ends at text in your terminal that you read, edit, and send yourself.

## Glossary

The vocabulary both procedures fix to one meaning each. `references/concepts.md` is the long-form why; this is the quick lookup.

| term                 | meaning                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| impression distance  | gap between actual work state and a stakeholder's model of it; closed by reporting state (draft)               |
| target distance      | gap between what they think _should_ be done and what's feasible/agreed; renegotiate, never report             |
| state gap            | a complaint that is impression distance — report it                                                            |
| target gap           | a complaint that is target distance — renegotiate; splits impossible / too-large / off-target(a,b)             |
| artifact axis        | proof-of-work; closed by inspectable artifacts (merged PRs)                                                    |
| relational axis      | proof-of-care; produced only by the human act of communicating — why brief never sends                         |
| inspection-closeable | content an artifact already carries; one terse line                                                            |
| communication-only   | content no artifact carries (blocked/why, at-risk, revised estimate, next, counterfactual); the substance      |
| currency             | the units a stakeholder counts in (features/dates, infra/risk); draft translates work into them                |
| model                | a stakeholder's current belief about the work state; draft leads with what it's missing                        |
| inspects             | what a stakeholder closes on their own (PRs, board); what the draft may omit                                   |
| counterfactual       | claimed future value of non-feature work; mark for verification, never assert                                  |
| provenance           | per-field tag in draft: artifact (from git) / inferred (marked guess) / elicited (user supplies)               |
| roster               | the `stakeholders:` list in `.brief/context.md` frontmatter; authored by you, brief writes only `last_drafted` |
| `last_drafted`       | per-stakeholder date of the last accepted draft; the period default                                            |

## Dispatch

```
dir = skill base directory

route = do("""classify the input:
  - a relayed stakeholder reaction/complaint, OR target-gap language ('should have',
    'we agreed', 'this is too much', 'expected X by now', 'why isn't Y done') → diagnose
    (even if the user said 'update'; a status report aimed at a target objection deepens it)
  - a request for a status update → draft
  - genuinely ambiguous → diagnose, and ask the one consequence-first question in diagnose.md""")

if route == diagnose:
    Read(dir/references/diagnose.md)
    do("follow the diagnose procedure")
else:
    Read(dir/references/draft.md)
    do("follow the draft procedure")
```

## Resolving the project and its artifacts

Both procedures share this setup. Do it once. No vault, no external config — just the repo working tree.

```
repo    = Bash(git rev-parse --show-toplevel)   // fall back to pwd outside a git repo
ctx     = <repo>/.brief/context.md
context = Read(ctx) if it exists, else none      // roster + per-stakeholder last_drafted

roster  = context.frontmatter.stakeholders       // list; may be absent (no file, or no block)
```

**Repo.** brief reads one git history: the repo containing cwd. An engagement spanning
several repos is out of scope — to read another repo's commits, run brief from inside it.

**Roster.** The `stakeholders:` list in `.brief/context.md` frontmatter, one entry per person:
`name`, `currency`, `model`, `inspects`, optional `role`, and `last_drafted` (template below).
You author it; brief writes only `last_drafted` (see draft.md). If the file or list is absent,
both procedures degrade gracefully: draft writes a single generic update and offers to create
the file, diagnose works without it.

## The context file

`<repo-root>/.brief/context.md`. You author the `stakeholders:` block; brief writes only each
`last_drafted`. The template is embedded here — no external file is read. draft offers to create
it from this template when it is absent.

```markdown
---
# stakeholders: read by the `brief` skill. One entry per person; brief writes only each
# `last_drafted`. Everything else is yours. Delete the block if unused. Repo paths are NOT
# stored here — brief reads the git repo containing cwd.
stakeholders:
  - name: Sarah
    role: PM # optional; no brief logic branches on it
    currency: [features, dates] # units they count in; brief translates work into these
    model: thinks the migration is nearly done # their current belief about the state
    inspects: [] # what they close themselves (e.g. [PRs]); [] = waits to be told
    last_drafted: # YYYY-MM-DD, written by brief on an accepted draft
---

# <project> — brief context

Optional prose: what the project is for, who counts in what. Durable framing the draft
digest reads for context. Keep it short; the roster above is the load-bearing part.
```

## The two procedures

| File                     | When                                                  |
| ------------------------ | ----------------------------------------------------- |
| `references/draft.md`    | Compose a per-stakeholder update from artifacts.      |
| `references/diagnose.md` | Classify a complaint; route to the matching practice. |

Keep `concepts.md` in mind as the why; keep `drafts but never sends` as the one rule that
does not bend.
