---
name: research
description: >
  Answer a fact question from the world at self-calibrated depth. The skill picks how deep to go — from one lookup to parallel cross-checked verification — so the caller states the question, not the effort. Returns a cited findings block. Mechanizes the `fact → research` instrument of `30 notes/SDLC/Planning.md`. Triggers: `/research`, "research <X>", "look up", "find out", "what is the current/actual <fact>", "gather sources on", "is it true that <fact>". Route elsewhere: your own prior view → `/consult` (vault-facing, not the world); a choice someone must make → `/design` or grill (that is a decision, not a fact); stress-testing a plan → `/probe`; testing a falsifiable claim by running it → `/experiment`; learning feasibility by building → `/prototype`.
---

# Research

Answer a fact question — one the world settles — at the shallowest depth that closes it. Depth is the skill's call, not the caller's: state the question, get a calibrated answer with citations.

This skill **mechanizes the `fact → research` instrument** of `Planning.md` (Force 2). It adds one rule from `30 notes/Pragmatic first is reconnaissance for elegance`: **depth scales with amortization** — go deep only when many downstream nodes rest on the answer. Research gathers signal from the world; it never settles a choice you own (see §Type boundary).

## Dispatch

```
dir = skill base directory

question = <question> from arguments or conversation context
if no question: AskUserQuestion("What fact should I resolve?")

Read(dir/references/run.md)
do("follow run procedure — triage the depth, run the rung, escalate only if it fails to close")
```

## Model

The contract. Depth is **emergent from residual uncertainty**, not declared upfront — take the lowest rung that closes the fact, climb only when a stop-condition fails. Same engine as the `Planning.md` escalation ladder.

### The depth ladder

| Depth | What runs | For |
| --- | --- | --- |
| D0 | one lookup — a scrape of a known URL, one Explore read, or context | a fact with one obvious source |
| D1 | one focused fork — Explore (code) or general-purpose + Firecrawl (world) | the default fact |
| D2 | parallel breadth — several agents, distinct sub-questions, merged | a multi-part or landscape question |
| D3 | parallel breadth + adversarial cross-check | a load-bearing, contested, or high-stakes fact |

### Triage — set the start rung and the ceiling

Read three axes off the question before spending anything:

- **Locus** — code or world. Picks the instrument: Explore for a codebase fact; a general-purpose subagent using Firecrawl for a world fact. (`WebSearch`/`WebFetch` are blocked here — web goes through Firecrawl.)
- **Breadth** — single fact → start D1; multi-part or landscape → start D2.
- **Stakes** — how much rests on the answer. Low → ceiling D1; crux-feeding or expensive-to-undo → ceiling D3.

### Escalate — climb only on a failed stop-condition

Run the rung, then test the findings. Climb one rung, up to the ceiling, if any holds:

- sources **conflict** → +1 (cross-check),
- coverage has **gaps** — a sub-question is unanswered → +1 (breadth),
- confidence is **below the bar the stakes demand** → +1.

Stop when the findings are consistent, complete, and confident enough for the stakes — or the ceiling is reached. Then synthesize.

### Two guards

- **Amortization cap** — depth never exceeds the stakes. A throwaway fact never reaches D3, even if sources mildly disagree. D3 on a D1 fact is the ceremony `Planning.md` forbids.
- **Type boundary** — if the "fact" turns out to hinge on a preference or a judgment call, stop and hand it back as a **decision**. Do not let deep research launder a choice the user should make. Research answers _what is_, never _what to pick_.

### Output — one contract at every depth

Return a **cited findings block**:

- the answer, stated as claims;
- each claim carries **source · date · confidence**;
- conflicts flagged, gaps named;
- one audit line: **"depth D_n, because &lt;trigger&gt;"** — so the depth choice is visible and the caller can override.

A caller may pass a floor or ceiling ("quick lookup" caps D1; "verify thoroughly" floors D2). Absent that, the skill decides.

## Reference

| File | Purpose |
| --- | --- |
| `references/run.md` | Triage the depth, run each rung (D0–D3), apply the stop-conditions, synthesize the findings block. |
