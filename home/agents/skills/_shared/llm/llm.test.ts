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
  dashscope,
  ensureKeys,
  extractJson,
  fireworks,
  isTransient,
  makeRethrowIfBug,
  type ModelRef,
  openai,
  TransientError,
  TruncationError,
} from "./llm.ts";
import { MissingKeyError, resolveKey } from "./keys.ts";

// A test transport is keyed by a bare model id; wrap it in the simplest ModelRef (fireworks,
// no reasoning knobs). The provider only matters for the buildBody/key tests further down.
const demo = (id = "demo"): ModelRef => fireworks(id);

// The fetch-mock tests drive the real transport, which resolves the provider key before
// fetching. Pre-set them so resolveKey returns immediately (hermetic — no Keychain/Doppler shell-out).
process.env.FIREWORKS_API_KEY ||= "test-key";
process.env.OPENAI_API_KEY ||= "test-key";
process.env.DASHSCOPE_API_KEY ||= "test-key";

// Drive the real transport with a fetch mock that captures the outgoing request, returning a
// minimal valid completion. Returns the parsed request body so a test can assert per-provider shape.
async function captureBody(model: ModelRef): Promise<Record<string, unknown>> {
  let seen: Record<string, unknown> = {};
  const realFetch = globalThis.fetch;
  globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
    seen = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  try {
    await askJson(model, "prompt", 4096);
  } finally {
    globalThis.fetch = realFetch;
  }
  return seen;
}

// ---- provider routing: each ModelRef shapes the request body for its own API ----
test("buildBody: Fireworks uses max_tokens + temperature", async () => {
  const b = await captureBody(fireworks("acme/m"));
  expect(b.max_tokens).toBe(4096);
  expect(b.temperature).toBe(0);
  expect(b.max_completion_tokens).toBeUndefined();
});

test("buildBody: OpenAI uses max_completion_tokens + reasoning_effort, and OMITS temperature", async () => {
  const b = await captureBody(openai("gpt-5.6-luna", { effort: "medium" }));
  expect(b.max_completion_tokens).toBe(4096);
  expect(b.reasoning_effort).toBe("medium");
  expect(b.temperature).toBeUndefined(); // reasoning models reject temperature != 1
  expect(b.max_tokens).toBeUndefined();
});

test("buildBody: qwencloud passes enable_thinking:false when thinking is disabled", async () => {
  const off = await captureBody(dashscope("glm-5.2", { thinking: { enable: false } }));
  expect(off.enable_thinking).toBe(false);
  const dflt = await captureBody(dashscope("glm-5.2"));
  expect(dflt.enable_thinking).toBeUndefined(); // omitted → provider default (thinking on)
});

// ---- key resolution: env wins; nothing resolvable → MissingKeyError (non-transient) ----
test("resolveKey: an already-set env var short-circuits the shell-outs", () => {
  process.env.TESTKIT_FAKE_KEY = "abc123";
  expect(resolveKey({ env: "TESTKIT_FAKE_KEY" })).toBe("abc123");
  delete process.env.TESTKIT_FAKE_KEY;
});

test("resolveKey: a key with no resolvable source throws MissingKeyError", () => {
  expect(() => resolveKey({ env: "TESTKIT_ABSENT_KEY_XYZ" })).toThrow(MissingKeyError);
  expect(isTransient(new MissingKeyError("x"))).toBe(false); // must surface (exit 1), never degrade
});

test("ensureKeys: resolves each provider once and throws if any key is missing", () => {
  expect(() => ensureKeys([fireworks("a"), openai("b")])).not.toThrow(); // both env-set above
  const missing: ModelRef = { provider: fireworks("a").provider, id: "a" };
  // swap in a ref whose provider key is unresolvable by pointing at an absent env-only source
  const bad = { ...missing, provider: { ...missing.provider, key: { env: "TESTKIT_ABSENT2" } } };
  expect(() => ensureKeys([bad as ModelRef])).toThrow(MissingKeyError);
});

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
      await askJson(demo("demo-model"), "prompt", 16384);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TruncationError);
    expect(isTransient(err)).toBe(false); // a truncation is NOT a transient flake
    expect((err as Error).message).toContain("cap=16384");
    expect((err as Error).message).toContain("demo-model"); // short model name from the path tail
    expect(fetchMock).toHaveBeenCalledTimes(1); // no network retry, no parse retry
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---- retry policy: a timeout is a re-roll, retried; it recovers when the retry clears ----
// gpt-oss's generation length is non-deterministic, so a call that ran to the (per-call) ceiling
// usually clears on the next try. fw retries a timeout rather than failing it, and only surfaces
// a TransientError once the retry ALSO times out.
test("askJson: a persistent timeout is retried once, then surfaces", async () => {
  const fetchMock = mock(async () => {
    throw new DOMException("The operation timed out.", "TimeoutError");
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  try {
    let err: unknown;
    try {
      await askJson(demo(), "prompt", 2048);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TransientError); // degrades gracefully to the caller's fallback
    expect(fetchMock).toHaveBeenCalledTimes(2); // the timeout was re-rolled, not failed on attempt 0
  } finally {
    globalThis.fetch = realFetch;
  }
});

// attempts=1 opts OUT of the re-roll: an advisory stage (the fidelity gate) that would rather
// degrade than pay a second full-length call fails fast on the first flake.
test("askJson: attempts=1 fails fast on a timeout — no re-roll", async () => {
  const fetchMock = mock(async () => {
    throw new DOMException("The operation timed out.", "TimeoutError");
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  try {
    let err: unknown;
    try {
      await askJson(demo(), "prompt", 2048, undefined, 1);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TransientError);
    expect(fetchMock).toHaveBeenCalledTimes(1); // attempts=1: no network re-roll
  } finally {
    globalThis.fetch = realFetch;
  }
});

// The point of retrying a timeout: a single runaway attempt clears on the re-roll, so the run
// recovers instead of dropping to passthrough.
test("askJson: a timeout that clears on the retry recovers the run", async () => {
  let n = 0;
  const fetchMock = mock(async () => {
    n++;
    if (n === 1) throw new DOMException("The operation timed out.", "TimeoutError");
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  try {
    const out = await askJson<{ ok: boolean }>(demo(), "prompt", 2048);
    expect(out).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2); // one runaway, then the re-roll succeeded
  } finally {
    globalThis.fetch = realFetch;
  }
});

// A non-timeout network error (connection reset, DNS) is likewise transient — retried once.
test("askJson: a non-timeout network error is retried once", async () => {
  const fetchMock = mock(async () => {
    throw new TypeError("network connection reset");
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  try {
    let err: unknown;
    try {
      await askJson(demo(), "prompt", 2048);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TransientError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// The per-call timeoutMs is threaded to the transport, so a runaway-prone stage can set a tight
// ceiling. Inject a fake transport (the `call` seam) and assert it receives the value.
test("askJson: forwards the per-call timeoutMs to the transport", async () => {
  let seen: number | undefined = -1;
  const fakeCall = mock(
    async (_model: string, _messages: unknown, opts: { timeoutMs?: number }) => {
      seen = opts.timeoutMs;
      return '{"ok":true}';
    },
  );
  await askJson(demo(), "prompt", 2048, 75_000, 2, fakeCall as never);
  expect(seen).toBe(75_000);
});
