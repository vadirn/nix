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

// Extract the proposed rewrite — the one fenced block under the ## rewrite heading.
// verdict/cut/change/shape/keep/borderline are read-only rationale; ## guard is advisory.
rewrite = do("take the single fenced block under ## rewrite")

// Gate before any write. Pipe the rewrite to the apply-gate against the source.
report = Bash("simplify-verify <source>")   // rewrite piped on stdin
if exit == 1:                               // drift — do NOT write
  do("surface the dropped/invented span or the heading/fence count delta from <report>")
  AskUserQuestion("Re-run simplify-text, or hand this back?")
  stop
if exit == 2 or exit == 3:                  // usage or empty
  do("stop and report the gate error")
  stop

// exit == 0 — verified for spans and structure, NOT meaning: the gate is deterministic and cannot
// see a distorted claim. So the reviewer owns meaning-fidelity before any write.
do("show the ## verdict and a short change summary")
do("check each ## change item — the `after` must keep the `before`'s claim, tense, and mood; flag any that recast a statement as a command or flip a negation")

if target is a file:
  Write(target, rewrite)
  do("show what changed")
elif target is a live surface:
  do("confirm before writing back — a PR body or commit message is public")
  do("then offer gh pr edit --body-file, or an amend")
else:
  do("show the rewrite")
```

## Reference

The canonical style is the Simplified output style at `home/agents/output-styles/Simplified.md`. The `simplify-text` CLI applies it; read the style when a call is unclear.
