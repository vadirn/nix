---
name: simplified
description: >
  Rewrite a given text to the Simplified output style: short sentences (one idea,
  ≤20 words), active voice, plain words, conclusion first, sets as vertical lists.
  Use when the user invokes /simplified or asks to "apply the Simplified style",
  "make this simplified", "rewrite in Simplified", or "simplify this text / prose /
  PR body / commit message / doc". Works on inline text, a file path, or a live
  surface named in the conversation (the last message, a PR body). Restyle the prose
  and keep fixed structure verbatim — headings, template scaffolding, code, tables,
  quoted specimens, frontmatter, and any fixed surface limit. Route code cleanups to
  /simplify, idea-compression to /distill, and negative-to-positive instruction
  flips to /affirm.
---

# Simplified

Rewrite prose to the Simplified output style. Restyle the prose; keep the structure verbatim.

## Parameters

- `text` (required): The text to rewrite. Inline text, a file path, or a live surface named in the conversation (the last message, a PR body).

```
content = <args> or conversation context
if no content: AskUserQuestion("Which text should I rewrite?")
if content is a file path (starts with / or ./, a known extension, or an existing file):
  content = Read(path)
  target = that file
if content names a live surface (a PR body, a commit message, the last message):
  content = do("fetch it — e.g. gh pr view <n> --json body -q .body")
  target = that surface

// Mark what stays verbatim
fixed = do("mark the fixed structure to keep verbatim — see Reference")

// Relevance
do("lead each unit with its conclusion; put the reason after it")
// Sentences
do("split every sentence to one idea, capped at 20 words")
do("use active voice and name the actor; use the imperative for a step")
do("start with the known part, end with the new part; keep connectives — because, so, but, although")
// Words
do("cut any word the sentence survives without; use one term per concept")
do("replace a nominalization with its verb; use the positive form; keep noun stacks to three")
// Shape
do("turn a set or a sequence into a vertical list; give each paragraph one topic")

result = do("reassemble the restyled prose with the fixed structure spliced back verbatim")

// Verify
do("check every prose sentence carries one idea and ≤20 words")
do("check meaning, specimens, numbers, and fixed structure are unchanged")

// Output
if target is a file:
  Write(target, result)
  do("show a short summary of the changes")
elif target is a live surface:
  do("show result, then offer to write it back — gh pr edit --body-file, an amend")
else:
  do("show result")
```

## Reference

### What stays verbatim

The style shapes prose. It leaves fixed structure alone. Restyle inside the structure, never the structure itself.

- Headings, template scaffolding, emoji, and section count.
- Code spans, code blocks, and quoted specimens.
- Table structure, exact numbers, and frontmatter.
- A fixed surface limit — a one-line commit subject, a PR template's sections.

### One idea, ≤20 words

The cap is on the sentence, not the passage. Split a long sentence into short ones. Meaning stays; only the packing changes.

| Before                                                                                                                 | After |
| ---------------------------------------------------------------------------------------------------------------------- | ----- |
| Adds the rule and wires it into the registry, and it also documents the rule in the vault skill, so callers can react. | Adds the rule and wires it into the registry. It documents the rule in the vault skill. So callers can react. |
| The content test was measured against the vault and rejected because it flags intended file-naming bold.               | A content test flags intended file-naming bold. So the vault measurement rejected it. |

### Where the rules live

The canonical style is the Simplified output style at `home/agents/output-styles/Simplified.md`. It carries the full principles (ISO 24495-1, STE) and the Relevance / Sentences / Words / Shape rules this skill applies. Read it when a call is unclear.
