---
name: consult
description: >
  Use this skill to recover the user's own prior thinking (opinions, positions, definitions, past
  decisions, reasoning) from their personal vault before answering, via `vault-query consult`. Trigger
  whenever the user asks for their own judgment: "what's my take on X", "how do I usually frame or define
  Y", "what have I already reasoned or decided about Z", their stance on a design fork, or planning work
  they've deliberated before. This holds even when the surface topic is code or engineering; the signal is
  the request for the user's view, not the subject matter. The tool abstains silently when nothing fits, so
  consulting is cheap. Limit triggering to tasks where the user's opinion is sought; mechanical execution
  (running commands, editing, refactoring, debugging code, file operations, routine boilerplate setup, even
  when phrased "how do I usually") and conversational/meta turns fall outside scope. Manually invocable as /consult <task>.
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

result = Bash(vault-query consult "<task>" --types card,note,experiment --format markdown)
                                            // exit codes: 0=results, 4=abstain, 1=runtime error, 2=CLI usage error (clap)

if exit == 0:                         // success — inline docs, pointers, or both
    if result has inline docs:
        do("weave the returned vault context into your answer; name the source titles/paths so the user
            can trace what informed you. Prefer the user's own framing where it bears on the task.")
    if result has pointers:           // markdown: a 'Too large to inline — read directly:' block;
                                      // json: a non-empty `pointers` array
        do("pointers are relevant docs the tool found but could not inline (over the per-doc cap or
            budget). Read them lazily — only when the inline material is insufficient to answer. Pick
            the most promising pointer by score, coverage, and title; outline it with
            rg --no-ignore '^#' \"<vault_root>/<path>\"; Read the section you need with offset/limit,
            widening the window if the slice proves too narrow. Treat what you read as the user's own
            prior thinking, exactly like inline docs.")

elif exit == 4:                       // abstain — nothing cleared the relevance gate
    do("the abstain payload lists near-miss titles/terms; reformulate ONCE aiming at the corpus's real
        vocabulary (broader or differently-worded terms), then call consult again")
    if still exit == 4:
        do("proceed un-enriched and say nothing about it — an abstention is identical to the knowledge
            not existing, and a silent miss is the designed-for outcome, not a failure")

else:                                 // exit 1 (runtime) or 2 (bad CLI invocation) — vault or index error
    do("proceed un-enriched; the task proceeds regardless of vault errors. Surface the error only when
        the user explicitly asked to consult the vault.")
```

## Scope and flags

- This skill always passes `--types card,note,experiment` (the CLI default searches all types). References are bookmarks to
  external content (URL + a one-line description), not the user's prior thinking, so they are excluded
  from the default. Opt in with `--types card,note,experiment,reference` when the task is about finding
  what the user has *read* on a topic rather than what they *think*. Reach time-bound project memory
  deliberately with `--types track` when the task is specifically about prior project decisions rather
  than reusable knowledge; checkpoints are superseded entries, so reaching one also needs
  `--include-superseded` (e.g. `--types track,checkpoint --include-superseded`).
- `--format markdown` (the default) returns a paste-ready block. Use `--format json` only when you need
  the structured envelope (path, title, type, score, body, tokens, links) for programmatic handling.
- Pass `--ambient` only on the unattended hook path; as a deliberate caller, use the higher-recall default gate (omit the flag).

## When to reach for this

Bias toward consulting when the user's own past decisions, definitions, or framing would change your
answer — that is the whole reason this exists as an agent-judged call rather than an automatic one. A
prior always-on hook fired on every prompt and injected unrelated notes into mechanical and conversational
turns; moving the judgment here is the fix. So apply judgment: a question about a concept, a "what do I
think about", a design fork, or planning work the user has touched before is worth a consult; renaming a
variable or running a test is not.
