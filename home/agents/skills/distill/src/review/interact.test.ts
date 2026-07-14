// interact grammar-core red corpus — run with `bun test` from this directory.
//
// Freezes the interactive-text grammar (Phase 1) ahead of the
// implementation. Pins: every typed error class including the '[-]' teaching
// error; the round-trip law parseInteract(renderBlock(spec)) ≡ spec for all
// three kinds; fence-state-first scanning (anchor text inside a fenced payload
// never terminates a block); fence-length escalation; indented-anchor
// tolerance; payload dedent by the fence's indent; strip preserving content
// checkboxes byte-identically while removing blocks with their intro prose;
// id=/src=/dest= attribute parsing including src=new vs src=sha256:<hex>; and
// the 2026-07-03 stability experiment's two fixture forms — the emitted shape
// (fixtures/interact-triage-emit.md) and oxfmt's pad-line reflow of it
// (fixtures/interact-oxfmt-mangled.md) — parsing to the SAME decision set.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "bun:test";
import {
  type Block,
  type BlockSpec,
  classifyDangling,
  detectNestedRegions,
  InteractFormatError,
  parseInteract,
  renderBlock,
  resolveInteract,
  stripInteract,
} from "@/review/interact.ts";
import type { MdRegion, RegionDiagnostic } from "@/kernel/mdstruct.ts";

const FIX = (name: string): string =>
  readFileSync(resolve(import.meta.dir, "..", "fixtures", name), "utf8");

const lines = (...ls: string[]): string => ls.join("\n") + "\n";
const F = "```"; // fence delimiter, kept out of literals so payloads read clean

// The decision set: what a processor acts on. Presentation fields (line
// numbers, targetRaw, intro prose, span) are excluded — two byte-different
// files that a reviewer would resolve identically must project equal.
const decisions = (blocks: Block[]) =>
  blocks.map((b) => ({
    kind: b.kind,
    id: b.id,
    src: b.src,
    dest: b.dest,
    items: b.items.map((i) => ({
      state: i.state,
      verb: i.verb,
      target: i.target,
      note: i.note,
      payload: i.payload,
    })),
  }));

const parseOk = (text: string): Block[] => {
  const { blocks, errors } = parseInteract(text);
  expect(errors).toEqual([]);
  return blocks;
};

const errorCodes = (text: string): string[] => parseInteract(text).errors.map((e) => e.code);

// ---- passthrough: text outside blocks is never interpreted ----

test("parse: plain text with content checkboxes yields no blocks and no errors", () => {
  const { blocks, errors } = parseInteract(
    lines("# Note", "", "- [ ] a content checkbox", "- [x] another", ""),
  );
  expect(blocks).toEqual([]);
  expect(errors).toEqual([]);
});

// ---- block and item basics ----

test("parse: pick-any block — kind, id, item fields, [X] checked case-insensitively", () => {
  const [b] = parseOk(
    lines(
      "<!-- interact: pick-any id=residue -->",
      "",
      "- [ ] recover: `Impression distance` — inverted: nearness vs gap",
      "  " + F,
      "  payload line one",
      "  payload line two",
      "  " + F,
      "- [X] keep: `Anchor image`",
      "",
      "<!-- /interact -->",
      "",
    ),
  );
  expect(b!.kind).toBe("pick-any");
  expect(b!.id).toBe("residue");
  expect(b!.src).toBeUndefined();
  expect(b!.dest).toBeUndefined();
  expect(b!.items).toHaveLength(2);
  const [first, second] = b!.items;
  expect(first!.state).toBe("unchecked");
  expect(first!.verb).toBe("recover");
  expect(first!.target).toBe("Impression distance");
  expect(first!.targetRaw).toBe("`Impression distance`");
  expect(first!.note).toBe("inverted: nearness vs gap");
  expect(first!.payload).toBe("payload line one\npayload line two");
  expect(second!.state).toBe("checked");
  expect(second!.verb).toBe("keep");
  expect(second!.payload).toBeUndefined();
});

test("parse: pick-one block parses with intro prose captured", () => {
  const [b] = parseOk(
    lines(
      "<!-- interact: pick-one id=disposition -->",
      "",
      "Check exactly one.",
      "",
      "- [x] keep: `~note.md`",
      "- [ ] discard: `~note.md` — the one authorized delete",
      "",
      "<!-- /interact -->",
      "",
    ),
  );
  expect(b!.kind).toBe("pick-one");
  expect(b!.intro).toBe("Check exactly one.");
  expect(b!.items.map((i) => i.state)).toEqual(["checked", "unchecked"]);
});

test("parse: block line/span cover both anchors (1-indexed, inclusive)", () => {
  const [b] = parseOk(
    lines(
      "prose above",
      "",
      "<!-- interact: pick-any id=p -->",
      "",
      "- [ ] recover: X",
      "",
      "<!-- /interact -->",
      "",
      "prose below",
    ),
  );
  expect(b!.line).toBe(3);
  expect(b!.span).toEqual([3, 7]);
  expect(b!.items[0]!.line).toBe(5);
});

// ---- attribute set: id= / src= / dest= ----

test("parse: gate anchor carries dest= and src=sha256:<hex> as raw strings", () => {
  const [b] = parseOk(
    lines(
      "<!-- interact: confirm-all id=triage-final dest=impression-distance.md src=sha256:3f9c2a1b8d4e -->",
      "",
      "- [ ] reviewed: residue triage above is final",
      "",
      "<!-- /interact -->",
      "",
    ),
  );
  expect(b!.id).toBe("triage-final");
  expect(b!.dest).toBe("impression-distance.md");
  expect(b!.src).toBe("sha256:3f9c2a1b8d4e");
});

test("parse: src=new (creation case) is carried verbatim", () => {
  const [b] = parseOk(
    lines(
      "<!-- interact: confirm-all id=g dest=fresh.md src=new -->",
      "",
      "- [ ] reviewed: done",
      "",
      "<!-- /interact -->",
      "",
    ),
  );
  expect(b!.src).toBe("new");
  expect(b!.dest).toBe("fresh.md");
});

test("parse: attributes are accepted in any order", () => {
  const [b] = parseOk(
    lines(
      "<!-- interact: confirm-all src=new id=g dest=out.md -->",
      "",
      "- [ ] reviewed: done",
      "",
      "<!-- /interact -->",
      "",
    ),
  );
  expect(b!.id).toBe("g");
  expect(b!.src).toBe("new");
  expect(b!.dest).toBe("out.md");
});

test("parse: double-quoted attribute value carries spaces (inbox-stage basenames)", () => {
  const [b] = parseOk(
    lines(
      '<!-- interact: confirm-all id=g dest="impression distance (distilled).md" src=new -->',
      "",
      "- [ ] reviewed: done",
      "",
      "<!-- /interact -->",
      "",
    ),
  );
  expect(b!.dest).toBe("impression distance (distilled).md");
});

test("parse error: duplicate attribute key on one anchor", () => {
  expect(
    errorCodes(
      lines(
        "<!-- interact: pick-any id=a id=b -->",
        "",
        "- [ ] recover: X",
        "",
        "<!-- /interact -->",
        "",
      ),
    ),
  ).toEqual(["duplicate-attribute"]);
});

test("parse error: unknown attribute key (closed set: id, src, dest)", () => {
  expect(
    errorCodes(
      lines(
        "<!-- interact: pick-any id=a foo=bar -->",
        "",
        "- [ ] recover: X",
        "",
        "<!-- /interact -->",
        "",
      ),
    ),
  ).toEqual(["unknown-attribute"]);
});

test("parse error: missing id= on the opening anchor", () => {
  expect(
    errorCodes(
      lines("<!-- interact: pick-any -->", "", "- [ ] recover: X", "", "<!-- /interact -->", ""),
    ),
  ).toEqual(["missing-id"]);
});

test("parse error: duplicate block id across blocks, error names the id", () => {
  const { errors } = parseInteract(
    lines(
      "<!-- interact: pick-any id=dup -->",
      "",
      "- [ ] recover: X",
      "",
      "<!-- /interact -->",
      "",
      "<!-- interact: confirm-all id=dup -->",
      "",
      "- [ ] reviewed: done",
      "",
      "<!-- /interact -->",
      "",
    ),
  );
  expect(errors.map((e) => e.code)).toEqual(["duplicate-id"]);
  expect(errors[0]!.blockId).toBe("dup");
});

// ---- anchor-level errors ----

test("parse error: unknown kind", () => {
  expect(
    errorCodes(
      lines(
        "<!-- interact: pick-two id=p -->",
        "",
        "- [ ] recover: X",
        "",
        "<!-- /interact -->",
        "",
      ),
    ),
  ).toEqual(["unknown-kind"]);
});

test("parse error: interact comment that is not a well-formed anchor", () => {
  expect(errorCodes(lines("some prose", "", "<!-- interact: -->", ""))).toEqual(["bad-anchor"]);
});

test("parse error: unclosed block at EOF", () => {
  expect(errorCodes(lines("<!-- interact: pick-any id=p -->", "", "- [ ] recover: X", ""))).toEqual(
    ["unclosed-block"],
  );
});

test("parse error: closing anchor without an open block", () => {
  expect(errorCodes(lines("prose", "", "<!-- /interact -->", ""))).toEqual(["unopened-close"]);
});

test("parse error: opening anchor inside an open block (blocks do not nest)", () => {
  expect(
    errorCodes(
      lines(
        "<!-- interact: pick-any id=a -->",
        "",
        "- [ ] recover: X",
        "",
        "<!-- interact: pick-one id=b -->",
        "",
        "- [ ] keep: Y",
        "",
        "<!-- /interact -->",
        "",
        "<!-- /interact -->",
        "",
      ),
    ),
  ).toContain("nested-block");
});

// ---- region-consumer divergences (Phase B) ----
// After region recognition moved into the single mdstruct engine, interact is a pure
// filter over anchor pairs mdstruct locates by geometry over a masked raw-byte scan.
// Three inputs resolve differently than the retired thin-pass scanner did; these are the
// accepted new behavior, pinned so they can't silently regress.

test("region divergence: a paired region whose OPEN anchor is malformed is bad-anchor alone — its matched close is not orphaned", () => {
  // mdstruct pairs `<!-- interact: -->` with its `<!-- /interact -->` into one region, so the
  // empty-info open yields only bad-anchor. The close is never an unopened-close — the retired
  // scan emitted [bad-anchor, unopened-close] because a bad open opened nothing, orphaning it.
  const codes = errorCodes(
    lines("<!-- interact: -->", "", "- [ ] recover: X", "", "<!-- /interact -->", ""),
  );
  expect(codes).toEqual(["bad-anchor"]);
  expect(codes).not.toContain("unopened-close");
});

test("region divergence: a no-colon `<!-- interact -->` is bad-anchor, but its quoted and inline-code forms stay inert", () => {
  // mdstruct recognizes the colon-less comment as a (dangling) interact open, so interact
  // re-reads its bytes and reports bad-anchor — the retired scan's OPEN_RE required the colon and
  // let it pass through. Wrapped as code, the same text is masked out of region recognition.
  expect(errorCodes(lines("some prose", "", "<!-- interact -->", ""))).toEqual(["bad-anchor"]);
  expect(errorCodes(lines(F, "<!-- interact -->", F, ""))).toEqual([]); // quoted (fenced) form
  expect(errorCodes(lines("prose `<!-- interact -->` inline", ""))).toEqual([]); // inline-code form
});

test("region divergence: a nested block reports nested-block alone and skips BOTH bodies", () => {
  // The outer body carries a bad-state item ([-]); because both nested regions' bodies are
  // skipped, that error is suppressed — only the single nested-block surfaces, naming the outer
  // id at the inner anchor's line, with no block emitted. The retired scan also parsed the outer
  // body, which would have added bad-state alongside nested-block.
  const { blocks, errors } = parseInteract(
    lines(
      "<!-- interact: pick-any id=a -->",
      "",
      "- [-] recover: X",
      "",
      "<!-- interact: pick-one id=b -->",
      "",
      "- [ ] keep: Y",
      "",
      "<!-- /interact -->",
      "",
      "<!-- /interact -->",
      "",
    ),
  );
  expect(errors.map((e) => e.code)).toEqual(["nested-block"]);
  expect(errors[0]!.blockId).toBe("a");
  expect(errors[0]!.line).toBe(5);
  expect(blocks).toEqual([]);
});

// ---- lifted pure helpers (unit-level, off the full-parse path) ----
// detectNestedRegions and classifyDangling were carved out of parseInteract so the
// nested-region geometry and the dangling-anchor classification are testable without
// spinning the whole document parse; these exercise their branches directly.

const region = (span: [number, number], startLine: number, info?: string): MdRegion => ({
  type: "region",
  label: "interact",
  info,
  span,
  bodySpan: span,
  startLine,
  endLine: startLine,
});

test("detectNestedRegions: disjoint regions nest nothing and emit no error", () => {
  const { nested, errors } = detectNestedRegions([
    region([0, 10], 1, "pick-one id=a"),
    region([20, 30], 5, "pick-any id=b"),
  ]);
  expect([...nested]).toEqual([]);
  expect(errors).toEqual([]);
});

test("detectNestedRegions: a properly-contained region marks BOTH indices and names the outer id at the inner line", () => {
  // regions[0] wraps regions[1]; both indices land in the skip-set, one nested-block error
  // naming the outer's id at the inner anchor's opening line.
  const { nested, errors } = detectNestedRegions([
    region([0, 100], 1, "pick-any id=outer"),
    region([20, 60], 7, "pick-one id=inner"),
  ]);
  expect([...nested].sort()).toEqual([0, 1]);
  expect(errors).toEqual([
    {
      code: "nested-block",
      blockId: "outer",
      line: 7,
      message: "an interact block cannot open inside another open block",
    },
  ]);
});

test("detectNestedRegions: two regions with identical spans are not nesting (the equality guard)", () => {
  const { nested, errors } = detectNestedRegions([
    region([0, 40], 1, "pick-one id=a"),
    region([0, 40], 1, "pick-one id=b"),
  ]);
  expect([...nested]).toEqual([]);
  expect(errors).toEqual([]);
});

const diag = (
  type: RegionDiagnostic["type"],
  span: [number, number],
  line: number,
): RegionDiagnostic => ({ type, label: "interact", span, line });

test("classifyDangling: an unpaired close carries a ready unopened-close error", () => {
  const [c] = classifyDangling([diag("unpaired-close", [0, 20], 5)], Buffer.from(""));
  expect(c).toEqual({
    kind: "unopened-close",
    error: { code: "unopened-close", line: 5, message: "close without an open block" },
  });
});

test("classifyDangling: an unpaired open with a well-formed anchor yields its post-interact: info bytes", () => {
  const buf = Buffer.from("<!-- interact: pick-one id=q -->", "utf8");
  const [c] = classifyDangling([diag("unpaired-open", [0, buf.length], 3)], buf);
  expect(c).toEqual({ kind: "unpaired-open", info: "pick-one id=q", line: 3 });
});

test("classifyDangling: an unpaired open whose bytes do not match OPEN_RE reports undefined info (parseAnchor will bad-anchor it)", () => {
  const buf = Buffer.from("<!-- interact -->", "utf8"); // no colon
  const [c] = classifyDangling([diag("unpaired-open", [0, buf.length], 2)], buf);
  expect(c).toEqual({ kind: "unpaired-open", info: undefined, line: 2 });
});

// ---- item-level errors ----

test("parse error: item line without a verb marker", () => {
  expect(
    errorCodes(
      lines(
        "<!-- interact: pick-any id=p -->",
        "",
        "- [ ] just prose with no verb marker",
        "",
        "<!-- /interact -->",
        "",
      ),
    ),
  ).toEqual(["bad-item"]);
});

test("parse error: unsupported checkbox state character", () => {
  expect(
    errorCodes(
      lines(
        "<!-- interact: pick-any id=p -->",
        "",
        "- [?] recover: X",
        "",
        "<!-- /interact -->",
        "",
      ),
    ),
  ).toEqual(["bad-state"]);
});

test("parse error: '[-]' is a loud teaching error naming the fix", () => {
  const { errors } = parseInteract(
    lines("<!-- interact: pick-any id=p -->", "", "- [-] recover: X", "", "<!-- /interact -->", ""),
  );
  expect(errors).toHaveLength(1);
  expect(errors[0]!.code).toBe("bad-state");
  expect(errors[0]!.message).toContain("unsupported state '-'");
  expect(errors[0]!.message).toContain("leave unchecked and check the gate");
});

test("parse error: block with no items", () => {
  expect(
    errorCodes(
      lines(
        "<!-- interact: pick-any id=e -->",
        "",
        "Just prose, no items.",
        "",
        "<!-- /interact -->",
        "",
      ),
    ),
  ).toEqual(["empty-block"]);
});

// ---- payload attachment ----

test("parse error: indented non-fence content under an item", () => {
  expect(
    errorCodes(
      lines(
        "<!-- interact: pick-any id=p -->",
        "",
        "- [ ] recover: X",
        "  plain indented prose, not a fence",
        "",
        "<!-- /interact -->",
        "",
      ),
    ),
  ).toEqual(["unfenced-payload"]);
});

test("parse error: payload fence never closes", () => {
  expect(
    errorCodes(
      lines(
        "<!-- interact: pick-any id=p -->",
        "",
        "- [ ] recover: X",
        "  " + F,
        "  payload with no closing fence",
        "",
        "<!-- /interact -->",
        "",
      ),
    ),
  ).toContain("unclosed-fence");
});

test("parse: payload is dedented by the fence indent, inner blank and relative indent kept", () => {
  const [b] = parseOk(
    lines(
      "<!-- interact: pick-any id=p -->",
      "",
      "- [ ] recover: X",
      "  " + F,
      "  first payload line",
      "",
      "    indented payload line",
      "  " + F,
      "",
      "<!-- /interact -->",
      "",
    ),
  );
  expect(b!.items[0]!.payload).toBe("first payload line\n\n  indented payload line");
});

test("parse: blank pad line between item and fence still attaches the payload (oxfmt form)", () => {
  const [b] = parseOk(
    lines(
      "<!-- interact: pick-any id=p -->",
      "",
      "- [ ] recover: X",
      "",
      "  " + F,
      "  padded payload",
      "  " + F,
      "",
      "<!-- /interact -->",
      "",
    ),
  );
  expect(b!.items[0]!.payload).toBe("padded payload");
});

test("parse: anchor text inside a fenced payload does NOT terminate the block (fence-state-first)", () => {
  const [b] = parseOk(
    lines(
      "<!-- interact: pick-any id=p -->",
      "",
      "- [ ] recover: X",
      "  " + F,
      "  <!-- /interact -->",
      "  <!-- interact: pick-one id=fake -->",
      "  " + F,
      "",
      "<!-- /interact -->",
      "",
    ),
  );
  expect(b!.items[0]!.payload).toBe("<!-- /interact -->\n<!-- interact: pick-one id=fake -->");
});

test("parse: indented closing anchor still closes the block (oxfmt re-indent tolerance)", () => {
  const [b] = parseOk(
    lines("<!-- interact: pick-any id=p -->", "", "- [ ] recover: X", "  <!-- /interact -->", ""),
  );
  expect(b!.items).toHaveLength(1);
  expect(b!.items[0]!.payload).toBeUndefined();
});

// ---- note split and target backticks ----

test("parse: note splits at the first ' — ' outside backticks", () => {
  const [b] = parseOk(
    lines(
      "<!-- interact: pick-any id=p -->",
      "",
      "- [ ] recover: `a — b` — real note",
      "",
      "<!-- /interact -->",
      "",
    ),
  );
  expect(b!.items[0]!.target).toBe("a — b");
  expect(b!.items[0]!.targetRaw).toBe("`a — b`");
  expect(b!.items[0]!.note).toBe("real note");
});

// ---- render + round-trip law ----

const RT_SPECS: BlockSpec[] = [
  {
    kind: "pick-any",
    id: "residue",
    intro: "Residue triage. Unchecked means the entry is removed.",
    items: [
      {
        state: "unchecked",
        verb: "recover",
        target: "Impression distance",
        note: "inverted: nearness vs gap",
        payload: "line one\nline two",
      },
      { state: "checked", verb: "keep", target: "Anchor image" },
    ],
  },
  {
    kind: "pick-one",
    id: "disposition",
    items: [
      { state: "checked", verb: "keep", target: "~impression-distance.md" },
      {
        state: "unchecked",
        verb: "discard",
        target: "~impression-distance.md",
        note: "the one authorized delete",
      },
    ],
  },
  {
    kind: "confirm-all",
    id: "triage-final",
    dest: "impression-distance.md",
    src: "sha256:3f9c2a1b8d4e",
    intro: "Check this last.",
    items: [{ state: "unchecked", verb: "reviewed", target: "residue triage above is final" }],
  },
];

const toSpec = (b: Block): BlockSpec => ({
  kind: b.kind,
  id: b.id,
  src: b.src,
  dest: b.dest,
  intro: b.intro,
  items: b.items.map((i) => ({
    state: i.state,
    verb: i.verb,
    target: i.target,
    note: i.note,
    payload: i.payload,
  })),
});

test("round-trip law: parseInteract(renderBlock(spec)) reconstructs spec for all three kinds", () => {
  for (const spec of RT_SPECS) {
    const [b] = parseOk(renderBlock(spec));
    expect(toSpec(b!)).toEqual(spec);
  }
});

test("renderBlock: gate golden — attribute order id/dest/src, blank line before AND after the closing anchor", () => {
  expect(renderBlock(RT_SPECS[2]!)).toBe(
    lines(
      "<!-- interact: confirm-all id=triage-final dest=impression-distance.md src=sha256:3f9c2a1b8d4e -->",
      "",
      "Check this last.",
      "",
      "- [ ] reviewed: residue triage above is final",
      "",
      "<!-- /interact -->",
      "",
    ),
  );
});

test("renderBlock: payload fences are untagged and indented under the item; close anchor padded", () => {
  const out = renderBlock(RT_SPECS[0]!);
  expect(out).toContain("\n  " + F + "\n"); // untagged, two-space indent
  expect(out).not.toMatch(/```[a-z]/); // no language tag, ever
  expect(out).toMatch(/\n\n<!-- \/interact -->\n\n$/);
  expect(out.split("\n")).toContain("- [x] keep: Anchor image");
});

test("renderBlock: fence-length escalation — payload containing triple backticks round-trips", () => {
  const spec: BlockSpec = {
    kind: "pick-any",
    id: "p",
    items: [
      {
        state: "unchecked",
        verb: "recover",
        target: "X",
        payload: "before\n" + F + "\ninner\n" + F + "\nafter",
      },
    ],
  };
  const out = renderBlock(spec);
  expect(out).toContain("````"); // longest run (3) + 1
  const [b] = parseOk(out);
  expect(b!.items[0]!.payload).toBe(spec.items[0]!.payload);
});

test("renderBlock: target containing ' — ' is backticked so the note split stays unambiguous", () => {
  const spec: BlockSpec = {
    kind: "pick-any",
    id: "p",
    items: [{ state: "unchecked", verb: "recover", target: "a — b", note: "real note" }],
  };
  const [b] = parseOk(renderBlock(spec));
  expect(b!.items[0]!.target).toBe("a — b");
  expect(b!.items[0]!.note).toBe("real note");
});

// targetCode is presentational only (the fixture backticks def terms):
// render wraps the target, parse strips it back to the same semantic target, and
// a plain-target item in the same block stays unbackticked.
test("renderBlock: targetCode wraps the target in backticks; parse strips them back", () => {
  const spec: BlockSpec = {
    kind: "pick-any",
    id: "p",
    items: [
      { state: "unchecked", verb: "recover", target: "Impression distance", targetCode: true },
      { state: "unchecked", verb: "recover", target: "workflow:2" },
    ],
  };
  const out = renderBlock(spec);
  expect(out).toContain("- [ ] recover: `Impression distance`");
  expect(out).toContain("- [ ] recover: workflow:2");
  const [b] = parseOk(out);
  expect(b!.items[0]!.target).toBe("Impression distance");
  expect(b!.items[0]!.targetRaw).toBe("`Impression distance`");
});

test("renderBlock: dest with spaces is emitted quoted and round-trips", () => {
  const spec: BlockSpec = {
    kind: "confirm-all",
    id: "g",
    dest: "impression distance (distilled).md",
    src: "new",
    items: [{ state: "unchecked", verb: "reviewed", target: "done" }],
  };
  const out = renderBlock(spec);
  expect(out).toContain('dest="impression distance (distilled).md"');
  const [b] = parseOk(out);
  expect(b!.dest).toBe("impression distance (distilled).md");
});

test("renderBlock: throws on a newline in target or note", () => {
  expect(() =>
    renderBlock({
      kind: "pick-any",
      id: "p",
      items: [{ state: "unchecked", verb: "recover", target: "a\nb" }],
    }),
  ).toThrow(/newline/);
  expect(() =>
    renderBlock({
      kind: "pick-any",
      id: "p",
      items: [{ state: "unchecked", verb: "recover", target: "a", note: "x\ny" }],
    }),
  ).toThrow(/newline/);
});

// ---- resolve: verb vocabulary and kind semantics ----

const gateChecked = lines(
  "<!-- interact: pick-any id=r -->",
  "",
  "- [x] recover: A — first",
  "  " + F,
  "  payload A",
  "  " + F,
  "- [x] recover: B",
  "",
  "<!-- /interact -->",
  "",
  "<!-- interact: confirm-all id=g -->",
  "",
  "- [x] reviewed: done",
  "",
  "<!-- /interact -->",
  "",
);

test("resolve: checked items fire in document order across blocks, payload and note carried", () => {
  const res = resolveInteract(parseOk(gateChecked), { verbs: ["recover", "reviewed"] });
  expect(res.errors).toEqual([]);
  expect(res.fired.map((f) => [f.blockId, f.verb, f.target])).toEqual([
    ["r", "recover", "A"],
    ["r", "recover", "B"],
    ["g", "reviewed", "done"],
  ]);
  expect(res.fired[0]!.payload).toBe("payload A");
  expect(res.fired[0]!.note).toBe("first");
  expect(res.gates).toEqual([{ blockId: "g", satisfied: true, uncheckedCount: 0 }]);
});

test("resolve: out-of-vocabulary verb (even unchecked) is an error and nothing fires", () => {
  const blocks = parseOk(
    lines(
      "<!-- interact: pick-any id=r -->",
      "",
      "- [x] recover: A",
      "- [ ] delete-everything: B",
      "",
      "<!-- /interact -->",
      "",
    ),
  );
  const res = resolveInteract(blocks, { verbs: ["recover"] });
  expect(res.errors.map((e) => e.code)).toEqual(["unknown-verb"]);
  expect(res.errors[0]!.blockId).toBe("r");
  expect(res.fired).toEqual([]); // rejected, never executed — and errors empty fired
});

test("resolve: pick-one with zero checked is unresolved, naming the block", () => {
  const blocks = parseOk(
    lines(
      "<!-- interact: pick-one id=d -->",
      "",
      "- [ ] keep: X",
      "- [ ] discard: X",
      "",
      "<!-- /interact -->",
      "",
    ),
  );
  const res = resolveInteract(blocks, { verbs: ["keep", "discard"] });
  expect(res.errors.map((e) => e.code)).toEqual(["unresolved-pick-one"]);
  expect(res.errors[0]!.blockId).toBe("d");
  expect(res.fired).toEqual([]);
});

test("resolve: pick-one with two checked is unresolved", () => {
  const blocks = parseOk(
    lines(
      "<!-- interact: pick-one id=d -->",
      "",
      "- [x] keep: X",
      "- [x] discard: X",
      "",
      "<!-- /interact -->",
      "",
    ),
  );
  const res = resolveInteract(blocks, { verbs: ["keep", "discard"] });
  expect(res.errors.map((e) => e.code)).toEqual(["unresolved-pick-one"]);
  expect(res.fired).toEqual([]);
});

test("resolve: pick-one with exactly one checked fires exactly that item", () => {
  const blocks = parseOk(
    lines(
      "<!-- interact: pick-one id=d -->",
      "",
      "- [x] keep: X",
      "- [ ] discard: X",
      "",
      "<!-- /interact -->",
      "",
    ),
  );
  const res = resolveInteract(blocks, { verbs: ["keep", "discard"] });
  expect(res.errors).toEqual([]);
  expect(res.fired.map((f) => f.verb)).toEqual(["keep"]);
});

test("resolve: unchecked confirm-all gate is gate-unsatisfied with the unchecked count", () => {
  const blocks = parseOk(
    lines(
      "<!-- interact: confirm-all id=g -->",
      "",
      "- [x] reviewed: first",
      "- [ ] reviewed: second",
      "",
      "<!-- /interact -->",
      "",
    ),
  );
  const res = resolveInteract(blocks, { verbs: ["reviewed"] });
  expect(res.errors.map((e) => e.code)).toEqual(["gate-unsatisfied"]);
  expect(res.errors[0]!.blockId).toBe("g");
  expect(res.gates).toEqual([{ blockId: "g", satisfied: false, uncheckedCount: 1 }]);
  expect(res.fired).toEqual([]);
});

// ---- strip ----

test("strip: removes blocks with their intro prose; everything before survives byte-identically", () => {
  const before = FIX("interact-triage-emit.md");
  const stripped = stripInteract(before);
  const prefix = before.slice(0, before.indexOf("<!-- interact:")).trimEnd() + "\n";
  expect(stripped).toBe(prefix);
  // the named contract, stated explicitly: the canonical note body before the blocks survives
  expect(stripped).toContain("1. Fix the anchor image before opening paints");
  expect(stripped).toContain("2. Re-check values against the anchor, not the scene");
  expect(stripped).not.toContain("interact");
  expect(stripped).not.toContain("Residue triage");
  expect(stripped).not.toContain("Check this last");
});

test("strip: mid-document block collapses to a single blank line of separation", () => {
  const text = lines(
    "# T",
    "",
    "- [ ] content box",
    "",
    "<!-- interact: pick-one id=d -->",
    "",
    "- [x] keep: `x.md`",
    "",
    "<!-- /interact -->",
    "",
    "Tail paragraph.",
  );
  expect(stripInteract(text)).toBe(lines("# T", "", "- [ ] content box", "", "Tail paragraph."));
});

test("strip: a document with no blocks is returned byte-identical", () => {
  const text = "# T\n\n- [ ] a content box\n\ntail with trailing space \n";
  expect(stripInteract(text)).toBe(text);
});

test("strip: malformed input throws InteractFormatError carrying the parse errors", () => {
  expect(() =>
    stripInteract(lines("<!-- interact: pick-any id=p -->", "", "- [ ] recover: X", "")),
  ).toThrow(InteractFormatError);
});

// ---- golden fixtures: emitted form vs oxfmt pad-line form ----

const P1 =
  "Impression distance is the gap between the felt sense of a scene and what\n" +
  "the eye verifies on re-inspection; the painting should honor the former.";
const P2 =
  "Before glazing, let the underlayer dry fully; a damp underlayer lifts and\n" +
  "muddies the glaze.";
const P3 = "The anchor image is the first felt impression, fixed before mixing begins.";

const TRIAGE_DECISIONS: ReturnType<typeof decisions> = [
  {
    kind: "pick-any",
    id: "residue",
    src: undefined,
    dest: undefined,
    items: [
      {
        state: "unchecked",
        verb: "recover",
        target: "Impression distance",
        note: "inverted: def asserts nearness where source asserts a gap",
        payload: P1,
      },
      {
        state: "unchecked",
        verb: "recover",
        target: "procedure:Block from the impression:2",
        note: "workflow: drying precondition missing from steps",
        payload: P2,
      },
      {
        state: "unchecked",
        verb: "keep",
        target: "Anchor image",
        note: "gate-inconclusive: judge returned no verdict after retry",
        payload: P3,
      },
    ],
  },
  {
    kind: "confirm-all",
    id: "triage-final",
    src: "sha256:3f9c2a1b8d4e",
    dest: "impression-distance.md",
    items: [
      {
        state: "unchecked",
        verb: "reviewed",
        target: "residue triage above is final",
        note: "apply writes impression-distance.md and deletes this file",
        payload: undefined,
      },
    ],
  },
];

test("fixture: interact-triage-emit.md parses clean to the pinned decision set", () => {
  const blocks = parseOk(FIX("interact-triage-emit.md"));
  expect(decisions(blocks)).toEqual(TRIAGE_DECISIONS);
  expect(blocks[0]!.intro).toBe(
    "Residue triage. Checked `recover:` re-renders the entry from its fenced source (spliced verbatim if it fails the grade again); checked `keep:` keeps the entry exactly as it stands above; unchecked means the entry is removed from the final note.",
  );
  expect(blocks[1]!.intro).toBe("Check this last, on the device you will apply from.");
});

test("fixture: interact-oxfmt-mangled.md (pad-line form) parses clean", () => {
  const blocks = parseOk(FIX("interact-oxfmt-mangled.md"));
  expect(blocks).toHaveLength(2);
});

test("fixture: emitted form and oxfmt-mangled form parse to the SAME decision set", () => {
  const emitted = parseOk(FIX("interact-triage-emit.md"));
  const mangled = parseOk(FIX("interact-oxfmt-mangled.md"));
  expect(decisions(mangled)).toEqual(decisions(emitted));
});

test("fixture: triage resolve — all-unchecked file refuses only on the gate", () => {
  const blocks = parseOk(FIX("interact-triage-emit.md"));
  const res = resolveInteract(blocks, { verbs: ["recover", "keep", "reviewed"] });
  expect(res.errors.map((e) => e.code)).toEqual(["gate-unsatisfied"]);
  expect(res.errors[0]!.blockId).toBe("triage-final");
  expect(res.gates).toEqual([{ blockId: "triage-final", satisfied: false, uncheckedCount: 1 }]);
  expect(res.fired).toEqual([]);
});

// ---- adversarial pinning (post-review): fence-state-first at document level,
// CRLF tolerance, strip byte-preservation, silent-drop and round-trip holes ----

test("parse: anchors inside a document-level content fence are passthrough, and strip keeps them byte-identical", () => {
  const text = lines(
    "# Doc",
    "",
    F + "markdown",
    "<!-- interact: pick-any id=example -->",
    "",
    "- [ ] recover: X",
    "",
    "<!-- /interact -->",
    F,
    "",
    "Real content.",
  );
  const { blocks, errors } = parseInteract(text);
  expect(blocks).toEqual([]);
  expect(errors).toEqual([]);
  expect(stripInteract(text)).toBe(text);
});

test("parse: a tilde content fence shields anchors too; a real block after it still parses", () => {
  const text = lines(
    "~~~",
    "<!-- interact: pick-any id=example -->",
    "~~~",
    "",
    "<!-- interact: pick-one id=real -->",
    "",
    "- [x] keep: X",
    "",
    "<!-- /interact -->",
    "",
  );
  const blocks = parseOk(text);
  expect(blocks.map((b) => b.id)).toEqual(["real"]);
});

test("parse: a CRLF copy of a document yields the same decision set as its LF form", () => {
  const lf = lines(
    "<!-- interact: pick-any id=p -->",
    "",
    "- [x] recover: X — note here",
    "  " + F,
    "  payload line",
    "  " + F,
    "",
    "<!-- /interact -->",
    "",
  );
  const crlf = lf.replace(/\n/g, "\r\n");
  expect(decisions(parseOk(crlf))).toEqual(decisions(parseOk(lf)));
});

test("parse error: empty id= value is missing-id, not a block with id ''", () => {
  expect(
    errorCodes(
      lines(
        "<!-- interact: pick-any id= -->",
        "",
        "- [ ] recover: X",
        "",
        "<!-- /interact -->",
        "",
      ),
    ),
  ).toEqual(["missing-id"]);
});

test("parse error: unterminated quote in an attribute value never guesses", () => {
  expect(
    errorCodes(
      lines(
        '<!-- interact: confirm-all id=g dest="x src=new -->',
        "",
        "- [ ] reviewed: done",
        "",
        "<!-- /interact -->",
        "",
      ),
    ),
  ).toEqual(["unknown-attribute"]);
});

test("parse error: a mistyped item line inside a block fails loud instead of dropping the decision", () => {
  const { errors } = parseInteract(
    lines(
      "<!-- interact: pick-any id=p -->",
      "",
      "- [x] recover: X",
      "-[x] keep: Y",
      "",
      "<!-- /interact -->",
      "",
    ),
  );
  expect(errors.map((e) => e.code)).toEqual(["bad-item"]);
  expect(errors[0]!.line).toBe(4);
});

test("parse error: an indented item after a payload is stray content, not a silent drop", () => {
  expect(
    errorCodes(
      lines(
        "<!-- interact: pick-any id=p -->",
        "",
        "- [ ] recover: X",
        "  " + F,
        "  p",
        "  " + F,
        "  - [x] keep: Y",
        "",
        "<!-- /interact -->",
        "",
      ),
    ),
  ).toEqual(["bad-item"]);
});

test("round-trip: multi-paragraph intro keeps its blank line", () => {
  const spec: BlockSpec = {
    kind: "pick-any",
    id: "p",
    intro: "Para one.\n\nPara two.",
    items: [{ state: "unchecked", verb: "recover", target: "X" }],
  };
  const [b] = parseOk(renderBlock(spec));
  expect(toSpec(b!)).toEqual(spec);
});

test("strip: a multi-blank run and a trailing space in content far from the block survive byte-identically", () => {
  const text = lines(
    "para1",
    "",
    "",
    "para2 with trailing space ",
    "",
    "<!-- interact: pick-one id=d -->",
    "",
    "- [x] keep: `x.md`",
    "",
    "<!-- /interact -->",
    "",
    "tail",
  );
  expect(stripInteract(text)).toBe(
    lines("para1", "", "", "para2 with trailing space ", "", "tail"),
  );
});

test("strip: trailing space on the last content line survives when the block ends the document", () => {
  const text = lines(
    "tail with trailing space ",
    "",
    "<!-- interact: pick-one id=d -->",
    "",
    "- [x] keep: `x.md`",
    "",
    "<!-- /interact -->",
  );
  expect(stripInteract(text)).toBe("tail with trailing space \n");
});

test("renderBlock: throws on specs the grammar cannot carry back", () => {
  const item = (over: object) => ({
    kind: "pick-any" as const,
    id: "p",
    items: [{ state: "unchecked" as const, verb: "recover", target: "X", ...over }],
  });
  // backtick in target: stripBackticks/splitNote would reparse it differently
  expect(() => renderBlock(item({ target: "`--out`" }))).toThrow(/backtick/);
  expect(() => renderBlock(item({ target: "a`b", note: "n" }))).toThrow(/backtick/);
  // non-slug verb or id: the emitted line would not reparse as an item/anchor
  expect(() => renderBlock(item({ verb: "Keep" }))).toThrow(/verb/);
  expect(() => renderBlock({ ...item({}), id: "my id" })).toThrow(/slug/);
  // intro that would reparse as structure
  expect(() => renderBlock({ ...item({}), intro: "- [ ] fake item" })).toThrow(/re-parse/);
  expect(() => renderBlock({ ...item({}), intro: "x\n" })).toThrow(/blank/);
});
