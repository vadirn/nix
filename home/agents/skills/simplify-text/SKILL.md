---
name: simplify-text
description: >
  Rewrite prose in the Simplified output style. Use one idea per sentence, with ≤20
  words, active voice, plain words, and the conclusion first. Turn sets into vertical
  lists. Use it when the user invokes /simplify-text or asks to "apply the Simplified
  style", "simplify this text / prose / PR body / commit message / doc", or turns the
  style on you: "simplify your reply", "say that more simply", "restyle your last
  message". Russian too: «упрости этот текст», «перепиши проще», «сделай текст проще».
  Reach for it even when the user never names the style but wants plainer prose.
---

# Simplify text

Rewrite prose to the Simplified output style. The `simplify-text` CLI restyles. The `simplify-verify` CLI gates the write.

## Stance

You rewrite prose to the Simplified output style. Plainer is the goal.

Restyle the prose and keep fixed structure verbatim. Headings, template scaffolding, code, tables, and quoted specimens survive the pass unchanged. So do frontmatter and any fixed surface limit.

The restyle strips cadence, flourish, and hedging. That is the style working, not a defect. So do not protect voice, rhythm, or ornament.

You repair, you do not refute. The deterministic `simplify-verify` gate owns the block. It stops a write when a reference span or the structure breaks. Everything else is your read, not your veto.

Repair every claim the pass shifted or dropped. Both modes repair, because a finding you only report still ships. So restore the claim against the source first, then say what you restored.

Report the repairs as a list in external mode. Name each shifted claim, dropped argument, or borderline call. Never hand the rewrite back for reading terser or flatter than the source, nor on taste.

In reply mode you have no reader to report to, so repair and stay silent about the pass.

## Modes

The target picks the mode. Nothing else does.

- **External** — a file path, a PR body, an issue, a commit message. The text lives outside this conversation, and the write lands where the user or the public reads it. So publish the artifact, then write.
- **Reply** — your own draft, your last message, or a snippet pasted into the chat. The text IS this conversation. So send the rewrite as your message: no artifact, no brief, no note that the pass ran.

A pasted snippet takes reply mode, because an artifact for two lines costs more than it shows.

One pass serves both. Only the ending differs.

## Parameters

- `text` (required): The text to rewrite. A file path, an external surface named in the conversation (a PR body, a commit message), or inline text.

```
dir = skill base directory              // the artifact build lives under dir/assets
content = <args> or conversation context
if no content: AskUserQuestion("Which text should I rewrite?")

// Resolve the source, the write target, and the mode. The target picks the mode — see §Modes.
if content is a file path (starts with / or ./, a known extension, or an existing file):
  source = that file
  target = that file
  mode = external
elif content names an external surface (a PR body, an issue, a commit message):
  text = do("fetch it — e.g. gh pr view <n> --json body -q .body")
  source = Write("$TMPDIR/simplify-src.md", text)   // both CLIs read files
  target = that surface
  mode = external
else:                                               // your own draft, your last message, a snippet
  source = Write("$TMPDIR/simplify-src.md", content)
  target = none
  mode = reply

// Analyze — the CLI owns the ruleset; language auto-detects (override with --lang en|ru)
brief = Bash("simplify-text <source>")
if exit != 0:
  do("stop and report per the exit — see §Exit codes")
  stop
rewrite = do("take the single fenced block under ## Rewrite — see §The brief")

// Gate before any write
report = Bash("simplify-verify <source>")   // rewrite piped on stdin
if exit == 1:                               // drift — do NOT write
  if mode == external:
    do("surface the dropped/invented span or the heading/fence count delta from <report>")
    AskUserQuestion("Re-run simplify-text, or hand this back?")
    stop
  do("send your original draft unrestyled")
  stop
if exit == 2 or exit == 3:
  do("stop and report the gate error")
  stop

// Read for meaning, then repair — see §The meaning check
findings = do("read the rewrite against the source and name every claim the pass shifted or dropped")
if findings is non-empty:
  rewrite = do("repair every finding in <findings> against <source>, keeping the Simplified style")
rewrite = do("replicate the source's emphasis by intent — see §Emphasis")

// Re-gate, because the repair and the emphasis are your own edits
report = Bash("simplify-verify <source>")   // the edited rewrite piped on stdin
edits_held = exit == 0
if not edits_held:
  do("surface what broke from <report>")
  rewrite = do("fall back to the CLI's gated rewrite, discarding your edits")

if mode == reply:
  if edits_held: do("send <rewrite> as your message: no artifact, no brief, no note that the pass ran")
  else: do("send your original draft unrestyled")
  stop

// External: show the read, publish, then write
do("show the ## Verdict and a short change summary")
do("report <findings> as a bulleted list, each marked repaired or left as-is")
Read(dir/references/artifact.md)             // external only, so the recipe loads on demand
do("follow it to build and publish the artifact")

if findings is non-empty and not edits_held:
  answer = AskUserQuestion("Your repair broke the gate. Write it unrepaired, re-run simplify-text, or hand this back?")
  if answer != "write": stop

if target is a file:
  Write(target, rewrite)
  do("show what changed")
else:                                       // an external surface
  do("confirm before writing back — a PR body or commit message is public")
  do("then offer gh pr edit --body-file, or an amend")
```

## Reference

### Exit codes

`simplify-text`: 1 missing key, 2 usage, 3 empty, 4 analysis failed.

`simplify-verify`: 0 clean, 1 drift, 2 usage, 3 empty. Exit 1 blocks the write.

On drift the CLI has already re-rolled three times, so a fourth buys little.

### The brief

`## Rewrite` holds the one fenced block to extract. Verdict, Cut, Change, Shape, Keep, and Borderline are read-only rationale. `## Guard` is advisory.

### The meaning check

A clean gate verifies spans and structure, never meaning. Every axis is deterministic, so none of them sees a distorted or deleted claim. You are the only meaning check in this loop.

Both modes repair. A finding you only report still ships. External mode lands it on a file or a public surface. Reply mode hands it to the user. So the report is an audit trail, never a substitute for the fix.

Repair against the source, not your memory of it. Restore the shifted claim in the rewrite's new wording, and change nothing else.

Then re-gate. The first gate read the CLI's rewrite, but the repair and the emphasis are your edits. A hand edit drops a ⟦N⟧ span or shifts a fence count as easily as a model pass does. So gate what you actually intend to ship.

### Emphasis

The restyle drops inline emphasis, because the CLI masks references and never `**bold**` or `*italic*`. Re-apply it where you hold both texts, and after the repair, so a repaired sentence carries its own emphasis.

Replicate the intent to emphasize, not the exact phrase. For each emphasized span in the source, find the idea it stressed. Then emphasize that idea in the rewrite's new wording.

Leave it out where the restyle left no natural home — the phrase merged, moved, or dissolved. A forced fit is worse than none.

### Style

The canonical style is the Simplified output style at `home/agents/output-styles/Simplified.md`. The `simplify-text` CLI applies it; read the style when a call is unclear.
