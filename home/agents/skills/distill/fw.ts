// fw — the Fireworks transport layer: model ids, the HTTP call with transient
// retry, and the JSON-extracting wrapper every stage uses. No prompt text and no
// pipeline logic live here.

// A failure distill knows how to ride out: a network/timeout throw, a 429/5xx
// gateway status, or an unparseable model response. fw/askJson tag every such
// failure by throwing this class; everything else — a TypeError from our own
// logic, a ReferenceError, a 4xx request/auth/content-policy fault — is a real
// bug that carries no tag and must surface rather than degrade to "inconclusive".
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

export function isTransient(e: unknown): boolean {
  return e instanceof TransientError;
}

// The single gate every graceful-degradation catch routes through: a transient
// flake returns (the caller keeps its fallback, exactly as before), but a
// non-transient throw is logged to stderr and re-thrown so a code bug cannot
// masquerade as a judge flake and ship an unverified result. `stage` names the
// failing stage in the log line.
export function rethrowIfBug(e: unknown, stage: string): void {
  // A truncation rides out the same way a transient flake does: at every
  // degrade-site the caller's safe fallback (inconclusive / thesis / kept draft)
  // is the right outcome — a cap exhausted on a thinking model (glm legitimately
  // spends FIDELITY_TOKENS) must never abort the whole distill. The clean
  // actionable skip for a truncation in a NO-CATCH core stage lives in main().
  if (isTransient(e) || e instanceof TruncationError) return;
  console.error(`distill: ${stage} failed with a non-transient error (propagating):`, e);
  throw e;
}

const FW = "https://api.fireworks.ai/inference/v1/chat/completions";
export const EXTRACT = "accounts/fireworks/models/gpt-oss-120b"; // fast, obedient; ~3 s — stages 1-3 + revise
export const FIDELITY = "accounts/fireworks/models/glm-5p2"; // thinking; ~15-20 s — stage 5 only (the different model)
const TIMEOUT_MS = 180_000;
// Token budget for the FIDELITY thinking model. Its reasoning is inlined in the
// content, so the cap must cover BOTH the thinking and the trailing JSON — too low
// and the model exhausts it mid-thought, returning prose with no `{`, which fails
// extractJson and drops the whole run to the passthrough failsafe. Sized with
// headroom for the longest gate input (rationale-carrying workflow steps).
export const FIDELITY_TOKENS = 16_384;
// Output ceiling for the content-scaling EXTRACT stages (extractCombo, gradeBlocks,
// synth*, revise, connectiveProse, proseFix, renderProse). gpt-oss inlines reasoning in
// the content, so the budget must cover reasoning + JSON; a dense note overran the old
// per-stage caps (4096/2048) and truncated. max_tokens is a CEILING, not a target — a
// normal note generates only what its content needs (~3-5k) and costs the same at any
// ceiling, so this is sized generously to never truncate a real note. The 180s
// TIMEOUT_MS is the de-facto limit (a runaway times out long before 96k); a genuine
// length-truncation now surfaces as an actionable TruncationError (D39), not silent loss.
// The intentionally-tiny stages (tieTogether, recover-def: ~1024) keep their small caps
// as sanity bounds.
export const EXTRACT_TOKENS = 96_000;

// ---- Fireworks call with retry ----
// Retry once, but only on transient failures: a network/timeout throw, or a
// 429/5xx status. A 401/400/content-policy error fails the same way on retry, so
// retrying it only burns a second TIMEOUT_MS before the outer failsafe fires —
// fail those fast with the status in the message instead.
async function fw(
  model: string,
  messages: { role: string; content: string }[],
  opts: { json?: boolean; maxTokens?: number; temp?: number } = {},
): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: opts.maxTokens ?? 2048,
    temperature: opts.temp ?? 0,
  };
  if (opts.json) body.response_format = { type: "json_object" };
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetch(FW, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.FIREWORKS_API_KEY}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 2000));
        continue; // network error / timeout: transient
      }
      throw new TransientError(`FW network/timeout: ${String(e).slice(0, 200)}`, { cause: e });
    }
    const j = await res.json().catch(() => ({}) as Record<string, unknown>); // 5xx gateways return HTML
    if (!res.ok) {
      if ((res.status === 429 || res.status >= 500) && attempt === 0) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      // 429/5xx stay transient even after the retry is spent (rate-limit / server);
      // a 4xx (bad request, auth, content-policy) is a real fault — fail it hard.
      const msg = `FW ${res.status}: ${JSON.stringify(j).slice(0, 300)}`;
      throw res.status === 429 || res.status >= 500 ? new TransientError(msg) : new Error(msg);
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
      const shortModel = model.split("/").pop() ?? model;
      throw new TruncationError(
        `output truncated at max_tokens=${body.max_tokens} (${shortModel}) — raise this stage's cap`,
      );
    }
    const content = choice?.message?.content;
    if (typeof content !== "string") {
      // model returned no content: a model-output flake, retryable — transient.
      throw new TransientError(`FW empty choices: ${JSON.stringify(j).slice(0, 300)}`);
    }
    return content;
  }
  throw new Error("FW unreachable"); // loop always returns or throws
}

// Defensive layer over json_object mode: that mode is a strong hint, not a
// guarantee — a thinking model (the FIDELITY judge) can still emit reasoning
// around the JSON. Pull the first balanced {...} object so such violations parse
// instead of dropping to the passthrough failsafe. Kept deliberately.
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

export async function askJson<T>(model: string, prompt: string, maxTokens: number): Promise<T> {
  // Retry once on a PARSE failure (distinct from fw's network/5xx retry): the
  // FIDELITY thinking model sometimes returns only reasoning with no JSON object,
  // which extractJson rejects. It is non-deterministic, so a second call usually
  // complies — cheaper than dropping the whole run to the passthrough failsafe.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await fw(model, [{ role: "user", content: prompt }], { json: true, maxTokens });
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
