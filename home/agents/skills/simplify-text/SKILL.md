---
name: simplify-text
description: >
  Rewrite a given text to the Simplified output style: short sentences (one idea,
  ≤20 words), active voice, plain words, conclusion first, sets as vertical lists.
  Two modes, picked by the target. External — a file, a PR body, a commit message —
  gets a side-by-side artifact and a write back. Reply — your own draft or last
  message, or a snippet pasted into the chat — gets the rewrite as the message
  itself. Use when the user invokes /simplify-text or asks to "apply the Simplified
  style", "make this simplified", "rewrite in Simplified", "simplify this text /
  prose / PR body / commit message / doc", or turns the style on you: "simplify your
  reply", "say that more simply", "restyle your last message". Restyle the prose and
  keep fixed structure verbatim — headings, template scaffolding, code, tables,
  quoted specimens, frontmatter, and any fixed surface limit. Route code cleanups to
  /simplify, idea-compression to /distill, and negative-to-positive instruction
  flips to /affirm.
---

# Simplify text

Rewrite prose to the Simplified output style. The `simplify-text` CLI restyles. The `simplify-verify` CLI gates the write.

## Stance

You rewrite prose to the Simplified output style. Plainer is the goal.

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

// Analyze. The CLI owns the ruleset; language auto-detects (override with --lang en|ru).
brief = Bash("simplify-text <source>")
if exit != 0:
  do("stop and report per the exit — 1 missing key, 2 usage, 3 empty, 4 analysis failed")
  stop

// Extract the proposed rewrite — the one fenced block under the ## Rewrite heading.
// Verdict/Cut/Change/Shape/Keep/Borderline are read-only rationale; ## Guard is advisory.
rewrite = do("take the single fenced block under ## Rewrite")

// Gate before any write. Pipe the rewrite to the apply-gate against the source.
report = Bash("simplify-verify <source>")   // rewrite piped on stdin
if exit == 1:                               // drift — do NOT write
  if mode == external:
    do("surface the dropped/invented span or the heading/fence count delta from <report>")
    AskUserQuestion("Re-run simplify-text, or hand this back?")
    stop
  do("send your original draft unrestyled — the CLI already re-rolled three times, so a fourth buys little")
  stop
if exit == 2 or exit == 3:                  // usage or empty
  do("stop and report the gate error")
  stop

// exit == 0 — verified for spans and structure, NOT meaning: every axis is deterministic, so none of
// them sees a distorted or deleted claim. YOU are the only meaning check in this loop.
findings = do("read the rewrite against the source and name every claim the pass shifted or dropped")

// Repair before the rewrite leaves this loop. BOTH modes repair — a finding you only report still
// ships, to a file or a public surface in external mode and to the user in reply mode. The report is
// an audit trail, never a substitute for the fix. Repair against <source>, not your memory of it:
// restore the shifted claim in the rewrite's new wording, and change nothing else.
if findings is non-empty:
  rewrite = do("repair every finding in <findings> against <source>, keeping the Simplified style")

// The restyle drops inline emphasis: the CLI masks references, never `**bold**` or `*italic*`. Re-apply it
// here, where you hold both the source and the rewrite, and after the repair, so a repaired sentence
// carries its own emphasis. The CLI's one clean pass should not carry this judgment. Replicate the INTENT
// to emphasize, not the exact phrase. For each emphasized span in the source, find the idea it stressed,
// then emphasize that idea in the rewrite's new wording. Where the restyle left no natural home — the
// phrase merged, moved, or dissolved — leave it unemphasized. A forced fit is worse than none.
rewrite = do("replicate the source's emphasis by intent — re-emphasize each stressed idea in the rewrite's new wording, and leave it out where the restyle left no natural fit")

// Re-gate. The first gate read the CLI's rewrite; the repair and the emphasis are YOUR edits, and a
// hand edit drops a ⟦N⟧ span or shifts a fence count as easily as a model pass does. Gate what you
// actually intend to ship.
report = Bash("simplify-verify <source>")   // the edited rewrite piped on stdin
edits_held = exit == 0
if not edits_held:
  do("surface what broke from <report>")
  rewrite = do("fall back to the CLI's gated rewrite, discarding your edits")

if mode == reply:
  if edits_held:
    do("send <rewrite> as your message: no artifact, no brief, no note that the pass ran")
    stop
  do("send your original draft unrestyled — shipping a claim you know shifted is worse than shipping no restyle")
  stop

// External from here: show the read, publish the artifact, then write.
do("show the ## Verdict and a short change summary")
do("report <findings> as a bulleted list, each marked repaired or left as-is — a shifted claim, a dropped argument, a borderline call; do not hand the rewrite back on meaning or taste")

// Show the result as a black-and-white HTML artifact with two views — original-vs-edited and the
// full brief — verbatim in <pre>, MonoLisaCode, generous spacing. Reply mode never reaches here,
// so the recipe stays out of this file until the run needs it.
Read(dir/references/artifact.md)
do("follow it to build and publish the artifact")

// The write is the whole reason external mode repairs. Never let a claim you know shifted land on
// disk or on a public surface just because you named it above.
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

The canonical style is the Simplified output style at `home/agents/output-styles/Simplified.md`. The `simplify-text` CLI applies it; read the style when a call is unclear.
