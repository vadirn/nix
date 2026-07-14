// retype — the span-typing review, distill's second interactive moment. It gates each unit's
// `type` against its resolved source slice: one `pick-one` block per unit, the five `UnitType`s
// as options, the unit's standing type pre-checked, and the located slice riding as the
// pre-checked item's payload — so the reviewer checks the type against the ACTUAL span, not the
// model's paraphrase. A mandatory `confirm-all` gate closes the set. Re-typing a unit SETS
// `unit.type` on the flat `DistillationResult.units[]`; it does NOT move units between arrays,
// because this runs AFTER locate where the per-channel `PreGraph` arrays no longer exist —
// `projectMarkdown` re-buckets purely on `unit.type` via `byType`, so setting the field is the
// whole operation.
//
// This is the interact analogue of triage.ts: the grammar (parse/resolve/render, the round-trip
// law parseInteract(renderBlock(spec)) ≡ spec) lives in interact.ts and is untouched; this
// module owns only the typing-review policy — the verb vocabulary, the block-builder, and the
// `type` apply verb.
//
// PURE by contract: no fs, no LLM, no imports from distill-core.ts. The TTY orchestration
// (writing the scratch review, the reviewer sugar-loop) lives in tty.ts; these two functions
// are the pure halves it drives and the whole of what the test surface (retype.test.ts)
// exercises.
import { Buffer } from "node:buffer";
import {
  type BlockSpec,
  InteractFormatError,
  type ItemState,
  parseInteract,
  resolveInteract,
} from "./interact.ts";
import type { DistillationResult, Unit, UnitType } from "./graph.ts";
import { sliceBytes } from "./mdstruct.ts";
import { slugSegment } from "./text.ts";

/// The typing-review vocabulary: `type` on the pick-one items (re-type a unit), `reviewed` on
/// the confirm-all gate (mirroring triage's gate verb). resolveInteract validates a parsed file
/// against exactly this set — any other verb is `unknown-verb`.
export const TYPING_VERBS = ["type", "reviewed"] as const satisfies readonly string[];

// The five knowledge-element types, in projection order — the pick-one options and the guard the
// apply verb checks a re-type target against (a target outside the set is ignored, never assigned).
const UNIT_TYPES: readonly UnitType[] = [
  "concept",
  "judgment",
  "inference",
  "procedure",
  "payload",
];
const UNIT_TYPE_SET = new Set<string>(UNIT_TYPES);

// The gate block id — the single mandatory confirm-all over the whole review.
const TYPING_GATE_ID = "typing-final";

/// A unique, render-safe block id for a unit's pick-one: its handle slug (`slugSegment(unit.id)`)
/// suffixed with the unit's array index. The suffix guarantees BOTH a valid render slug
/// (`^[A-Za-z0-9_-]+$`, which a raw headword with spaces is not) AND per-file uniqueness (two
/// headwords can slug-collide; the index cannot). Exported so the apply verb rebuilds the same
/// id→unit map from the graph (the source of truth) rather than re-parsing the id.
export function typingBlockId(unit: Unit, index: number): string {
  const slug = slugSegment(unit.id);
  return `${slug || "unit"}-${index}`;
}

// The block intro: a single render-safe line orienting the reviewer — the standing type plus the
// unit's current statement, whitespace-collapsed (so no `\r`, no line that re-parses as an item/
// anchor, never blank-edged) and capped. The verbatim source truth rides as the pre-checked item's
// payload; the intro is orientation only, so collapsing the statement to one line loses nothing.
function typingIntro(unit: Unit): string {
  const flat = unit.statement.replace(/\s+/g, " ").trim();
  const shown = flat.length > 300 ? `${flat.slice(0, 299)}…` : flat;
  const head = `Tooling typed this as ${unit.type}. Re-type it against the source slice if wrong`;
  return shown ? `${head}: ${shown}` : `${head}.`;
}

/// Build the span-typing review as interact blocks: one `pick-one` per unit — the five UnitType
/// slugs as `type:` items, the unit's standing type pre-checked — followed by one mandatory
/// `confirm-all` gate. The resolved source slice (`sliceBytes(body, unit.span)`) rides as the
/// payload of the pre-checked (standing-type) item ONLY (apply reads the checked target, never
/// a payload, so carrying the slice once rather than across five items loses nothing). The
/// slice is LF-normalized because renderBlock rejects `\r` in a payload — the graph's span
/// still indexes the true bytes, so this display normalization loses no fidelity. Satisfies the
/// round-trip law by construction: type-name targets are bare lowercase slugs, block ids are
/// slug+index, the intro is a single safe line, the gate is a well-formed confirm-all. `body`
/// is the SAME text the spans index into (the compress body). Returns [] when the graph has no
/// units.
export function buildTypingReview(result: DistillationResult, body: string): BlockSpec[] {
  if (result.units.length === 0) return [];
  const buf = Buffer.from(body, "utf8");
  const blocks: BlockSpec[] = result.units.map((unit, index) => {
    // LF-normalize the display slice: renderBlock throws on a `\r` in a payload (CRLF source).
    const slice = sliceBytes(buf, unit.span).replace(/\r\n?/g, "\n");
    return {
      kind: "pick-one" as const,
      id: typingBlockId(unit, index),
      intro: typingIntro(unit),
      items: UNIT_TYPES.map((t) => ({
        state: (t === unit.type ? "checked" : "unchecked") as ItemState,
        verb: "type",
        target: t,
        payload: t === unit.type ? slice : undefined,
      })),
    };
  });
  blocks.push({
    kind: "confirm-all",
    id: TYPING_GATE_ID,
    intro: "Check this last: confirm every unit's type against its source slice above.",
    items: [{ state: "unchecked", verb: "reviewed", target: "unit types above are final" }],
  });
  return blocks;
}

/// Apply a reviewed typing document to the graph IN PLACE: parse + resolve the (reviewer-edited)
/// text against TYPING_VERBS, then for each fired `type:` item set `units[i].type = target`. The
/// re-type SETS THE FIELD on the flat units[]; it moves nothing between arrays and preserves
/// unit ids, so incident edges stay valid and `projectMarkdown` re-buckets on the field. REFUSES
/// (throws InteractFormatError, graph untouched) on any parse error, an unchecked gate, an
/// unresolved pick-one (zero or two checked), or an unknown verb — resolveInteract returns no
/// fired items when it errors, so no mutation ever lands on a bad review. A fired target outside
/// the five UnitTypes, or a block id that maps to no unit, is ignored (never assigned).
export function applyTyping(result: DistillationResult, editedText: string): void {
  const { blocks, errors: parseErrors } = parseInteract(editedText);
  if (parseErrors.length > 0) throw new InteractFormatError(parseErrors);
  const { fired, errors } = resolveInteract(blocks, { verbs: TYPING_VERBS });
  if (errors.length > 0) throw new InteractFormatError(errors);
  // Rebuild the authoritative blockId → unit-index map from the graph (never from the parsed ids).
  const idToIndex = new Map<string, number>();
  result.units.forEach((u, i) => idToIndex.set(typingBlockId(u, i), i));
  for (const f of fired) {
    if (f.verb !== "type") continue; // the gate's `reviewed` item is not a re-type
    const idx = idToIndex.get(f.blockId);
    if (idx === undefined) continue; // block id maps to no unit — ignore
    if (!UNIT_TYPE_SET.has(f.target)) continue; // target outside the five types — ignore
    result.units[idx]!.type = f.target as UnitType;
  }
}
