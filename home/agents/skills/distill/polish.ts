#!/usr/bin/env bun
// polish-text — copy-edit a markdown note in place: four writing passes, a
// spell/grammar pass, typography normalization, and a self-consistency name lint.
// No compression, no glossary, no fidelity gate — the text's claims are untouched.
// Shares the writing-core (writing/) with distill: revise() and spellPass() mask
// reference spans before rewriting and normalize typography on the way out.
//
// Frontmatter passes through verbatim. Output is written raw to a fresh temp .md
// file — no <result> XML envelope (that envelope exists to carry residue; polish
// has no residue channel and its output IS the file content). stdout is two
// lines: the file path, then a one-line summary footer.
//
// Failsafe mirrors distill: a TruncationError or transient throw escaping the
// passes writes the ORIGINAL input to the temp file with a "polish skipped"
// footer instead of aborting; a non-transient throw (a code bug) propagates.
//
// Standalone headless CLI. Fireworks via FIREWORKS_API_KEY (e.g.
// `doppler run --project claude-code --config std --`).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parseFrontmatter } from "./frontmatter.ts";
import { isTransient, TruncationError } from "./fw.ts";
import { detectLang, segment, wordCount } from "./text.ts";
import {
  type NameLintResult,
  formatNameLint,
  nameLintSelfConsistency,
} from "./writing/name-lint.ts";
import { PASS_EN, PASS_RU, revise } from "./writing/passes.ts";
import { spellPass } from "./writing/spell.ts";

export const USAGE = `polish-text — copy-edit a markdown note in place: four writing passes, a
spell/grammar pass, typography normalization, and a self-consistency name lint.
No compression, no glossary, no fidelity gate — the text's claims are untouched.

Usage:
  polish-text [options] [input.md]    polish a note (reads stdin if no path)

Options:
  --lang <en|ru>    force the language rubric (default: auto-detect)
  --no-revise       skip the four writing passes
  --no-spell        skip the spell/grammar pass
  -h, --help        show this help and exit

Env: FIREWORKS_API_KEY (e.g. doppler run --project claude-code --config std --)
`;

export type PolishOpts = {
  lang: "en" | "ru" | "auto";
  noRevise: boolean;
  noSpell: boolean;
  path?: string;
};

export type ParseResult =
  | { kind: "help" }
  | { kind: "error"; message: string }
  | { kind: "ok"; opts: PolishOpts };

// Whole CLI surface as one pure argv→result function (distill/card-stage discipline):
// help/misuse resolve before the API-key gate or any network call, and the surface is
// unit-testable without spawning the binary. Flags may appear in any position. `--` is
// the end-of-options marker (a dash-prefixed input path can follow); a bare `-` stays a
// positional. Any other dash-prefixed token is a flag typo, named rather than
// misattributed to the following value or crashed on as a bogus filename.
export function parseArgs(argv: string[]): ParseResult {
  let lang: PolishOpts["lang"] = "auto";
  let noRevise = false;
  let noSpell = false;
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") return { kind: "help" };
    if (a === "--") {
      for (let j = i + 1; j < argv.length; j++) positionals.push(argv[j]);
      break;
    }
    if (a === "--no-revise") {
      noRevise = true;
      continue;
    }
    if (a === "--no-spell") {
      noSpell = true;
      continue;
    }
    if (a === "--lang") {
      const v = argv[++i];
      if (v === undefined) return { kind: "error", message: "--lang expects a value (en or ru)" };
      if (v !== "en" && v !== "ru")
        return { kind: "error", message: `--lang expects one of: en, ru (got '${v}')` };
      lang = v;
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

  return { kind: "ok", opts: { lang, noRevise, noSpell, path } };
}

export function buildPolishFooter(m: {
  beforeWords: number;
  afterWords: number;
  noRevise: boolean;
  noSpell: boolean;
  reverted: number;
  spellFailed: boolean;
  nameLint: NameLintResult;
}): string {
  const pct = m.beforeWords
    ? Math.round((100 * (m.beforeWords - m.afterWords)) / m.beforeWords)
    : 0;
  const sizeTag = `${pct > 0 ? "-" : pct < 0 ? "+" : "±"}${Math.abs(pct)}%`;
  return (
    `— polished · ${m.beforeWords}→${m.afterWords} words (${sizeTag})` +
    (m.noRevise ? " · revise skipped" : " · 4 passes") +
    (m.noSpell
      ? " · spell skipped"
      : m.spellFailed
        ? " · spell pass failed (kept input)"
        : m.reverted
          ? ` · spell: ${m.reverted} block(s) reverted`
          : " · spell ok") +
    formatNameLint(m.nameLint)
  );
}

// Create an empty temp file with a .md extension and return its path (same helper
// shape as pipeline.ts's tempMdPath).
function tempMdPath(): string {
  return execFileSync("mktemp", ["--suffix=.md"], { encoding: "utf8" }).trim();
}

export async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.kind === "help") {
    process.stdout.write(USAGE);
    return;
  }
  if (parsed.kind === "error") {
    console.error(`polish: ${parsed.message}\nTry 'polish-text --help' for usage.`);
    process.exit(2);
    return; // process.exit ends the run; the explicit return also narrows `parsed` to "ok" below
  }
  const { lang, noRevise, noSpell, path: inputPath } = parsed.opts;
  // Both passes skipped: nothing calls out, so the key gate would only block a
  // typography-only no-op run for no reason.
  if (!(noRevise && noSpell) && !process.env.FIREWORKS_API_KEY) {
    console.error(
      "FIREWORKS_API_KEY not set (run under: doppler run --project claude-code --config std --)",
    );
    process.exit(1);
  }
  const input = readFileSync(inputPath ?? 0, "utf8");
  if (!input.trim()) process.exit(0);
  const path = tempMdPath();
  try {
    const { front, body } = parseFrontmatter(input);
    const resolvedLang = lang === "auto" ? detectLang(body) : lang;
    const beforeWords = wordCount(body);
    let blocks = segment(body);
    let reverted: string[] = [];
    let spellFailed = false;
    if (!noRevise) blocks = await revise(blocks, resolvedLang === "ru" ? PASS_RU : PASS_EN);
    if (!noSpell) {
      const r = await spellPass(blocks, resolvedLang);
      blocks = r.blocks;
      reverted = r.reverted;
      spellFailed = r.failed;
    }
    const outBody = blocks.map((b) => b.text).join("\n\n");
    const nameLint = nameLintSelfConsistency(outBody);
    const afterWords = wordCount(outBody);
    const result = front ? front + "\n" + outBody : outBody;
    writeFileSync(path, result);
    const footer = buildPolishFooter({
      beforeWords,
      afterWords,
      noRevise,
      noSpell,
      reverted: reverted.length,
      spellFailed,
      nameLint,
    });
    process.stdout.write(`${path}\n${footer}\n`);
  } catch (e) {
    // Failsafe (mirrors distill's pipeline.ts main): a truncation or a transient
    // flake escaping the passes ships the ORIGINAL input rather than aborting; a
    // non-transient throw (a code bug) propagates.
    if (e instanceof TruncationError) {
      writeFileSync(path, input);
      process.stdout.write(`${path}\n— polish skipped: output TRUNCATED — ${e.message}\n`);
      process.exit(0);
    }
    if (!isTransient(e)) throw e;
    writeFileSync(path, input);
    process.stdout.write(`${path}\n— polish skipped (error): ${String(e).slice(0, 160)}\n`);
    process.exit(0);
  }
}

// Guard the CLI entrypoint so test imports can load this module (parseArgs,
// buildPolishFooter, USAGE) without running the pipeline against stdin.
if (import.meta.main) main();
