---
name: simplify-text
description: >
  Rewrite a given text to the Simplified output style: short sentences (one idea,
  ≤20 words), active voice, plain words, conclusion first, sets as vertical lists.
  Use when the user invokes /simplify-text or asks to "apply the Simplified style",
  "make this simplified", "rewrite in Simplified", or "simplify this text / prose /
  PR body / commit message / doc". Works on inline text, a file path, or a live
  surface named in the conversation (the last message, a PR body). Restyle the prose
  and keep fixed structure verbatim — headings, template scaffolding, code, tables,
  quoted specimens, frontmatter, and any fixed surface limit. Route code cleanups to
  /simplify, idea-compression to /distill, and negative-to-positive instruction
  flips to /affirm.
---

# Simplify text

Rewrite prose to the Simplified output style. The `simplify-text` CLI restyles. The `simplify-verify` CLI gates the write.

## Stance

You rewrite prose to the Simplified output style. Plainer is the goal.

The restyle strips cadence, flourish, and hedging. That is the style working, not a defect. So do not protect voice, rhythm, or ornament.

You report, you do not refute. The deterministic `simplify-verify` gate owns the block. It stops a write when a reference span or the structure breaks. Everything else is your read, not your veto.

Report your read as a list. Name a shifted claim, a dropped argument, or a borderline call. Never hand the rewrite back for reading terser or flatter than the source, nor on taste.

## Parameters

- `text` (required): The text to rewrite. Inline text, a file path, or a live surface named in the conversation (the last message, a PR body).

```
content = <args> or conversation context
if no content: AskUserQuestion("Which text should I rewrite?")

// Resolve the source and the write target.
if content is a file path (starts with / or ./, a known extension, or an existing file):
  source = that file
  target = that file
elif content names a live surface (a PR body, a commit message, the last message):
  text = do("fetch it — e.g. gh pr view <n> --json body -q .body")
  source = Write("$TMPDIR/simplify-src.md", text)   // both CLIs read files
  target = that surface
else:
  source = Write("$TMPDIR/simplify-src.md", content) // a bare snippet
  target = none                                      // show the result only

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
  do("surface the dropped/invented span or the heading/fence count delta from <report>")
  AskUserQuestion("Re-run simplify-text, or hand this back?")
  stop
if exit == 2 or exit == 3:                  // usage or empty
  do("stop and report the gate error")
  stop

// exit == 0 — verified for spans and structure, NOT meaning: every axis is deterministic, so none of
// them sees a distorted or deleted claim. YOU are the only meaning check in this loop. Read the
// rewrite against the source and name what shifted. You report, you do not refute (see §Stance).
do("show the ## Verdict and a short change summary")
do("report your read as a bulleted list — a shifted claim, a dropped argument, a borderline call; do not hand the rewrite back on meaning or taste")

// The restyle drops inline emphasis: the CLI masks references, never `**bold**` or `*italic*`. Re-apply it
// here, where you hold both the source and the rewrite. The CLI's one clean pass should not carry this
// judgment. Replicate the INTENT to emphasize, not the exact phrase. For each emphasized span in the
// source, find the idea it stressed, then emphasize that idea in the rewrite's new wording. Where the
// restyle left no natural home — the phrase merged, moved, or dissolved — leave it unemphasized. A forced
// fit is worse than none.
rewrite = do("replicate the source's emphasis by intent — re-emphasize each stressed idea in the rewrite's new wording, and leave it out where the restyle left no natural fit")

// Show the result as a black-and-white HTML artifact with two modes — original-vs-edited and the
// full brief — verbatim in <pre>, MonoLisaCode, generous spacing. See §Artifact.
do("build the artifact from <source>, <rewrite>, and <brief>, then publish it")

if target is a file:
  Write(target, rewrite)
  do("show what changed")
elif target is a live surface:
  do("confirm before writing back — a PR body or commit message is public")
  do("then offer gh pr edit --body-file, or an amend")
// else: the artifact is the result display
```

## Artifact

Show the result as a black-and-white HTML artifact with two modes. The template is `assets/viewer.html`.

- Original vs edited: two columns, source left, rewrite right, a center rule.
- Brief: the full CLI brief.

Print every text verbatim. Do not render the markdown to HTML. Show the exact characters — headings, fences, list markers — inside a `<pre>`. HTML-escape each text, fill the markers, then publish.

Fill five markers:

- `__FONT_B64__` — the MonoLisaCode TTF, base64-encoded, because the artifact CSP blocks an external font.
- `__SRC__` — the source name.
- `__ORIGINAL__` — the escaped source note.
- `__EDITED__` — the escaped rewrite, the `## Rewrite` block.
- `__BRIEF__` — the escaped full brief.

The typography matches the user's ghostty:

- Features: `liga`, `calt`, `cv01`, `cv08`, `cv09`, `ss14`, and `GRAD` 50.
- Color: black on white in light, white on black in dark. No accent.

## Reference

The canonical style is the Simplified output style at `home/agents/output-styles/Simplified.md`. The `simplify-text` CLI applies it; read the style when a call is unclear.
