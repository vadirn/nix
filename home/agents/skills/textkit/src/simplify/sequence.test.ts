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
