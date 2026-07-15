// llm transport tests — the provider-neutral primitives, in isolation.
//
// These pin the transport itself: the balanced-JSON extractor over loose model
// output, the transient/truncation classifiers, the rethrowIfBug degrade gate, and
// the finish_reason→TruncationError signal driven through the real fw() via a mocked
// fetch. Pipeline-degradation wiring (a distill stage degrading on a flake) lives in
// textkit's own suite (textkit/src/degradation.test.ts); only the transport
// primitives live here.
import { expect, mock, test } from "bun:test";
import {
  askJson,
  extractJson,
  isTransient,
  makeRethrowIfBug,
  TransientError,
  TruncationError,
} from "./llm.ts";

// The gate is bound per-consumer to a log prefix; the tests exercise a bound instance.
const rethrowIfBug = makeRethrowIfBug("test");

// ---- balanced-JSON extraction over loose model output ----
test("extractJson: returns a clean object verbatim", () => {
  expect(extractJson('{"a":1}')).toBe('{"a":1}');
});

test("extractJson: pulls the first balanced object out of surrounding reasoning", () => {
  expect(extractJson('thinking... {"prose":"hi"} trailing text')).toBe('{"prose":"hi"}');
});

test("extractJson: respects nesting and braces inside strings", () => {
  expect(extractJson('x {"a":{"b":1}} y')).toBe('{"a":{"b":1}}');
  expect(extractJson('{"a":"}"}')).toBe('{"a":"}"}'); // brace in a string value
});

test("extractJson: throws on no object and on an unbalanced object", () => {
  expect(() => extractJson("no braces here")).toThrow(/no JSON/);
  expect(() => extractJson('{"a":1')).toThrow(/unbalanced JSON/);
});

// ---- the classifier + the degrade gate it backs (pure, no network) ----
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

test("makeRethrowIfBug: the bound prefix names the consumer in the log line", () => {
  const captured: string[] = [];
  const realErr = console.error;
  console.error = ((first: unknown) => captured.push(String(first))) as typeof console.error;
  try {
    expect(() => makeRethrowIfBug("polish")(new TypeError("bug"), "spell")).toThrow();
  } finally {
    console.error = realErr;
  }
  expect(captured[0]).toContain("polish: spell failed");
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
      await askJson("accounts/test/models/demo-model", "prompt", 16384);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TruncationError);
    expect(isTransient(err)).toBe(false); // a truncation is NOT a transient flake
    expect((err as Error).message).toContain("max_tokens=16384");
    expect((err as Error).message).toContain("demo-model"); // short model name from the path tail
    expect(fetchMock).toHaveBeenCalledTimes(1); // no network retry, no parse retry
  } finally {
    globalThis.fetch = realFetch;
  }
});
