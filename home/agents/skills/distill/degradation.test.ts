// degradation tests — the narrowed gate/helper catches (§4.3).
//
// Every LLM stage wraps its askJson call in a graceful-degradation catch. Before
// this step those catches swallowed ANY throw, so a real code bug shipped an
// unverified distillation indistinguishable from a judge flake. The catches now
// route through fw's rethrowIfBug, which degrades only on a TransientError (the
// tag fw/askJson put on network/timeout/rate-limit/parse-of-model-output) and
// re-throws everything else after logging it. These tests pin both directions:
// (i) a non-transient code bug surfaces/propagates, (ii) a transient judge flake
// still degrades gracefully.
import { afterAll, expect, mock, test } from "bun:test";
import { TransientError, isTransient, rethrowIfBug } from "./fw.ts";

// ---- the classifier + the gate it backs (pure, no network) ----
test("isTransient: only TransientError is transient", () => {
  expect(isTransient(new TransientError("flake"))).toBe(true);
  expect(isTransient(new Error("plain"))).toBe(false);
  expect(isTransient(new TypeError("bug"))).toBe(false);
  expect(isTransient("string throw")).toBe(false);
});

test("rethrowIfBug: a transient flake returns; a code bug logs and propagates", () => {
  // transient: returns without throwing (the caller keeps its fallback)
  expect(() => rethrowIfBug(new TransientError("flake"), "stage")).not.toThrow();
  // non-transient: re-thrown verbatim so it cannot masquerade as a flake
  const bug = new TypeError("real bug");
  expect(() => rethrowIfBug(bug, "stage")).toThrow(bug);
});

// ---- the wiring: an actual stage degrades on transient, propagates on a bug ----
// fidelityGate and synthWorkflow stand in for the gate and the helper catches;
// all of them share the same rethrowIfBug seam. mock.module repoints prompts.ts's
// live askJson binding so we drive the catch without a network call.
const FW = "./fw.ts";
const PROMPTS = "./prompts.ts";
const real = await import(FW);

function mockAskJson(throwing: () => never) {
  mock.module(FW, () => ({
    ...real,
    askJson: mock(async () => throwing()),
  }));
}

// restore the real transport so the mock cannot leak into other test files
afterAll(() => mock.module(FW, () => real));

test("fidelityGate: a transient judge flake degrades every concept to inconclusive", async () => {
  mockAskJson(() => {
    throw new TransientError("judge returned no JSON");
  });
  const { fidelityGate } = await import(PROMPTS);
  const r = await fidelityGate("thesis", "body", [{ term: "x", def: "d", sourceText: "s" }]);
  expect(r.thesisRecoverable).toBe(true);
  expect(r.concepts).toHaveLength(1);
  expect(r.concepts[0].grade).toBe("inconclusive");
});

test("fidelityGate: a non-transient code bug propagates instead of shipping unverified", async () => {
  mockAskJson(() => {
    throw new TypeError("cannot read property of undefined");
  });
  const { fidelityGate } = await import(PROMPTS);
  await expect(
    fidelityGate("thesis", "body", [{ term: "x", def: "d", sourceText: "s" }]),
  ).rejects.toThrow("cannot read property of undefined");
});

test("synthWorkflow: a transient flake keeps the drafted steps", async () => {
  mockAskJson(() => {
    throw new TransientError("model output parse failure");
  });
  const { synthWorkflow } = await import(PROMPTS);
  const steps = [{ step: "do the thing", source: ["B1"] }];
  const blockById = new Map([["B1", { id: "B1", text: "do the thing" }]]);
  const out = await synthWorkflow(steps, "regenerate", blockById, "en");
  expect(out).toEqual(["do the thing"]); // unchanged draft survives the flake
});

test("synthWorkflow: a non-transient code bug propagates", async () => {
  mockAskJson(() => {
    throw new ReferenceError("undefined helper");
  });
  const { synthWorkflow } = await import(PROMPTS);
  const steps = [{ step: "do the thing", source: ["B1"] }];
  const blockById = new Map([["B1", { id: "B1", text: "do the thing" }]]);
  await expect(synthWorkflow(steps, "regenerate", blockById, "en")).rejects.toThrow(
    "undefined helper",
  );
});
