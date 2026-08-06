// writing/spell tests — the frozen prompt pinned, and spellPass's mask/revert/degrade
// wiring driven through an injected `ask` fake (degradation.test.ts pattern) — all offline.
// The deterministic verifier's own accept/reject matrix moved to core/writing/verify.test.ts.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "bun:test";
import { askJson, TransientError } from "@skills/llm/llm.ts";
import { langRule, segment } from "textkit/core/text.ts";
import { spellPass, spellPassPrompt } from "textkit/polish/spell.ts";

const read = (name: string) => readFileSync(resolve(import.meta.dir, "../fixtures", name), "utf8");

// ---- the frozen prompt (pure) ----
test("spellPassPrompt: frozen sentences and JSON shape pinned; proofreader never translates", () => {
  const blocks = [{ id: "B1", text: "Teh text." }];
  const en = spellPassPrompt(blocks);
  expect(en).toContain("Change NOTHING else:");
  expect(en).toContain('Return ONLY JSON {"blocks":');
  expect(en).toContain("[B1] Teh text.");
  expect(en).toContain("Keep every word in the language it is written in; never translate.");
  // langRule is an abstractive-generation rule ("write everything in X"): on a
  // code-switched RU/EN note it reads as an order to translate the other language's
  // clauses (observed live). It must stay out of the proofreader prompt.
  expect(en).not.toContain(langRule("en"));
  expect(en).not.toContain(langRule("ru"));
});

// ---- spellPass wiring: injected `ask` fake, no network, no process-global module
// mock (see degradation.test.ts's note on why mock.module leaks across bun's concurrent
// test files). spellPass takes its model call as a trailing `ask` param. ----
const throwsAsk = (err: unknown): typeof askJson =>
  (async () => {
    throw err;
  }) as typeof askJson;
const askBy = (handler: (prompt: string) => unknown): typeof askJson =>
  (async (_model: unknown, prompt: string) => handler(prompt)) as typeof askJson;

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
  const out = await spellPass(
    [
      { id: "B1", text: b1 },
      { id: "B2", text: "Blocks with seperate concerns are split." },
    ],
    [],
    askBy((prompt) => ({
      blocks: [
        { id: "B1", text: "Everything about this block was rewritten from scratch by the model." },
        { id: "B2", text: promptBlocks(prompt)[1].text.replace("seperate", "separate") },
      ],
    })),
  );
  expect(out.failed).toBe(false);
  expect(out.reverted).toEqual(["B1"]);
  expect(out.blocks[0].text).toBe(b1); // input kept verbatim
  expect(out.blocks[1].text).toBe("Blocks with separate concerns are split.");
});

test("spellPass: an echoed [B1] marker is stripped before verification", async () => {
  const out = await spellPass(
    [{ id: "B1", text: "Teh text is fixed." }],
    [],
    askBy(() => ({ blocks: [{ id: "B1", text: "[B1] The text is fixed." }] })),
  );
  expect(out.reverted).toEqual([]);
  expect(out.blocks[0].text).toBe("The text is fixed.");
});

test("spellPass: a transient flake returns the input blocks with failed: true", async () => {
  const blocks = [{ id: "B1", text: "Teh text." }];
  const out = await spellPass(
    blocks,
    [],
    throwsAsk(new TransientError("model output parse failure")),
  );
  expect(out).toEqual({ blocks, reverted: [], failed: true });
});

test("spellPass: a non-transient code bug propagates", async () => {
  await expect(
    spellPass(
      [{ id: "B1", text: "Teh text." }],
      [],
      throwsAsk(new TypeError("cannot read property of undefined")),
    ),
  ).rejects.toThrow("cannot read property of undefined");
});

test("spellPass: EN fixture's masked spans survive a mocked fix byte-identical", async () => {
  const out = await spellPass(
    segment(read("spell-seeded-en.md")),
    [],
    askBy((prompt) => ({
      blocks: promptBlocks(prompt).map((b) => ({
        id: b.id,
        text: b.text
          .replace("recieves", "receives")
          .replace("dose", "does")
          .replace("seperate", "separate")
          .replace("teh ", "the "),
      })),
    })),
  );
  expect(out.reverted).toEqual([]);
  expect(out.blocks[0].text).toContain("[[render router]]");
  expect(out.blocks[0].text).toContain("receives");
  expect(out.blocks[1].text).toContain("`--tau 0.5`");
  expect(out.blocks[1].text).toContain("the results");
});

test("spellPass: a live-observed synonym swap reverts its block; the legit fix beside it ships", async () => {
  const out = await spellPass(
    segment(read("spell-quirks-en.md")),
    [],
    askBy((prompt) => ({
      blocks: promptBlocks(prompt).map((b) => ({
        id: b.id,
        text: b.text.replace("bruited", "broadcast").replace("irregardless", "regardless"),
      })),
    })),
  );
  expect(out.failed).toBe(false);
  expect(out.reverted).toEqual(["B2"]);
  expect(out.blocks[1].text).toContain("bruited"); // rare-but-correct word survives
  expect(out.blocks[2].text).toContain("right, regardless of"); // the real fix ships
});

test("spellPass: an indented block echoed byte-identical keeps its leading whitespace", async () => {
  // regression: the id-marker stripper's unconditional trim flattened nested list
  // items and 4-space code blocks even when the model changed nothing.
  const out = await spellPass(
    segment("- parent\n\n  - child one\n  - child two"),
    [],
    askBy((prompt) => ({
      blocks: promptBlocks(prompt).map((b) => ({ id: b.id, text: b.text })),
    })),
  );
  expect(out.reverted).toEqual([]);
  expect(out.blocks[1].text).toBe("  - child one\n  - child two");
});

test("spellPass: RU fixture's masked spans survive a mocked fix byte-identical", async () => {
  const out = await spellPass(
    segment(read("spell-seeded-ru.md")),
    [],
    askBy((prompt) => ({
      blocks: promptBlocks(prompt).map((b) => ({
        id: b.id,
        text: b.text
          .replace("что бы", "чтобы")
          .replace("зависет", "зависит")
          .replace("по этому", "поэтому"),
      })),
    })),
  );
  expect(out.reverted).toEqual([]);
  expect(out.blocks[0].text).toContain("`card-stage`");
  expect(out.blocks[0].text).toContain("чтобы");
  expect(out.blocks[1].text).toContain("[[глоссарий|глоссарию]]");
  expect(out.blocks[1].text).toContain("зависит");
});
