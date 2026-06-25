# cut — wikilink protection + revise fidelity

Status: implemented in `home/agents/skills/cut/cut.ts`.

## Problem

A field test of `/cut` on a vault note lost wikilinks two ways:

1. **Block drop.** The editor can drop a whole block that carries a `[[wikilink]]`, destroying a deliberate graph connection that is expensive to recreate.
2. **Inline strip.** The revise passes rewrite survivor text and strip inline markdown (`[[wikilinks]]`, `**bold**`, `_italic_`) and introduce typographic substitutions (curly quotes), mangling links that survived the cut.

These are independent: (1) is a cut/grade decision, (2) is a revise-prompt fidelity issue. Both need fixing.

## Decisions

The pipeline order is unchanged — segment → editor cut → judge gate → reconstruct → revise → output. The judge is the restore _gate_: it runs before the cut is final and decides what to restore. Rejected alternatives, with reasons:

- **Weigh-first / grade-last.** `load`/`borderline`/`surplus` already is the weight scale; a separate numeric weigh step adds a call and a threshold to calibrate without fixing anything. Moving the grade past revise turns the gate into a passive report and churns revised-vs-restored ordering.
- **Relocate wikilinks to a "References" section.** Most vault wikilinks are inline and load-bearing ("as `[[Cornforth]]` argues…") and cannot move without breaking the sentence; creating that heading also violates the tool's existing no-new-structure rule (`revisePrompt`).
- **Deterministic force-keep (regex → exempt from drop).** Bulletproof against loss, but blunt: a bare `Related: [[a]] [[b]]` footer would always survive even when it is genuinely surplus. Superseded by the flag+clamp below, which keeps the loss guarantee and adds nuance.
- **Plain `has_wikilink` hint to the judge.** Resolves the footer case but reintroduces the original failure: a hint the judge merely weighs can still grade a wikilink block `surplus`, silently dropping it. A model signal is softer than a guarantee.

Adopted: **deterministic detection + bounded judge authority.** The judge still decides, but cannot silently drop a wikilink.

## Edit 1 — `has_wikilink` flag to the judge

Detect deterministically (no model call). One regex covers both wikilinks and embeds, since `![[…]]` contains `[[…]]`:

```ts
const WIKILINK = /\[\[[^\]]+\]\]/;
const hasWikilink = (text: string): boolean => WIKILINK.test(text);
```

In `judgePrompt`, annotate each dropped block with its flag (e.g. a `[wikilink]` marker beside the `[Bn]` id, or a parallel id list in the prompt) and add the grading constraint:

> A block that contains a wikilink carries a deliberate connection. Grade it `load` (inline in load-bearing prose) or `borderline` (e.g. a bare list of related links), **never `surplus`**.

The flag is shown to the **judge only**, not the editor. The editor's role is to over-cut ruthlessly; leave it blind and let the judge + clamp do the protecting.

## Edit 2 — surplus→borderline clamp in reconstruct

The prompt constraint is a request; the clamp is the guarantee. In `cutText`, after building `gradeById` (`cut.ts:305`), force the floor for dropped wikilink blocks — covering both a `surplus` grade and a **missing** grade (a missing grade currently falls through to a silent drop):

```ts
for (const b of dropped) {
  if (hasWikilink(b.text) && gradeById.get(b.id) !== "load") {
    gradeById.set(b.id, "borderline");
  }
}
```

Effect via the existing reconstruct logic (`cut.ts:312`–`313`): a wikilink block is either restored (`load` → kept) or flagged (`borderline` → dropped + named in the footer for the parent to restore). It can never be dropped silently. A genuine link-dump footer still gets cut — but visibly, with a restore path.

## Edit 3 — revise fidelity (three-way split)

This is independent of the wikilink rule and fixes inline strip (problem 2). A prompt-only instruction was tried first and is **insufficient** — verified empirically:

- gpt-oss-120b substitutes typography regardless of instruction. A revise survivor turned `in-flight` into `in‑flight` (U+2011 NON-BREAKING HYPHEN, confirmed by codepoint). Online consensus matches: smart-quote / em-dash / unicode-hyphen emission is a known LLM artifact, fixed by deterministic post-normalization (a whole "AI text formatter" tool class plus standard unicode→ASCII recipes), never by prompting.
- Markdown loss is **stochastic, not a deterministic strip**. Method-of-difference test: `**atomic**` survived two in-place rewrites (one heavy). It died in the original fixture only when revise _merged two blocks and dissolved the bolded span_ into a new clause. So preservation holds in the common case and fails on span dissolution.

The failure modes differ, so the fix splits three ways rather than guarding everything:

1. **Typographic substitution → deterministic post-normalize.** A `normalizeTypography()` mapping the finite set (curly quotes → straight, hyphen/non-breaking-hyphen/figure/en/em/bar dashes → `-`, ellipsis → `...`, nbsp → space) applied to each revised block. Certain, no downside. Do **not** frame this as "stay ASCII" — `PASS_RU` prose is non-ASCII by definition; the map targets only typographic substitutes, leaving Cyrillic and source guillemets alone.
2. **Reference tokens → placeholder-mask.** Wikilinks `[[…]]`, embeds `![[…]]`, and inline code `` `…` `` are atomic references that must survive verbatim and never need rewording. Before the revise passes, replace each with an opaque token (`⟦0⟧`, `⟦1⟧`, …); after the passes, restore verbatim. Makes their survival deterministic and reword-immune — covers a `load`-graded wikilink block, which reaches revise. Masking, normalize, then restore, so injected originals are untouched by the normalize step.
3. **Emphasis (`**bold**`/`*italic*`) → prompt, best-effort.** Do **not** mask it: emphasis spans real words that legitimately get reworded, so masking would block valid edits to win a cosmetic marker. The prompt instruction preserves it in the common case; the rare merge-dissolution loss is not worth fighting the rewrite.

Principle: mask what must be verbatim and is reword-immune (references); prompt for what is entangled with rewording (emphasis); post-normalize the finite typographic set.

`revisePrompt`'s constraint clause (covers both `PASS_EN` and `PASS_RU`):

> Keep code blocks verbatim, and copy any `⟦N⟧` placeholder tokens exactly — never alter, translate, or remove them. Preserve emphasis (`**bold**`, `_italic_`). Do not introduce typographic substitution (curly quotes, en/em dashes).

Residual risk: the model could drop or alter a `⟦N⟧` token despite the instruction, losing that reference. Verify with a `load`-graded wikilink fixture; if it surfaces, make restore tolerant of whitespace inside the token (`⟦\s*N\s*⟧`).

## Out of scope

- **oxfmt normalize-first.** Verified clean on markdown (wikilinks, embeds, callouts, images, straight quotes all survive; it only canonicalizes block boundaries, e.g. inserts the blank line after a heading). It is also already ambient: `home/claude/hooks/post-tool-format.sh` runs oxfmt on every vault `.md` written through the agent, so agent-written notes arrive pre-normalized for `segment()`. Adding an explicit oxfmt pre-step in `cut.ts` would only help stdin-piped, never-written text — a nice-to-have, not part of this change.

## Verification

Write the fixture via the **Write tool**, not a heredoc or `printf` — zsh/harness escaping turns `!` into `\!` inside the shell, which silently corrupts `![[embed]]` and `[!callout]` before any tool sees them (this misfire happened while speccing). Fixture covers: an inline wikilink in load-bearing prose, a bare `Related: [[a]] [[b]]` footer, an embed, a callout, `**bold**`/`_italic_`, and straight quotes.

Run under `doppler run --project claude-code --config std --` and assert:

1. Every wikilink block is either kept in stdout (`load`) or named in the stderr footer (`borderline`) — never silently dropped. The judge decides load-vs-flag; the guarantee is only "never silent," so a borderline grade for an inline wikilink is acceptable.
2. The link-dump footer is dropped **and** named in the stderr footer (`borderline`) — not silently gone.
3. A `load`-graded wikilink block that reaches revise keeps its `[[…]]` verbatim (masking holds; the `⟦N⟧` token round-trips).
4. Revise output contains no typographic substitutes: no curly quotes, no en/em/non-breaking-hyphen codepoints (`rg '[^\x00-\x7F]'` shows only intended non-ASCII, e.g. Cyrillic for RU). `**bold**` preserved in the common case (best-effort).

Build with `bun build home/agents/skills/cut/cut.ts` before running.
