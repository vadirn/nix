# Structure locators

textkit locates markdown structure two ways. Regex line scans do it in TypeScript. The `mdstruct`
binary does it in Rust, through the `src/core/mdstruct.ts` wrapper.

This file catalogues every structure-locating expression in `src/core/text.ts` and `src/simplify/`.
Each carries exactly one verdict:

- **mdstruct today** — the binary already emits what the expression computes.
- **crate change** — mdstruct could answer it after a change to the Rust crate.
- **TypeScript** — the question is not markdown structure, so it stays here.

It then records the dependency decision, the defects the verdicts must fix, and the migration order.

Measured against the PATH binary at schema 1.3 on 2026-08-11. Every specimen below was run, not
reasoned about.

## The dependency decision

`simplify-text` and `simplify-verify` MAY take a hard dependency on the `mdstruct` binary. Both must
fail loud when it is missing. There is no fallback path and no flag to disable it.

Three grounds carried the answer.

**Gate semantics decided it.** `simplify-verify` gates a permanent write to the user's note. A gate
that reports "verified" off a weaker check is worse than no gate. So a missing binary must block the
apply, never degrade to regex.

**The package already answers this question.** `src/core/mdstruct.ts` throws `mdstruct
unavailable` on a spawn failure, because a silent fallback reintroduces the bugs the swap fixes. A
second policy in one package would be a second answer to one question.

**First-party deployment removed the remaining objection.** `mdstruct` ships from this repo.
`./rebuild.sh` installs it beside the four CLIs. So the dependency adds no new supply chain, and the
remedy for a missing binary is a local rebuild.

**Spawn cost moved nothing.** A parse costs 3.8 ms on a small file and 6.9 ms on the largest markdown
file in the repo. `simplify-verify` pays two parses per run, so 8–14 ms. `simplify-text` parses at
most six times on the verify path, and the parse cache keys on source text, so the original parses
once. A restyle pass costs one or more LLM round trips, measured in seconds.

### What each CLI does when the binary is missing

`simplify-verify` exits **5** and prints no report. The code must stay distinct from 1. A 1 says the
rewrite drifted. A 5 says the gate could not run. Both block the apply, and the subagent has to name
which one happened.

`simplify-text` parses the source BEFORE the first model call, and exits 5 on failure. Parsing first
is what keeps a missing binary from burning tokens. Its existing 4 stays reserved for an exhausted
model, which is a different failure.

## Inventory — src/core/text.ts

`core/text.ts` is shared with `src/distill/`, which this work puts out of scope. So one routing rule
governs every row below.

**A verdict never changes distill's behaviour on its own.** Move simplify's call sites off a shared
expression, and leave the expression in place for distill until a distill ticket retires it. Two rows
break the rule and say so.

| Expression                 | Verdict        | Reason                                                                                      | Callers |
| -------------------------- | -------------- | ------------------------------------------------------------------------------------------- | ------- |
| `fenceScan`                | mdstruct today | A `codeBlock` node carries `fenced`, `fenceChar`, and spans, including inside a blockquote. | shared |
| `segment`                  | mdstruct today | Top-level `nodes[]` tile the document, so block boundaries need no blank-line scan.         | distill |
| `stripFences`              | mdstruct today | `codeBlock` spans name the exact bytes a caller wants blanked.                              | shared |
| `THEMATIC_BREAK_RE`        | mdstruct today | A `thematicBreak` node is never a setext underline. The regex cannot tell them apart.       | shared |
| `WIKILINK` / `hasWikilink` | mdstruct today | A `wikilink` inline covers the `![[embed]]` form through its `embed` flag.                  | distill |
| `ASSET_RE`                 | TypeScript     | It classifies a file extension. That is a vault policy, not markdown structure.             | distill |
| `isExternalUrl`            | TypeScript     | It classifies a URL string. The parse tree holds no vault-versus-external opinion.          | distill |
| `normalizeEdgeTarget`      | TypeScript     | It also strips fragments from markdown-link URLs, which mdstruct emits raw.                 | distill |
| `wikilinkTarget`           | mdstruct today | `wikilink{page}` already carries the alias-stripped, fragment-stripped target.              | distill |
| `decodeTarget`             | TypeScript     | Percent-decoding a path is a URL concern, outside the parser's surface.                     | distill |
| `hasOperational`           | TypeScript     | It scores prose for CLI flags and paths. That is a writing judgment.                        | distill |
| `MASK_RE`                  | mdstruct today | A `codeSpan` span includes its delimiters, so a double-backtick span slices whole.          | shared |
| `HTML_COMMENT`             | crate change   | A block comment is an `htmlBlock`. An inline comment emits no inline at all.                | shared |
| `VERBATIM_SPAN_RE`         | crate change   | It composes `HTML_COMMENT`, so the whole atom set waits on that gap.                        | shared |
| `slugSegment`              | TypeScript     | It mirrors vault-query's `slug.rs` byte for byte, pinned by a parity test.                  | distill, cards |

Two rows break the routing rule, because their defect lives in one shared constant:

- `MASK_RE` — fixing its code-span spelling changes what distill's harvest probes blank. The change
  runs the same direction for both consumers: it blanks a whole span instead of a fragment.
- `VERBATIM_SPAN_RE` — `createMasker` reads it, and `core/writing/passes.ts` reaches distill's
  `revise()` through that. So any atom-set change reaches distill's rewriting passes.

`HTML_COMMENT`'s crate change is one addition: an `htmlInline` inline kind. Verified below.

## Inventory — src/simplify/

| Expression                              | File                    | Verdict        | Reason |
| --------------------------------------- | ----------------------- | -------------- | ------ |
| `isSkippedLine`                         | sequence.ts             | mdstruct today | Node kinds name heading, table, blockquote, and list item exactly. |
| `isStructureLine`                       | wordcap.ts              | mdstruct today | Same kinds. A paragraph holding a bare pipe stays a paragraph. |
| `stripLeadingMarker`                    | wordcap.ts              | mdstruct today | The paragraph inside a `listItem` starts after the marker and the task box. |
| `SENTENCE_SPLIT_RE`                     | wordcap.ts, sequence.ts | TypeScript     | Sentence segmentation measures prose. Only its closing-marker class is structural. |
| `ORDERED_ITEM_RE` / `UNORDERED_ITEM_RE` | guard.ts                | mdstruct today | `list{ordered}` and its `listItem` children give kind, block, and count. |
| `listMarkers` / `listBlockSizes`        | guard.ts                | mdstruct today | A nested sublist opens its own `list` node, so the block undercount goes. |
| `fencedBlocks`                          | guard.ts                | mdstruct today | Slicing each `codeBlock` span also catches a fence inside a blockquote. |
| `headingCount`                          | verify.ts               | mdstruct today | `headings[]` carries `setext` and excludes frontmatter. |
| `fenceMarkers`                          | verify.ts               | mdstruct today | Counting `codeBlock` nodes replaces it. The axis then counts blocks, not marker lines. |
| `thematicBreakCount`                    | verify.ts               | mdstruct today | `thematicBreak` nodes exclude the setext underline this regex counts. |
| `spanList`                              | verify.ts               | crate change   | It reads `VERBATIM_SPAN_RE`, so it waits on the inline-comment gap. |
| `fenceFor`                              | brief.ts                | TypeScript     | It measures backtick runs to build an output fence. It locates nothing in a note. |

`SENTENCE_SPLIT_RE` earns one note. Its closing-marker class exists so a split never lands on a
markdown emphasis or code-span closer. Schema 1.3 emits `emph{span}` and `strong{span}`, so a
masked-emphasis pass could retire that class later. The split itself stays prose work.

Excluded as prose measurement, not structure: `ASIDE_RE`, `COORD_OPENS_RE`, `commaMembers`,
`segmentsOn`, `wordsIn`, `wordCount`, `detectLang`.

## Defects the verdicts must fix

Four defects, each run against the live code.

**1 — `verify()` sees no setext heading.** Its counter matches an ATX run only.

```
input   "Sub\n---\n\nBody.\n"  vs  "## Sub\n\nBody.\n"
output  headings 0 → 1 DRIFT, thematic 1 → 0 DRIFT
```

The known symptom understates it. A setext-only note reports zero headings on both sides, so the axis
gates on nothing. Worse, a setext-to-ATX normalization trips BOTH axes at once, because
`thematicBreakCount` reads the underline as a break. So the gate blocks a correct restyle.

**2 — a bare pipe removes prose from the sequence scan.** `isSkippedLine` tests for a pipe anywhere
on the line.

```
input   "The scan reads a table cell | a pipe in prose, a second member, a third member, and a fourth."
output  sequenceScan → []
```

**3 — `MASK_RE` slices a double-backtick span.** Its code-span alternative spells one backtick pair.

```
input   "Text with ``a `tick` inside`` tail."
output  MASK_RE → ["`a `", "` inside`"]
```

It returns two fragments where one atom sits. The gate then compares invented spans on both sides.

**4 — `isStructureLine` carries the same bare-pipe test.** The word-cap scan drops the same prose.

```
input   "x | word word word … (30 words)"
output  wordCapScan → []
```

**This fourth instance joins the same fix rather than taking its own ticket.** It is one expression,
one defect, and one replacement. Both scans feed one brief, and both hand the model a worklist. A
split would ship a fix claiming the pipe defect is closed while half the brief still drops prose.

## Corrections to the existing defence

**`THEMATIC_BREAK_RE`'s comment is wrong about guard, but guard's code is right.** The comment
defends the expression on the grounds that callers only compare counts across two sides. `guard.ts`
excludes lines from an absolute count instead, so that ground does not cover it. The behaviour is
still correct, for a different reason.

```
"---"    break: true   unordered-item: false
"___"    break: true   unordered-item: false
"- - -"  break: true   unordered-item: true
"* * *"  break: true   unordered-item: true
```

The ambiguous form `---` never matches the item pattern, because no space follows the marker. So the
exclusion cannot fire on it. The forms that do reach the exclusion are thematic breaks under
CommonMark, which gives a break precedence over a list item. mdstruct confirms it: `- - -` inside a
list run emits a `thematicBreak` and splits the run into two `list` nodes, which is exactly what
`listBlockSizes` already does. Fix the comment's stated ground. Leave the code.

**`headingCount` does not strip frontmatter, while `thematicBreakCount` in the same file does.** That
asymmetry costs.

```
input   "---\ntitle: x\n# a yaml comment\n---\n\n# Real heading\n"
output  headingCount → 2
```

A YAML comment counts as a heading. It cancels only while both sides carry identical frontmatter.
`simplify-verify`'s CLI path reads whole files, so a rewrite piped without frontmatter reports false
drift. mdstruct's `headings[]` excludes frontmatter outright, so the swap closes this with no extra
call.

**`stripFences` cannot see a fence inside a blockquote, and `fenceScan`'s comment misstates the
scope.** The comment claims a fence indented inside a list item is also unreadable. It is not —
`^\s*` matches the indentation.

```
input   "> ```js\n> const a = 1;\n> ```\n\nAfter.\n"
output  stripFences → unchanged, fenceMarkers → 0
```

So guard's code axis and both scans read blockquoted code as prose today. mdstruct parses it as
`blockQuote` → `codeBlock`.

## The crate gap

mdstruct emits no inline for an HTML comment inside a paragraph.

```
input   "Text … and ![[embed.png]] plus <!-- inline note --> tail."
output  inlines → codeSpan, wikilink, wikilink — no comment
```

A comment on its own line is an `htmlBlock` node with a span. An inline comment is invisible. So
`VERBATIM_SPAN_RE` cannot move to mdstruct until the crate emits an `htmlInline` inline kind. That is
the one crate change this inventory asks for.

## Implementation order

**Step 1 unblocked the most.** `scripts/boundaries.ts` allows a cross-slice import only when the
imported slice is `core`. Before the move, no file under `simplify/` could import the wrapper
(it lived under `distill/`), and every other step waited on it.

1. **Move the wrapper to `src/core/mdstruct.ts`.** ~~Rewrite the import specifier in 17 files.~~
   Done. Import paths only, so distill's behaviour is untouched. This was the precondition for every
   step below.
2. **Swap `verify.ts`'s three structural axes** to one `parseDoc` per side. Add the exit 5 path and
   its `--help` line. This closes defect 1, the frontmatter asymmetry, and the setext-to-ATX double
   drift. It is the smallest surface with the most expensive failure.
3. **Swap `sequence.ts` and `wordcap.ts`** to walk `nodes[]` instead of lines. This closes defects 2
   and 4 together, retires `stripLeadingMarker`, and picks up blockquoted fences.
4. **Swap `guard.ts`'s list and code axes** to `list` / `listItem` / `codeBlock` nodes. This also
   closes the nested-sublist undercount its own comment admits.
5. **Fix `MASK_RE`'s code-span spelling** to close defect 3. Do it last and alone: it reaches
   distill's harvest probes and, through `createMasker`, distill's `revise()`. Re-run the distill
   suite and add a pin for the double-backtick specimen.
6. **Correct the three comments** in `core/text.ts` and `verify.ts` named above.

Deferred, in order: an mdstruct-backed masker, which waits on the crate's `htmlInline` gap; and the
distill-only rows in the first table, which need their own ticket.
