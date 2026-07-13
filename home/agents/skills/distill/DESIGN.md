# distill — design anchors

The code cites an external spec, blueprint, decision log, work brief, and build log
through short tokens in comments: `spec §N`, `blueprint §N`, `D<n>`, `W<n>`, `Log <n>`.
Those source documents are retired and were never checked in. This file is their
in-repo replacement: every heading below is keyed by the exact token the comments use,
so a `// … (D13)` anchor resolves by grepping this file for `D13`.

Provenance: reconstructed from the inline comments that cite each anchor, not from the
original documents (which no longer exist). Each entry names the authoritative
`file:line` where the code explains it most fully — that site, not this summary, is
ground truth; this catalog only makes the token resolvable. Where an anchor is only ever
cited without an inline definition, the entry says so.

The five knowledge-element types (`spec §1`) and the seven-section projection (`spec §3`)
are the two anchors everything else orbits; read those first.

## Spec

The spec fixes distill's data model and stage sequence — what a distillation _is_.

### spec §1 — the typed knowledge-element ontology

A distillation is a typed, span-anchored knowledge graph `{ source, units[], edges[] }`
over five knowledge-element types: **concept / judgment / inference / procedure /
payload**. Markdown is one projection of the graph, not the graph itself.
Ground: `graph.ts:1`, `distill.ts:5`.

### spec §2 — the span-locate fidelity gate

The model never emits byte offsets. Every unit and edge carries a verbatim `quote`; a
locate pass resolves each quote to a byte span against the source, and a quote that fails
to round-trip **hard-aborts before any projection**. Spans use the half-open `start..end`
notation (bare or bracketed `[start..end]`, both the same range).
Ground: `locate.ts:1`; span notation at `graph.ts:129`.

### spec §3 — the seven-section markdown projection

The canonical render of the graph: YAML frontmatter mirroring the mdstruct Source, a
`# title`, an unanchored `## Abstract`, then the type-as-section blocks (`## Concepts` /
`## Judgements` / `## Inferences` / `## Procedures` / `## Payload`) and finally
`## Relations`. A section appears only when a unit/edge of that type exists — an empty
section is never emitted (absence is diagnostic). Modality tags ride the judgement/
inference bullets (assertoric emits none); `rel` is an open token (see D32); a unit with
no located quote renders **unanchored** (the synthesized-step-2 convention). This is the
heaviest-cited spec anchor and the sole projector for every build path.
Ground: `project.ts:2`; worked renders at `project.test.ts:2`.

### spec §4 — the pipeline stage sequence

Three stages: **extract** (native typed pre-graph + per-unit source quotes) → **locate**
(quote → span, run immediately after extract, not deferred to end-of-pipeline) →
**span-typing review** (interactive type confirmation, `blueprint §11`).
Ground: `distill.ts:19`, `locate-graph.ts:1`.

## Blueprint

The blueprint is the implementation map — the stages of `spec §4` broken into the modules
and lanes that realize them. Several sections are only ever cited by numbered sub-part;
the bare-section meaning is inferred from those sub-parts, not stated in the code.

### blueprint §0 — the canonical compress core

The spine: extract native typed units → retain-grade payload → locate → project.
Ground: `distill-core.ts:121`, `distill.ts:19`.

### blueprint §1 — the extract stage internals

Cited only by sub-part: **§1.1** the deterministic payload **retain lane** — the one
selection that survives (computed by `gradeBlocks`, `prompts.ts:246`); **§1.2** the
projection never renders the `predicate` field (`graph.ts:99`); **§1.4** the **pre-graph**,
extract's output before locate (`graph.ts:74`).

### blueprint §2 — the locate stage

Turns a `PreGraph` into the span-anchored canonical graph.
Ground: `locate-graph.ts:1`.

### blueprint §4 — the demoted fidelity gate

Cited only as **§4.2**: the retired settle-chain gate reduced to its verdict half — it
runs after projection, is residue-only, and never recovers or rewrites. See D46 for the
prose-coverage counterpart.
Ground: `gates.ts:19`.

### blueprint §6 — the build/output paths

By sub-part: **§6.1** the synthesized `## Abstract` head, omitted by `--glossary`
(`distill-core.ts:211`); **§6.2** `--reference` keeps the head but suppresses `## Relations`
(see D30); **§6.3** the per-section **routed/heterogeneous build** (`distillRouted`, whose
head spans index the reassembled whole source, `distill-core.ts:331`).

### blueprint §8 — per-step spans deferred

The procedures-step residue field (`stepIdxs`) stays typed, but the canonical backstop
always emits it empty, awaiting a future per-step-span backstop. Defined once, cited once.
Ground: `residue.ts:40`.

### blueprint §11 — the span-typing review (retype)

distill's second interactive stage, where semantic taste re-enters: **§11.1** the review
vocabulary / `pick-one` per unit; **§11.3** apply the reviewed typing to the graph in
place; **§11.4** the TTY orchestration.
Ground: `retype.ts:1`.

## Decisions

Each `D<n>` records one settled design choice. Ordered numerically, not by weight.

### D1 — residue carries structure, not just a reason string

`residueToBlocks` threads what failed and where structurally (`kind` / `stepIdxs`) rather
than re-deriving it from the reason text, so triage picks the decision verb and target per
entry. Partially explained inline; attributed to "plan §1".
Ground: `residue.ts:22`.

### D2 — one structural detection, N uses

A single structural-payload harvest feeds the residue inventory, the router's
`payloadMask`, and the density signal, so router and inventory can never disagree on what
is structural.
Ground: `text.ts:282`.

### D6 — the single canonical-note reader

The pre-canonical two-channel `GlossEntry` / `Relation` shape is gone; consumers read
term/def via `parseCanonicalNote(body).concepts`.
Ground: `graph.ts:8`, `parse-projection.ts:10`.

### D7 — distilled output is served unverified

Distilled output must not default to trusted: without an explicit `epistemic_status`,
vault-query's absent-key default (`certified`) would wrongly serve agent output as ground.
Co-cited with D18; the two are not distinguished inline.
Ground: `frontmatter.ts:68`.

### D12 — per-section density grain

Each section is routed on its own payload density, not on the note as a whole.
Ground: `text.ts:743`.

### D13 — the cards-layer boundary

`cards/` reads an _emitted_ distilled note — a `.md` file path is the handshake — and
never calls `distill()` or imports `distill-core.ts`. Structural channels are read through one
leaf-module seam (`text.ts`'s `## Relations` parser).
Ground: `cards/types.ts:5`, `cards/cards.ts:7`.

### D16 — payload is held byte-verbatim

Code, tables, and exact numbers are forbidden from paraphrase; payload residue is surfaced
for rollback rather than silently dropped.
Ground: `text.ts:896`.

### D18 — retrieval-trust default (with D7)

The same concern as D7: unverified output must not inherit the `certified` default. Cited
only jointly as "D7/D18"; no independent inline definition.
Ground: `frontmatter.ts:68`.

### D22 — the band verdict annotates, never filters

Every candidate is staged regardless of its band verdict; nothing in `cards/` gates or
drops on it. Admission logic lives downstream at the human commit (Log 10), not in
enumeration.
Ground: `cards/types.ts:7`, `cards/cards.ts:10`.

### D26 — single-atom relation omits the from-label

The single-atom relation form leaves `from` null; the multi-node form carries the entry's
own slug as `from`.
Ground: `text.ts:971`.

### D27 — an agent-distilled note is provisional

An agent-distilled note is unverified until curated, so its frontmatter carries
`epistemic_status: provisional`.
Ground: `frontmatter.ts:65`.

### D29 — relation coercion is lossy

Keep every well-formed edge; drop only when `rel` or `to` is missing. An unknown rel or an
unresolved endpoint is a REBUILD-lint finding, never a BUILD-time drop.
Ground: `text.ts:943`.

### D30 — a reference body stays link-free

A source note whose own frontmatter is `type: reference` renders without `## Relations`.
Automatic from the source frontmatter, not a flag.
Ground: `distill-core.ts:568`, `distill.ts:16`.

### D32 — open relation vocabulary

An off-registry `rel` token is parsed and kept; being off `REL_REGISTRY` is a review flag,
never an error.
Ground: `text.ts:20`.

### D38 — the external-citation lane

External `[text](url)` links are a distinct grounding lane from vault cross-note edges
(`[[wikilink]]` / relative-path); this anchor also names the note's own slug as the source
endpoint of a note-level edge.
Ground: `text.ts:181`.

### D39 — truncation surfaces as an actionable error

A genuine length truncation surfaces as a `TruncationError`, never silent loss. The token
cap is sized never to truncate a real note; the timeout is the de-facto limit.
Ground: `fw.ts:60`.

### D46 — the prose-list-item (prose-judge) gate

A glm matcher over a deterministic inventory of explicit prose list items, producing
coverage residue. Superseded / "Context document" genre notes are licensed to drop
wholesale and skip the gate.
Ground: `text.ts:647`, `distill-core.ts:295`.

## Work items

`W<n>` names a unit of the cards-layer build brief.

### W1 — the relations REBUILD

Parse an emitted note's `## Relations` block back into structural edges. Lives in
`text.ts`, not `cards/`, so cards reads it through one leaf-module seam.
Ground: `text.ts:966`.

### W2 — the pure card-extraction layer

Enumerate candidates, normalize against `REL_REGISTRY`, and assemble the staging record —
zero I/O, zero LLM calls.
Ground: `cards/cards.ts:4`.

### W5 — the staging writer

`renderStagingFile` emits the staging file. Cited only as its test's subject; thinly
defined inline.
Ground: `cards/stage.test.ts:1`.

## Log

`Log <n>` records an observation from a live run that hardened a rule.

### Log 10 — the staging → cards commit boundary

The only path from staging into `20 cards/` is a human commit; the staging file is a
review packet (drafts exist to be rewritten, never auto-accepted), and the vault
frontmatter schema owns the typed `20 cards/` files.
Ground: `cards/types.ts:9`.
