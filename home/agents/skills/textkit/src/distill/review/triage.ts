// triage — the distill instance of the interactive-text format: maps pipeline
// Residue into decision blocks and serializes the intermediary that compress-mode
// emit writes and `apply` (Phase 4) consumes. The grammar itself lives in
// interact.ts (instance-blind); this module owns the triage policy — the verb
// vocabulary, the reason-class → verb mapping, and the mandatory trailing gate.
// fixtures/interact-triage-emit.md is the byte-exact golden for buildIntermediary.
//
// PURE by contract: no fs, no LLM. The stamp (src=) and destination are computed
// by the caller and passed in, so the fixture's hash is injectable in tests.
import {
  type BlockSpec,
  renderBlock,
  sanitizeNote,
  sanitizePayload,
  targetIsRenderable,
} from "@/distill/review/interact.ts";
import { parseFrontmatter } from "@/core/frontmatter.ts";
import type { Residue } from "@/distill/review/residue.ts";

/// The triage vocabulary: `recover` — failed items; checked = re-render from the fenced
/// source at apply (verbatim splice on a second grade failure). `keep` — gate-inconclusive
/// items, which SHIPPED in the body unverified; checked = keep as shipped, no LLM.
/// `reviewed` — the confirm-all gate item. Unchecked is uniform across the block: the entry
/// is removed from the final note.
export const TRIAGE_VERBS = ["recover", "keep", "reviewed"] as const satisfies readonly string[];

const RESIDUE_INTRO =
  "Residue triage. Checked `recover:` re-renders the entry from its fenced source " +
  "(spliced verbatim if it fails the grade again); checked `keep:` keeps the entry " +
  "exactly as it stands above; unchecked means the entry is removed from the final note.";

/// A single-line, backtick-free, non-empty handle for a hostile edge/payload/prose
/// label: backticks stripped (the payload carries the verbatim truth, the target is
/// only a grep handle), internal whitespace (including newlines) collapsed to a
/// single space, truncated so a fenced code block doesn't become a wall of a target.
/// Exported for apply-mode.ts (Phase 4): a def whose term carries a backtick/newline
/// ships a DEGRADED target (safeHandle(term) ≠ term), so apply matches a recover/keep/
/// remove back to its glossary row by re-deriving safeHandle over each row's real
/// term — the emit transform run in reverse, no handle→term channel in the file.
export function safeHandle(label: string): string {
  const collapsed = label.replace(/`/g, "").replace(/\s+/g, " ").trim();
  const truncated = collapsed.length > 80 ? `${collapsed.slice(0, 80).trimEnd()}…` : collapsed;
  return truncated || "(unlabeled)";
}

/// The render target (and whether it should render backticked) for one residue entry, keyed
/// by its kind — see the case comments below for the addressing scheme per kind.
function targetFor(r: Residue): { target: string; targetCode?: boolean } {
  switch (r.kind) {
    case "def":
      // renderBlock's domain guards reject a backtick or newline in a target, and a
      // term CAN carry one (LLM-extracted, unsanitized) — degrade such a term to the
      // safeHandle grep-handle instead of crashing the emit after the full LLM run.
      // The fenced payload still carries the verbatim source; apply-side row matching
      // for degraded handles is Phase 4's seam. targetIsRenderable is interact.ts's own
      // guard predicate, so this check can't drift from what renderBlock would throw on.
      if (!targetIsRenderable(r.label)) {
        return { target: safeHandle(r.label), targetCode: true };
      }
      return { target: r.label, targetCode: true };
    case "steps": {
      // Canonical `## Procedures` groups numbered steps under per-headword `### headword`
      // subsections, so a step is addressed by (headword, stepIdx), not a global ordinal.
      // The label IS the procedure headword (pipeline stamps v.id); safeHandle guards a
      // headword carrying a backtick/newline (a bare target cannot be backticked). A
      // populated stepIdxs appends the 1-based indices (`procedure:<headword>:2,3`); an empty
      // stepIdxs (per-step spans deferred — the canonical backstop) addresses the WHOLE
      // procedure (`procedure:<headword>`), which apply refuses to recover per-step and
      // ignores on removal until per-step spans land.
      const hw = safeHandle(r.label);
      if (r.stepIdxs && r.stepIdxs.length > 0) {
        return { target: `procedure:${hw}:${r.stepIdxs.map((i) => i + 1).join(",")}` };
      }
      return { target: `procedure:${hw}` };
    }
    case "thesis":
      return { target: "thesis" };
    default: // edge | payload | prose
      return { target: safeHandle(r.label) };
  }
}

/// One `pick-any id=residue` block, one unchecked item per residue entry in array order —
/// nothing pre-checked, since the reason string is diagnosis, not a recommendation. Verb by
/// reason class: "gate-inconclusive" → `keep`, everything else → `recover`. Targets: def →
/// the term (backticked via targetCode); steps → `procedure:<headword>:<stepIdxs 1-based,
/// comma-joined>` (the headword-scoped step address into the canonical `## Procedures` list;
/// drops the `:<idxs>` tail to address the whole procedure when stepIdxs is absent/empty);
/// thesis → `thesis`; edge/payload/prose → a single-line handle derived from the label
/// (backticks stripped, whitespace collapsed, truncated — the fenced payload carries the
/// verbatim truth). Item note = the reason string, newlines flattened to spaces. Payload = the
/// verbatim source excerpt; omitted when the entry carries none. Returns [] when residue is
/// empty.
export function residueToBlocks(residue: Residue[]): BlockSpec[] {
  if (residue.length === 0) return [];
  return [
    {
      kind: "pick-any",
      id: "residue",
      intro: RESIDUE_INTRO,
      items: residue.map((r) => ({
        state: "unchecked" as const,
        verb: r.reasonClass === "gate-inconclusive" ? "keep" : "recover",
        ...targetFor(r),
        // renderBlock rejects any CR in a note or payload, and a CRLF source note
        // threads CRs into residue verbatim — a crash HERE would land after the whole
        // LLM run. sanitizeNote/sanitizePayload are interact.ts's own guard-paired
        // sanitizers: notes flatten to one line; payloads keep their lines, LF-normalized.
        note: sanitizeNote(r.reason),
        payload: r.source === "" ? undefined : sanitizePayload(r.source),
      })),
    },
  ];
}

const EPISTEMIC_LINE = "epistemic_status: in-review";

/// Force `epistemic_status: in-review` into a frontmatter block — the intermediary's
/// leak self-label, overriding any existing value (this file is not the certified
/// note; it is a review artifact apply will later replace). front === "" (no
/// frontmatter at all) creates a minimal block.
function forceEpistemicStatus(front: string): string {
  if (front === "") return `---\n${EPISTEMIC_LINE}\n---\n`;
  const crlf = front.includes("\r\n");
  const nl = crlf ? "\r\n" : "\n";
  const lines = front.split(nl);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const filtered = lines.filter((l) => !l.startsWith("epistemic_status:"));
  let close = -1;
  for (let i = filtered.length - 1; i >= 0; i--) {
    if (filtered[i] === "---" || filtered[i] === "...") {
      close = i;
      break;
    }
  }
  if (close <= 0) return front; // malformed: leave as-is rather than guess
  filtered.splice(close, 0, EPISTEMIC_LINE);
  return filtered.join(nl) + nl;
}

/// Serialize the intermediary (byte-exact): the future note (frontmatter
/// with epistemic_status FORCED to "in-review" — the leak self-label; created when
/// the note has no frontmatter) + the residueToBlocks block (when any) + the
/// mandatory `confirm-all id=triage-final` gate LAST, carrying dest=<opts.dest>
/// and src=<opts.src> verbatim, intro "Check this last, on the device you will
/// apply from.", and one item `reviewed: residue triage above is final` (residue
/// present) or `reviewed: distilled result above is final` (clean run), noted
/// "apply writes <opts.dest> and deletes this file". Blocks render via
/// interact.ts renderBlock; the document ends with exactly one newline.
/// opts.dest is the destination BASENAME; opts.src is "new" (creation case) or
/// "sha256:<12hex>" of the destination's current bytes — caller-computed, so the
/// golden test injects the fixture's literal stamp.
export function buildIntermediary(
  note: string,
  residue: Residue[],
  opts: { dest: string; src: string },
): string {
  const { front, body } = parseFrontmatter(note);
  const forcedFront = forceEpistemicStatus(front);
  const noteOut = forcedFront === "" ? body : `${forcedFront}\n${body}`;

  const blocks = residueToBlocks(residue);
  const gate: BlockSpec = {
    kind: "confirm-all",
    id: "triage-final",
    dest: opts.dest,
    src: opts.src,
    intro: "Check this last, on the device you will apply from.",
    items: [
      {
        state: "unchecked",
        verb: "reviewed",
        target:
          residue.length > 0 ? "residue triage above is final" : "distilled result above is final",
        note: `apply writes ${opts.dest} and deletes this file`,
      },
    ],
  };

  const rendered = [...blocks, gate].map(renderBlock).join("");
  const out = `${noteOut}\n${rendered}`;
  return out.replace(/\n+$/, "\n");
}
