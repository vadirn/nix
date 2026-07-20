---
name: tessera
description: Tessera compiles per-project skill "tiles" from generic reference skills. This skill is the front door to the compile ladder; step 1 (the partition survey) is built. Run it to survey a repo's activities, carve them disjoint, and write the in-scope/out-of-scope partition to `.claude/tessera/spec.yaml`. Use on /tessera, "set up tessera", "partition this repo's skill surface", "tile this project's skills", "survey activities for tiling", or "what skills should this project have". Steps 2-5 (selection, generation, validation) are not yet built.
---

# Tessera

Tessera treats the model as a compiler: a generic reference skill (`tdd`, `react-best-practices`, `modern-web-guidance`) is source, and a **tile** is the artifact compiled from it under a project's material conditions. The output of a full run is a _tiling_ of the project's skills-covered surface — tiles that cover every admitted activity and stay disjoint (no two tiles fire on one prompt).

The workflow is a **three-step ladder**, downward-only, each rung with its own change-trigger:

1. **Partition** (layout-triggered) — survey the repo's activities, carve them disjoint, declare in-scope (`admit`) vs out-of-scope (`skip`). Practice-blind and conditions-blind. **← this skill, built.**
2. **Selection** (catalog-triggered) — bind a practice per in-scope activity, or mark `unbound` when base behaviour already suffices. _Not yet built._
3. **Generation** (conditions-triggered) — `compile(practice, activity, conditions)` → tile, per bound activity, then validate cover/disjoint/overreach. _Not yet built._

A change re-runs its rung and everything below it, never above. The full design lives in the vault at `41 projects/tessera/workflow.md`, `context.md`, and `GLOSSARY.md`.

## Dispatch

```
repo = cwd                                  // the repo being tesselated
spec_path = <repo>/.claude/tessera/spec.yaml

if the request is selection / generation / validation / "full compile":
    do("report: only step 1 (partition survey) is built. The selection survey,
        the compile engine, and the tiling-validator are unbuilt — point to
        41 projects/tessera/workflow.md for the design. Offer to run step 1 now.")
    stop unless the human wants the partition survey

// default: run the partition survey (step 1)
run Partition survey
```

## Partition survey (step 1)

Goal: produce the **partition** — the set of activities this repo entails, each judged in-scope or out-of-scope, carved so no two activities claim the same prompt. This is a judgment about _what work happens here_, nothing else. Hold two blinders the whole way:

- **Practice-blind.** Do not consider which reference skill could cover an activity. That is step 2 (selection). An activity is in-scope because it is real work here, not because a skill exists for it.
- **Conditions-blind.** Do not read the browser floor, dependency versions, or tsconfig target to decide scope. Those are read at generation (step 3). Step 1 only finds _where_ the condition files are (the `conditions_from` pointers), never _what they say_.

```
// 1. Metadata — layout-derived
project_name   = <repo basename>, refined by package.json "name" if present
reference_root = "/Users/vadim/nix/home/agents/skills"     // global default; honor an existing spec override
conditions_from = discover which of these exist in the repo (record POINTERS only, never contents):
                  package.json (root and per-workspace), .browserslistrc, tsconfig*.json

// 2. Evidence base — layout + conventions (read these; they are not material conditions)
tree        = Bash(list repo tree to depth 2-3, excluding node_modules/dist/.git/build)
workspaces  = parse the monorepo layout: package.json "workspaces", packages/*, apps/*, services/*
conventions = Read(CLAUDE.md / AGENTS.md / README.md when present); list <repo>/.claude/skills/*
existing    = if Read(spec_path): parse the confirmed admit/skip (step-1 layers);
              KEEP any bind/unbound (step-2 layers) and overrides verbatim for the rewrite

// 3. Enumerate candidates — one axis per level (Invariant 1: never mix axes in a level)
categories = propose disciplines GROUNDED IN THE EVIDENCE, naming only what the repo shows
             (e.g. frontend, backend, infra, design, docs, tooling, library, release).
             Categories are scaffolding for grouping, not the unit of admission.
for each category:
    activities = the atomic units of work in that category, carved DISJOINT (Invariant 2):
                 phrase each so two activities never match the same prompt. An activity is
                 a kind of task a contributor does here ("unit-tests", "api-design", "release"),
                 not a file or a tool.

// 4. Classify each candidate activity — the partition judgment, and ONLY this
for each candidate activity:
    propose  admit  (real work here) + a one-line SCOPE NOTE: what this activity owns,
                     and where you merged or split siblings, what it excludes. The note
                     fixes the disjoint boundary the bare name cannot hold (e.g. "unit-tests"
                     alone does not say whether type-level tests belong to it). Write it in the glossary's
                     distinct-from-siblings discipline. Stay practice-blind and conditions-blind:
                     name the work, never a practice ("tdd") or a condition ("Safari 14").
        OR   skip   (out of scope — a partition-skip, with a one-line reason)
if existing spec:
    carry confirmed entries as-is; (re)propose only activities the current layout surfaced
    that the spec does not yet rule on. Re-survey is layout-triggered, not from scratch.

// 5. Human confirmation — the survey is human-in-loop, the human owns the partition
present a table:  category | activity | proposed (admit/skip) | reason
let the human admit / skip / rename / split / merge. Loop until they accept the partition.
Disjointness is the human's call too: if two activities feel overlapping, merge or re-cut them.
Confirm each scope note as well — it records the merge or split the human just made, so the
next layout-triggered survey does not silently undo it.

// 6. Write step-1 layers only
ensure <repo>/.claude/tessera/ exists
Write(spec_path) with:
    admit:  map of <category>/<activity>: "<scope-note>"   # the scope each owns (disjoint boundary)
    skip:   <category>/<activity>: "<reason>"              # partition-skips, the negative test set
    # preserve existing bind/unbound (step 2) and overrides untouched
    # include reference_root only if it overrides the global default
    # include conditions_from pointers
The spec lives in the repo (git-shareable, repo-specific). Do NOT add it to .gitignore.

// 7. Report
do("report: N admitted, M skipped, partition written to spec.yaml. Next rung is
    selection (step 2, unbuilt): bind a practice per admitted activity. The partition
    re-runs only on a repo-layout change (Invariant 7) — a dependency bump or a model
    release does not touch it.")
```

## Reference

### Spec file format

`.claude/tessera/spec.yaml` — written in layers by the ladder. Step 1 writes the top two fields; step 2 (unbuilt) will add `bind`/`unbound`. Material-condition _values_ are never stored, only `conditions_from` pointers, read fresh at compile time (Invariant 6).

```yaml
# .claude/tessera/spec.yaml — judgments only; surveys derive the candidates

# Step 1 — partition (this skill; re-derived on repo-layout change)
admit: # in-scope activity -> the scope it owns (the disjoint boundary, distinct-from-siblings)
  library/api-design: "the public controller/state API surface and its inference; not internal refactors"
  library/unit-tests: "behavioral vitest suites; no type-level tests exist — type safety is owned by tooling/typecheck"
skip: # out of scope — partition-skip, with a reason
  - backend/migrations: "no backend in this repo"

conditions_from: # pointers only; contents read at generation (step 3)
  - package.json
  - packages/*/tsconfig.json
# reference_root: <path>        # include only to override the global default

# Step 2 — selection (NOT YET BUILT; shown for shape)
# bind:                         # in-scope activity -> chosen practice => admitted, gets a tile
#   library/unit-tests: tdd
# unbound:                      # in scope, base handles it — selection-skip, with a reason
#   - library/api-design: "base handles typed API design"
```

### What counts as an activity

An activity is the **atomic unit of admission** and the unit a tile covers. Test a candidate against three rules:

- **It is work, not a thing.** "unit-tests", "release", "api-design" — a kind of task. Not "vitest", "package.json", "the core package".
- **It is disjoint from its siblings.** Two activities must never match the same prompt. If "testing" and "unit-tests" overlap, you cut the axis wrong — pick one level.
- **It is discipline-scoped by its category.** `frontend/forms`, `library/release`. The category is the discipline; the activity is the task within it.

Record the boundary as a one-line **scope note** on the `admit` entry, in the glossary's distinct-from-siblings discipline: state what the activity owns and, where a merge or split happened, what it excludes. The note is the disjointness contract made explicit. It is the part of the partition judgment the bare name loses, so it persists in the spec; the survey re-derives everything else each run (Decision 19). Keep it one line and free of practice or condition language (Invariant 7) — its job is to fix the cut, not to document the activity.

### Three admission states (don't conflate them)

- **Admitted** — in-scope (step 1 `admit`) and later bound to a practice (step 2 `bind`). Gets a tile.
- **Skipped** — no tile. A **partition-skip** (this step, out of scope, recorded with a reason) or a later **selection-skip** (`unbound`, base handles it). Both fire zero tiles; an explicit skip is a negative test case. Step 1 produces partition-skips only.
- **Deferred** — admitted but not yet coverable (a tool-backed practice whose tool is absent). A step-2/3 concern; step 1 does not produce these.

Step 1 owns the **partition-skip** alone. "This is real work but base behaviour handles it" is _not_ a partition-skip — that judgment needs the practice catalog, so it belongs to step 2 (`unbound`). Routing "base handles it" through step 1 would break conditions-blindness (Invariant 7). When unsure whether something is out-of-scope vs base-handled: if it is not real work here, skip it; otherwise admit it and let step 2 decide.
