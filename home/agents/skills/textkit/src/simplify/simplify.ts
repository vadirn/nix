#!/usr/bin/env bun
// simplify-text — analyze a markdown note against the Simplified output style and print a brief.
// See the USAGE block below for the full CLI surface (invocation, flags, output contract, exit
// codes).
//
// The tool APPLIES NOTHING: it masks reference spans, runs up to three restyle passes (gpt-5.6-luna,
// with a gpt-5.4-mini fallback) and keeps the first that clears the apply-gate, runs a
// deterministic guard over that rewrite, and prints the markdown brief to stdout. The simplify-text
// skill's subagent reads the brief, applies the `rewrite`, and owns all file I/O. So the input file
// is never touched here.
//
// The product is the BRIEF, not the file. A brief with no rewrite is useless, so — unlike polish's
// passthrough — a model call that fails after the fallback exits nonzero (4) rather than shipping
// the input. Guard findings are advisory and never change the exit code (they ride the `## Guard`
// section); only an operational failure — bad args, a missing key, a dead model — exits nonzero.
import { readFileSync } from "node:fs";
import { takeValue } from "textkit/core/args.ts";
import { parseFrontmatter } from "textkit/core/frontmatter.ts";
import { askJson, ensureKeys, isTransient, TruncationError } from "@skills/llm/llm.ts";
import { MissingKeyError } from "@skills/llm/keys.ts";
import { SIMPLIFY_FALLBACK, SIMPLIFY_MODEL, SIMPLIFY_TOKENS } from "textkit/core/models.ts";
import { simplifyDegrade as rethrowIfBug } from "textkit/core/degrade.ts";
import { createMasker } from "textkit/core/writing/mask.ts";
import { type SimplifyBrief, resolveLang, simplifyPrompt } from "textkit/simplify/prompt.ts";
import { coerceBrief, renderBrief } from "textkit/simplify/brief.ts";
import { runGuard } from "textkit/simplify/guard.ts";
import { verify, verifyClean } from "textkit/simplify/verify.ts";
import { wordCapScan } from "textkit/simplify/wordcap.ts";

// The restyle pass is re-rolled up to this many times to clear the apply-gate. The model is
// non-deterministic, so a run that drops a span or adds a heading is one bad roll, not a fixed
// failure — the next run often clears it. Three balances those odds against the token cost of a
// heavy pass. Overridable via deps so the retry test pins it.
const MAX_ATTEMPTS = 3;

// USAGE is the full `--help` text printed to stdout on `-h`/`--help`: the invocation forms, every
// option, the output contract, and the exit codes — the human-facing counterpart to parseArgs.
export const USAGE = `simplify-text — analyze a markdown note against the Simplified output style:
up to three restyle passes (keep the first the gate accepts), then a
deterministic guard. It APPLIES NOTHING — it prints a brief; the
simplify-text skill applies the rewrite.

Usage:
  simplify-text [options] [input.md]   analyze a note (stdin when no path or '-')

Options:
  --lang <en|ru>   force the ruleset language (default: auto-detect)
  -h, --help       show this help and exit

Output:
  A markdown brief to stdout: the seven sections (Verdict, Cut, Change,
  Shape, Keep, Borderline, Rewrite) plus a ## Guard section (masks, code,
  names, sentences, lists — all advisory, all deterministic). The input file
  is never modified; diagnostics go to stderr.
  Exit: 0 brief printed · 1 missing key · 2 usage error · 3 empty input ·
  4 analysis failed (both models exhausted).

Env: OPENAI_API_KEY, resolved from Doppler (claude-code/std) via keys.ts
(e.g. doppler run --project claude-code --config std --)
`;

// The validated options parseArgs hands to runSimplify: the language override and the input path
// (undefined or "-" means stdin).
type SimplifyOpts = { lang: "en" | "ru" | "auto"; path?: string };

// The result of parsing argv: "help" (print USAGE, exit 0), "error" (usage mistake, exit 2), or
// "ok" (a validated SimplifyOpts).
export type ParseResult =
  | { kind: "help" }
  | { kind: "error"; message: string }
  | { kind: "ok"; opts: SimplifyOpts };

// Whole CLI surface as one pure argv→result function (polish/distill discipline): help/misuse
// resolve before the key gate or any network call, and the surface is unit-testable without
// spawning the binary. Flags may appear in any position; `--` ends options; a bare `-` is a
// positional; any other dash-prefixed token is a flag typo, named rather than misattributed.
export function parseArgs(argv: string[]): ParseResult {
  let lang: SimplifyOpts["lang"] = "auto";
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") return { kind: "help" };
    if (a === "--") {
      for (let j = i + 1; j < argv.length; j++) positionals.push(argv[j]);
      break;
    }
    if (a === "--lang") {
      const t = takeValue(argv, i, "--lang", "a value (en or ru)");
      if (!t.ok) return { kind: "error", message: t.message };
      if (t.value !== "en" && t.value !== "ru")
        return { kind: "error", message: `--lang expects one of: en, ru (got '${t.value}')` };
      lang = t.value;
      i = t.next;
      continue;
    }
    if (a.startsWith("-") && a !== "-") return { kind: "error", message: `unknown flag '${a}'` };
    positionals.push(a);
  }
  const path = positionals[0];
  if (positionals.length > 1)
    return {
      kind: "error",
      message: `unexpected extra argument(s): ${positionals.slice(1).join(", ")}`,
    };
  return { kind: "ok", opts: { lang, path } };
}

// The seam runSimplify takes to reach the model, injected so a unit test drives the pass without a
// process-global module mock (default: the real askJson). `progress` is the optional TTY-gated tick.
// `maxAttempts` is the retry budget for the gate loop (default MAX_ATTEMPTS); the retry test pins it.
type SimplifyDeps = {
  ask?: typeof askJson;
  progress?: (line: string) => void;
  maxAttempts?: number;
};

// onePass runs the single restyle pass: the primary model, falling back to the second model on a
// transient/truncation failure (rethrowIfBug re-throws a real code bug first). If the fallback also
// fails, its throw propagates to main, which exits 4.
async function onePass(
  prompt: string,
  ask: typeof askJson,
  progress?: (line: string) => void,
): Promise<unknown> {
  try {
    return await ask<unknown>(SIMPLIFY_MODEL, prompt, SIMPLIFY_TOKENS);
  } catch (e) {
    rethrowIfBug(e, "primary pass"); // a non-transient code bug propagates here
    progress?.("primary model flaked — retrying on the fallback…");
    return await ask<unknown>(SIMPLIFY_FALLBACK, prompt, SIMPLIFY_TOKENS);
  }
}

// runSimplify is the pure pipeline: parse frontmatter, mask reference spans, run the restyle pass
// (re-rolled to the gate), coerce the brief, guard the masked rewrite, then render the display brief
// (rewrite and change spans unmasked, original frontmatter prepended so the rewrite is the whole
// note). It touches no process/fs state — the transport arrives via deps — so it is unit-testable in
// isolation. Throws (transient/truncation) when the first pass fails on both models; main maps that
// to exit 4.
export async function runSimplify(
  input: string,
  opts: SimplifyOpts,
  deps: SimplifyDeps = {},
): Promise<string> {
  const { ask = askJson, progress, maxAttempts = MAX_ATTEMPTS } = deps;
  const { front, body } = parseFrontmatter(input);
  const lang = resolveLang(opts.lang, body);
  // No literals: simplify runs no glossary term list, so createMasker freezes only the reference
  // spans MASK_RE finds (wikilinks, embeds, inline code). Inline emphasis (`**bold**`, `*italic*`) is
  // deliberately NOT masked: it wraps editable prose, not an atom, and masking it would inject ⟦N⟧
  // tokens mid-sentence into the restyle prompt. So the restyle drops emphasis, and the simplify-text
  // skill's subagent re-applies it by intent at apply time (see that skill's apply step).
  const { mask, unmask } = createMasker();
  const maskedInput = mask(body);
  // Deterministic length pre-hint. wordCapScan is the one guard axis that reads a text standalone
  // (the other four diff the rewrite against the source), so it is the only "what's wrong with the
  // original" finding available before the pass. Feed the measured over-cap sentences into the prompt
  // so the model splits the exact offenders it counts unreliably. Empty for a within-cap source.
  const overCap = wordCapScan(maskedInput);
  const prompt = simplifyPrompt(maskedInput, lang, overCap);
  // Retry-to-gate. The model is non-deterministic, so a run that drops a span or adds a heading is
  // one bad roll. Re-roll up to `attempts` and keep the FIRST run the apply-gate accepts — the same
  // `verify` the simplify-verify CLI runs, called here on the source and the unmasked rewrite. If no
  // run clears the gate, keep the LAST: the tool still prints a brief (blocking drift is the
  // downstream gate's call), and both the `## Guard` and the skill's simplify-verify still fire on
  // what shipped. A pass that throws keeps the last usable brief; the first pass throwing has none,
  // so it propagates and main exits 4.
  const attempts = Math.max(1, maxAttempts);
  let chosen: { brief: SimplifyBrief; rewriteMasked: string; rewriteUnmasked: string } | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    progress?.(`restyle pass (${lang}) — attempt ${attempt}/${attempts}…`);
    let brief: SimplifyBrief;
    try {
      brief = coerceBrief(await onePass(prompt, ask, progress));
    } catch (e) {
      if (chosen) {
        progress?.(`attempt ${attempt} flaked — keeping the attempt ${attempt - 1} rewrite`);
        break;
      }
      throw e; // first pass died on both models: no brief to keep, so main exits 4
    }
    const rewriteUnmasked = unmask(brief.rewrite);
    chosen = { brief, rewriteMasked: brief.rewrite, rewriteUnmasked };
    if (verifyClean(verify(body, rewriteUnmasked))) {
      if (attempt > 1) progress?.(`gate satisfied on attempt ${attempt}`);
      break;
    }
    progress?.(
      attempt < attempts
        ? `gate drift on attempt ${attempt} — re-rolling…`
        : `gate still drifts after ${attempts} attempts — simplify-verify will block the apply`,
    );
  }
  // chosen is set: attempts >= 1, so either a pass returned a brief or the first throw already exited.
  const { brief, rewriteMasked, rewriteUnmasked } = chosen!;
  const guard = runGuard({ source: body, maskedInput, rewriteMasked, rewriteUnmasked });
  // Display brief: unmask the rewrite and each change span so a human reads real spans, and prepend
  // the original frontmatter (verbatim, never restyled) so `## Rewrite` is the whole note the
  // subagent applies as one block.
  const display: SimplifyBrief = {
    ...brief,
    change: brief.change.map((c) => ({ ...c, before: unmask(c.before), after: unmask(c.after) })),
    rewrite: front ? `${front}\n${rewriteUnmasked}` : rewriteUnmasked,
  };
  return renderBrief(display, guard);
}

// main is the CLI entrypoint: it parses argv, acts on --help and misuse before the key gate or any
// network call, reads the input (file or stdin), runs the pass, and prints the brief. It returns no
// value; it sets the exit code (0 brief, 1 missing key, 2 usage, 3 empty input, 4 analysis failed).
async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.kind === "help") {
    process.stdout.write(USAGE);
    return;
  }
  if (parsed.kind === "error") {
    console.error(`simplify: ${parsed.message}\nTry 'simplify-text --help' for usage.`);
    process.exit(2);
    return; // process.exit ends the run; the explicit return narrows `parsed` to "ok" below
  }
  // Both models share the DashScope provider, so ensureKeys resolves one key. A missing key exits 1
  // here rather than mid-run.
  try {
    ensureKeys([SIMPLIFY_MODEL, SIMPLIFY_FALLBACK]);
  } catch (e) {
    if (e instanceof MissingKeyError) {
      console.error(`${e.message}\nSeed it in the Keychain or Doppler (claude-code/std).`);
      process.exit(1);
    }
    throw e;
  }
  const inputPath = parsed.opts.path;
  const fromStdin = inputPath === undefined || inputPath === "-";
  if (fromStdin && process.stdin.isTTY)
    console.error("simplify: reading stdin — pass a file or pipe input (ctrl-d ends input)");
  const input = readFileSync(fromStdin ? 0 : inputPath, "utf8");
  if (!input.trim()) {
    console.error("simplify: empty input — nothing to restyle");
    process.exit(3);
  }
  const progress = process.stderr.isTTY
    ? (line: string): void => void process.stderr.write(`${line}\n`)
    : undefined;
  try {
    const out = await runSimplify(input, parsed.opts, { progress });
    process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
  } catch (e) {
    // Both models exhausted (transient) or truncated: the brief has no usable rewrite, so fail
    // rather than print a hollow brief. A non-transient throw (a code bug) propagates.
    if (isTransient(e) || e instanceof TruncationError) {
      console.error(`simplify: analysis failed — ${String(e).replace(/\n/g, " ").slice(0, 200)}`);
      process.exit(4);
    }
    throw e;
  }
}

// Guard the CLI entrypoint so test imports can load this module (parseArgs, runSimplify, USAGE)
// without running the pipeline against stdin.
if (import.meta.main) main();
