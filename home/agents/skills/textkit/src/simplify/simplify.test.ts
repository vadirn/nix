// simplify/simplify tests — the CLI surface as a pure argv→result function, and the runSimplify
// pipeline driven through an injected `ask` fake (no network, no process-global mock). The fake
// echoes the masked text back as the rewrite (a perfect no-op restyle), so mask survival and the
// guard are exercised on real masking; targeted variants break one axis. Offline.
import { expect, test } from "bun:test";
import { askJson, TransientError } from "@skills/llm/llm.ts";
import { parseArgs, runSimplify, USAGE } from "textkit/simplify/simplify.ts";

// ---- parseArgs (pure) ----
test("parseArgs: -h and --help resolve to help before any I/O", () => {
  expect(parseArgs(["-h"])).toEqual({ kind: "help" });
  expect(parseArgs(["--help"])).toEqual({ kind: "help" });
});

test("parseArgs: bare invocation defaults to auto language and stdin", () => {
  expect(parseArgs([])).toEqual({ kind: "ok", opts: { lang: "auto", path: undefined } });
});

test("parseArgs: a file positional and an explicit --lang", () => {
  expect(parseArgs(["--lang", "ru", "note.md"])).toEqual({
    kind: "ok",
    opts: { lang: "ru", path: "note.md" },
  });
});

test("parseArgs: misuse is named, not misattributed", () => {
  expect(parseArgs(["--lang", "de"])).toEqual({
    kind: "error",
    message: "--lang expects one of: en, ru (got 'de')",
  });
  expect(parseArgs(["--lang"])).toMatchObject({ kind: "error" });
  expect(parseArgs(["--bogus"])).toEqual({ kind: "error", message: "unknown flag '--bogus'" });
  expect(parseArgs(["a.md", "b.md"])).toMatchObject({ kind: "error" });
});

test("parseArgs: `--` ends options so a dash-named file survives; a bare `-` is stdin", () => {
  expect(parseArgs(["--", "-weird.md"])).toEqual({
    kind: "ok",
    opts: { lang: "auto", path: "-weird.md" },
  });
  expect(parseArgs(["-"])).toEqual({ kind: "ok", opts: { lang: "auto", path: "-" } });
});

test("USAGE names the exit codes and the no-apply contract", () => {
  expect(USAGE).toContain("APPLIES NOTHING");
  expect(USAGE).toContain("4 analysis failed");
});

// ---- runSimplify pipeline: injected `ask` fake ----
const NOTE = `---
title: demo
---
We cite the Levenshtein distance in [[notes]] and run \`build\`.

\`\`\`ts
const x = 1;
\`\`\`

Keep it short.`;

// The masked text the prompt carries (everything after the TEXT: marker) — the fake echoes or
// perturbs this so mask survival is tested on genuine ⟦N⟧ masking, not a hand-written string.
const maskedOf = (prompt: string): string => prompt.split("TEXT:\n")[1]!;

// Build an ask fake that returns a seven-key brief; `rewrite` derives from the masked prompt text.
const askWithRewrite = (rewrite: (masked: string) => string): typeof askJson =>
  (async (_model: unknown, prompt: string) => ({
    verdict: "ok",
    cut: [],
    change: [],
    shape: [],
    keep: [],
    borderline: [],
    rewrite: rewrite(maskedOf(prompt)),
  })) as unknown as typeof askJson;

test("runSimplify: a faithful no-op rewrite passes the guard and prints the brief", async () => {
  const out = await runSimplify(NOTE, { lang: "auto" }, { ask: askWithRewrite((m) => m) });
  expect(out).toContain("## rewrite");
  expect(out).toContain("## guard\n\nAll checks passed.");
  // reference spans are restored (unmasked) in the printed rewrite
  expect(out).toContain("[[notes]]");
  expect(out).toContain("`build`");
});

test("runSimplify: the original frontmatter is prepended to the rewrite verbatim", async () => {
  const out = await runSimplify(NOTE, { lang: "auto" }, { ask: askWithRewrite((m) => m) });
  const rewrite = out.split("## rewrite\n\n")[1]!;
  expect(rewrite).toContain("---\ntitle: demo\n---");
});

test("runSimplify: a dropped ⟦N⟧ span is reported as an advisory masks FAIL, still a brief", async () => {
  const out = await runSimplify(
    NOTE,
    { lang: "auto" },
    { ask: askWithRewrite((m) => m.replace(/⟦1⟧/, "")), maxAttempts: 1 }, // one pass, drop the span
  );
  expect(out).toContain("- masks: FAIL");
  expect(out).toContain("## verdict"); // the brief is still produced
});

test("runSimplify: a planted name typo is flagged against the source", async () => {
  const out = await runSimplify(
    NOTE,
    { lang: "auto" },
    { ask: askWithRewrite((m) => m.replace("Levenshtein", "Levenstein")) },
  );
  expect(out).toContain("Levenstein ← Levenshtein");
});

test("runSimplify: a Russian note auto-routes to the RU ruleset and preserves Cyrillic spans", async () => {
  const RU = "Мы используем [[глоссарий]] и флаг `--tau` здесь.";
  let seenPrompt = "";
  const ask: typeof askJson = (async (_model: unknown, prompt: string) => {
    seenPrompt = prompt;
    return {
      verdict: "ок",
      cut: [],
      change: [],
      shape: [],
      keep: [],
      borderline: [],
      rewrite: maskedOf(prompt),
    };
  }) as unknown as typeof askJson;
  const out = await runSimplify(RU, { lang: "auto" }, { ask });
  expect(seenPrompt).toContain("«является»"); // detectLang → ru selected the Russian ruleset
  expect(out).toContain("[[глоссарий]]"); // reference span restored
  expect(out).toContain("## guard\n\nAll checks passed.");
});

test("runSimplify: an over-cap source sentence is measured and forwarded into the prompt", async () => {
  // a 24-word sentence in the source: wordCapScan must find it and simplifyPrompt must carry it, so
  // the model gets the exact offender it counts unreliably (the deterministic length pre-hint).
  const LONG =
    "We compute the Levenshtein distance between the two given strings and then we also run the build and keep everything short and tidy.";
  let seenPrompt = "";
  const ask: typeof askJson = (async (_model: unknown, prompt: string) => {
    seenPrompt = prompt;
    return {
      verdict: "ok",
      cut: [],
      change: [],
      shape: [],
      keep: [],
      borderline: [],
      rewrite: maskedOf(prompt),
    };
  }) as unknown as typeof askJson;
  await runSimplify(LONG, { lang: "auto" }, { ask });
  expect(seenPrompt).toContain("LENGTH CHECK"); // the pre-hint block reached the model
  expect(seenPrompt).toContain("We compute the Levenshtein distance"); // the offender itself
});

test("runSimplify: a within-cap source carries no length hint", async () => {
  let seenPrompt = "";
  const ask: typeof askJson = (async (_model: unknown, prompt: string) => {
    seenPrompt = prompt;
    return {
      verdict: "ok",
      cut: [],
      change: [],
      shape: [],
      keep: [],
      borderline: [],
      rewrite: maskedOf(prompt),
    };
  }) as unknown as typeof askJson;
  await runSimplify(NOTE, { lang: "auto" }, { ask }); // NOTE's sentences are all short
  expect(seenPrompt).not.toContain("LENGTH CHECK");
});

test("runSimplify: a gate-drifting pass is re-rolled, and the first clean run is kept", async () => {
  let calls = 0;
  const driftThenClean: typeof askJson = (async (_model: unknown, prompt: string) => {
    calls++;
    const masked = maskedOf(prompt);
    // attempt 1 drops a reference span (gate DRIFT); attempt 2 is a faithful no-op (gate clean)
    const rewrite = calls === 1 ? masked.replace(/⟦1⟧/, "") : masked;
    return { verdict: "ok", cut: [], change: [], shape: [], keep: [], borderline: [], rewrite };
  }) as unknown as typeof askJson;
  const out = await runSimplify(NOTE, { lang: "auto" }, { ask: driftThenClean });
  expect(calls).toBe(2); // attempt 1 drifted, attempt 2 cleared the gate
  expect(out).toContain("## guard\n\nAll checks passed."); // the clean run was kept
  expect(out).toContain("`build`"); // the span the drifting run dropped is restored
});

test("runSimplify: when every pass drifts, the last is kept and the brief still prints", async () => {
  let calls = 0;
  const alwaysDrift: typeof askJson = (async (_model: unknown, prompt: string) => {
    calls++;
    return {
      verdict: "ok",
      cut: [],
      change: [],
      shape: [],
      keep: [],
      borderline: [],
      rewrite: maskedOf(prompt).replace(/⟦1⟧/, ""),
    };
  }) as unknown as typeof askJson;
  const out = await runSimplify(NOTE, { lang: "auto" }, { ask: alwaysDrift, maxAttempts: 2 });
  expect(calls).toBe(2); // exhausted the pinned budget
  expect(out).toContain("- masks: FAIL"); // the drift rode into the advisory guard
  expect(out).toContain("## verdict"); // a brief is still produced
});

test("runSimplify: a late transient flake keeps the earlier drifting brief, not exit 4", async () => {
  let calls = 0;
  const driftThenFlake: typeof askJson = (async (_model: unknown, prompt: string) => {
    calls++;
    if (calls === 1) {
      // attempt 1: a usable but gate-drifting brief (a dropped span)
      return {
        verdict: "ok",
        cut: [],
        change: [],
        shape: [],
        keep: [],
        borderline: [],
        rewrite: maskedOf(prompt).replace(/⟦1⟧/, ""),
      };
    }
    throw new TransientError("both models down on the re-roll"); // attempt 2: primary + fallback die
  }) as unknown as typeof askJson;
  const out = await runSimplify(NOTE, { lang: "auto" }, { ask: driftThenFlake, maxAttempts: 3 });
  expect(calls).toBe(3); // attempt 1 (1 call) + attempt 2 primary+fallback (2 calls), then kept
  expect(out).toContain("- masks: FAIL"); // attempt 1's drift shipped rather than failing hard
});

test("runSimplify: a transient primary flake re-rolls on the fallback model", async () => {
  let calls = 0;
  const flakeThenOk: typeof askJson = (async (_model: unknown, prompt: string) => {
    calls++;
    if (calls === 1) throw new TransientError("primary flake");
    return {
      verdict: "ok",
      cut: [],
      change: [],
      shape: [],
      keep: [],
      borderline: [],
      rewrite: maskedOf(prompt),
    };
  }) as unknown as typeof askJson;
  const out = await runSimplify(NOTE, { lang: "auto" }, { ask: flakeThenOk });
  expect(calls).toBe(2); // primary threw, fallback answered
  expect(out).toContain("## guard\n\nAll checks passed.");
});
