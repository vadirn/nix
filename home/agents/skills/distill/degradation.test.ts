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
import { EXTRACT, TransientError, TruncationError, isTransient, rethrowIfBug } from "./fw.ts";

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

test("rethrowIfBug: a truncation is swallowed like a transient flake", () => {
  // a cap exhausted mid-output rides out to the caller's safe fallback, never aborts
  expect(() =>
    rethrowIfBug(new TruncationError("output truncated at max_tokens=16384"), "stage"),
  ).not.toThrow();
  expect(isTransient(new TruncationError("x"))).toBe(false); // distinct from TransientError
});

// ---- the truncation signal: finish_reason "length" → TruncationError, no retry ----
// A length-truncation throws TruncationError out of fw's attempt loop, so it is never
// network-retried; askJson awaits fw OUTSIDE its parse-retry, so it propagates
// immediately with no wasted parse-retry either. We mock fetch (not the module) to
// drive the real transport and count the calls.
test("askJson: a length finish_reason throws TruncationError, not retried", async () => {
  const fetchMock = mock(
    async () =>
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: "length", message: { content: '{"partial":' } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  );
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  try {
    let err: unknown;
    try {
      await real.askJson(EXTRACT, "prompt", 16384);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TruncationError);
    expect(isTransient(err)).toBe(false); // a truncation is NOT a transient flake
    expect((err as Error).message).toContain("max_tokens=16384");
    expect((err as Error).message).toContain("gpt-oss-120b");
    expect(fetchMock).toHaveBeenCalledTimes(1); // no network retry, no parse retry
  } finally {
    globalThis.fetch = realFetch;
  }
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

// per-call variant: the mock inspects each prompt so independent batches can succeed
// or flake separately (proseGate fires its batches concurrently via Promise.all).
function mockAskJsonBy(handler: (prompt: string) => unknown) {
  mock.module(FW, () => ({
    ...real,
    askJson: mock(async (_model: unknown, prompt: string) => handler(prompt)),
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

test("fidelityGate: a TruncationError rides out to inconclusive (run not aborted)", async () => {
  // glm legitimately exhausts FIDELITY_TOKENS; the gate must degrade, not abort
  mockAskJson(() => {
    throw new TruncationError(
      "output truncated at max_tokens=16384 (glm-5p2) — raise this stage's cap",
    );
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

test("synthWorkflow: a marker-only model step is rejected, the draft kept (no '3. 3.')", async () => {
  // the model "tightened" S0 into the bare ordinal "3." (a real failure seen in output);
  // accepting it would overwrite the draft and render "3. 3." — reject it, keep the draft.
  mockAskJsonBy(() => ({ steps: [{ id: "S0", step: "3." }] }));
  const { synthWorkflow } = await import(PROMPTS);
  const steps = [{ step: "do the thing", source: ["B1"] }];
  const blockById = new Map([["B1", { id: "B1", text: "do the thing" }]]);
  const out = await synthWorkflow(steps, "regenerate", blockById, "en");
  expect(out).toEqual(["do the thing"]);
});

// ---- proseGate: parallel batches keep the per-batch flake isolation (D46 / FIX B) ----
// The batches now fire concurrently, but a flake must still flag ONLY its own ids while a
// sibling batch's verdicts survive — never collapsing into one outer catch.
const proseUnits = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `u${i}`, heading: "H", depth: 2, span: "s" }));

test("proseGate: a transient flake on one batch flags only that batch's ids", async () => {
  // 7 units → two batches (u0-u4, u5-u6); the second batch flakes, the first verdicts.
  mockAskJsonBy((prompt) => {
    if (prompt.includes("### u5")) throw new TransientError("judge returned no JSON");
    const ids = [...prompt.matchAll(/### (u\d+)/g)].map((m) => m[1]);
    return { units: ids.map((id) => ({ id, grade: "covered", anchor: "abcd", missing: "" })) };
  });
  const { proseGate } = await import(PROMPTS);
  const { verdicts, flaked } = await proseGate(proseUnits(7), "body", "en");
  expect(flaked).toEqual(new Set(["u5", "u6"])); // only the flaked batch, not the whole run
  for (const id of ["u0", "u1", "u2", "u3", "u4"]) expect(verdicts.has(id)).toBe(true);
  for (const id of ["u5", "u6"]) expect(verdicts.has(id)).toBe(false);
});

test("proseGate: a non-transient code bug rejects the parallel batches", async () => {
  mockAskJson(() => {
    throw new TypeError("cannot read property of undefined");
  });
  const { proseGate } = await import(PROMPTS);
  await expect(proseGate(proseUnits(7), "body", "en")).rejects.toThrow(
    "cannot read property of undefined",
  );
});
