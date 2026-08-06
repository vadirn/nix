#!/usr/bin/env bun
// simplify-text — analyze a markdown note against the Simplified output style and print a brief.
// See the USAGE block below for the full CLI surface (invocation, flags, output contract, exit
// codes).
//
// The tool APPLIES NOTHING: it masks reference spans, runs one strong pass (qwen-flash, with a
// deepseek-v4-flash fallback) that fills the seven-key brief, runs a deterministic guard over the
// rewrite, and prints the markdown brief to stdout. The simplify-text skill's subagent reads the
// brief, applies the `rewrite`, and owns all file I/O. So the input file is never touched here.
//
// The product is the BRIEF, not the file. A brief with no rewrite is useless, so — unlike polish's
// passthrough — a model call that fails after the fallback exits nonzero (4) rather than shipping
// the input. Guard findings are advisory and never change the exit code (they ride the `## guard`
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
import { runMeaning } from "textkit/simplify/meaning.ts";

// USAGE is the full `--help` text printed to stdout on `-h`/`--help`: the invocation forms, every
// option, the output contract, and the exit codes — the human-facing counterpart to parseArgs.
export const USAGE = `simplify-text — analyze a markdown note against the Simplified output style:
one strong restyle pass, then a deterministic guard. It APPLIES NOTHING —
it prints a brief; the simplify-text skill applies the rewrite.

Usage:
  simplify-text [options] [input.md]   analyze a note (stdin when no path or '-')

Options:
  --lang <en|ru>   force the ruleset language (default: auto-detect)
  -h, --help       show this help and exit

Output:
  A markdown brief to stdout: the seven sections (verdict, cut, change,
  shape, keep, borderline, rewrite) plus a ## guard section (masks, code,
  names, sentences, lists, meaning — all advisory). The input file is never
  modified; diagnostics go to stderr.
  Exit: 0 brief printed · 1 missing key · 2 usage error · 3 empty input ·
  4 analysis failed (both models exhausted).

Env: DASHSCOPE_API_KEY, resolved from Doppler (claude-code/std) via keys.ts
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
type SimplifyDeps = { ask?: typeof askJson; progress?: (line: string) => void };

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

// runSimplify is the pure pipeline: parse frontmatter, mask reference spans, run one restyle pass,
// coerce the brief, guard the masked rewrite, then render the display brief (rewrite and change
// spans unmasked, original frontmatter prepended so the rewrite is the whole note). It touches no
// process/fs state — the transport arrives via deps — so it is unit-testable in isolation. Throws
// (transient/truncation) when both models fail; main maps that to exit 4.
export async function runSimplify(
  input: string,
  opts: SimplifyOpts,
  deps: SimplifyDeps = {},
): Promise<string> {
  const { ask = askJson, progress } = deps;
  const { front, body } = parseFrontmatter(input);
  const lang = resolveLang(opts.lang, body);
  // No literals: simplify runs no glossary term list, so createMasker freezes only the reference
  // spans MASK_RE finds (wikilinks, embeds, inline code).
  const { mask, unmask } = createMasker();
  const maskedInput = mask(body);
  progress?.(`restyle pass (${lang})…`);
  const brief = coerceBrief(await onePass(simplifyPrompt(maskedInput, lang), ask, progress));
  const rewriteMasked = brief.rewrite;
  const rewriteUnmasked = unmask(rewriteMasked);
  const guard = runGuard({ source: body, maskedInput, rewriteMasked, rewriteUnmasked });
  // Unmask each change span once so a human reads real spans AND the meaning judge reads real prose;
  // reuse it for both the axis and the display brief.
  const change = brief.change.map((c) => ({
    ...c,
    before: unmask(c.before),
    after: unmask(c.after),
  }));
  // The advisory meaning axis: one bounded model call over the change pairs, degrading to a clean
  // skip on any flake so the brief still ships. Empty change short-circuits before any call.
  if (change.length) progress?.("meaning check…");
  const meaning = await runMeaning(change, { ask });
  // Display brief: the unmasked change spans, and the original frontmatter (verbatim, never
  // restyled) prepended so `## rewrite` is the whole note the subagent applies as one block.
  const display: SimplifyBrief = {
    ...brief,
    change,
    rewrite: front ? `${front}\n${rewriteUnmasked}` : rewriteUnmasked,
  };
  return renderBrief(display, guard, meaning);
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
