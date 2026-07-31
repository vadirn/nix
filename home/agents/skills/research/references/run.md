# Run — resolve a fact at calibrated depth

Take the lowest depth that closes the question; climb only when a stop-condition fails.

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
        spawn_subagent(general-purpose, "CROSS-CHECK: given these claims and their sources, mark each claim
            agreed (>=2 independent sources) | single-source | contradicted. Reconcile conflicts; flag what only one agent found.")
    return findings
```

## Reference

### Triage axes

- **Locus** decides the instrument, not the depth. Code facts (does this API exist, what does this function return) go to Explore — read-only, context-efficient. World facts (fees, limits, market data, current events) go to a general-purpose subagent driving Firecrawl. `WebSearch`/`WebFetch` are blocked in this environment; web is always Firecrawl.
- **Breadth** is about coverage, not stakes. A single fact needs one pass (D1). A multi-part or landscape question ("compare the payment providers") needs parallel angles (D2), because one pass silently drops sub-questions.
- **Stakes** set the ceiling, from the amortization rule: how many downstream nodes rest on this answer, and how expensive is being wrong. A one-off fact caps at D1; a fact feeding a crux earns D3. The caller passes this when known (map: "this fact feeds the crux"); otherwise infer it from the question.

### Stop-conditions

A rung closes the fact when its findings are, together:

- **consistent** — no unreconciled conflict between sources,
- **complete** — every sub-question the caller asked is answered,
- **confident enough for the stakes** — the confidence bar rises with the stakes; a crux-feeding fact needs firmer ground than a throwaway.

Any one failing is the climb trigger, and it names the next rung: a conflict wants cross-check (toward D3), a gap wants breadth (toward D2), thin confidence wants more sources.

### The amortization cap

Depth never exceeds the stakes. This is the guard against ceremony. A mildly contested fact that nothing important rests on stops at D1 with the conflict **flagged**, not escalated — the flag is the honest output, and D3 would burn a parallel sweep to sharpen a number no decision needs. Conversely, a crux-feeding fact earns D3 even when the first pass looked clean, because a single clean pass is exactly how a wrong load-bearing fact hides.

### Type boundary

The instrument answers _what is_, never _what to pick_. A question that looked factual often hides a preference: "what MRR is realistic?" is fact (research it); "what MRR should I target?" is a decision (yours). When a rung's findings reveal the real fork is a value judgment, stop and return it as a decision — do not let a deeper rung settle it under a factual disguise. This keeps the `Planning.md` type line intact.

### The D3 cross-check

D3 is D2 plus one adversarial pass. The breadth agents gather independently; the cross-check agent then scores each claim by source agreement — agreed (two or more independent sources), single-source (flag as uncertain), or contradicted (reconcile or report both). This is the `/deep` pattern: consensus across independent agents beats any single pass, because errors one agent makes another rarely repeats. For a very large sweep (dozens of sources), the user may opt into the Workflow tool instead; the default D3 is subagent-orchestrated and needs no opt-in.

### Output — the findings block

```
**Answer.** <one-line resolution, or "unresolved — see gaps">

- <claim> — <source URL / file:symbol> · <date> · confidence: high|medium|low
- <claim> — ...

Conflicts: <claims where sources disagree, both sides shown> — or "none"
Gaps: <sub-questions left unanswered> — or "none"

_depth D_n, because <trigger>_
```

The block is the whole return. A fact node pastes it into `## Resolution`; a standalone caller reads it. Either way, `/research` decides nothing on the caller's behalf — it hands back evidence, and the audit line shows how hard it looked.

### AFK and parallelism

Research is fire-and-forget. A caller (the map at chart time) may fire several `/research` calls at once, one per fact node; each returns its own block independently. Within a single call, D2/D3 fan their sub-questions out in parallel and join on the merge.
