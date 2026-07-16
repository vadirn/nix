// llm — a multi-provider LLM transport: one OpenAI-compatible HTTP call with transient
// retry (callProvider) behind the JSON-extracting wrapper (askJson) that callers drive.
// A caller passes a ModelRef — {provider, id, reasoning knobs} — so each call routes to
// Fireworks, OpenAI, or qwencloud (DashScope) by the model's own declaration. All three
// speak `/chat/completions`, so only the base URL, auth key, and a few body params differ
// (see the Provider descriptors); the response half — content, usage, finish_reason,
// retry — is shared. No model-policy (which model rides which stage, token budgets), no
// prompt text, and no pipeline logic live here — a caller supplies those via the ModelRef.

import { type KeySource, resolveKey } from "./keys.ts";

// A failure a caller can ride out: a network/timeout throw, a 429/5xx
// gateway status, or an unparseable model response. fw/askJson tag every such
// failure by throwing this class; everything else — a TypeError from our own
// logic, a ReferenceError, a 4xx request/auth/content-policy fault — is a real
// bug that carries no tag and must surface rather than be swallowed as a flake.
export class TransientError extends Error {
  override readonly name = "TransientError";
}

// A length-truncation: the model hit its max_tokens cap and returned a partial
// response (finish_reason "length"). Distinct from TransientError because retrying
// the same call burns another timeout and truncates identically — the cap, not the
// network, is the fault. A throw exits fw's attempt loop, so it is never
// network-retried; the message names the model and cap so the cure is actionable.
export class TruncationError extends Error {
  override readonly name = "TruncationError";
}

// isTransient reports whether e is a TransientError — the type guard callers use to decide
// whether to retry/degrade gracefully versus let a real bug propagate.
export function isTransient(e: unknown): boolean {
  return e instanceof TransientError;
}

// The single gate every graceful-degradation catch routes through, bound to the
// consumer's log `prefix` (its app/tool name — this lib names no consumer): a
// transient flake returns (the caller keeps its fallback, exactly as before), but a
// non-transient throw is logged to stderr and re-thrown so a code bug cannot
// masquerade as a judge flake and ship an unverified result. `stage` names the
// failing stage in the log line. Each consumer binds this once, e.g.
// `const rethrowIfBug = makeRethrowIfBug("myapp")`.
export function makeRethrowIfBug(prefix: string): (e: unknown, stage: string) => void {
  return (e: unknown, stage: string): void => {
    // A truncation rides out the same way a transient flake does: at every
    // degrade-site the caller's safe fallback is the right outcome — a cap
    // exhausted on a thinking model that legitimately spends its whole token budget
    // must never abort the caller's run. A caller that wants a truncation to surface
    // (an actionable "raise the cap" skip) simply omits this catch.
    if (isTransient(e) || e instanceof TruncationError) return;
    console.error(`${prefix}: ${stage} failed with a non-transient error (propagating):`, e);
    throw e;
  };
}

const TIMEOUT_MS = 180_000;

// The retry backoff delay, shared by both wait points in callProvider's attempt loop
// (network-error retry and 429/5xx retry) so the two can never drift apart.
const BACKOFF_MS = 2000;

// A transient-HTTP status: rate-limited (429) or a server-side gateway fault (5xx). Shared
// by the retry-eligibility check and the throw-classification below it, so "should we
// retry" and "is this a TransientError" can never mean two different things.
const transientStatus = (status: number): boolean => status === 429 || status >= 500;

type Msg = { role: string; content: string };
// The reasoning knobs a ModelRef may carry, passed through to the provider's buildBody:
// `effort` is OpenAI's reasoning_effort; `thinking` is qwencloud's enable_thinking /
// thinking_budget. Fireworks reads neither. A caller sets only what its provider honors.
type ReasoningOpts = { json?: boolean; maxTokens?: number; temp?: number };
type Effort = "low" | "medium" | "high";
type Thinking = { enable?: boolean; budget?: number };

// A Provider is one OpenAI-compatible endpoint: its URL, where its key lives (resolved
// lazily by keys.ts), and buildBody — the ONE thing that varies per provider (token-param
// name, whether temperature is allowed, the reasoning knob). The response half is shared
// below in callProvider.
type Provider = {
  id: string;
  url: string;
  key: KeySource;
  buildBody: (
    id: string,
    messages: Msg[],
    opts: ReasoningOpts & { effort?: Effort; thinking?: Thinking },
  ) => Record<string, unknown>;
};

const jsonFmt = (json?: boolean) =>
  json ? { response_format: { type: "json_object" as const } } : {};

const FIREWORKS: Provider = {
  id: "fireworks",
  url: "https://api.fireworks.ai/inference/v1/chat/completions",
  key: {
    env: "FIREWORKS_API_KEY",
    keychain: "fireworks-api",
    doppler: { secret: "FIREWORKS_API_KEY", project: "claude-code", config: "std" },
  },
  buildBody: (id, messages, o) => ({
    model: id,
    messages,
    max_tokens: o.maxTokens ?? 2048,
    temperature: o.temp ?? 0,
    ...jsonFmt(o.json),
  }),
};

// OpenAI reasoning models: `max_completion_tokens` (not max_tokens), NO temperature
// (a value ≠ 1 is rejected), and reasoning_effort as the depth knob.
const OPENAI: Provider = {
  id: "openai",
  url: "https://api.openai.com/v1/chat/completions",
  key: {
    env: "OPENAI_API_KEY",
    doppler: { secret: "OPENAI_API_KEY", project: "claude-code", config: "std" },
  },
  buildBody: (id, messages, o) => ({
    model: id,
    messages,
    max_completion_tokens: o.maxTokens ?? 2048,
    ...(o.effort ? { reasoning_effort: o.effort } : {}),
    ...jsonFmt(o.json),
  }),
};

// qwencloud (DashScope international, OpenAI-compatible): max_tokens + temperature like
// Fireworks, plus optional thinking control — enable_thinking:false to run non-thinking,
// or a thinking_budget ceiling. Omitting both uses the model's default (thinking on for glm).
const DASHSCOPE: Provider = {
  id: "dashscope",
  url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
  key: {
    env: "DASHSCOPE_API_KEY",
    doppler: { secret: "DASHSCOPE_API_KEY", project: "claude-code", config: "std" },
  },
  buildBody: (id, messages, o) => ({
    model: id,
    messages,
    max_tokens: o.maxTokens ?? 2048,
    temperature: o.temp ?? 0,
    ...(o.thinking?.enable === false ? { enable_thinking: false } : {}),
    ...(o.thinking?.budget ? { enable_thinking: true, thinking_budget: o.thinking.budget } : {}),
    ...jsonFmt(o.json),
  }),
};

// A ModelRef binds a model id to its provider plus any reasoning knobs. Model-policy modules
// build these via the helpers below; the transport reads `provider` to route and `effort`/
// `thinking` to shape the body. Equality is by reference — `model === FIDELITY` still works
// because callers pass the same imported constant.
export type ModelRef = { provider: Provider; id: string; effort?: Effort; thinking?: Thinking };

export const fireworks = (id: string): ModelRef => ({ provider: FIREWORKS, id });
export const openai = (id: string, o: { effort?: Effort } = {}): ModelRef => ({
  provider: OPENAI,
  id,
  effort: o.effort,
});
export const dashscope = (id: string, o: { thinking?: Thinking } = {}): ModelRef => ({
  provider: DASHSCOPE,
  id,
  thinking: o.thinking,
});

// Resolve every provider key a set of models will use, up front, so a missing key fails fast
// (the CLI maps MissingKeyError to exit 1) instead of mid-run. Dedups by provider so each
// key is queried at most once. A CLI calls this with the ModelRefs its run will touch.
export function ensureKeys(models: ModelRef[]): void {
  const seen = new Set<string>();
  for (const m of models) {
    if (seen.has(m.provider.id)) continue;
    seen.add(m.provider.id);
    resolveKey(m.provider.key);
  }
}

// ---- provider call with retry ----
// Retry once, but only on transient failures: a network/timeout throw, or a 429/5xx status.
// A 401/400/content-policy error fails the same way on retry, so retrying it only burns a
// second timeout before the outer failsafe fires — fail those fast with the status instead.
// The timeout retry is a deliberate re-roll: a thinking model's generation length is
// non-deterministic, so a call that ran to a (short, per-call `timeoutMs`) ceiling usually
// clears on the next try. resolveKey runs before the loop, so a missing key surfaces as a
// (non-transient) MissingKeyError rather than being swallowed as a flake.
async function callProvider(
  model: ModelRef,
  messages: Msg[],
  opts: ReasoningOpts & { timeoutMs?: number } = {},
): Promise<string> {
  const p = model.provider;
  const key = resolveKey(p.key);
  const body = p.buildBody(model.id, messages, {
    json: opts.json,
    maxTokens: opts.maxTokens,
    temp: opts.temp,
    effort: model.effort,
    thinking: model.thinking,
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetch(p.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
      });
    } catch (e) {
      // A timeout or a network error is transient — retry once. A timeout is a re-roll: an
      // attempt that ran to the per-call ceiling usually clears on the next try (see the header
      // note), and a network error (connection reset, DNS) is cheap to re-send.
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, BACKOFF_MS));
        continue; // network error / timeout: transient, retry
      }
      throw new TransientError(`${p.id} network/timeout: ${String(e).slice(0, 200)}`, { cause: e });
    }
    const j = await res.json().catch(() => ({}) as Record<string, unknown>); // 5xx gateways return HTML
    if (!res.ok) {
      if (transientStatus(res.status) && attempt === 0) {
        await new Promise((r) => setTimeout(r, BACKOFF_MS));
        continue;
      }
      // 429/5xx stay transient even after the retry is spent (rate-limit / server);
      // a 4xx (bad request, auth, content-policy) is a real fault — fail it hard.
      const msg = `${p.id} ${res.status}: ${JSON.stringify(j).slice(0, 300)}`;
      throw transientStatus(res.status) ? new TransientError(msg) : new Error(msg);
    }
    const choice = (
      j as { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[] }
    ).choices?.[0];
    // PRIMARY truncation signal: a "length" finish_reason means the model hit the
    // cap mid-output. Check it regardless of whether content is present (a
    // length-truncation usually carries truncated content) and throw a distinct,
    // non-retried TruncationError naming the model + cap. The extractJson
    // "unbalanced JSON" path stays as the fallback for when finish_reason is absent.
    if (choice?.finish_reason === "length") {
      throw new TruncationError(
        `output truncated at cap=${opts.maxTokens ?? 2048} (${model.id}) — raise this stage's cap`,
      );
    }
    const content = choice?.message?.content;
    if (typeof content !== "string") {
      // model returned no content: a model-output flake, retryable — transient.
      throw new TransientError(`${p.id} empty choices: ${JSON.stringify(j).slice(0, 300)}`);
    }
    return content;
  }
  throw new Error("provider call unreachable"); // loop always returns or throws
}

// Defensive layer over json_object mode: that mode is a strong hint, not a
// guarantee — a thinking model can still emit reasoning around the JSON. Pull the
// first balanced {...} object so such violations parse instead of dropping to the
// caller's failsafe. Kept deliberately.

export function extractJson(s: string): string {
  const start = s.indexOf("{");
  if (start < 0) throw new Error(`no JSON in: ${s.slice(0, 200)}`);
  let depth = 0,
    inStr = false,
    esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced JSON: ${s.slice(0, 200)}`);
}

// The transport askJson drives: the module-private callProvider signature. Injected via
// askJson's optional `call` param so a test can drive the parse-retry/degrade loop
// with a fake transport instead of mocking the module; production callers omit it
// and get callProvider unchanged.
type Transport = (
  model: ModelRef,
  messages: Msg[],
  opts: { json?: boolean; maxTokens?: number; temp?: number; timeoutMs?: number },
) => Promise<string>;

// askJson calls `model` with `prompt`, requesting JSON-object output, and parses the response as
// T. Retries once on a JSON-parse failure (the model returned no or unbalanced JSON) before
// giving up with a TransientError; fw() below handles the separate network/HTTP retry
// underneath. `timeoutMs` sets a per-call abort ceiling (default the module's 180s) — a
// runaway-prone stage passes a tight one so fw's timeout retry re-rolls cheaply. `call` defaults
// to fw and exists only so tests can inject a fake transport.
export async function askJson<T>(
  model: ModelRef,
  prompt: string,
  maxTokens: number,
  timeoutMs?: number,
  call: Transport = callProvider,
): Promise<T> {
  // Retry once on a PARSE failure (distinct from fw's network/5xx retry): a
  // thinking model sometimes returns only reasoning with no JSON object, which
  // extractJson rejects. It is non-deterministic, so a second call usually
  // complies — cheaper than dropping the whole run to the caller's failsafe.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await call(model, [{ role: "user", content: prompt }], {
      json: true,
      maxTokens,
      timeoutMs,
    });
    try {
      return JSON.parse(extractJson(raw)) as T;
    } catch (e) {
      lastErr = e;
    }
  }
  // a parse failure after the retry is a model-output flake (no/unbalanced JSON):
  // transient, so a flaky judge degrades gracefully instead of aborting the run.
  throw new TransientError(
    `model output parse failure: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    { cause: lastErr },
  );
}
