---
name: consult
description: >
  Use this skill to recover the user's own prior thinking (opinions, positions, definitions, past
  decisions, reasoning) from their personal vault before answering, via `vault-query consult`. Trigger
  whenever the user asks for their own judgment: "what's my take on X", "how do I usually frame or define
  Y", "what have I already reasoned or decided about Z", their stance on a design fork, or planning work
  they've deliberated before. This holds even when the surface topic is code or engineering; the signal is
  the request for the user's view, not the subject matter. The tool abstains silently when nothing fits, so
  consulting is cheap. Skip purely mechanical execution where no opinion is sought: running commands,
  editing, refactoring, or debugging code, file operations, and routine boilerplate setup (even when phrased
  "how do I usually"), plus conversational and meta turns. Manually invocable as /consult <task>.
---

# Consult

Pull relevant slices of the user's vault to inform the current task, then answer with that context.
The tool owns retrieval and selection; you own phrasing. It never synthesizes — the corpus is on this
filesystem, so a weaker in-tool model pre-chewing it would only degrade what you do better. The returned
material is the user's own prior thinking: treat it as recovered memory, not an external source to hedge
about.

## Procedure

```
task = do("describe, in your own words, what the user is trying to do — and expand it with the concrete
           terms and concepts you expect their notes to use. You own query phrasing (the tool does no
           expansion), so a richer task string retrieves better.")

result = Bash(vault-query consult "<task>" --format markdown)   // typed exit codes: 0 / 4 / 1

if exit == 0:
    do("weave the returned vault context into your answer; name the source titles/paths so the user can
        trace what informed you. Prefer the user's own framing where it bears on the task.")

elif exit == 4:                       // abstain — nothing cleared the relevance gate
    do("the abstain payload lists near-miss titles/terms; reformulate ONCE aiming at the corpus's real
        vocabulary (broader or differently-worded terms), then call consult again")
    if still exit == 4:
        do("proceed un-enriched and say nothing about it — an abstention is identical to the knowledge
            not existing, and a silent miss is the designed-for outcome, not a failure")

else:                                 // exit 1 or other — vault or index error
    do("proceed un-enriched; a vault hiccup must never block the task. Do not surface the error unless
        the user explicitly asked to consult the vault.")
```

## Scope and flags

- Default corpus is the knowledge types (cards, notes, references, experiments). Reach time-bound project
  memory deliberately with `--types track,checkpoint` when the task is specifically about prior project
  decisions rather than reusable knowledge.
- `--format markdown` (the default) returns a paste-ready block. Use `--format json` only when you need
  the structured envelope (path, title, type, score, body, tokens, links) for programmatic handling.
- Do not pass `--ambient`: that tightens the gate for the unattended hook path and trades recall for
  fewer false positives. As a deliberate caller you want the higher-recall default gate.

## When to reach for this

Bias toward consulting when the user's own past decisions, definitions, or framing would change your
answer — that is the whole reason this exists as an agent-judged call rather than an automatic one. A
prior always-on hook fired on every prompt and injected unrelated notes into mechanical and conversational
turns; moving the judgment here is the fix. So apply judgment: a question about a concept, a "what do I
think about", a design fork, or planning work the user has touched before is worth a consult; renaming a
variable or running a test is not.
