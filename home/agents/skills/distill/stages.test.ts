// stage-level tests — run with `bun test` from this directory.
//
// 17e decomposed distill() into named stage functions behind the seams the 17a-d
// splits stabilized. This suite pins the three PURE stages directly (no model
// call): orderContent (grade→order), computeStepGroups (group by shared source),
// and buildFooter (the success-footer renderer). The async stages route through
// the network and are covered by the end-to-end + degradation suites.
import { expect, test } from "bun:test";
import type { Block, Combo, Grade, ProseUnit, WorkStep } from "./text.ts";
import { normalizeForContainment } from "./text.ts";
import type { ProseVerdict } from "./prompts.ts";
import { segment } from "./text.ts";
import {
  anchored,
  buildFooter,
  computeStepGroups,
  expandGuardCap,
  groupStepsByOwner,
  orderContent,
  parseArgs,
  payloadResidue,
  proseResidue,
  tagOwnedBlocks,
  wikilinkResidue,
} from "./pipeline.ts";

// ---- expandGuardCap: the passthrough guard's threshold, customizable via --max-words ----
test("expandGuardCap: unset maxWords defaults to the note's own input size (today's behavior)", () => {
  expect(expandGuardCap(100, undefined)).toBe(100);
});

test("expandGuardCap: maxWords 0 disables the guard (debugging escape hatch)", () => {
  expect(expandGuardCap(100, 0)).toBeNull();
});

test("expandGuardCap: a positive maxWords sets an absolute ceiling, ignoring input size", () => {
  expect(expandGuardCap(100, 500)).toBe(500);
  expect(expandGuardCap(100, 10)).toBe(10);
});

// ---- orderContent: retain selection + note-order entries/steps ----
test("orderContent: orders entries by first source block, drops fully-retained steps", () => {
  const blocks: Block[] = [
    { id: "B1", text: "a" },
    { id: "B2", text: "b" },
    { id: "B3", text: "c" },
  ];
  const grades: Map<string, Grade> = new Map([
    ["B1", "distill"],
    ["B2", "retain"],
    ["B3", "distill"],
  ]);
  const combo: Combo = {
    description: "",
    thesis: "t",
    glossary: [
      { term: "X", def: "dx", relations: [], source: ["B3"] }, // orderKey 2
      { term: "Y", def: "dy", relations: [], source: ["B1"] }, // orderKey 0
    ],
    workflow: [
      { step: "do z", source: ["B1"] }, // B1 is distill → kept
      { step: "do w", source: ["B2"] }, // every source block retained → dropped
    ],
  };
  const { payloadBlocks, payloadBlockIds, orderedEntries, orderedSteps } = orderContent(
    combo,
    blocks,
    grades,
  );
  expect(payloadBlocks).toEqual([{ id: "B2", text: "b" }]);
  expect([...payloadBlockIds]).toEqual(["B2"]);
  expect(orderedEntries.map((e) => e.term)).toEqual(["Y", "X"]);
  expect(orderedSteps.map((s) => s.step)).toEqual(["do z"]);
});

// ---- tagOwnedBlocks: owner-section tagging at segmentation time (routed-build splice) ----
test("tagOwnedBlocks: assigns sequential ids across sections, tagging each block's owner index", () => {
  const owned = tagOwnedBlocks([{ text: "para one" }, { text: "para two" }]);
  expect(owned.blocks).toEqual([
    { id: "B1", text: "para one" },
    { id: "B2", text: "para two" },
  ]);
  expect([...owned.owner]).toEqual([
    ["B1", 0],
    ["B2", 1],
  ]);
  expect(owned.ownerCount).toBe(2);
});

test("tagOwnedBlocks: a section with two blank-line-separated paragraphs contributes two blocks, same owner", () => {
  const owned = tagOwnedBlocks([{ text: "first\n\nsecond" }, { text: "third" }]);
  expect(owned.blocks.map((b) => b.id)).toEqual(["B1", "B2", "B3"]);
  expect(owned.owner.get("B1")).toBe(0);
  expect(owned.owner.get("B2")).toBe(0);
  expect(owned.owner.get("B3")).toBe(1);
});

test("tagOwnedBlocks: segmenting per-section then concatenating agrees, block-for-block, with segmenting the join", () => {
  const sections = [
    { text: "## Idea\n\nsome prose\n\nmore prose" },
    { text: "## Mixed\n\n- a list\n\n```js\nconst x = 1;\n```" },
    { text: "## Tail\n\ntrailing prose" },
  ];
  const owned = tagOwnedBlocks(sections);
  const wholeText = sections.map((s) => s.text).join("\n\n");
  expect(owned.blocks.map((b) => b.text)).toEqual(segment(wholeText).map((b) => b.text));
});

// ---- groupStepsByOwner: bucket already-ordered/synthesized steps by their source section ----
test("groupStepsByOwner: buckets steps by owning section, preserving order within a bucket", () => {
  const owned = tagOwnedBlocks([{ text: "first" }, { text: "second" }]);
  const orderedSteps: WorkStep[] = [
    { step: "s1", source: [owned.blocks[0].id] },
    { step: "s2", source: [owned.blocks[1].id] },
    { step: "s3", source: [owned.blocks[0].id] },
  ];
  const byOwner = groupStepsByOwner(
    orderedSteps,
    ["s1 rendered", "s2 rendered", "s3 rendered"],
    owned,
  );
  expect(byOwner).toEqual([["s1 rendered", "s3 rendered"], ["s2 rendered"]]);
});

test("groupStepsByOwner: a step sourced from two owners resolves to the earlier one", () => {
  const owned = tagOwnedBlocks([{ text: "first" }, { text: "second" }]);
  const orderedSteps: WorkStep[] = [
    { step: "cross", source: [owned.blocks[1].id, owned.blocks[0].id] },
  ];
  const byOwner = groupStepsByOwner(orderedSteps, ["cross rendered"], owned);
  expect(byOwner).toEqual([["cross rendered"], []]);
});

test("groupStepsByOwner: an owner with zero steps yields an empty array at that position", () => {
  const owned = tagOwnedBlocks([{ text: "first" }, { text: "second" }, { text: "third" }]);
  const byOwner = groupStepsByOwner([], [], owned);
  expect(byOwner).toEqual([[], [], []]);
});

// ---- computeStepGroups: steps sharing a source block group together ----
test("computeStepGroups: groups by shared source, ids in encounter order, joins source text", () => {
  const blockById = new Map<string, Block>([
    ["B1", { id: "B1", text: "block one" }],
    ["B2", { id: "B2", text: "block two" }],
  ]);
  const steps: WorkStep[] = [
    { step: "s1", source: ["B1"] },
    { step: "s2", source: ["B1"] },
    { step: "s3", source: ["B2"] },
  ];
  const groups = computeStepGroups(steps, blockById);
  expect(groups).toEqual([
    { id: "workflow:1", idxs: [0, 1], sourceText: "block one" },
    { id: "workflow:2", idxs: [2], sourceText: "block two" },
  ]);
});

// ---- buildFooter: tag composition + size-tag branches ----
test("buildFooter: compressed run renders size + steps tags, omits the zero tags", () => {
  expect(
    buildFooter({
      beforeWords: 100,
      afterWords: 60,
      entries: 3,
      steps: 2,
      verbatim: 1,
      residue: 0,
      gateSkipped: 0,
      keptVerbatim: 0,
      retries: 0,
      proseFixes: 0,
      coreOnly: false,
      proseGateOffFactsDump: false,
    }),
  ).toBe(
    "— distilled prose+gloss · 100→60 words (-40%) · 3 entries · 2 steps · 1 verbatim · 0 residue",
  );
});

test("buildFooter: ±0% on no shrink, --core-only shape, gate-skipped + retries tags", () => {
  expect(
    buildFooter({
      beforeWords: 50,
      afterWords: 50,
      entries: 2,
      steps: 0,
      verbatim: 0,
      residue: 1,
      gateSkipped: 1,
      keptVerbatim: 0,
      retries: 2,
      proseFixes: 0,
      coreOnly: true,
      proseGateOffFactsDump: false,
    }),
  ).toBe(
    "— distilled gloss · 50→50 words (±0%) · 2 entries · 0 verbatim · 1 residue · 1 gate-skipped · 2 retries",
  );
});

test("buildFooter: facts-dump skip of the in-scope prose gate surfaces as a tag", () => {
  expect(
    buildFooter({
      beforeWords: 100,
      afterWords: 70,
      entries: 4,
      steps: 0,
      verbatim: 0,
      residue: 0,
      gateSkipped: 0,
      keptVerbatim: 0,
      retries: 0,
      proseFixes: 0,
      coreOnly: false,
      proseGateOffFactsDump: true,
    }),
  ).toBe(
    "— distilled prose+gloss · 100→70 words (-30%) · 4 entries · 0 verbatim · 0 residue · prose-gate off (facts-dump)",
  );
});

// ---- wikilinkResidue: dropped source edges surface; covered ones don't ----
test("wikilinkResidue: a dropped source wikilink surfaces; a relation/retained one does not", () => {
  const source =
    "prose [[30 notes/Elegant solution]] and [[20 cards/Outline speedrunning]].\n\n## References\n- [[30 notes/Kept link]]";
  // output: one link survived as a pre-slugged ## Relations endpoint, one verbatim in a
  // retained see-also list; the second prose link was dropped.
  const out =
    "## Relations\n\n- a subsumes:: [[30-notes-elegant-solution]]\n\n## References\n- [[30 notes/Kept link]]";
  const res = wikilinkResidue(source, out);
  expect(res.map((r) => r.label)).toEqual(["[[20 cards/Outline speedrunning]]"]);
  expect(res[0].reason).toMatch(/wikilink dropped/);
});

test("wikilinkResidue: a repeated dropped link is reported once", () => {
  expect(wikilinkResidue("[[a/B]] then [[a/B]] again", "no links")).toHaveLength(1);
});

test("wikilinkResidue: full coverage yields no residue", () => {
  expect(wikilinkResidue("[[x]] [[y]]", "[[x]] and [[y]]")).toEqual([]);
});

test("wikilinkResidue: a captured note-level edge counts as covered, not residue", () => {
  // the acceptance failure mode: two stated-relation hostless links were dropped to
  // residue. Once captured as a note-level edge in the ## Relations block (its to is a
  // pre-slugged [[file-slug]]), the slug matches the source and drops out of residue.
  const source =
    "Pragmatic first relates to [[Not all shipped work looks the same]] and [[Tech debt multiplied by AI]].";
  const out =
    "## Relations\n\n" +
    "- [[pragmatic-first-is-reconnaissance-for-elegance]] contrast-to:: [[not-all-shipped-work-looks-the-same]] (a)\n" +
    "- [[pragmatic-first-is-reconnaissance-for-elegance]] refines:: [[tech-debt-multiplied-by-ai]] (b)";
  expect(wikilinkResidue(source, out)).toEqual([]);
});

test("wikilinkResidue: slug-colliding source edges both surface even when output covers one", () => {
  // [[foo bar]] and [[foo/bar]] both slug to foo-bar; output covers the slug once.
  // Slug coverage cannot be attributed to a single edge, so both surface as residue
  // (loud false positive) rather than the dropped one passing silently.
  const res = wikilinkResidue("[[foo bar]] and [[foo/bar]]", "see [[foo bar]]");
  expect(res.map((r) => r.label).sort()).toEqual(["[[foo bar]]", "[[foo/bar]]"]);
  expect(res[0].reason).toMatch(/slug-collision/);
});

// ---- payloadResidue: dropped non-edge payload surfaces; compressed prose does not ----

test("payloadResidue: a dropped table, image, stat, blockquote, fence, and citation all surface", () => {
  const source =
    "Intro.\n\n" +
    "| Sign | Defect |\n| --- | --- |\n| coupling | rigidity |\n\n" +
    "![[diagram.png]]\n\n" +
    "CISQ found $1.52 trillion in waste.\n\n" +
    "> A verbatim law.\n\n" +
    "```sql\nSELECT 1;\n```\n\n" +
    "Source: [report](https://x.example/r).";
  const out = "A tightened one-paragraph restatement that keeps none of the payload.";
  const reasons = payloadResidue(source, out).map((r) => r.reason);
  expect(reasons.some((r) => /table-row/.test(r))).toBe(true);
  expect(reasons.some((r) => /image-embed/.test(r))).toBe(true);
  expect(reasons.some((r) => /numeric-token/.test(r))).toBe(true);
  expect(reasons.some((r) => /blockquote/.test(r))).toBe(true);
  expect(reasons.some((r) => /fenced-block/.test(r))).toBe(true);
  expect(reasons.some((r) => /citation-url/.test(r))).toBe(true);
});

test("payloadResidue: the core invariant — a pure-prose restatement-collapse yields zero residue", () => {
  const source =
    "The first paragraph restates the thesis at length. The second paragraph restates " +
    "it again from another angle. The third paragraph restates it once more for emphasis.";
  const out = "One sentence that captures the thesis.";
  expect(payloadResidue(source, out)).toEqual([]);
});

test("payloadResidue: payload surviving anywhere in output (a retained block) is covered", () => {
  const source = "```js\nconst x = 1;\n```\n\nand a stat: 47%.";
  const out = "Prose mentioning 47%.\n\n```js\nconst x = 1;\n```";
  expect(payloadResidue(source, out)).toEqual([]);
});

test("payloadResidue: a span dropped twice in source is reported once", () => {
  const source = "first 47% then again 47%";
  expect(payloadResidue(source, "no figures")).toHaveLength(1);
});

test("payloadResidue: a bare year is not flagged as a dropped statistic", () => {
  expect(payloadResidue("Written back in 2024.", "A reworded summary.")).toEqual([]);
});

test("payloadResidue: URL path digits are not phantom statistics (covered URL → no residue)", () => {
  const u = "see https://x.example/2010/390755 for detail";
  expect(payloadResidue(u, "kept " + u)).toEqual([]);
});

// ---- proseResidue + anchored: the prose-judge mapping (D46) ----
// surfaced is the DEFAULT; a unit clears only on an explicit covered verdict whose anchor is
// verified present in the output AND on-topic for the judged item.
const pu = (id: string, span: string): ProseUnit => ({ id, heading: "Sec", depth: 4, span });
const pv = (id: string, grade: "covered" | "dropped", anchor = "", missing = ""): ProseVerdict => ({
  id,
  grade,
  anchor,
  missing,
});

test("proseResidue: a dropped verdict surfaces as residue", () => {
  const units = [pu("sec-0", "weaken preconditions in a subtype, never strengthen them")];
  const verdicts = new Map([
    ["sec-0", pv("sec-0", "dropped", "", "the precondition rule is absent")],
  ]);
  const res = proseResidue(units, verdicts, new Set(), "an unrelated compressed body");
  expect(res).toHaveLength(1);
  expect(res[0].reason).toMatch(/prose dropped/);
});

test("proseResidue: the core invariant — a covered+anchored verdict clears to zero residue", () => {
  const span = "weaken preconditions in a subtype, never strengthen them";
  const out = "Subtypes may weaken preconditions in a subtype but never strengthen them.";
  const verdicts = new Map([
    ["sec-0", pv("sec-0", "covered", "weaken preconditions in a subtype")],
  ]);
  expect(proseResidue([pu("sec-0", span)], verdicts, new Set(), out)).toEqual([]);
});

test("proseResidue: an unrelated anchor cannot launder a dropped item (F3 relevance binding)", () => {
  const span = "weaken preconditions in a subtype, never strengthen them";
  // the anchor exists verbatim in out but is the THESIS — it shares no content word with the item
  const out = "The thesis is that clean architecture pays its way over the long run.";
  const verdicts = new Map([["sec-0", pv("sec-0", "covered", "clean architecture pays its way")]]);
  const res = proseResidue([pu("sec-0", span)], verdicts, new Set(), out);
  expect(res).toHaveLength(1);
  expect(res[0].reason).toMatch(/not anchored/);
});

test("proseResidue: an omitted id surfaces (default-to-surfaced)", () => {
  const res = proseResidue(
    [pu("sec-0", "a must-cover enumerated claim about something")],
    new Map(),
    new Set(),
    "out",
  );
  expect(res).toHaveLength(1);
  expect(res[0].reason).toMatch(/omitted this item/);
});

test("proseResidue: a flaked-batch id surfaces with a distinct reason", () => {
  const res = proseResidue(
    [pu("sec-0", "a must-cover enumerated claim about something")],
    new Map(),
    new Set(["sec-0"]),
    "out",
  );
  expect(res).toHaveLength(1);
  expect(res[0].reason).toMatch(/no verdict for this item's batch/);
});

test("proseResidue: a surviving sibling never clears a dropped sibling (single-survivor / F4)", () => {
  const out =
    "We keep only the first moat: a proprietary data network effect competitors cannot copy.";
  const units = [
    pu("moats-0", "a proprietary data network effect competitors cannot copy"),
    pu("moats-1", "a regulatory licence barrier that takes years to clear"),
    pu("moats-2", "a switching-cost lock-in from deep workflow integration"),
  ];
  const verdicts = new Map<string, ProseVerdict>([
    [
      "moats-0",
      pv("moats-0", "covered", "a proprietary data network effect competitors cannot copy"),
    ],
    ["moats-1", pv("moats-1", "dropped", "", "the regulatory licence barrier is gone")],
    ["moats-2", pv("moats-2", "dropped", "", "the switching-cost lock-in is gone")],
  ]);
  expect(
    proseResidue(units, verdicts, new Set(), out)
      .map((r) => r.label)
      .sort(),
  ).toEqual(["moats-1", "moats-2"]);
});

test("anchored: rejects a too-short anchor or one absent from output, accepts an on-topic one", () => {
  const span = "weaken preconditions in a subtype, never strengthen them";
  const normOut = normalizeForContainment(
    "Subtypes weaken preconditions in a subtype, never strengthen them.",
  );
  expect(anchored(pv("x", "covered", "weaken"), span, normOut)).toBe(false); // < 16 chars
  expect(anchored(pv("x", "covered", "a totally absent phrase here"), span, normOut)).toBe(false); // not in out
  expect(anchored(pv("x", "covered", "weaken preconditions in a subtype"), span, normOut)).toBe(
    true,
  );
});

// ---- parseArgs: the CLI surface (help / validation / render subcommand / flag composition) ----
// A pure argv→result function: it returns a discriminated result (help | error | ok) so the
// help path and every misuse fail loudly BEFORE main() reaches the API-key gate or any network
// call. `ok` carries the resolved mode + options bag.
function ok(argv: string[]) {
  const r = parseArgs(argv);
  if (r.kind !== "ok") throw new Error(`expected ok, got ${r.kind}: ${JSON.stringify(r)}`);
  return r;
}
function err(argv: string[]) {
  const r = parseArgs(argv);
  if (r.kind !== "error") throw new Error(`expected error, got ${r.kind}`);
  return r.message;
}

test("parseArgs: --help and -h short-circuit to the help result", () => {
  expect(parseArgs(["--help"]).kind).toBe("help");
  expect(parseArgs(["-h"]).kind).toBe("help");
  // help wins even alongside otherwise-valid args, so `distill-text input.md --help` shows help.
  expect(parseArgs(["input.md", "--help"]).kind).toBe("help");
});

test("parseArgs: bare invocation reads stdin with defaults", () => {
  const r = ok([]);
  expect(r.mode).toBe("compress");
  expect(r.opts.path).toBeUndefined();
  expect(r.opts).toMatchObject({
    lang: "auto",
    synth: "render",
    maxRetries: 2,
    noRevise: false,
    noGate: false,
    coreOnly: false,
    dryRun: false,
  });
  expect(r.opts.maxWords).toBeUndefined();
});

test("parseArgs: a positional is taken as the input path; flags compose", () => {
  const r = ok(["--core-only", "--no-gate", "--no-revise", "input.md"]);
  expect(r.opts.path).toBe("input.md");
  expect(r.opts.coreOnly).toBe(true);
  expect(r.opts.noGate).toBe(true);
  expect(r.opts.noRevise).toBe(true);
});

test("parseArgs: an unknown flag errors and names the offending token", () => {
  expect(err(["--frobnicate", "input.md"])).toContain("--frobnicate");
});

test("parseArgs: --synth rejects an out-of-set value and lists the choices", () => {
  const m = err(["--synth", "foo"]);
  expect(m).toContain("--synth");
  expect(m).toContain("render");
  expect(m).toContain("regenerate");
  expect(m).toContain("foo");
});

test("parseArgs: --synth regenerate is accepted", () => {
  expect(ok(["--synth", "regenerate", "in.md"]).opts.synth).toBe("regenerate");
});

test("parseArgs: --lang rejects a missing value and an out-of-set value", () => {
  expect(err(["--lang"])).toContain("--lang");
  const m = err(["--lang", "fr"]);
  expect(m).toContain("--lang");
  expect(m).toContain("fr");
});

test("parseArgs: --lang ru is accepted", () => {
  expect(ok(["--lang", "ru", "in.md"]).opts.lang).toBe("ru");
});

test("parseArgs: numeric flags reject non-numbers and out-of-range values", () => {
  expect(err(["--max-retries", "abc"])).toContain("--max-retries");
  expect(err(["--max-retries", "-1"])).toContain("--max-retries");
  expect(err(["--max-words", "-5"])).toContain("--max-words");
  expect(err(["--tau", "2"])).toContain("--tau");
  expect(err(["--tau", "nope"])).toContain("--tau");
  // valid values pass
  expect(ok(["--max-retries", "1", "in.md"]).opts.maxRetries).toBe(1);
  expect(ok(["--tau", "0.7", "in.md"]).opts.tau).toBe(0.7);
});

test("parseArgs: a value flag with no following token errors instead of silently defaulting", () => {
  expect(err(["--max-retries"])).toContain("--max-retries");
});

test("parseArgs: --max-words 0 disables the guard; a positive value is an absolute ceiling", () => {
  expect(ok(["--max-words", "0", "in.md"]).opts.maxWords).toBe(0);
  expect(ok(["--max-words", "500", "in.md"]).opts.maxWords).toBe(500);
});

test("parseArgs: --no-expand-guard is sugar for --max-words 0", () => {
  expect(ok(["--no-expand-guard", "in.md"]).opts.maxWords).toBe(0);
  // agreeing --max-words 0 is not a conflict
  expect(ok(["--no-expand-guard", "--max-words", "0", "in.md"]).opts.maxWords).toBe(0);
});

test("parseArgs: --no-expand-guard conflicting with a positive --max-words errors", () => {
  const m = err(["--no-expand-guard", "--max-words", "500", "in.md"]);
  expect(m).toContain("--no-expand-guard");
  expect(m).toContain("--max-words");
});

test("parseArgs: `render` as the first positional selects render mode", () => {
  const r = ok(["render", "glossary.md"]);
  expect(r.mode).toBe("render");
  expect(r.opts.path).toBe("glossary.md");
});

test("parseArgs: a flag may precede the render subcommand without breaking detection", () => {
  const r = ok(["--lang", "ru", "render", "glossary.md"]);
  expect(r.mode).toBe("render");
  expect(r.opts.path).toBe("glossary.md");
  expect(r.opts.lang).toBe("ru");
});

test("parseArgs: `render` as a second positional errors instead of misparsing to ENOENT", () => {
  const m = err(["foo.md", "render"]);
  expect(m).toMatch(/extra|unexpected/i);
});

test("parseArgs: an extra positional argument errors", () => {
  const m = err(["a.md", "b.md"]);
  expect(m).toMatch(/extra|unexpected/i);
  expect(m).toContain("b.md");
});

// A blank/whitespace-only value (a common `--flag "$UNSET"` shell footgun) must fail loudly
// like every other non-number, NOT coerce to 0 via Number("") — for --max-words that would
// silently disable the expand-guard, the very footgun this flag exists to make explicit.
test("parseArgs: a blank numeric value errors instead of silently coercing to 0", () => {
  expect(err(["--max-words", "", "in.md"])).toContain("--max-words");
  expect(err(["--max-words", "   ", "in.md"])).toContain("--max-words");
  expect(err(["--tau", " ", "in.md"])).toContain("--tau");
  expect(err(["--max-retries", "", "in.md"])).toContain("--max-retries");
});

// `--` is the conventional end-of-options separator: everything after it is a positional,
// so a dash-prefixed filename can still be passed as the input path.
test("parseArgs: `--` ends option parsing; a following dash-prefixed token is the path", () => {
  expect(ok(["--", "input.md"]).opts.path).toBe("input.md");
  expect(ok(["--", "-weird-name.md"]).opts.path).toBe("-weird-name.md");
});

// A single-dash unknown token is a flag typo, not a positional: name it, don't misattribute
// the error to the following values or ENOENT-crash on it as a bogus path.
test("parseArgs: a single-dash unknown token errors and names the offending token", () => {
  expect(err(["-x", "in.md"])).toContain("-x");
  const m = err(["-tau", "0.6", "in.md"]);
  expect(m).toContain("-tau");
  // the values must not be misattributed as the problem
  expect(m).not.toContain("0.6");
});
