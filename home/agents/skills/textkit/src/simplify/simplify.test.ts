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
    { ask: askWithRewrite((m) => m.replace(/⟦1⟧/, "")) }, // drop the inline-code span
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
