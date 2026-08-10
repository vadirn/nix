// simplify/sequence tests — the SHAPE scan on synthetic prose: it flags a serial run and a
// semicolon set, holds its fire on a pair or a bare comma, and skips the structure a list must never
// grow into. Pure, offline.
import { expect, test } from "bun:test";
import { sequenceScan } from "textkit/simplify/sequence.ts";

test("sequenceScan: a serial run of three or more comma members is a sequence", () => {
  const line = "It extracts every comment, classifies each one, and verdicts it.";
  const found = sequenceScan(line);
  expect(found).toHaveLength(1);
  expect(found[0]!.sentence).toBe(line);
});

test("sequenceScan: a pair stays prose, because two members read worse as a list", () => {
  expect(sequenceScan("It extracts every comment, and it verdicts each one.")).toEqual([]);
});

test("sequenceScan: commas without a closing and/or are an aside, not a series", () => {
  // Three comma segments, no serial coordination: an appositive, which prose holds better than a list.
  expect(sequenceScan("The tool, a fifth CLI, reads source, then stops.")).toEqual([]);
});

test("sequenceScan: three semicolon members are a set, with no and/or needed", () => {
  const line =
    "The keep-list holds: why comments; invariants a type cannot express; public API docs.";
  const found = sequenceScan(line);
  expect(found).toHaveLength(1);
  expect(found[0]!.members).toBe(3);
});

test("sequenceScan: a list item is skipped whole, so SHAPE never nests a list under one", () => {
  // The same sentence flagged bare must NOT be flagged as a bullet or a numbered item — KEEP forbids
  // growing a list's item count, and a nested list is the over-split the module guards against.
  const sentence = "It extracts every comment, classifies each one, and verdicts it.";
  expect(sequenceScan(sentence)).toHaveLength(1);
  for (const marker of ["- ", "* ", "+ ", "1. ", "2) "])
    expect(sequenceScan(`${marker}${sentence}`)).toEqual([]);
});

test("sequenceScan: headings, table rows, blockquotes, and fenced code never count as prose", () => {
  const sentence = "It extracts every comment, classifies each one, and verdicts it.";
  const doc = [
    `# ${sentence}`, // heading
    "```", // fenced code opener
    sentence, // code line — not prose
    "```",
    `| ${sentence} | cell |`, // table row
    `> ${sentence}`, // blockquote — a quoted specimen KEEP freezes
  ].join("\n");
  expect(sequenceScan(doc)).toEqual([]);
});

test("sequenceScan: only the enumerating sentence on a line is flagged", () => {
  const seq = "It extracts, classifies, and verdicts.";
  const found = sequenceScan(`${seq} It prints a brief.`);
  expect(found).toHaveLength(1);
  expect(found[0]!.sentence).toBe(seq);
});

test("sequenceScan: a bold lead ends a sentence, so the members are not merged across it", () => {
  // The Simplified style writes bold leads, so a sentence routinely ends at `.**`. A splitter blind
  // to the closing `**` would merge the lead into the next sentence and miscount its members.
  const found = sequenceScan("**A lead, short.** It extracts, classifies, and verdicts.");
  expect(found).toHaveLength(1);
  expect(found[0]!.sentence).toBe("It extracts, classifies, and verdicts.");
});

test("sequenceScan: a frozen ⟦N⟧ span is one member like any other token", () => {
  const line = "It verdicts each comment ⟦0⟧, ⟦1⟧, ⟦2⟧, or ⟦3⟧.";
  expect(sequenceScan(line)).toHaveLength(1);
});

test("sequenceScan: findings come back with the most members first", () => {
  const two = "It extracts, classifies, and verdicts.";
  const three = "It reads source, extracts comments, classifies each, and verdicts them.";
  const members = sequenceScan(`${two}\n${three}`).map((f) => f.members);
  expect(members).toEqual([...members].sort((a, b) => b - a));
  expect(members).toHaveLength(2);
});

test("sequenceScan: the threshold is overridable, so a pair scans as a sequence at min 2", () => {
  const pair = "It extracts every comment, and it verdicts each one.";
  expect(sequenceScan(pair)).toEqual([]);
  expect(sequenceScan(pair, 2)).toHaveLength(1);
});

test("sequenceScan: the Oxford comma is required, so a bare 'A, B and C' is not a candidate", () => {
  // Deliberate under-reach. Counting a final segment that merely CONTAINS a coordinator makes
  // "member, member and member" indistinguishable from "adverbial, clause and clause": over 207
  // corpus files it took findings 707 → 904, and the 343 added were almost all fronted adverbials.
  // A false candidate is worse than a missed one here, because shapeHint's worklist is CLOSED — a
  // false candidate is a licensed conversion, while a missed series only stays prose.
  expect(sequenceScan("It reads, extracts and verdicts.")).toEqual([]);
  expect(sequenceScan("In this mode, the scan strips fences and skips lists.")).toEqual([]);
  expect(
    sequenceScan("Although the gate is advisory, it reports drift and names the axis."),
  ).toEqual([]);
});

test("sequenceScan: a Russian comma series is out of reach, and its semicolon set is not", () => {
  // Russian writes «А, Б и В» with no comma before "и", so every Russian comma series is non-Oxford
  // and the rule above excludes all of them. This is a KNOWN gap, recorded so it is not mistaken for
  // working support: closing it needs a language-aware scan, not a wider regex.
  expect(sequenceScan("Он читает, разбирает и решает.")).toEqual([]);
  const set = sequenceScan("Один читает; другой разбирает; третий решает.");
  expect(set).toHaveLength(1);
  expect(set[0]!.members).toBe(3);
});

test("sequenceScan: a relative-clause aside delimits nothing, so it never inflates the count", () => {
  // Two commas wrap the aside AND cut its host clause in two: "The scan, which is deterministic,
  // measures the source" reads as three segments where there is one member. With the coordinated
  // clause after it that reached 4 and the scan named a candidate that is not a series at all.
  expect(
    sequenceScan("The scan, which is deterministic, measures the source, and it never throws."),
  ).toEqual([]);
});

test("sequenceScan: a real series carrying a relative clause still counts its own members", () => {
  // The aside comes out of the sentence before the split, so removing it must not cost the series
  // its members — only the aside's own two commas go.
  const found = sequenceScan(
    "The tools we ship, which run offline, are distill-text, card-stage, and simplify-text.",
  );
  expect(found).toHaveLength(1);
  expect(found[0]!.members).toBe(3);
});
