// degradation tests — the narrowed gate/helper catches.
//
// Every LLM stage wraps its askJson call in a graceful-degradation catch. Before
// this step those catches swallowed ANY throw, so a real code bug shipped an
// unverified distillation indistinguishable from a judge flake. The catches now
// route through fw's rethrowIfBug, which degrades only on a TransientError (the
// tag fw/askJson put on network/timeout/rate-limit/parse-of-model-output) and
// re-throws everything else after logging it. These tests pin both directions:
// (i) a non-transient code bug surfaces/propagates, (ii) a transient judge flake
// still degrades gracefully.
import { expect, test } from "bun:test";
import { askJson, fireworks, TransientError, TruncationError } from "@skills/llm/llm.ts";
import { fidelityGate, proseGate, revise, workflowGate } from "textkit/distill/prompt/prompts.ts";

// The transport primitives these gates lean on (isTransient / rethrowIfBug / the
// finish_reason→TruncationError signal, in isolation) are tested in the shared lib
// at libs/llm/llm.test.ts. This suite pins the PIPELINE wiring: an actual distill
// stage degrades on a transient/truncation flake and propagates a real code bug.

// ---- the wiring: an actual stage degrades on transient, propagates on a bug ----
// Each gate takes its model call as a trailing `ask` param that defaults to the real
// fw askJson; the tests pass a stand-in instead. This is dependency injection, NOT a
// process-global module mock — `mock.module("./llm.ts")` would repoint fw for EVERY
// file, and under bun's concurrent file execution it leaks into another suite's live
// LLM call (e.g. apply.test.ts's recover). An injected `ask` is scoped to the one call.
const throwsAsk = (err: unknown): typeof askJson =>
  (async () => {
    throw err;
  }) as typeof askJson;
// per-call variant: the fake inspects each prompt so independent batches can succeed
// or flake separately (proseGate fires its batches concurrently via Promise.all).
const askBy = (handler: (prompt: string) => unknown): typeof askJson =>
  (async (_model: unknown, prompt: string) => handler(prompt)) as typeof askJson;

test("fidelityGate: a transient judge flake degrades every concept to inconclusive", async () => {
  const r = await fidelityGate(
    "thesis",
    "body",
    [{ term: "x", def: "d", sourceText: "s" }],
    throwsAsk(new TransientError("judge returned no JSON")),
  );
  expect(r.thesisRecoverable).toBe(true);
  expect(r.concepts).toHaveLength(1);
  expect(r.concepts[0].grade).toBe("inconclusive");
});

test("fidelityGate: a TruncationError rides out to inconclusive (run not aborted)", async () => {
  // glm legitimately exhausts FIDELITY_TOKENS; the gate must degrade, not abort
  const r = await fidelityGate(
    "thesis",
    "body",
    [{ term: "x", def: "d", sourceText: "s" }],
    throwsAsk(
      new TruncationError(
        "output truncated at max_tokens=16384 (glm-5p2) — raise this stage's cap",
      ),
    ),
  );
  expect(r.thesisRecoverable).toBe(true);
  expect(r.concepts).toHaveLength(1);
  expect(r.concepts[0].grade).toBe("inconclusive");
});

test("fidelityGate: a non-transient code bug propagates instead of shipping unverified", async () => {
  await expect(
    fidelityGate(
      "thesis",
      "body",
      [{ term: "x", def: "d", sourceText: "s" }],
      throwsAsk(new TypeError("cannot read property of undefined")),
    ),
  ).rejects.toThrow("cannot read property of undefined");
});

test("workflowGate: a transient judge flake degrades every group to inconclusive", async () => {
  const r = await workflowGate(
    [{ id: "g0", steps: ["step"], sourceText: "s" }],
    "en",
    throwsAsk(new TransientError("judge returned no JSON")),
  );
  expect(r).toHaveLength(1);
  expect(r[0].grade).toBe("inconclusive");
  expect(r[0].id).toBe("g0");
});

test("revise: an echoed block-id marker is stripped from the returned text (live [__G0__] leak)", async () => {
  // a real vault run shipped glossary defs carrying literal [__G0__]–[__G4__] tokens:
  // render() shows blocks as "[id] text" and the model echoed the marker back.
  const out = await revise(
    [
      { id: "__G0__", text: "orig def 0" },
      { id: "__G1__", text: "orig def 1" },
    ],
    [{ name: "words", rules: "- tighten" }],
    fireworks("test"),
    2048,
    [],
    undefined,
    askBy(() => ({
      blocks: [
        { id: "__G0__", text: "[__G0__] A clean definition." },
        { id: "__G1__", text: "Mid-sentence [__G1__] echo survives content." },
      ],
    })),
  );
  expect(out[0].text).toBe("A clean definition.");
  expect(out[1].text).toBe("Mid-sentence echo survives content.");
});

// ---- proseGate: parallel batches keep the per-batch flake isolation ----
// The batches now fire concurrently, but a flake must still flag ONLY its own ids while a
// sibling batch's verdicts survive — never collapsing into one outer catch.
const proseUnits = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `u${i}`, heading: "H", depth: 2, span: "s" }));

test("proseGate: a transient flake on one batch flags only that batch's ids", async () => {
  // 7 units → two batches (u0-u4, u5-u6); the second batch flakes, the first verdicts.
  const { verdicts, flaked } = await proseGate(
    proseUnits(7),
    "body",
    "en",
    askBy((prompt) => {
      if (prompt.includes("### u5")) throw new TransientError("judge returned no JSON");
      const ids = [...prompt.matchAll(/### (u\d+)/g)].map((m) => m[1]);
      return { units: ids.map((id) => ({ id, grade: "covered", anchor: "abcd", missing: "" })) };
    }),
  );
  expect(flaked).toEqual(new Set(["u5", "u6"])); // only the flaked batch, not the whole run
  for (const id of ["u0", "u1", "u2", "u3", "u4"]) expect(verdicts.has(id)).toBe(true);
  for (const id of ["u5", "u6"]) expect(verdicts.has(id)).toBe(false);
});

test("proseGate: a non-transient code bug rejects the parallel batches", async () => {
  await expect(
    proseGate(
      proseUnits(7),
      "body",
      "en",
      throwsAsk(new TypeError("cannot read property of undefined")),
    ),
  ).rejects.toThrow("cannot read property of undefined");
});
