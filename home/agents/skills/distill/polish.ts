#!/usr/bin/env bun
// polish-text — copy-edit a markdown note. See the USAGE block below for the full CLI
// surface (invocation, flags, output contract, exit codes).
//
// The input file is never modified (fallible LLM pass; the write-back is the reviewer's
// act, not the tool's). Shares the writing-core (writing/) with distill: revise() and
// spellPass() mask reference spans before rewriting and normalize typography on the way
// out. Frontmatter passes through verbatim, and there is no <result> XML envelope: that
// envelope exists to carry residue, and polish has no residue channel — its output IS
// the file content.
//
// Failsafe mirrors distill: a TruncationError or transient throw escaping the passes
// ships the ORIGINAL input with a "polish skipped" footer instead of aborting; a
// non-transient throw (a code bug) propagates.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// USAGE is the full `--help` text printed to stdout on `-h`/`--help`: the invocation forms,
// every option, the output contract, and the exit codes — the human-facing counterpart to
// parseArgs, which enforces the same surface programmatically.
export const USAGE = `polish-text — copy-edit a markdown note: four writing passes, then a
spell/grammar pass, typography normalization, and a self-consistency name lint.
It does not compress the text, add a glossary, or apply a fidelity gate — the
original claims remain unchanged.

Usage:
  polish-text [options] [input.md]    polish a note (stdin when no path or '-')

Options:
  --lang <en|ru>    force the language rubric (default: auto-detect)
  --no-revise       skip the four writing passes
  --no-spell        skip the spell/grammar pass
  -o, --temp-file   write to a fresh temp .md; stdout: the path, then the footer
  -h, --help        show this help and exit

Output:
  The input file is never modified. Polished content goes to stdout as exact
  bytes (frontmatter + body, trailing newline preserved), so
  \`polish-text in.md > out.md\` composes; the report footer and all
  diagnostics go to stderr.
  Exit: 0 polished · 2 usage error · 3 passthrough (failsafe or empty input —
  the output is the unpolished input).

Env: FIREWORKS_API_KEY (the deployed wrapper fills it from the macOS Keychain,
service fireworks-api; or doppler run --project claude-code --config std --)
`;

// The validated options bag parseArgs hands to main(): the language override, which of the
// two writing passes to skip, whether to write to a fresh temp file instead of stdout, and
// the input path (undefined or "-" means stdin).
export type PolishOpts = {
  lang: "en" | "ru" | "auto";
  noRevise: boolean;
  noSpell: boolean;
  tempFile: boolean;
  path?: string;
};

// The result of parsing argv: "help" (print USAGE, exit 0), "error" (a usage mistake, exit
// 2), or "ok" (a validated PolishOpts ready to run).
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
  let tempFile = false;
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
    if (a === "-o" || a === "--temp-file") {
      tempFile = true;
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

  return { kind: "ok", opts: { lang, noRevise, noSpell, tempFile, path } };
}

// Render the stderr report footer: the before/after word count and percent change, whether
// each pass ran or was skipped (and, for spell, whether it failed or reverted blocks), and
// the name-lint tail from formatNameLint.
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

// Create a fresh temp directory and return the path to a .md file inside it (not
// yet created — the caller writeFileSync's the content). Same helper shape as
// cli.ts's tempMdPath: fs.mkdtempSync instead of shelling out to a platform
// mktemp binary, whose --suffix flag is GNU-coreutils-specific (not portable).
function tempMdPath(): string {
  return join(mkdtempSync(join(tmpdir(), "polish-")), "out.md");
}

// main is the CLI entrypoint: it parses argv, acts on --help and misuse before the
// API-key gate or any network call, reads the input (file or stdin), then runs the
// revise/spell passes and emits the polished content. It returns no value; it sets the
// process exit code (0 polished, 1 missing key, 2 usage error, 3 passthrough).
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
  const { lang, noRevise, noSpell, tempFile, path: inputPath } = parsed.opts;
  // Both passes skipped: nothing calls out, so the key gate would only block a
  // typography-only no-op run for no reason.
  if (!(noRevise && noSpell) && !process.env.FIREWORKS_API_KEY) {
    console.error(
      "FIREWORKS_API_KEY not set — the deployed wrapper (bin/polish-text) fills it from the " +
        "macOS Keychain (service fireworks-api), or prefix: " +
        "doppler run --project claude-code --config std --",
    );
    process.exit(1);
  }
  const fromStdin = inputPath === undefined || inputPath === "-";
  // A bare `polish-text` at a terminal would hang silently on fd 0; say so.
  if (fromStdin && process.stdin.isTTY)
    console.error("polish: reading stdin — pass a file or pipe input (ctrl-d ends input)");
  const input = readFileSync(fromStdin ? 0 : inputPath, "utf8");
  if (!input.trim()) {
    console.error("polish skipped: empty input");
    process.exit(3);
  }
  // Default: content → stdout (exact bytes), footer → stderr. --temp-file keeps
  // the parent-loop contract: a fresh temp .md, stdout two lines (path, footer).
  const emit = (content: string, footer: string): void => {
    if (tempFile) {
      const path = tempMdPath();
      writeFileSync(path, content);
      process.stdout.write(`${path}\n${footer}\n`);
    } else {
      process.stdout.write(content);
      process.stderr.write(`${footer}\n`);
    }
  };
  // A full run is tens of seconds of LLM calls; tick per pass, TTY-gated so
  // scripts and parent loops never see it.
  const progress = process.stderr.isTTY
    ? (line: string): void => void process.stderr.write(`${line}\n`)
    : undefined;
  try {
    const { front, body } = parseFrontmatter(input);
    const resolvedLang = lang === "auto" ? detectLang(body) : lang;
    const beforeWords = wordCount(body);
    let blocks = segment(body);
    let reverted: string[] = [];
    let spellFailed = false;
    if (!noRevise)
      blocks = await revise(blocks, resolvedLang === "ru" ? PASS_RU : PASS_EN, [], (i, n) =>
        progress?.(`revise ${i}/${n}`),
      );
    if (!noSpell) {
      progress?.("spell…");
      const r = await spellPass(blocks);
      blocks = r.blocks;
      reverted = r.reverted;
      spellFailed = r.failed;
    }
    const outBody = blocks.map((b) => b.text).join("\n\n");
    const nameLint = nameLintSelfConsistency(outBody);
    const afterWords = wordCount(outBody);
    // block-join drops the source's final newline; restore it so a polished
    // file round-trips POSIX-complete when the input was newline-terminated.
    const nl = input.endsWith("\n") ? "\n" : "";
    const result = (front ? front + "\n" + outBody : outBody) + nl;
    const footer = buildPolishFooter({
      beforeWords,
      afterWords,
      noRevise,
      noSpell,
      reverted: reverted.length,
      spellFailed,
      nameLint,
    });
    emit(result, footer);
  } catch (e) {
    // Failsafe (mirrors distill's passthrough catch, not its emit/apply flow —
    // polish has no intermediary): a truncation or a transient flake escaping the
    // passes ships the ORIGINAL input rather than aborting; a non-transient throw
    // (a code bug) propagates. Exit 3: valid but unpolished.
    if (e instanceof TruncationError) {
      emit(input, `— polish skipped: output TRUNCATED — ${e.message}`);
      process.exit(3);
    }
    if (!isTransient(e)) throw e;
    // newlines folded so the --temp-file footer stays one line
    emit(input, `— polish skipped (error): ${String(e).replace(/\n/g, " ").slice(0, 160)}`);
    process.exit(3);
  }
}

// Guard the CLI entrypoint so test imports can load this module (parseArgs,
// buildPolishFooter, USAGE) without running the pipeline against stdin.
if (import.meta.main) main();
