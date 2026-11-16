# Structure locators

textkit locates markdown structure two ways. Regex line scans do it in TypeScript. The `mdstruct`
binary does it in Rust, through the `src/core/mdstruct.ts` wrapper.

This file catalogues every structure-locating expression in `src/core/text.ts`. Each carries exactly
one verdict:

- **mdstruct today** — the binary already emits what the expression computes.
- **crate change** — mdstruct could answer it after a change to the Rust crate.
- **TypeScript** — the question is not markdown structure, so it stays here.
- **removed** — a swap deleted the expression outright, with no replacement.

Measured against the PATH binary at schema 1.3 on 2026-08-11. Every specimen below was run, not
reasoned about.

The inventory once covered `src/simplify/` too. That slice and its two CLIs (`simplify-text`,
`simplify-verify`) were removed, and git history keeps their rows, defects, and migration order.

## Inventory — src/core/text.ts

| Expression                 | Verdict        | Reason                                                                                                                                                                                    | Callers |
| -------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `fenceScan`                | mdstruct today | A `codeBlock` node carries `fenced`, `fenceChar`, and spans, including inside a blockquote.                                                                                               | distill |
| `segment`                  | mdstruct today | Top-level `nodes[]` tile the document, so block boundaries need no blank-line scan.                                                                                                       | distill |
| `stripFences`              | mdstruct today | `codeBlock` spans name the exact bytes a caller wants blanked.                                                                                                                            | distill |
| `THEMATIC_BREAK_RE`        | removed        | Its last consumer was the simplify guard, and the swap deleted the regex outright.                                                                                                        | — |
| `WIKILINK` / `hasWikilink` | mdstruct today | A `wikilink` inline covers the `![[embed]]` form through its `embed` flag.                                                                                                                | distill |
| `ASSET_RE`                 | TypeScript     | It classifies a file extension. That is a vault policy, not markdown structure.                                                                                                           | distill |
| `isExternalUrl`            | TypeScript     | It classifies a URL string. The parse tree holds no vault-versus-external opinion.                                                                                                        | distill |
| `normalizeEdgeTarget`      | TypeScript     | It also strips fragments from markdown-link URLs, which mdstruct emits raw.                                                                                                               | distill |
| `wikilinkTarget`           | mdstruct today | `wikilink{page}` already carries the alias-stripped, fragment-stripped target.                                                                                                            | distill |
| `decodeTarget`             | TypeScript     | Percent-decoding a path is a URL concern, outside the parser's surface.                                                                                                                   | distill |
| `hasOperational`           | TypeScript     | It scores prose for CLI flags and paths. That is a writing judgment.                                                                                                                      | distill |
| `MASK_RE`                  | mdstruct today | A `codeSpan` span includes its delimiters, so a double-backtick span slices whole. The applied fix stayed a regex — `VERBATIM_SPAN_RE` still needs the crate's missing `htmlInline` kind. | distill |
| `HTML_COMMENT`             | crate change   | A block comment is an `htmlBlock`. An inline comment emits no inline at all.                                                                                                              | distill |
| `VERBATIM_SPAN_RE`         | crate change   | It composes `HTML_COMMENT`, so the whole atom set waits on that gap.                                                                                                                      | distill |
| `slugSegment`              | TypeScript     | It mirrors vault-query's `slug.rs` byte for byte, pinned by a parity test.                                                                                                                | distill, cards |

`createMasker` reads `VERBATIM_SPAN_RE`, and `core/writing/passes.ts` reaches distill's `revise()`
through that. So any atom-set change reaches distill's rewriting passes.

## Known limit

**`stripFences` cannot see a fence inside a blockquote.**

```
input   "> ```js\n> const a = 1;\n> ```\n\nAfter.\n"
output  stripFences → unchanged
```

mdstruct parses it as `blockQuote` → `codeBlock`.

## The crate gap

mdstruct emits no inline for an HTML comment inside a paragraph.

```
input   "Text … and ![[embed.png]] plus <!-- inline note --> tail."
output  inlines → codeSpan, wikilink, wikilink — no comment
```

A comment on its own line is an `htmlBlock` node with a span. An inline comment is invisible. So
`VERBATIM_SPAN_RE` cannot move to mdstruct until the crate emits an `htmlInline` inline kind. That is
the one crate change this inventory asks for.

## Deferred

- An mdstruct-backed masker, which waits on the crate's `htmlInline` gap.
- The distill rows in the table above, which need their own ticket.
