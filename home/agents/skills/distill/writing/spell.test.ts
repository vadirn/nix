// writing/spell tests — the frozen prompt pinned, the deterministic verifier's
// accept/reject matrix on synthetic pairs, and spellPass's mask/revert/degrade
// wiring driven through a mocked fw (degradation.test.ts pattern) — all offline.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, expect, mock, test } from "bun:test";
import { TransientError } from "../fw.ts";
import { langRule, segment } from "../text.ts";
import { spellPassPrompt, verifySpellBlock } from "./spell.ts";

const read = (name: string) => readFileSync(resolve(import.meta.dir, "../fixtures", name), "utf8");

// ---- the frozen prompt (pure) ----
test("spellPassPrompt: frozen sentences and JSON shape pinned; bilingual via langRule", () => {
  const blocks = [{ id: "B1", text: "Teh text." }];
  const en = spellPassPrompt(blocks, "en");
  expect(en).toContain("Change NOTHING else:");
  expect(en).toContain('Return ONLY JSON {"blocks":');
  expect(en).toContain("[B1] Teh text.");
  expect(en).toContain(langRule("en"));
  expect(spellPassPrompt(blocks, "ru")).toContain(langRule("ru"));
});

// ---- the deterministic verifier (pure) ----
test("verifySpellBlock: identical input/output is ok", () => {
  expect(verifySpellBlock("a ⟦0⟧ b", "a ⟦0⟧ b")).toEqual({ ok: true });
});

test("verifySpellBlock: a dropped ⟦N⟧ token fails as mask tokens changed", () => {
  expect(verifySpellBlock("see ⟦0⟧ here", "see here")).toEqual({
    ok: false,
    reason: "mask tokens changed",
  });
});

test("verifySpellBlock: a duplicated ⟦N⟧ token fails as mask tokens changed", () => {
  expect(verifySpellBlock("see ⟦0⟧ here", "see ⟦0⟧ ⟦0⟧ here")).toEqual({
    ok: false,
    reason: "mask tokens changed",
  });
});

test("verifySpellBlock: a merged line fails as line structure changed", () => {
  expect(verifySpellBlock("first line\nsecond line", "first line second line")).toEqual({
    ok: false,
    reason: "line structure changed",
  });
});

test("verifySpellBlock: a 1-char fix in a 200-char block is ok", () => {
  const input = "The pipeline recieves each note from the inbox and does a quick triage. ".repeat(
    3,
  );
  expect(input.length).toBeGreaterThanOrEqual(200);
  expect(verifySpellBlock(input, input.replace("recieves", "receives"))).toEqual({ ok: true });
});

test("verifySpellBlock: a full rephrase fails as diff exceeds bound", () => {
  const input = "The pipeline recieves each note from the inbox and does a quick triage. ".repeat(
    3,
  );
  const rephrase = "Every note arriving in the inbox is triaged rapidly by our system. ".repeat(3);
  expect(verifySpellBlock(input, rephrase)).toEqual({ ok: false, reason: "diff exceeds bound" });
});

test("verifySpellBlock: a 1-word block correction rides the absolute floor of 4", () => {
  expect(verifySpellBlock("Teh", "The")).toEqual({ ok: true });
});

// ---- spellPass wiring: mocked fw, no network (degradation.test.ts pattern) ----
const FW = "../fw.ts";
const SPELL = "./spell.ts";
const real = await import(FW);

function mockAskJsonBy(handler: (prompt: string) => unknown) {
  mock.module(FW, () => ({
    ...real,
    askJson: mock(async (_model: unknown, prompt: string) => handler(prompt)),
  }));
}

// restore the real transport so the mock cannot leak into other test files
afterAll(() => mock.module(FW, () => real));

// parse the "[Bn] text" entries back out of the prompt's TEXT section (fixture
// blocks are single-line paragraphs, so the \n\n split is exact)
const promptBlocks = (prompt: string): { id: string; text: string }[] =>
  prompt
    .split("\nTEXT:\n")[1]
    .split("\n\n")
    .map((s) => {
      const m = s.match(/^\[(B\d+)\] ([\s\S]*)$/);
      if (!m) throw new Error(`unparseable block: ${s}`);
      return { id: m[1], text: m[2] };
    });

test("spellPass: a rephrased block reverts to its input and is flagged; others keep the fix", async () => {
  const b1 = "The pipeline recieves each note from the inbox and does a quick triage step. ".repeat(
    2,
  );
  mockAskJsonBy((prompt) => ({
    blocks: [
      { id: "B1", text: "Everything about this block was rewritten from scratch by the model." },
      { id: "B2", text: promptBlocks(prompt)[1].text.replace("seperate", "separate") },
    ],
  }));
  const { spellPass } = await import(SPELL);
  const out = await spellPass(
    [
      { id: "B1", text: b1 },
      { id: "B2", text: "Blocks with seperate concerns are split." },
    ],
    "en",
  );
  expect(out.failed).toBe(false);
  expect(out.reverted).toEqual(["B1"]);
  expect(out.blocks[0].text).toBe(b1); // input kept verbatim
  expect(out.blocks[1].text).toBe("Blocks with separate concerns are split.");
});

test("spellPass: an echoed [B1] marker is stripped before verification", async () => {
  mockAskJsonBy(() => ({ blocks: [{ id: "B1", text: "[B1] The text is fixed." }] }));
  const { spellPass } = await import(SPELL);
  const out = await spellPass([{ id: "B1", text: "Teh text is fixed." }], "en");
  expect(out.reverted).toEqual([]);
  expect(out.blocks[0].text).toBe("The text is fixed.");
});

test("spellPass: a transient flake returns the input blocks with failed: true", async () => {
  mock.module(FW, () => ({
    ...real,
    askJson: mock(async () => {
      throw new TransientError("model output parse failure");
    }),
  }));
  const { spellPass } = await import(SPELL);
  const blocks = [{ id: "B1", text: "Teh text." }];
  const out = await spellPass(blocks, "en");
  expect(out).toEqual({ blocks, reverted: [], failed: true });
});

test("spellPass: a non-transient code bug propagates", async () => {
  mock.module(FW, () => ({
    ...real,
    askJson: mock(async () => {
      throw new TypeError("cannot read property of undefined");
    }),
  }));
  const { spellPass } = await import(SPELL);
  await expect(spellPass([{ id: "B1", text: "Teh text." }], "en")).rejects.toThrow(
    "cannot read property of undefined",
  );
});

test("spellPass: EN fixture's masked spans survive a mocked fix byte-identical", async () => {
  mockAskJsonBy((prompt) => ({
    blocks: promptBlocks(prompt).map((b) => ({
      id: b.id,
      text: b.text
        .replace("recieves", "receives")
        .replace("dose", "does")
        .replace("seperate", "separate")
        .replace("teh ", "the "),
    })),
  }));
  const { spellPass } = await import(SPELL);
  const out = await spellPass(segment(read("spell-seeded-en.md")), "en");
  expect(out.reverted).toEqual([]);
  expect(out.blocks[0].text).toContain("[[render router]]");
  expect(out.blocks[0].text).toContain("receives");
  expect(out.blocks[1].text).toContain("`--tau 0.5`");
  expect(out.blocks[1].text).toContain("the results");
});

test("spellPass: RU fixture's masked spans survive a mocked fix byte-identical", async () => {
  mockAskJsonBy((prompt) => ({
    blocks: promptBlocks(prompt).map((b) => ({
      id: b.id,
      text: b.text
        .replace("что бы", "чтобы")
        .replace("зависет", "зависит")
        .replace("по этому", "поэтому"),
    })),
  }));
  const { spellPass } = await import(SPELL);
  const out = await spellPass(segment(read("spell-seeded-ru.md")), "ru");
  expect(out.reverted).toEqual([]);
  expect(out.blocks[0].text).toContain("`card-stage`");
  expect(out.blocks[0].text).toContain("чтобы");
  expect(out.blocks[1].text).toContain("[[глоссарий|глоссарию]]");
  expect(out.blocks[1].text).toContain("зависит");
});
