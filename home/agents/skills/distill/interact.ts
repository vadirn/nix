// interact — the pure grammar core of the interactive-text format (spec:
// interactive-text-format.md; frozen by interact.test.ts). Markdown intermediaries
// carry reviewer decisions as native task-list checkboxes inside HTML-comment-
// anchored blocks; a processor parses the checked states and acts. Both directions
// live here so the round-trip law parseInteract(renderBlock(spec)) ≡ spec is a
// testable property.
//
// PURE by contract: no fs, no LLM, no imports from pipeline.ts. Deterministic
// parse — malformed input yields typed errors, never guesses.
//
// Scanner discipline the tests pin (constraints the signatures can't show):
// - fence-state-first: inside a fenced payload, anchor-looking lines are payload
//   bytes, never block boundaries; the same holds at document level — an anchor
//   inside a content code fence (a note quoting the format itself) is passthrough,
//   matching what Obsidian renders;
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
// Document-level content fences (tagged or not, backtick or tilde) whose
// interiors are passthrough even when they contain anchor-looking lines.
const DOC_FENCE_OPEN_RE = /^[ \t]*(`{3,})[^`]*$|^[ \t]*(~{3,}).*$/;
const DOC_FENCE_CLOSE_RE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;

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

/// Deterministic scan of a whole document. Text outside blocks is passthrough
/// (never interpreted). Never throws; malformed input is reported in errors.
export function parseInteract(text: string): {
  blocks: Block[];
  errors: InteractError[];
} {
  const rawLines = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (text.endsWith("\n")) rawLines.pop();

  const blocks: Block[] = [];
  const errors: InteractError[] = [];
  const seenIds = new Set<string>();
  let open: Frame | null = null;
  /// Open document-level content fence (outside any block): its char and length.
  let docFence: { ch: string; len: number } | null = null;

  // Looks ahead from the item at index i for a payload: zero or more blank pad
  // lines, then either a fence (consumed and attached), an anchor-like line
  // (bailed — belongs to the enclosing block/document), indented non-fence
  // content (unfenced-payload), or anything else (no payload). Returns the
  // index the main loop should resume from (the last line consumed).
  function consumePayload(item: Item, i: number, frame: Frame): number {
    let j = i + 1;
    while (j < rawLines.length && rawLines[j]!.trim() === "") j++;
    if (j >= rawLines.length) return i;
    const candidate = rawLines[j]!;
    const fenceOpen = candidate.match(FENCE_OPEN_RE);
    if (fenceOpen) {
      const indent = fenceOpen[1]!;
      const tickLen = fenceOpen[2]!.length;
      const interior: string[] = [];
      let k = j + 1;
      let closed = false;
      for (; k < rawLines.length; k++) {
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
        return rawLines.length - 1;
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

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]!;
    const lineNo = i + 1;

    if (open === null) {
      if (docFence) {
        const close = raw.match(DOC_FENCE_CLOSE_RE);
        if (close && close[1]![0] === docFence.ch && close[1]!.length >= docFence.len) {
          docFence = null;
        }
        continue; // fence interior is passthrough, anchors included
      }
      const fenceOpen = raw.match(DOC_FENCE_OPEN_RE);
      if (fenceOpen) {
        const ticks = fenceOpen[1] ?? fenceOpen[2]!;
        docFence = { ch: ticks[0]!, len: ticks.length };
        continue;
      }
      const openMatch = raw.match(OPEN_RE);
      if (openMatch) {
        const rest = openMatch[1]!;
        const tokens = rest.match(/[^\s"=]+="[^"]*"|\S+/g) ?? [];
        const kindToken = tokens[0];
        if (tokens.length === 0 || !kindToken || !KIND_TOKEN_RE.test(kindToken)) {
          errors.push({ code: "bad-anchor", line: lineNo, message: "malformed interact anchor" });
          continue;
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
        open = frame;
        continue;
      }
      if (CLOSE_RE.test(raw)) {
        errors.push({
          code: "unopened-close",
          line: lineNo,
          message: "close without an open block",
        });
        continue;
      }
      continue; // passthrough
    }

    // inside an open block
    if (CLOSE_RE.test(raw)) {
      const frame = open;
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
          span: [frame.line, lineNo],
        });
      }
      open = null;
      continue;
    }
    if (OPEN_RE.test(raw)) {
      errors.push({
        code: "nested-block",
        blockId: open.id,
        line: lineNo,
        message: "an interact block cannot open inside another open block",
      });
      open.hasError = true;
      continue;
    }
    if (raw.trim() === "") {
      // interior blank lines of a multi-paragraph intro are part of the intro;
      // leading blanks are padding, trailing ones are trimmed at close
      if (!open.sawFirstItem && open.introLines.length > 0) open.introLines.push(raw);
      continue;
    }
    const itemMatch = raw.match(ITEM_RE);
    if (itemMatch) {
      const frame = open;
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
      const item: Item = { state, verb, target, targetRaw, note, payload: undefined, line: lineNo };
      frame.items.push(item);
      i = consumePayload(item, i, frame);
      continue;
    }
    if (!open.sawFirstItem) {
      open.introLines.push(raw);
      continue;
    }
    // Stray content after the first item: a mistyped item line silently dropped
    // would be a reviewer's decision lost, so it fails loud instead.
    errors.push({
      code: "bad-item",
      blockId: open.id,
      line: lineNo,
      message: `unparseable line inside block '${open.id ?? ""}' — items look like '- [ ] verb: target', payloads are fenced and indented under their item`,
    });
    open.hasError = true;
  }

  if (open !== null) {
    errors.push({
      code: "unclosed-block",
      blockId: open.id,
      line: open.line,
      message: `block '${open.id ?? ""}' opened at line ${open.line} is never closed`,
    });
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

export function renderBlock(spec: BlockSpec): string {
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
    if (/[\n\r]/.test(it.target)) {
      throw new Error("renderBlock: newline in target is not allowed");
    }
    if (it.target.includes("`")) {
      throw new Error(
        "renderBlock: backtick in target is not allowed — pass the semantic target, formatting belongs to the renderer",
      );
    }
    if (it.note !== undefined && /[\n\r]/.test(it.note)) {
      throw new Error("renderBlock: newline in note is not allowed");
    }
    if (it.payload?.includes("\r")) {
      throw new Error("renderBlock: carriage return in payload is not allowed");
    }
  }

  let attrs = ` id=${spec.id}`;
  if (spec.dest !== undefined) attrs += ` dest=${quoteIfNeeded(spec.dest)}`;
  if (spec.src !== undefined) attrs += ` src=${quoteIfNeeded(spec.src)}`;

  let out = `<!-- interact: ${spec.kind}${attrs} -->\n\n`;
  if (spec.intro) out += `${spec.intro}\n\n`;

  const chunks: string[] = [];
  spec.items.forEach((it, idx) => {
    if (idx > 0) chunks.push("");
    const targetRaw =
      it.targetCode || needsBacktick(it.target) ? `\`${it.target}\`` : it.target;
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
