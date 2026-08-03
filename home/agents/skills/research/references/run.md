# Run — resolve a fact at calibrated depth

Take the lowest depth that closes the question. Climb only when a stop-condition fails.

## Pseudocode

```
// 1. Fix the question — one sharp, answerable fact
question = do("state the fact question in one line: answerable by evidence, not by preference")
if the question hinges on a choice or a value judgment:
    do("TYPE BOUNDARY: this is a decision, not a fact. Hand it back — route to /design or a grill. Halt.")

// 2. Triage — set the start rung and the ceiling (see §Triage axes)
locus  = do("code | world")                       // picks the instrument
start  = do("single fact → D1; multi-part/landscape → D2")
ceiling = do("low stakes → D1; crux-feeding or expensive-to-undo → D3")
apply caller floor/ceiling if given               // 'quick lookup' caps D1; 'verify thoroughly' floors D2
depth = start

// 3. Run the rung, then decide whether to climb
loop:
    findings = run_depth(depth, locus, question)
    if findings consistent AND complete AND confident-enough-for-stakes: break
    if depth == ceiling: break                     // amortization cap — never exceed the stakes
    depth = depth + 1                              // climb on: conflict (+cross-check) | gap (+breadth) | low confidence

// 4. Synthesize — one contract at every depth (see §Output)
do("assemble the cited findings block: claims, each with source·date·confidence;
    flag conflicts; name gaps; add the audit line 'depth D_n, because <trigger>'")

// 5. Return
do("fact node → write the block into the node's ## Resolution.
    standalone → present the block. Do not decide anything on the caller's behalf.")
```

```
run_depth(depth, locus, question):
    if depth == D0:
        do("one lookup: Bash(firecrawl_scrape <known URL>) for world, or an Explore read for code, or answer from context")
    if depth == D1:
        if locus == code:  spawn_subagent(Explore, "find and read the sources that answer: <question>. Return cited findings.")
        if locus == world: spawn_subagent(general-purpose, "use firecrawl_search then firecrawl_scrape to answer: <question>. Return claims with source URLs and dates.")
    if depth == D2:
        parts = do("split the question into distinct sub-questions / angles")
        (parallel) for each part in parts:
            spawn_subagent(<locus instrument>, "answer sub-question: <part>. Return cited findings.")
        do("merge the returns; dedupe claims; carry every source")
    if depth == D3:
        do("run the D2 breadth sweep")
        (parallel):
            spawn_subagent(general-purpose, "CROSS-CHECK: given these claims and their sources, mark each claim
                agreed (>=2 independent sources) | single-source | contradicted. Reconcile conflicts; flag what only one agent found.")
            spawn_subagent(general-purpose, "GROUND: for each load-bearing claim — the ones the answer rests on — run a
                FRESH firecrawl_search on sources the breadth agents never saw. Mark each
                grounded (a fresh source confirms) | agent-only (no fresh source) | contradicted (a fresh source disagrees — cite it).")
        do("merge both passes; flag any agent-only or contradicted claim and lower its confidence")
    return findings
```

## Reference

### Triage axes

- **Locus** decides the instrument, not the depth. Code facts go to Explore — read-only and context-efficient. (Does this API exist? What does this function return?) World facts go to a general-purpose subagent driving Firecrawl — fees, limits, market data, current events. `WebSearch`/`WebFetch` are blocked here. Web is always Firecrawl.
- **Breadth** is about coverage, not stakes. A single fact needs one pass (D1). A multi-part or landscape question ("compare the payment providers") needs parallel angles (D2), because one pass silently drops sub-questions.
- **Stakes** set the ceiling, by the amortization rule. Two things set the stakes: how many downstream nodes rest on the answer, and how costly a wrong answer is. A one-off fact caps at D1. A fact feeding a crux earns D3. The caller passes the stakes when known ("this fact feeds the crux"). Otherwise infer them from the question.

### Stop-conditions

A rung closes the fact when its findings are, together:

- **consistent** — no unreconciled conflict between sources,
- **complete** — every sub-question the caller asked is answered,
- **confident enough for the stakes** — the confidence bar rises with the stakes; a crux-feeding fact needs firmer ground than a throwaway.

Any one failing is the climb trigger. It names the next rung. A conflict wants cross-check (toward D3). A gap wants breadth (toward D2). Thin confidence wants more sources.

### The amortization cap

Depth never exceeds the stakes. This is the guard against ceremony. Take a mildly contested fact that nothing important rests on. It stops at D1 with the conflict **flagged**, not escalated. The flag is the honest output. D3 would burn a parallel sweep to sharpen a number no decision needs. A crux-feeding fact is the opposite. A wrong load-bearing fact hides behind a clean first pass. So it earns D3 even when the first pass looks clean.

### Type boundary

The instrument answers _what is_, never _what to pick_. A question that looks factual often hides a preference. "What MRR is realistic?" is a fact — research it. "What MRR should I target?" is a decision — yours. A rung's findings may reveal the real fork is a value judgment. Then stop and return it as a decision. The decision stays yours, however deep the research could go. This keeps the `Planning.md` type line intact.

### The D3 cross-check and grounding

D3 is D2 plus two adversarial passes that run in parallel over the gathered claims.

**Cross-check** scores each claim by how its sources agree:

- **agreed** — two or more independent sources;
- **single-source** — flag as uncertain;
- **contradicted** — reconcile the sources, or report both.

This is the `/deep` pattern. Consensus across independent agents beats any single pass, because errors one agent makes another rarely repeats.

**Grounding** re-verifies each load-bearing claim against _fresh_ sources the breadth agents never saw. A load-bearing claim is one the answer rests on. Consensus has one hole: independent agents can share a blind spot and agree on a wrong claim. A fresh search is deterministic feedback against that hole. So grounding catches what more agents cannot.

Each load-bearing claim comes back marked:

- **grounded** — a fresh source confirms it;
- **agent-only** — no fresh source found; treat it as uncertain;
- **contradicted** — a fresh source disagrees; report both sides, lower the confidence.

Grounding checks only the load-bearing claims. To re-search every minor claim is the ceremony the amortization cap forbids.

For a very large sweep (dozens of sources), the user may opt into the Workflow tool instead; the default D3 is subagent-orchestrated and needs no opt-in.

### Output — the findings block

```
**Answer.** <one-line resolution, or "unresolved — see gaps">

- <claim> — <source URL / file:symbol> · <date> · confidence: high|medium|low · <grounding>
- <claim> — ...

Conflicts: <claims where sources disagree, both sides shown> — or "none"
Gaps: <sub-questions left unanswered> — or "none"

_depth D_n, because <trigger>_
```

`<grounding>` appears only on load-bearing claims when D3 ran: `grounded`, `agent-only`, or `contradicted`. Omit it on every other claim and at every lower depth. The block is the whole return. A fact node pastes it into `## Resolution`. A standalone caller reads it. Either way, `/research` decides nothing for the caller. It hands back evidence. The audit line shows how hard it looked.

### AFK and parallelism

Research is fire-and-forget. A caller may fire several `/research` calls at once, one per fact node — the map does this at chart time. Each call returns its own block independently. Within a single call, D2 and D3 fan their sub-questions out in parallel, then join on the merge.
