---
name: prototype
description: >
  Force four declarations (question, throwaway/retained, time-box, capture) before generating any prototype code. Select a method (spike, tracer bullet, walking skeleton, Wizard of Oz, prompt-as-prototype) from the declarations, run the workflow, produce a capture artifact (decision memo, ADR, eval set, or RFC). Triggers: /prototype, "prototype X", "spike", "throwaway", "PoC", "proof of concept", "is X feasible", "explore Y approach", "tracer bullet", "walking skeleton", "vibe-code this", "quick demo of"; Russian: «прототип», «спайк», «прощупать», «по-быстрому накидать». Skip on feature work with a known design, bug fixes, refactors, or production code paths; prototypes resolve open questions, not closed ones. Also skip when testing an existing behavior against a falsifiable claim without building new code (use /experiment).
---

# Prototype

Thin wrapper: the doctrine lives in the vault note `Prototype`. Load it at invocation — never run from memory of it.

## Parameters

- `question` (required): one sentence naming the design question.
- `intent=throwaway|retained` (required): code as evidence, or code as the first commit of production.
- `timebox` (required): `30m`, `2h`, `1d`, `3d`, etc. Hard stop.
- `capture=memo|adr|evalset|rfc` (required): the artifact this prototype produces.

```
// Load doctrine
note_path = Bash(vault-query get "Prototype")
if note_path missing or ambiguous: do("report the error to the user"); stop

// (parallel)
frame           = Bash(vault-query read <note_path> 0)
glossary        = Bash(vault-query read <note_path> "Glossary")
declarations    = Bash(vault-query read <note_path> "The four declarations")
matrix          = Bash(vault-query read <note_path> "Method selection matrix")
preconditions   = Bash(vault-query read <note_path> "Pre-conditions")
stop_conditions = Bash(vault-query read <note_path> "Stop conditions")
gotchas         = Bash(vault-query read <note_path> "Gotchas")
if any read errors: do("report the exact error and note_path to the user"); stop

do("hold frame + glossary as term bindings; refuse to run unless all of preconditions hold")

// Elicit the four declarations — refuse to proceed if any is missing; rationale in declarations
question = <args>.question or AskUserQuestion("What is the one-sentence design question?")
if question describes a closed problem (bug, refactor, known feature): stop, redirect to ordinary work
if question cannot be named:
    Read(references/find-goal.md)
    do("apply the find-goal workflow to extract a one-sentence design question")
    if still no question: stop, recommend writing a problem statement first

intent = <args>.intent or AskUserQuestion("Throwaway or retained?")
if user is undecided: intent = "throwaway"

timebox = <args>.timebox or AskUserQuestion("Time-box duration (e.g. 30m, 2h, 1d)?")
capture = <args>.capture or (intent == "throwaway" ? "memo" : "adr")
if intent == "throwaway" and capture == "adr": stop, ask user to resolve the intent/capture conflict
if intent == "retained"  and capture == "memo": stop, ask user to resolve the intent/capture conflict

// Pick the method from the loaded matrix
method = lookup(question, intent) in matrix
do("state the chosen method and wait for user confirmation")

// Load and execute the chosen workflow
if method == "spike":              Read(references/spike.md)
if method == "tracer_bullet":      Read(references/tracer-bullet.md)
if method == "walking_skeleton":   Read(references/tracer-bullet.md)
if method == "wizard_of_oz":       Read(references/wizard-of-oz.md)
if method == "prompt_as_prototype": Read(references/prompt-as-prototype.md)

start = now()
do("execute the loaded workflow up to timebox, gotchas' mitigations binding; any of stop_conditions triggers capture")

// Surface time-box expiry — hard stop
if now() - start >= timebox:
    AskUserQuestion("Time-box expired. Extend with written justification, decide now, or abandon?")
    if extend: record the justification in the capture artifact and continue
    if decide: jump to capture
    if abandon: archive workspace, stop

// Capture — glossary fixes the terms the artifact uses
Read(references/capture-templates.md)
artifact = do("draft <capture> using the matching template")
Read(references/capture-checks.md)
do("apply each check in references/capture-checks.md to the artifact; record the filled-in templates inline")

date = Bash(date +%Y-%m-%d)
if capture == "memo":
    Bash(mkdir -p docs/spikes)
    Write(docs/spikes/<date>-<slug>.md)
if capture == "adr":
    Bash(mkdir -p docs/adr)
    Write(docs/adr/<NNNN>-<slug>.md)
if capture == "evalset":
    Write(evals/<slug>/cases.jsonl)
    Write(evals/<slug>/prompt.md)
if capture == "rfc":     Write(docs/rfc/<NNNN>-<slug>.md)

// Followup
if artifact names next steps:
    Read(references/next-steps.md)
    do("expand the single-line Next step into a ranked task list with owners and acceptance tests")
if intent == "throwaway":
    do("ask the user: archive the spike workspace, or delete it")
```

## Reference

### Doctrine loading

- `vault-query get "Prototype"` resolves the note; the exact basename match `Prototype.md` is the intended target.
- Structured reads (`vault-query read` with addresses) load only the intro frame (address `0`), the glossary, the four-declaration rationale, the method selection matrix, the pre/stop conditions, and the gotchas, keeping the note's frontmatter and the remaining sections (excluded methods, primary sources) out of context.
- Fail loud, never improvise: on any resolution or address error the doctrine has moved or its headings were renamed — a gate reconstructed from memory looks like success while silently degrading the contract. The section headings `Glossary` / `The four declarations` / `Method selection matrix` / `Pre-conditions` / `Stop conditions` / `Gotchas` are part of this wrapper's contract with the note.

### Dispatch table

| Situation | Reference file |
| --- | --- |
| Throwaway implementation prototype | [references/spike.md](references/spike.md) |
| Retained tracer bullet or walking skeleton | [references/tracer-bullet.md](references/tracer-bullet.md) |
| Throwaway role prototype | [references/wizard-of-oz.md](references/wizard-of-oz.md) |
| LLM-feature prompt iteration | [references/prompt-as-prototype.md](references/prompt-as-prototype.md) |
| Draft the capture artifact (memo, ADR, eval, RFC) | [references/capture-templates.md](references/capture-templates.md) |
| Apply confidence / falsification / polish / reasoning checks | [references/capture-checks.md](references/capture-checks.md) |
| User cannot state the design question | [references/find-goal.md](references/find-goal.md) |
| Expand the artifact's Next step into a task list | [references/next-steps.md](references/next-steps.md) |

Load the matching reference file when the situation arises. Each file is self-contained; apply each only to its own case.

### Standalone

This skill carries every workflow it needs in `references/`; the doctrine it executes lives in the vault note `Prototype`. It does not call any other skill. Confidence rating, stress-testing, prose polish, and reasoning checks live in `references/capture-checks.md` as one-line templates; the agent applies them inline at capture without delegating to a sibling skill. The skill works on a host where no other skills are installed. On hosts where `/grade`, `/distill`, or `/probe` are installed, the user may run them against the filed artifact afterwards.
