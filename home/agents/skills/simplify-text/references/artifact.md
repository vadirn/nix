# artifact — publish the restyle as a side-by-side page

Show the result as a black-and-white HTML artifact with two views. External mode only, since reply mode publishes nothing.

- Original vs edited: two columns, source left, rewrite right, a center rule.
- Brief: the full CLI brief.

## Build

Both CLIs already read files, but `rewrite` and `brief` are in memory. Write them out, then call the script.

```
Write("$TMPDIR/simplify-rewrite.md", rewrite)
Write("$TMPDIR/simplify-brief.md", brief)
Bash("bun dir/assets/build.ts <target name> <source> $TMPDIR/simplify-rewrite.md $TMPDIR/simplify-brief.md $TMPDIR/simplify-artifact.html")
Artifact("$TMPDIR/simplify-artifact.html")
```

The script HTML-escapes each text and fills the four markers of `assets/viewer.html` in one regex pass.

**Never fill the template by hand.** A sequence of plain replaces breaks on any document that names the markers in its own prose. This skill's own files do. Each replace then writes into the text the one before it inserted, so the page ends up carrying a panel inside a panel.

Read the exit: 1 means a marker vanished from the template, so the script and the template drifted apart. 2 means usage.

## Rules

Print every text verbatim. Do not render the markdown to HTML. The `<pre>` shows the exact characters — headings, fences, list markers.

The typography matches the user's ghostty:

- Font: MonoLisaCode by name, never embedded. A reader without it gets the platform monospace.
- Features: `liga`, `calt`, `cv01`, `cv08`, `cv09`, `ss14`, and `GRAD` 50.
- Color: black on white in light, white on black in dark. No accent.
