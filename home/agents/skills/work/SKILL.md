---
name: work
description: >
  Orchestrate a multi-step task by delegating to fresh subagents, keeping the orchestrator session small.
  Triggers: /work <task>, "orchestrate this", "delegate this work". Skip one-shot questions, single-file
  edits, and the ambient "let's work on X" / "start working on X" phrasing.
---

# Work

Turn this session into an orchestrator. Hold the plan; delegate the work.

## Parameters

- `<task>` — the unit of work. One sentence describing the outcome.

```
// Enter or extend orchestration
if do("orchestration is already in progress from a prior /work in this session"):
    do("merge <task> into the existing plan as additional steps; tag each new step 'read' or 'write'")
else:
    plan = do("draft a numbered step list from <task>; tag each step 'read' (no file edits) or 'write' (creates or edits files); hold in session context only")
    auto_commits_enabled = do("establish git posture via a setup subagent; see Reference: Git posture and auto-commits")
    do("present plan to user")

// Orchestration loop
while plan has unresolved steps:
    batch = do("pick the next unresolved step; if it is tagged 'read', also pick any immediately following 'read' steps that don't depend on it (a parallel batch); 'write' steps form a batch of one")

    in_context_steps = do("for each step in batch: is the answer already in context (earlier subagent this session, or user this turn)?")
    do("answer in_context steps directly; mark them done; remove from batch")
    if batch is empty: continue

    briefs = do("write one three-section brief per remaining step: ## Task, ## Context (cite any $TMPDIR paths), ## Return (restate the four-section response contract; route any multi-step needs from the subagent into Backlog instead of /work)")
    responses = spawn_subagents(briefs)  // parallel when batch > 1; subagent_type per step's tag — see Reference: Mapping spawn_subagent to a real tool

    for each (step, response) in zip(batch, responses):
        if response is error or empty:
            choice = AskUserQuestion("subagent failed for this step; retry, modify brief, rerun as general-purpose (for tool-restriction errors), or skip?")
            do("act on choice; require user input before any retry")
            continue

        do("ingest response semantically: append Decisions to plan; collect Backlog items as end-of-orchestration questions (promote to a plan step only when the orchestrator explicitly chooses); surface Recap to user")

        if auto_commits_enabled and step is tagged 'write' and do("response reports any modified files"):
            commit_brief = do("write a one-line ## Task ('Run /commit on the just-completed step's changes'); ## Context inlines the step's Recap and Modified files; ## Return restates the four-section response contract")
            commit_response = spawn_subagent(commit_brief)  // sequential, subagent_type commit-runner
            if commit_response is error:
                choice = AskUserQuestion("commit subagent failed; retry, skip this step's commit, or stop orchestration?")
                do("act on choice; skipping leaves the working tree dirty going into the next step")

        do("mark step done")

    if do("user just signaled stop in natural language"): break

// End of orchestration
do("emit final recap")
do("list modified files and commits across the orchestration")
do("list unresolved backlog items as open questions")
```

## Reference

### Brief shape

Three fixed sections: `## Task` / `## Context` / `## Return`. The Return section restates the four-section response shape and routes any multi-step needs from the subagent into Backlog instead of /work.

Phrase directives affirmatively. Apply the `/affirm` convention as you write — it tightens output. "Edit only `rules/<name>.rs`" beats "do NOT modify ANY other file": the positive form is narrower and defines done.

Template:

```
## Task
<single goal — one sentence, then 2-4 bullets of acceptance criteria>

## Context
<prior decisions relevant to this step; any $TMPDIR paths to read; constraints from the orchestrator's plan>

## Return
Reply with these four sections, in order. If your task seems to need its own
multi-step orchestration, surface that in ## Backlog instead of invoking /work
yourself.

## Recap — short prose only (no lists, code blocks, tables, file dumps); bulk goes to $TMPDIR, cited by path. Aim for one short paragraph.
## Modified files — paths only
## Decisions — numbered list of any decisions you locked
## Backlog — numbered list of open items / obstacles you're handing back
```

### Response shape

Four sections: `## Recap` / `## Modified files` / `## Decisions` / `## Backlog`. Orchestrator ingests semantically: read for meaning, allow loose formatting in subagent replies.

### Recap discipline

`## Recap` is prose only: no lists, no code blocks, no tables, no file-content dumps. Structured findings — file lists, grep output, code snippets, schemas, JSON, anything not flowing prose — go to `$TMPDIR` and are cited in Recap by path. The orchestrator forwards Recaps as-is into the next step's `## Context`, so prose-only keeps inter-step context small without active compaction.

Aim for one short paragraph. If a summary genuinely needs more, the work probably had multiple deliverables — split them into separate `$TMPDIR` files and reference each in the Recap.

The rule is structural, not numerical. Subagents can reliably self-check "is this a paragraph of prose?" but cannot count their own tokens. The shape constraint catches the actual cause of Recap bloat (structured dumps) without requiring calibration.

Discipline applies only to Recap. `## Modified files`, `## Decisions`, and `## Backlog` keep their existing structured forms.

### Delegation classifier

Delegate by default. Answer directly only when the answer is already in the orchestrator's context (a fact just produced by a subagent in this session, or stated by the user this turn). Any step requiring a fresh Read, Bash, Write, or Edit, or producing bulk output → delegate. Conversational asides during orchestration are delegated like any other read; to skip delegation for an aside, the user signals stop first.

### Mapping spawn_subagent to a real tool

`spawn_subagent(brief)` and `spawn_subagents(briefs)` both map to the Agent tool, passing each brief as the `prompt`. The plural form emits multiple Agent calls in a single message so they execute concurrently.

Choose `subagent_type` by the step's tag:

- **`read` step → `Explore` agent type.** Tool-restricted: Edit, Write, NotebookEdit are absent. Enforcement is at the tool layer, not via brief instruction. Explore reads excerpts rather than whole files — fits parallel discovery (find X / where Y / which files reference Z); whole-module review still happens as a single sequential `general-purpose` step.
- **`write` step → `general-purpose` agent type.** Full read/write/edit/bash access. Always sequential.
- **Commit subagent → `commit-runner` agent type.** Sequential. Narrow toolset (`Bash`, `Read`, `Skill`) and a static system prompt that forces invocation of the `/commit` skill — keeps message style consistent across orchestrations. The brief can be one line because the agent's prompt carries the rest.

`spawn_subagents` is used only for batches of independent `read` steps. Write steps stay sequential. If an `Explore` subagent fails because it tried to use a missing write tool, the failure handler offers "rerun as general-purpose" as the modify option.

### Tmp dir

`$TMPDIR` is the shared scratch space across all subagents in the session. Use it as-is — subagents pick filenames freely, write where convenient, and read what's there.

### Subagent failures

Surface the error and the brief to the user; ask retry / modify / skip. Require user input before any retry.

### Git posture and auto-commits

At orchestration start, the orchestrator spawns a setup subagent to report git posture: `in_git` (bool) and `dirty` (bool, plus modified-file list if true). The orchestrator never runs git itself.

- Outside a git working tree → auto-commits disabled. No commits during orchestration.
- Inside git, clean tree → auto-commits enabled. Each step that produces file changes ends with a commit subagent.
- Inside git, dirty tree → ask the user: commit existing changes first (delegated to the `commit` skill in a subagent), proceed with auto-commits disabled, or abort. After committing existing changes, re-check posture; a clean tree enables auto-commits.

The commit subagent runs as the `commit-runner` agent type, whose static system prompt forces invocation of the `/commit` skill on the just-completed step's changes. The orchestrator's brief is one line; the agent's narrow toolset (`Bash`, `Read`, `Skill`) and procedural prompt carry the rest. The `commit` skill handles staging, conventional-prefix message generation (short, no body), and pre-commit hook failures. The orchestrator gets back the SHA and message in the subagent's Recap; nothing else enters orchestrator context.

If a commit subagent fails (e.g. a pre-commit hook failure the `commit` skill can't auto-fix), surface the failure and ask retry / skip this step's commit / stop orchestration. Skipping leaves the working tree dirty into the next step; subsequent commits will include the skipped step's changes.

The clean-tree precondition lets the commit subagent rely on the `commit` skill's default staging behavior. Selective staging from the prior step's `## Modified files` would require teaching either the brief or the skill new staging logic — plumbing for marginal benefit.

### Plan steps vs backlog items

Plan steps drive the orchestration loop until resolved. Backlog items surfaced by subagents are open questions, presented at orchestration end. The orchestrator promotes a backlog item to a plan step only by deliberate choice; auto-promotion would block loop termination.

### Stop conditions

Orchestration ends on either:

- All plan steps resolved, or
- User signals stop in natural language ("stop", "pause", "leave it here", "that's enough").

There is no `/stop` slash command.

### Out of scope for v1

- Pre-approval UX
- Tmp dir auto-cleanup
- Write parallelism (out of design scope, not just v1)
