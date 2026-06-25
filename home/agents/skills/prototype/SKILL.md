---
name: prototype
description: >
  Force four declarations (question, throwaway/retained, time-box, capture) before generating any
  prototype code. Select a method (spike, tracer bullet, walking skeleton, Wizard of Oz,
  prompt-as-prototype) from the declarations, run the workflow, produce a capture artifact
  (decision memo, ADR, eval set, or RFC). Triggers: /prototype, "prototype X", "spike", "throwaway",
  "PoC", "proof of concept", "is X feasible", "explore Y approach", "tracer bullet",
  "walking skeleton", "vibe-code this", "quick demo of"; Russian: «прототип», «спайк», «прощупать»,
  «по-быстрому накидать». Skip on feature work with a known design, bug fixes, refactors, or
  production code paths; prototypes resolve open questions, not closed ones. Also skip when testing an
  existing behavior against a falsifiable claim without building new code (use /experiment).
---

# Prototype

## Glossary

Fix term meanings before use. Each row holds one sense throughout this skill.

| Term                | Meaning                                                                                                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prototype           | A build whose purpose is to answer one design question, not to ship a feature.                                                                                                                           |
| Investigation       | Mode where code is evidence and the deliverable is knowledge.                                                                                                                                            |
| Throwaway           | Intent: code is investigation. Discarded after the question is answered. Default when undecided.                                                                                                         |
| Retained            | Intent: code is the first commit of production. Production-quality from line one.                                                                                                                        |
| Design question     | The single question the prototype answers. One sentence. One of: role, look-and-feel, implementation, integration.                                                                                       |
| Role                | Design dimension: how the system fits a user's life (Houde & Hill 1997).                                                                                                                                 |
| Look-and-feel       | Design dimension: what interaction feels like to use (Houde & Hill 1997).                                                                                                                                |
| Implementation      | Design dimension: does the technique work technically (Houde & Hill 1997).                                                                                                                               |
| Integration         | Design dimension: do the pieces talk to each other (Houde & Hill 1997).                                                                                                                                  |
| Time-box            | A duration with a hard stop. Expiry forces an explicit choice: extend with justification, decide, or abandon.                                                                                            |
| Capture artifact    | The document produced by the prototype: memo, ADR, eval set, or RFC. The prototype is not done until this is filed.                                                                                      |
| Spike               | Throwaway implementation prototype, minutes to days scale, isolated from production code (Beck 1999).                                                                                                    |
| Tracer bullet       | Retained end-to-end slice, lean but complete production code, not a facade (Hunt & Thomas 1999).                                                                                                         |
| Walking skeleton    | Retained thin end-to-end implementation that touches every architectural layer (Cockburn 2004).                                                                                                          |
| Wizard of Oz        | Throwaway role prototype: the agent produces the session plan; a human runs the sessions (Kelley 1984).                                                                                                  |
| Prompt-as-prototype | First-step LLM prototype: iterate the prompt against an eval set before RAG, tools, or fine-tuning.                                                                                                      |
| Decision memo       | Capture template for throwaway findings: Question / Method / Result / Decision / Next step.                                                                                                              |
| ADR                 | Capture template for retained architectural decisions: Context / Decision / Status / Consequences (Nygard 2011).                                                                                         |
| Eval set            | Capture for LLM behavioral prototypes: prompt plus JSONL cases with expected behavior.                                                                                                                   |
| RFC / RFD           | Capture for cross-team change requiring discussion before commit.                                                                                                                                        |
| Vibe coding         | Agent-driven, intuition-led coding without a stated design question (Karpathy 2025). A stance, not a workflow this skill operates. If the user is vibing, stop the skill and handle the work outside it. |

## Frame

A prototype is one of two things and never both at once. It is **investigation**: code is evidence, knowledge is the deliverable. Or it is **retained**: code is the first commit of production, the artifact is the deliverable. Confusion between the two causes most prototype failures, from Brooks's 1975 pilot systems to the 2025 Lovable and Replit incidents.

Every prototype answers one of four design questions (Houde & Hill 1997): **role** (how does the thing fit into a user's life), **look-and-feel** (what does interaction feel like), **implementation** (does the technique work), **integration** (do the pieces talk). Name the dimension before picking a method.

What to keep: build a thin slice and grow it. Brooks's 1995 retraction (_Mythical Man-Month_ 20th anniversary, ch. 19) replaced "plan to throw one away" with this rule. The "grow it" rule binds the retained methods (tracer bullet, walking skeleton); spikes are still discarded. A tracer bullet is lean but complete production code, not a facade (Hunt & Thomas 1999).

If the user cannot state a design question after `references/find-goal.md`, the work is vibing rather than prototyping. Stop the skill and handle the vibing outside it; this skill does not operate that stance.

## Parameters

- `question` (required): one sentence naming the design question.
- `intent=throwaway|retained` (required): code as evidence, or code as the first commit of production.
- `timebox` (required): `30m`, `2h`, `1d`, `3d`, etc. Hard stop.
- `capture=memo|adr|evalset|rfc` (required): the artifact this prototype produces.

```
// Elicit the four declarations — refuse to proceed if any is missing
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

// Pick the method from the matrix in Reference
method = lookup(question, intent) in the method matrix
do("state the chosen method and wait for user confirmation")

// Load and execute the chosen workflow
if method == "spike":              Read(references/spike.md)
if method == "tracer_bullet":      Read(references/tracer-bullet.md)
if method == "walking_skeleton":   Read(references/tracer-bullet.md)
if method == "wizard_of_oz":       Read(references/wizard-of-oz.md)
if method == "prompt_as_prototype": Read(references/prompt-as-prototype.md)

start = now()
do("execute the loaded workflow up to timebox")

// Surface time-box expiry — hard stop
if now() - start >= timebox:
    AskUserQuestion("Time-box expired. Extend with written justification, decide now, or abandon?")
    if extend: record the justification in the capture artifact and continue
    if decide: jump to capture
    if abandon: archive workspace, stop

// Capture
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

### Dispatch table

| Situation                                                    | Reference file                                                         |
| ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Throwaway implementation prototype                           | [references/spike.md](references/spike.md)                             |
| Retained tracer bullet or walking skeleton                   | [references/tracer-bullet.md](references/tracer-bullet.md)             |
| Throwaway role prototype                                     | [references/wizard-of-oz.md](references/wizard-of-oz.md)               |
| LLM-feature prompt iteration                                 | [references/prompt-as-prototype.md](references/prompt-as-prototype.md) |
| Draft the capture artifact (memo, ADR, eval, RFC)            | [references/capture-templates.md](references/capture-templates.md)     |
| Apply confidence / falsification / polish / reasoning checks | [references/capture-checks.md](references/capture-checks.md)           |
| User cannot state the design question                        | [references/find-goal.md](references/find-goal.md)                     |
| Expand the artifact's Next step into a task list             | [references/next-steps.md](references/next-steps.md)                   |

Load the matching reference file when the situation arises. Each file is self-contained; apply each only to its own case.

### The four declarations

**D1. Design question.** One sentence, one of four shapes:

- Implementation: "Does X work?"
- Look-and-feel: "What does Y feel like to use?"
- Role: "How should Z behave from the user's side?"
- Integration: "Do these pieces talk to each other?"

If the user cannot state the question, load `references/find-goal.md`.

**D2. Throwaway or retained.** Default when undecided: throwaway. Promotion-to-production failures dominate the empirical record (see Gotchas).

**D3. Time-box.** Minutes for a vibe variant, hours for a spike, days for a tracer bullet or walking skeleton. Hard stop at expiry. Silent overrun is the dominant failure mode (Cohn, practitioner reports).

**D4. Capture artifact.** Memo (throwaway findings), ADR (retained architectural decision), eval set (LLM behavioural prototype), RFC (cross-team change). Templates in `references/capture-templates.md`.

### Method selection matrix

| Question \ Intent | Throwaway                        | Retained                                              |
| ----------------- | -------------------------------- | ----------------------------------------------------- |
| Implementation    | Spike (Beck 1999)                | Tracer bullet (Hunt & Thomas 1999)                    |
| Look-and-feel     | Spike (throwaway UI slice)       | Out of scope: handle via team's design-system process |
| Role              | Wizard of Oz (Kelley 1984)       | rare; upgrade to MVP, out of scope                    |
| Integration       | Agent-driven spike across layers | Walking skeleton (Cockburn 2004)                      |

One orthogonal option:

- **Prompt-as-prototype**: default first step for any LLM-feature work. Iterate the prompt against an eval set before adding RAG, tools, or fine-tuning. Capture = `evalset`.

When two or more designs look plausible and switching cost after commit is high, generate the candidate designs first (in whatever way the host provides) and pick one before invoking this skill. The skill prototypes one design at a time.

### Standalone

This skill carries every workflow it needs in `references/`. It does not call any other skill. Confidence rating, stress-testing, prose polish, and reasoning checks live in `references/capture-checks.md` as one-line templates; the agent applies them inline at capture without delegating to a sibling skill. The skill works on a host where no other skills are installed. On hosts where `/grade`, `/distill`, or `/probe` are installed, the user may run them against the filed artifact afterwards.

### Pre-conditions

Refuse to run unless all three hold:

- A concrete design question, in one sentence.
- A workspace where throwaway code can be isolated (directory, branch, or scratch repo).
- A time-box stated as a duration with a hard stop.

### Stop conditions

Any one triggers the capture step:

- Question answered (yes / no / it depends, with supporting evidence).
- Time-box expired (surface and ask).
- User-initiated abort.
- Decision made (proceed / abandon / extend).

### Gotchas

**Throwaway promoted to production.** Replit/Lemkin incident, Fortune 23 July 2025: an AI coding agent deleted a production database during a stated code freeze, then fabricated 4,000 fake users and lied about the deletion. Lovable CVE-2025-48757, May 2025: researcher Matt Palmer audited 1,645 deployed Lovable apps and found roughly 10.3% leaking user data through missing or inverted Row-Level Security. Mitigation: physical separation of throwaway code (directory, branch, sometimes language) plus an explicit ship-or-discard step. Promotion never happens silently.

**Row-Level Security off by default.** Lovable CVE-2025-48757 again. If the prototype touches a database, authorization is non-optional, even for throwaway, even on shared infrastructure. Verify RLS or equivalent before any test data goes in.

**Package hallucination (slopsquatting).** Spracklen et al., "We Have a Package for You!", USENIX Security 2025: 576,000 samples across 16 LLMs, package-name hallucination rate roughly 19.6%, with 43% of hallucinations recurring across reruns. Lasso Security demonstrated the attack with `huggingface-cli` (30,000+ downloads after a researcher registered the empty placeholder name). Mitigation: verify every new dependency against the registry before installing; use lock files in spikes too.

**Perceived speed differs from measured speed.** METR study, arXiv 2507.09089, July 2025: 16 experienced open-source developers, 246 issues on their own mature repos. Developers predicted +24% speedup with AI; perceived +20% post-task; measured **−19%** (95% CI: 2% to 39% slower). Trust the time-box, not the felt sense of progress.

**Demo as proof.** A working demo is evidence the happy path runs once. It is not evidence the design is sound. Before acting on a demo, ask: what would falsify this? Then run that.

**Silent time-box overrun.** Spikes quietly expand past their bound. The skill surfaces expiry and forces a written choice (extend with justification, decide, or abandon). Default is hard stop.

**Willison's rule.** "I won't commit any code to my repository if I couldn't explain exactly what it does to somebody else." (Simon Willison, "Not all AI-assisted programming is vibe coding (but vibe coding rocks)", 19 March 2025.) Writing exploratory, uncommitted code within the spike workspace is allowed; committing it to a tracked branch is not.

### Excluded methods and rationale

- **Paper prototyping.** UX research method, not operable by a coding agent. Digital wireframes (Figma, Storybook) absorb the lo-fi function for software engineering.
- **Design sprints** (Knapp 2016). Team-process method requiring four to seven people across five days. Out of scope for a single engineer working with an agent.
- **Concierge / smoke-test / fake-door MVPs.** Business-validation methods, not engineering prototypes. Useful, but they answer market questions, not design questions.
- **Brooks's 1975 whole-system "throw one away".** Retracted by Brooks in 1995. The principle survives at the spike layer; the whole-system form is obsolete.

### Primary sources

- Brooks, F. _The Mythical Man-Month, Anniversary Edition_, Addison-Wesley 1995, ch. 19.
- Floyd, C. "A Systematic Look at Prototyping", 1984.
- Houde, S. & Hill, C. "What Do Prototypes Prototype?", Handbook of HCI, 1997. <https://hci.stanford.edu/courses/cs247/2012/readings/WhatDoPrototypesPrototype.pdf>
- Hunt, A. & Thomas, D. _The Pragmatic Programmer_, Addison-Wesley 1999, tracer bullets chapter.
- Cockburn, A. _Crystal Clear_, Addison-Wesley 2004 (walking skeleton).
- Kelley, J.F. "An iterative design methodology for user-friendly natural language office information applications", ACM TOIS 1984 (Wizard of Oz).
- Nygard, M. "Documenting Architecture Decisions", cognitect.com, 15 November 2011.
- Karpathy, A. X post, 2 February 2025 (vibe coding coinage).
- Willison, S. "Not all AI-assisted programming is vibe coding (but vibe coding rocks)", 19 March 2025. <https://simonwillison.net/2025/Mar/19/vibe-coding/>
- METR, "Measuring the Impact of Early-2025 AI on Experienced Open-Source Developer Productivity", arXiv 2507.09089, July 2025.
- Spracklen et al., "We Have a Package for You!", USENIX Security 2025 (slopsquatting).
- Lovable security disclosure, CVE-2025-48757, May 2025.
- Replit/Lemkin incident, Fortune coverage, 23 July 2025.
