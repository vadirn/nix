// simplify/meaning tests — the advisory meaning axis driven through an injected `ask` fake (no
// network): a recast pair is flagged, a faithful pair is silent, empty change short-circuits before
// any call, and every model failure (missing key, transient flake, truncation) degrades to a clean
// skip while a genuine bug propagates. Plus meaningClean and the formatMeaning rendering. Offline.
import { expect, test } from "bun:test";
import { MissingKeyError } from "@skills/llm/keys.ts";
import { type askJson, TransientError, TruncationError } from "@skills/llm/llm.ts";
import type { ChangeItem } from "textkit/simplify/prompt.ts";
import {
  type MeaningReport,
  formatMeaning,
  meaningClean,
  meaningPrompt,
  runMeaning,
} from "textkit/simplify/meaning.ts";

// A change pair helper: the two fields the axis reads; transform/why are ignored by the judge.
const pair = (before: string, after: string): ChangeItem => ({
  before,
  after,
  transform: "x",
  why: "y",
});

// An ask fake returning a fixed verdict for any prompt; `seen` captures the prompt to assert the
// batched pairs reached the model.
const askVerdict = (verdict: unknown, seen?: (prompt: string) => void): typeof askJson =>
  (async (_model: unknown, prompt: string) => {
    seen?.(prompt);
    return verdict;
  }) as unknown as typeof askJson;

// An ask fake that always throws, to drive the degrade paths.
const askThrows = (err: unknown): typeof askJson =>
  (async () => {
    throw err;
  }) as unknown as typeof askJson;

test("runMeaning: empty change short-circuits — no call, checked 0, not skipped, clean", async () => {
  let called = false;
  const ask = askVerdict({ findings: [] }, () => {
    called = true;
  });
  const r = await runMeaning([], { ask });
  expect(called).toBe(false); // no model call for an empty change array
  expect(r).toEqual({ checked: 0, findings: [], skipped: false });
  expect(meaningClean(r)).toBe(true);
});

test("runMeaning: a faithful pair yields no finding and the batched pairs reach the model", async () => {
  let prompt = "";
  const ask = askVerdict({ findings: [] }, (p) => {
    prompt = p;
  });
  const r = await runMeaning([pair("The tool masks spans.", "The tool masks the spans.")], { ask });
  expect(r.findings).toEqual([]);
  expect(r.skipped).toBe(false);
  expect(r.checked).toBe(1);
  expect(prompt).toContain("[0] BEFORE: The tool masks spans."); // the pair was submitted by index
  expect(meaningClean(r)).toBe(true);
});

test("runMeaning: a statement recast as a command is flagged and names the before/after", async () => {
  const ask = askVerdict({
    findings: [{ index: 0, issue: "statement recast as a command" }],
  });
  const r = await runMeaning([pair("The tool masks spans.", "Run the tool to mask spans.")], {
    ask,
  });
  expect(r.findings).toEqual([
    {
      before: "The tool masks spans.",
      after: "Run the tool to mask spans.",
      issue: "statement recast as a command",
    },
  ]);
  expect(meaningClean(r)).toBe(false);
  expect(formatMeaning(r)).toContain("statement recast as a command");
});

test("runMeaning: N pairs cost exactly one batched model call", async () => {
  let calls = 0;
  const ask = (async () => {
    calls++;
    return { findings: [] };
  }) as unknown as typeof askJson;
  await runMeaning([pair("a", "b"), pair("c", "d"), pair("e", "f")], { ask });
  expect(calls).toBe(1); // one bounded call for the whole change array
});

test("runMeaning: an out-of-range verdict index is ignored, never a crash", async () => {
  const ask = askVerdict({ findings: [{ index: 9, issue: "bogus" }] });
  const r = await runMeaning([pair("a", "b")], { ask });
  expect(r.findings).toEqual([]); // index 9 has no pair — dropped
  expect(meaningClean(r)).toBe(true);
});

test("runMeaning: a missing key degrades to a clean skip so the brief still ships", async () => {
  const r = await runMeaning([pair("a", "b")], { ask: askThrows(new MissingKeyError("no key")) });
  expect(r).toEqual({ checked: 1, findings: [], skipped: true });
  expect(meaningClean(r)).toBe(true);
});

test("runMeaning: a transient flake and a truncation both degrade to a skip", async () => {
  const t = await runMeaning([pair("a", "b")], { ask: askThrows(new TransientError("flake")) });
  expect(t.skipped).toBe(true);
  const c = await runMeaning([pair("a", "b")], { ask: askThrows(new TruncationError("cut off")) });
  expect(c.skipped).toBe(true);
});

test("runMeaning: a genuine code bug propagates rather than degrading", async () => {
  const ask = askThrows(new TypeError("cannot read property of undefined"));
  await expect(runMeaning([pair("a", "b")], { ask })).rejects.toThrow(TypeError);
});

test("formatMeaning: OK, skip, and no-pairs lines each read distinctly", () => {
  const ok: MeaningReport = { checked: 3, findings: [], skipped: false };
  expect(formatMeaning(ok)).toContain("- meaning: OK — 3 change pair(s) kept their speech act");
  const skip: MeaningReport = { checked: 2, findings: [], skipped: true };
  expect(formatMeaning(skip)).toContain("- meaning: skipped");
  const none: MeaningReport = { checked: 0, findings: [], skipped: false };
  expect(formatMeaning(none)).toContain("no change pairs to check");
});

test("meaningPrompt: it names the speech-act axes and forbids flagging on style alone", () => {
  const p = meaningPrompt([pair("a", "b")]);
  expect(p).toContain("tense");
  expect(p).toContain("mood");
  expect(p).toContain("polarity");
  expect(p).toContain("Only a shifted speech act is a finding.");
});
