---
name: opinion
description: >
  Route the current context to one expert persona and return that lens's candid second opinion.
  Auto-classifies to the best-fit persona, or name one explicitly. Runs the persona as a spawned
  subagent so its reasoning stays out of the main context. Roster spans engineering, product,
  go-to-market, and craft. Out of scope: generating new designs (use /design), arguing both sides
  (use /debate), stress-testing one plan (use /probe), scoring confidence in a claim (use /grade).
  Invoke explicitly with /opinion.
disable-model-invocation: true
---

# opinion

Get one expert's take on what's on the table. `/opinion` reads the current context — the artifact,
diff, plan, or question under discussion — picks the persona whose lens fits best, and spawns that
persona as a subagent to return a candid second opinion in its own voice. One voice, not a committee:
the value is a sharp read from a specific vantage, not consensus mush.

The persona runs as a **spawned subagent**. The main session distills what to opine on and hands it
off; the persona reasons in isolation and returns its verdict. The main context stays clean and the
opinion stays uncolored by the surrounding chat.

## Roster

| persona                | lens                                                           | routes on                                                                        |
| ---------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `staff-engineer`       | architecture, tradeoffs, maintainability, technical risk       | system design, refactors, "how should I build", scaling, build-vs-buy, tech debt |
| `security-engineer`    | threat model, attack surface, data & secrets, trust boundaries | auth, tokens, input handling, permissions, PII, untrusted data, deploys          |
| `performance-engineer` | latency, bundle size, rendering, memory, measurement           | "slow", janky, large, "optimize", render path, perf budgets                      |
| `product-manager`      | user value, scope, prioritization, why-now                     | features, roadmap, MVP, cut-or-keep, "is this worth building"                    |
| `product-designer`     | usability, interaction, hierarchy, accessibility               | UI, flows, forms, on-screen copy, "is this usable", a11y                         |
| `marketer`             | positioning, messaging, audience, distribution                 | landing copy, naming, launch, "how do I pitch this", growth                      |
| `founder`              | viability, ROI, opportunity cost, business risk                | "should I do this at all", pricing, market, time-vs-payoff                       |
| `editor`               | clarity, concision, structure, AI tells                        | prose, READMEs, posts, "does this read well", tighten                            |
| `technical-writer`     | documentation, onboarding, completeness for outsiders          | docs, API reference, guides, "is this documented", reader DX                     |

`staff-engineer` is the default when context is technical but no single lens dominates.

## Dispatch

```
dir = skill base directory
arg = <text after /opinion>

// list mode
if arg in {"list", "ls"}:
    do("print the Roster table"); stop
if arg == "" and nothing is clearly on the table in the conversation:
    do("print the Roster table; say: run /opinion <persona>, or /opinion with an artifact on screen")
    stop

// 1. find what to opine on
target = do("""identify the artifact under discussion: the file / diff / plan / question the user
  most recently put on the table. If nothing is clearly on the table, ask one question —
  'what should I get an opinion on?' — and stop until answered.""")

// 2. pick the persona
if arg names a persona (exact slug or unambiguous prefix):
    persona = that slug                      // explicit override — skip the classifier
else:
    persona = do("""classify `target` against the Roster 'routes on' cues; pick the single best
      fit. Tie, or technical-but-unclear → staff-engineer. Announce in one line:
      'Routing to <persona> — <the one cue that decided it>.'""")

// 3. run the persona as a subagent
spec  = Read(dir/personas/<persona>.md)
brief = do("""assemble the subagent brief:
  - the persona file contents (lens, heuristics, output contract) as its role
  - `target`: the distilled artifact/question PLUS the file paths it lives in, so the subagent
    can Read them directly for specifics
  - any particular angle the user asked for""")
opinion = Agent(subagent_type: general-purpose, prompt: brief)

// 4. return
do("relay the persona's opinion in its own voice; do not re-summarize, average, or soften it")
do("close with one line: 'Want another lens? /opinion <persona>.'")
```

## Reference

### Output contract (every persona)

1. **Verdict** — one line.
2. **What matters most here** — 2-4 highest-leverage observations, each tied to something concrete in the target.
3. **Recommendations** — what to change, ordered by leverage.
4. **Confidence** — 1-10 with one-line reasoning (matches the global confidence convention).

Each `personas/<slug>.md` restates this contract, because the subagent sees only its persona file plus the target — never this SKILL.md.

### Routing notes

- The one-line route announcement is load-bearing: it makes a mis-route visible. If it's wrong, re-run `/opinion <persona>` to force the right lens.
- Explicit `/opinion <persona>` always beats the classifier.
- One persona per run, by design. For contrasting lenses, run it twice — or reach for a neighbor skill below.

### Adding a persona

Drop a `personas/<slug>.md` with frontmatter `name`, `lens`, `signals`, then add a Roster row. The body is the subagent's role: what it optimizes for, the questions it always asks, what it flags, its declared blind spots, and the output contract above.

### Boundary with neighbors

- `/opinion` — one expert lens reacts to what already exists.
- `/design` — generates multiple new solutions before you commit.
- `/debate` — argues both sides of a single open question.
- `/probe` — stress-tests one chosen plan for holes.
- `/grade` — scores confidence in a claim or decision (1-10).
