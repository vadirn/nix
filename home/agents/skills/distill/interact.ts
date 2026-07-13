// interact — the grammar core of the interactive-text format (spec:
// interactive-text-format.md; frozen by interact.test.ts). Markdown intermediaries
// carry reviewer decisions as native task-list checkboxes inside HTML-comment-
// anchored blocks; a processor parses the checked states and acts. Both directions
// live here so the round-trip law parseInteract(renderBlock(spec)) ≡ spec is a
// testable property.
//
// Region recognition delegates to the single Rust engine (mdstruct): parseDoc emits
// every comment-anchor pair (fence-aware, inline-code-aware), and checkRegion reports
// unpaired anchors. interact is a pure FILTER over that — it owns no document scanner,
// no fence tracking. Its own recognizer (the "thin pass") was retired in Phase B; what
// stays here is the block-body grammar (kind/attribute/intro/item/payload semantics).
//
// Deterministic by contract: no fs, no LLM, no imports from distill-core.ts. It does shell
// mdstruct (via mdstruct.ts, synchronously) to locate regions — determinism is preserved
// because the same source yields the same regions. Malformed input yields typed errors,
// never guesses.
//
// Body-grammar discipline the tests pin (constraints the signatures can't show):
// - fence-state-first at document level (anchors inside a content code fence are
//   passthrough) now lives in mdstruct's masked scan; inside a block, a payload fence's
//   interior is still parsed HERE (anchor-looking lines in it are payload bytes);
// - CRLF-tolerant: a trailing '\r' on a line is line-terminator residue, stripped
//   before scanning, so a CRLF copy of a document yields the same decision set
//   as its LF form (strip still preserves kept lines byte-identically);
// - anchors tolerate leading whitespace (oxfmt re-indents a closing anchor that
//   lacks a preceding blank line); renderBlock emits a blank line before AND
//   after every closing anchor so our own output never trips that;
// - payloads are untagged fences, fence length = longest backtick run in the
//   payload + 1 (min 3), interior dedented by the fence's indent, otherwise
//   byte-verbatim, no trailing newline;
// - blank pad lines between an item and its fence and between items are legal
//   (oxfmt inserts one on non-final items — fixtures/interact-oxfmt-mangled.md);
// - the verb vocabulary is per-consumer: parse returns verbs as plain strings;
//   resolveInteract validates them against the invoker's spec. The vocabulary
//   never comes from the file.

import { checkRegion, parseDoc, sliceBytes } from "./mdstruct.ts";
import type { MdRegion, RegionDiagnostic } from "./mdstruct.ts";

// ---- kinds and attribute set ----

export type BlockKind = "pick-one" | "pick-any" | "confirm-all";
export const BLOCK_KINDS = [
  "pick-one",
  "pick-any",
  "confirm-all",
] as const satisfies readonly BlockKind[];

/// Checked/unchecked only — '[-]' is a loud bad-state teaching error, not a
/// third state (plan Q1: Obsidian won't toggle it; the "reviewed" bit lives on
/// the confirm-all gate).
export type ItemState = "checked" | "unchecked";

export type Item = {
  state: ItemState;
  /// Lowercase token before ':'. Validated by resolveInteract against the
  /// invoker's vocabulary, never at parse time.
  verb: string;
  /// Backticks stripped; the written form stays in targetRaw.
  target: string;
  targetRaw: string;
  /// Text after the first " — " outside backticks.
  note?: string;
  /// Fence interior, dedented by the fence's indent, otherwise byte-verbatim;
  /// no trailing newline.
  payload?: string;
  /// 1-indexed line of the item, for error messages.
  line: number;
};

export type Block = {
  kind: BlockKind;
  /// Required, unique per file: the reviewer's grep-handle, the machine address,
  /// and the host for the src=/dest= stamp attributes.
  id: string;
  /// Raw stamp value: "new" | "sha256:<hex>". Semantics (hash match, no-clobber)
  /// belong to the consumer; the grammar only carries the string.
  src?: string;
  /// Destination basename the consumer cross-checks against the tmp-derived
  /// destination at apply time. Quoted in the anchor when it contains spaces.
  dest?: string;
  /// Prose between the opening anchor and the first item — the human-facing
  /// instruction. Strips with the block.
  intro?: string;
  items: Item[];
  /// 1-indexed opening-anchor line.
  line: number;
  /// Inclusive 1-indexed line range including both anchors, for strip.
  span: [number, number];
};

// ---- typed errors ----

export type InteractErrorCode =
  // parse-time
  | "bad-anchor" // an interact comment that does not parse as an anchor
  | "unknown-kind"
  | "missing-id"
  | "duplicate-id"
  | "duplicate-attribute"
  | "unknown-attribute" // key set is closed ({id, src, dest}): never guesses
  | "unclosed-block"
  | "unopened-close"
  | "nested-block"
  | "bad-item"
  | "bad-state" // incl. '[-]': message teaches "leave unchecked and check the gate"
  | "empty-block"
  | "unfenced-payload"
  | "unclosed-fence"
  // resolve-time
  | "unknown-verb"
  | "unresolved-pick-one"
  | "gate-unsatisfied";

export type InteractError = {
  code: InteractErrorCode;
  blockId?: string;
  /// 1-indexed.
  line: number;
  /// Human sentence naming the block id and the expectation.
  message: string;
};

/// Thrown by stripInteract on malformed input; carries the parse errors.
export class InteractFormatError extends Error {
  readonly errors: InteractError[];
  constructor(errors: InteractError[]) {
    super(errors.map((e) => `${e.line}: ${e.message}`).join("\n"));
    this.name = "InteractFormatError";
    this.errors = errors;
  }
}

// ---- parse ----

const OPEN_RE = /^[ \t]*<!--\s*interact:\s*(.*?)\s*-->[ \t]*$/;
const CLOSE_RE = /^[ \t]*<!--\s*\/interact\s*-->[ \t]*$/;
const ANCHOR_LIKE_RE = /^[ \t]*<!--.*-->[ \t]*$/;
const KIND_TOKEN_RE = /^[a-z][a-z-]*$/;
const ATTR_KEYS = new Set(["id", "src", "dest"]);
const ITEM_RE = /^-\s\[(.)\]\s(.*)$/;
const VERB_RE = /^([a-z][a-z0-9-]*):\s(.*)$/;
const FENCE_OPEN_RE = /^([ \t]*)(`{3,})[ \t]*$/;
// Tokenizes an anchor's post-`interact:` info into [kind, attr, attr, ...]: a quoted
// attribute value (key="val with spaces") is one token, everything else splits on
// whitespace. Shared by parseAnchor and peekId so the id= grammar has one definition.
const ANCHOR_TOKEN_RE = /[^\s"=]+="[^"]*"|\S+/g;

// Reads just the id= attribute out of an anchor's info string, without validating the
// anchor or recording errors — used where we need a block's id for a message but the
// anchor is being deliberately skipped (e.g. a nested block's outer anchor never gets a
// real parseAnchor() call, since that would misfile it as its own frame).
function peekId(info: string | undefined): string | undefined {
  const tokens = (info ?? "").match(ANCHOR_TOKEN_RE) ?? [];
  for (const tok of tokens.slice(1)) {
    const eq = tok.indexOf("=");
    if (eq === -1) continue;
    if (tok.slice(0, eq) !== "id") continue;
    let val = tok.slice(eq + 1);
    if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    return val;
  }
  return undefined;
}

function splitNote(s: string): { targetRaw: string; note?: string } {
  let inBacktick = false;
  for (let idx = 0; idx + 3 <= s.length; idx++) {
    if (s[idx] === "`") inBacktick = !inBacktick;
    if (!inBacktick && s.slice(idx, idx + 3) === " — ") {
      return { targetRaw: s.slice(0, idx), note: s.slice(idx + 3) };
    }
  }
  return { targetRaw: s };
}

function stripBackticks(raw: string): string {
  if (raw.length >= 2 && raw[0] === "`" && raw[raw.length - 1] === "`") return raw.slice(1, -1);
  return raw;
}

function dedentLine(line: string, indent: string): string {
  if (line.startsWith(indent)) return line.slice(indent.length);
  return line.replace(/^[ \t]*/, "");
}

type Frame = {
  kindRaw: string;
  kindValid: BlockKind | null;
  id?: string;
  src?: string;
  dest?: string;
  introLines: string[];
  sawFirstItem: boolean;
  itemLinesSeen: number;
  items: Item[];
  line: number;
  hasError: boolean;
};

/// Nesting from geometry: an interact region whose span is properly contained in another's.
/// Current-parity — neither the outer nor the inner emits a block; one nested-block error per
/// contained region names the containing block's id at the inner anchor's opening line. Pure
/// over the sorted region list: returns the set of every region index touched by a containment
/// (both members of each pair, so the dispatch loop can skip them) alongside the errors the
/// caller appends, mutating nothing it was handed. `peekId` reads the outer anchor's id without
/// a real parseAnchor() call, which would misfile the outer as its own frame.
export function detectNestedRegions(regions: MdRegion[]): {
  nested: Set<number>;
  errors: InteractError[];
} {
  const nested = new Set<number>();
  const errors: InteractError[] = [];
  for (let n = 0; n < regions.length; n++) {
    for (let o = 0; o < regions.length; o++) {
      if (o === n) continue;
      const outer = regions[o]!;
      const inner = regions[n]!;
      const contains =
        outer.span[0] <= inner.span[0] &&
        inner.span[1] <= outer.span[1] &&
        !(outer.span[0] === inner.span[0] && outer.span[1] === inner.span[1]);
      if (contains) {
        nested.add(n);
        nested.add(o);
        const outerId = peekId(outer.info);
        errors.push({
          code: "nested-block",
          blockId: outerId,
          line: inner.startLine,
          message: "an interact block cannot open inside another open block",
        });
      }
    }
  }
  return { nested, errors };
}

/// The classification of one dangling (unpaired) anchor the single engine reports, decoupled
/// from the impure parseAnchor step that resolves an open. An `unpaired-close` carries its ready
/// unopened-close error; an `unpaired-open` carries the anchor's post-`interact:` info bytes
/// (undefined when the comment does not even match OPEN_RE) and line, for the caller to hand to
/// parseAnchor — a well-formed open re-parses to unclosed-block, a malformed one to bad-anchor
/// with no unclosed error (parity with the retired scan, where a bad open opened nothing).
export type DanglingClass =
  | { kind: "unopened-close"; error: InteractError }
  | { kind: "unpaired-open"; info: string | undefined; line: number };

/// Pure over (diagnostics, source buffer): slices each open anchor's bytes and reads its info
/// string, leaving the stateful parseAnchor call (which emits content errors and consults the
/// id set) to the caller so this stays free of the parser's accumulators.
export function classifyDangling(dangling: RegionDiagnostic[], buf: Buffer): DanglingClass[] {
  return dangling.map((d) => {
    if (d.type === "unpaired-close") {
      return {
        kind: "unopened-close",
        error: { code: "unopened-close", line: d.line, message: "close without an open block" },
      };
    }
    const anchorText = sliceBytes(buf, d.span);
    const m = anchorText.match(OPEN_RE);
    return { kind: "unpaired-open", info: m ? m[1]! : undefined, line: d.line };
  });
}

/// Parse a whole document. Region boundaries and fence-awareness come from the single
/// Rust engine — parseDoc emits every comment-anchor pair (fence/inline-code aware) and
/// checkRegion reports unpaired anchors — so this function owns no document scanner, only
/// the block-body grammar. Text outside interact regions is passthrough. Never throws on
/// malformed markdown (reported in errors); throws only if the mdstruct binary is
/// unavailable (fail-loud, matching mdstruct.ts).
export function parseInteract(text: string): {
  blocks: Block[];
  errors: InteractError[];
} {
  const rawLines = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (text.endsWith("\n")) rawLines.pop();

  const blocks: Block[] = [];
  const errors: InteractError[] = [];
  const seenIds = new Set<string>();

  // Looks ahead from the item at index i for a payload: zero or more blank pad lines, then
  // either a fence (consumed and attached), an anchor-like line (bailed), indented non-fence
  // content (unfenced-payload), or anything else (no payload). `limit` is the index of the
  // block's closing anchor, so the lookahead never scans past the region. Returns the index
  // the caller should resume from (the last line consumed).
  function consumePayload(item: Item, i: number, frame: Frame, limit: number): number {
    let j = i + 1;
    while (j < limit && rawLines[j]!.trim() === "") j++;
    if (j >= limit) return i;
    const candidate = rawLines[j]!;
    const fenceOpen = candidate.match(FENCE_OPEN_RE);
    if (fenceOpen) {
      const indent = fenceOpen[1]!;
      const tickLen = fenceOpen[2]!.length;
      const interior: string[] = [];
      let k = j + 1;
      let closed = false;
      for (; k < limit; k++) {
        const line = rawLines[k]!;
        const closeMatch = line.trim().match(/^`{3,}$/);
        if (closeMatch && closeMatch[0].length >= tickLen) {
          closed = true;
          break;
        }
        interior.push(line);
      }
      item.payload = interior.map((l) => dedentLine(l, indent)).join("\n");
      if (!closed) {
        errors.push({
          code: "unclosed-fence",
          blockId: frame.id,
          line: j + 1,
          message: `fenced payload opened at line ${j + 1} never closes`,
        });
        frame.hasError = true;
        return limit - 1;
      }
      return k;
    }
    if (ANCHOR_LIKE_RE.test(candidate)) return i;
    if (/^[ \t]/.test(candidate)) {
      errors.push({
        code: "unfenced-payload",
        blockId: frame.id,
        line: j + 1,
        message: "indented content under an item must be a fenced payload",
      });
      frame.hasError = true;
      return j;
    }
    return i;
  }

  // Read an opening anchor's post-`interact:` info into a Frame. Returns null when the content
  // is too malformed to open a block (bad-anchor: no kind token, or the kind is not a lowercase
  // slug). Emits kind/attribute/id errors and registers id uniqueness. `lineNo` is the anchor's
  // 1-indexed line. This is the attribute/kind/id grammar unchanged from the pre-migration scan.
  function parseAnchor(info: string | undefined, lineNo: number): Frame | null {
    const rest = info ?? "";
    const tokens = rest.match(ANCHOR_TOKEN_RE) ?? [];
    const kindToken = tokens[0];
    if (tokens.length === 0 || !kindToken || !KIND_TOKEN_RE.test(kindToken)) {
      errors.push({ code: "bad-anchor", line: lineNo, message: "malformed interact anchor" });
      return null;
    }
    const frame: Frame = {
      kindRaw: kindToken,
      kindValid: (BLOCK_KINDS as readonly string[]).includes(kindToken)
        ? (kindToken as BlockKind)
        : null,
      introLines: [],
      sawFirstItem: false,
      itemLinesSeen: 0,
      items: [],
      line: lineNo,
      hasError: false,
    };
    if (frame.kindValid === null) {
      errors.push({
        code: "unknown-kind",
        line: lineNo,
        message: `unknown block kind '${kindToken}'`,
      });
      frame.hasError = true;
    }
    const seenKeys = new Set<string>();
    for (const tok of tokens.slice(1)) {
      const eq = tok.indexOf("=");
      if (eq === -1) {
        errors.push({
          code: "unknown-attribute",
          line: lineNo,
          message: `malformed attribute '${tok}'`,
        });
        frame.hasError = true;
        continue;
      }
      const key = tok.slice(0, eq);
      let val = tok.slice(eq + 1);
      if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      if (val.includes('"')) {
        // an unterminated or embedded quote: never guess at the value
        errors.push({
          code: "unknown-attribute",
          line: lineNo,
          message: `malformed attribute value for '${key}'`,
        });
        frame.hasError = true;
        continue;
      }
      if (!ATTR_KEYS.has(key)) {
        errors.push({
          code: "unknown-attribute",
          line: lineNo,
          message: `unknown attribute '${key}' (allowed: id, src, dest)`,
        });
        frame.hasError = true;
        continue;
      }
      if (seenKeys.has(key)) {
        errors.push({
          code: "duplicate-attribute",
          line: lineNo,
          message: `duplicate attribute '${key}'`,
        });
        frame.hasError = true;
        continue;
      }
      seenKeys.add(key);
      if (key === "id") frame.id = val;
      else if (key === "src") frame.src = val;
      else frame.dest = val;
    }
    if (frame.id === undefined || frame.id === "") {
      errors.push({
        code: "missing-id",
        line: lineNo,
        message: frame.id === "" ? "empty id= attribute" : "missing id= attribute",
      });
      frame.hasError = true;
    } else if (seenIds.has(frame.id)) {
      errors.push({
        code: "duplicate-id",
        blockId: frame.id,
        line: lineNo,
        message: `duplicate block id '${frame.id}'`,
      });
      frame.hasError = true;
    } else {
      seenIds.add(frame.id);
    }
    return frame;
  }

  // The in-block grammar over the body line range [bodyStart, closeIdx) (0-indexed), where
  // closeIdx is the index of the closing anchor. Fills frame.items / introLines and pushes
  // item/intro/payload errors. Unchanged item/checkbox/intro/payload semantics.
  function parseBody(frame: Frame, bodyStart: number, closeIdx: number): void {
    for (let i = bodyStart; i < closeIdx; i++) {
      const raw = rawLines[i]!;
      const lineNo = i + 1;
      if (raw.trim() === "") {
        // interior blank lines of a multi-paragraph intro are part of the intro; leading
        // blanks are padding, trailing ones are trimmed at finalize.
        if (!frame.sawFirstItem && frame.introLines.length > 0) frame.introLines.push(raw);
        continue;
      }
      const itemMatch = raw.match(ITEM_RE);
      if (itemMatch) {
        frame.sawFirstItem = true;
        frame.itemLinesSeen++;
        const stateChar = itemMatch[1]!;
        const restAfterCheckbox = itemMatch[2]!;
        let state: ItemState;
        if (stateChar === " ") state = "unchecked";
        else if (stateChar.toLowerCase() === "x") state = "checked";
        else {
          if (stateChar === "-") {
            errors.push({
              code: "bad-state",
              blockId: frame.id,
              line: lineNo,
              message: "unsupported state '-' — leave unchecked and check the gate instead",
            });
          } else {
            errors.push({
              code: "bad-state",
              blockId: frame.id,
              line: lineNo,
              message: `unsupported checkbox state '${stateChar}'`,
            });
          }
          frame.hasError = true;
          continue;
        }
        const vm = restAfterCheckbox.match(VERB_RE);
        if (!vm) {
          errors.push({
            code: "bad-item",
            blockId: frame.id,
            line: lineNo,
            message: "item line is missing a 'verb: target' marker",
          });
          frame.hasError = true;
          continue;
        }
        const verb = vm[1]!;
        const { targetRaw, note } = splitNote(vm[2]!);
        const target = stripBackticks(targetRaw);
        const item: Item = {
          state,
          verb,
          target,
          targetRaw,
          note,
          payload: undefined,
          line: lineNo,
        };
        frame.items.push(item);
        i = consumePayload(item, i, frame, closeIdx);
        continue;
      }
      if (!frame.sawFirstItem) {
        frame.introLines.push(raw);
        continue;
      }
      // Stray content after the first item: a mistyped item line silently dropped would be a
      // reviewer's decision lost, so it fails loud instead.
      errors.push({
        code: "bad-item",
        blockId: frame.id,
        line: lineNo,
        message: `unparseable line inside block '${frame.id ?? ""}' — items look like '- [ ] verb: target', payloads are fenced and indented under their item`,
      });
      frame.hasError = true;
    }
  }

  // Close-anchor handling: the empty-block gate, trailing-intro trim, and block push.
  // `closeLineNo` is the closing anchor's 1-indexed line (the span upper bound).
  function finalizeBlock(frame: Frame, closeLineNo: number): void {
    if (frame.itemLinesSeen === 0) {
      errors.push({
        code: "empty-block",
        blockId: frame.id,
        line: frame.line,
        message: `block '${frame.id ?? ""}' has no items`,
      });
      frame.hasError = true;
    }
    while (
      frame.introLines.length > 0 &&
      frame.introLines[frame.introLines.length - 1]!.trim() === ""
    ) {
      frame.introLines.pop();
    }
    const intro = frame.introLines.length ? frame.introLines.join("\n") : undefined;
    if (!frame.hasError && frame.kindValid && frame.id !== undefined) {
      blocks.push({
        kind: frame.kindValid,
        id: frame.id,
        src: frame.src,
        dest: frame.dest,
        intro,
        items: frame.items,
        line: frame.line,
        span: [frame.line, closeLineNo],
      });
    }
  }

  // ---- region-driven dispatch (the single Rust engine locates the anchors) ----
  const { doc, buf } = parseDoc(text);
  const regions = (doc.regions ?? [])
    .filter((r) => r.label === "interact")
    .slice()
    .sort((a, b) => a.span[0] - b.span[0]);

  // Nested regions (spans properly contained in another's) are detected as pure geometry; the
  // helper returns both the skip-set the dispatch loop reads and the nested-block errors to append.
  const { nested, errors: nestedErrors } = detectNestedRegions(regions);
  errors.push(...nestedErrors);

  for (let idx = 0; idx < regions.length; idx++) {
    if (nested.has(idx)) continue;
    const r = regions[idx]!;
    const frame = parseAnchor(r.info, r.startLine);
    if (frame === null) continue; // bad-anchor: this anchor does not open a block
    // Body lines are (startLine+1 .. endLine-1), i.e. 0-indexed [startLine, endLine-1);
    // the closing anchor sits at index endLine-1.
    parseBody(frame, r.startLine, r.endLine - 1);
    finalizeBlock(frame, r.endLine);
  }

  // Dangling (unpaired) anchors come from the single engine's check pass. unpaired-close maps
  // to unopened-close directly. For unpaired-open, re-read the anchor's own bytes to classify
  // it: a malformed open is bad-anchor (and does NOT also count as unclosed, matching the
  // pre-migration scan where such an anchor never opened a block); a well-formed open that
  // simply never closed is unclosed-block, after its content errors.
  const dangling = checkRegion(text, "interact");
  for (const c of classifyDangling(dangling, buf)) {
    if (c.kind === "unopened-close") {
      errors.push(c.error);
      continue;
    }
    const frame = parseAnchor(c.info, c.line);
    if (frame !== null) {
      errors.push({
        code: "unclosed-block",
        blockId: frame.id,
        line: frame.line,
        message: `block '${frame.id ?? ""}' opened at line ${frame.line} is never closed`,
      });
    }
  }

  return { blocks, errors };
}

// ---- resolve (kind semantics + per-consumer verb vocabulary) ----

export type ResolveSpec = {
  /// The invoker's verb vocabulary; any verb outside it (checked or not) is an
  /// unknown-verb error.
  verbs: readonly string[];
};

export type Resolution = {
  /// Checked items in document order across all blocks. Empty whenever errors
  /// is non-empty (apply rule 1: abort before any action).
  fired: {
    blockId: string;
    kind: BlockKind;
    verb: string;
    target: string;
    payload?: string;
    note?: string;
  }[];
  /// One entry per confirm-all block.
  gates: { blockId: string; satisfied: boolean; uncheckedCount: number }[];
  /// unknown-verb, unresolved-pick-one, gate-unsatisfied.
  errors: InteractError[];
};

export function resolveInteract(blocks: Block[], spec: ResolveSpec): Resolution {
  const errors: InteractError[] = [];
  const gates: Resolution["gates"] = [];
  const vocab = new Set(spec.verbs);

  for (const b of blocks) {
    for (const it of b.items) {
      if (!vocab.has(it.verb)) {
        errors.push({
          code: "unknown-verb",
          blockId: b.id,
          line: it.line,
          message: `verb '${it.verb}' is not in the invoker's vocabulary`,
        });
      }
    }
    if (b.kind === "pick-one") {
      const checkedCount = b.items.filter((it) => it.state === "checked").length;
      if (checkedCount !== 1) {
        errors.push({
          code: "unresolved-pick-one",
          blockId: b.id,
          line: b.line,
          message: `pick-one block '${b.id}' must have exactly one checked item, found ${checkedCount}`,
        });
      }
    }
    if (b.kind === "confirm-all") {
      const uncheckedCount = b.items.filter((it) => it.state === "unchecked").length;
      const satisfied = uncheckedCount === 0;
      gates.push({ blockId: b.id, satisfied, uncheckedCount });
      if (!satisfied) {
        errors.push({
          code: "gate-unsatisfied",
          blockId: b.id,
          line: b.line,
          message: `confirm-all gate '${b.id}' is not satisfied (${uncheckedCount} unchecked)`,
        });
      }
    }
  }

  const fired =
    errors.length === 0
      ? blocks.flatMap((b) =>
          b.items
            .filter((it) => it.state === "checked")
            .map((it) => ({
              blockId: b.id,
              kind: b.kind,
              verb: it.verb,
              target: it.target,
              payload: it.payload,
              note: it.note,
            })),
        )
      : [];

  return { fired, gates, errors };
}

// ---- strip ----

/// Removes every block span (anchors, intro prose, items, payloads) plus the
/// adjacent blank padding, collapsing to at most one blank line of separation;
/// content checkboxes outside blocks survive byte-identically. A document with
/// no blocks is returned byte-identical. Throws InteractFormatError on any
/// parse error — never guesses at what to remove.
export function stripInteract(text: string): string {
  const { blocks, errors } = parseInteract(text);
  if (errors.length > 0) throw new InteractFormatError(errors);
  if (blocks.length === 0) return text;

  const endsNL = text.endsWith("\n");
  const arr = text.split("\n");
  if (endsNL) arr.pop();

  const del: boolean[] = new Array(arr.length).fill(false);
  for (const b of blocks) {
    for (let ln = b.span[0]; ln <= b.span[1]; ln++) del[ln - 1] = true;
  }

  // Absorb only the blank padding adjacent to each removed span, leaving at
  // most one blank line between the kept neighbors (none at a document edge).
  // Kept lines are byte-identical: a distant multi-blank run or a trailing
  // space in content is not strip's to touch.
  const out: string[] = [];
  let i = 0;
  while (i < arr.length) {
    if (!del[i]) {
      out.push(arr[i]!);
      i++;
      continue;
    }
    let absorbedBlank = false;
    while (out.length > 0 && out[out.length - 1]!.trim() === "") {
      out.pop();
      absorbedBlank = true;
    }
    while (i < arr.length && (del[i] || arr[i]!.trim() === "")) {
      if (!del[i]) absorbedBlank = true;
      i++;
    }
    if (absorbedBlank && out.length > 0 && i < arr.length) out.push("");
  }
  return out.join("\n") + (endsNL ? "\n" : "");
}

// ---- render ----

export type BlockSpec = {
  kind: BlockKind;
  id: string;
  src?: string;
  dest?: string;
  intro?: string;
  items: {
    state: ItemState;
    verb: string;
    target: string;
    /// Render the target wrapped in backticks — the reading-view cue for a
    /// glossary term (plan-§5 fixture: def targets are backticked, workflow/gate
    /// targets are not). Purely presentational: parse strips the backticks back
    /// to the same semantic target, so the round-trip law still holds. The
    /// backtick-in-target throw is unaffected — the semantic target itself may
    /// never carry one.
    targetCode?: boolean;
    note?: string;
    payload?: string;
  }[];
};

/// Emit side. Anchor attributes in the order id, dest, src; values quoted only
/// when they contain whitespace. Payload fences untagged, indented two spaces
/// under the item, fence length = longest backtick run in the payload + 1
/// (min 3). Targets containing " — " (or leading/trailing space) are backticked
/// so the note split stays unambiguous. Blank line before and after every
/// closing anchor (the oxfmt reflow fix). Round-trip law:
/// parseInteract(renderBlock(spec)) ≡ spec — enforced by throwing on any spec
/// the grammar cannot carry back: newlines/carriage returns in fields, a
/// backtick in a target (pass the semantic target; formatting is the
/// renderer's), a non-slug id or verb, a quote in dest/src, an intro that is
/// empty, starts/ends blank, or holds a line that would re-parse as structure.
function needsBacktick(target: string): boolean {
  return target === "" || target !== target.trim() || target.includes(" — ");
}

function quoteIfNeeded(val: string): string {
  return /\s/.test(val) ? `"${val}"` : val;
}

function longestBacktickRun(s: string): number {
  const runs = s.match(/`+/g);
  return runs ? Math.max(...runs.map((r) => r.length)) : 0;
}

const RENDER_ID_RE = /^[A-Za-z0-9_-]+$/;
const RENDER_VERB_RE = /^[a-z][a-z0-9-]*$/;
const NEWLINE_OR_CR_RE = /[\n\r]/;
const BACKTICK_RE = /`/;

// ---- field predicates/sanitizers shared with triage.ts ----
// triage.ts pre-satisfies these same throw guards before handing fields to renderBlock
// (e.g. degrading a def's target to safeHandle() when the raw term wouldn't render).
// Deriving that off the SAME regex constants the guards below use — rather than a
// hand-copied char class — means a guard change here can't silently desync triage's
// sanitization from what actually throws.

/// True iff target would NOT trip renderBlock's target guards (no backtick, no
/// newline/CR). Consult before deciding whether a field needs degrading (e.g. to
/// safeHandle()) ahead of a renderBlock call.
export function targetIsRenderable(target: string): boolean {
  return !NEWLINE_OR_CR_RE.test(target) && !BACKTICK_RE.test(target);
}

/// Flattens whatever renderBlock's note guard rejects (newline/CR) to a single space.
export function sanitizeNote(note: string): string {
  return note.replace(/[\r\n]+/g, " ");
}

/// Normalizes whatever renderBlock's payload guard rejects (a bare CR) to LF.
export function sanitizePayload(payload: string): string {
  return payload.replace(/\r\n?/g, "\n");
}

/// The renderBlock precondition, split out so the throw-guards read as a named
/// contract ("is this spec renderable") separate from the emission below. Composes
/// the shared predicates/sanitizers above (targetIsRenderable, sanitizeNote,
/// sanitizePayload) rather than re-deriving the char classes they already cover —
/// a guard change there can't silently desync from what actually throws here.
function assertRenderable(spec: BlockSpec): void {
  if (!RENDER_ID_RE.test(spec.id)) {
    throw new Error(`renderBlock: id '${spec.id}' is not a slug`);
  }
  for (const key of ["dest", "src"] as const) {
    const val = spec[key];
    if (val !== undefined && /["\n\r]/.test(val)) {
      throw new Error(`renderBlock: quote or newline in ${key} is not allowed`);
    }
  }
  if (spec.intro !== undefined) {
    const introLines = spec.intro.split("\n");
    if (
      spec.intro === "" ||
      introLines[0]!.trim() === "" ||
      introLines[introLines.length - 1]!.trim() === ""
    ) {
      throw new Error("renderBlock: intro cannot be empty or start/end with a blank line");
    }
    for (const l of introLines) {
      if (l.includes("\r") || OPEN_RE.test(l) || CLOSE_RE.test(l) || ITEM_RE.test(l)) {
        throw new Error("renderBlock: intro line would re-parse as block structure");
      }
    }
  }
  for (const it of spec.items) {
    if (!RENDER_VERB_RE.test(it.verb)) {
      throw new Error(`renderBlock: verb '${it.verb}' is not a lowercase slug`);
    }
    if (!targetIsRenderable(it.target)) {
      if (NEWLINE_OR_CR_RE.test(it.target)) {
        throw new Error("renderBlock: newline in target is not allowed");
      }
      throw new Error(
        "renderBlock: backtick in target is not allowed — pass the semantic target, formatting belongs to the renderer",
      );
    }
    if (it.note !== undefined && sanitizeNote(it.note) !== it.note) {
      throw new Error("renderBlock: newline in note is not allowed");
    }
    if (it.payload !== undefined && sanitizePayload(it.payload) !== it.payload) {
      throw new Error("renderBlock: carriage return in payload is not allowed");
    }
  }
}

export function renderBlock(spec: BlockSpec): string {
  assertRenderable(spec);

  let attrs = ` id=${spec.id}`;
  if (spec.dest !== undefined) attrs += ` dest=${quoteIfNeeded(spec.dest)}`;
  if (spec.src !== undefined) attrs += ` src=${quoteIfNeeded(spec.src)}`;

  let out = `<!-- interact: ${spec.kind}${attrs} -->\n\n`;
  if (spec.intro) out += `${spec.intro}\n\n`;

  const chunks: string[] = [];
  spec.items.forEach((it, idx) => {
    if (idx > 0) chunks.push("");
    const targetRaw = it.targetCode || needsBacktick(it.target) ? `\`${it.target}\`` : it.target;
    let line = `- [${it.state === "checked" ? "x" : " "}] ${it.verb}: ${targetRaw}`;
    if (it.note !== undefined) line += ` — ${it.note}`;
    chunks.push(line);
    if (it.payload !== undefined) {
      const fenceLen = Math.max(longestBacktickRun(it.payload) + 1, 3);
      const fence = "`".repeat(fenceLen);
      chunks.push(`  ${fence}`);
      for (const pl of it.payload.split("\n")) chunks.push(`  ${pl}`);
      chunks.push(`  ${fence}`);
    }
  });

  out += chunks.join("\n") + "\n\n";
  out += "<!-- /interact -->\n\n";
  return out;
}
