// cli — the command-line surface: USAGE, the pure argv->ParseResult parser (parseArgs), and the
// temp-file / pending-intermediary path helpers. parseArgs resolves the whole surface
// (help/misuse/ok) before main() touches the API key or the network, so it is unit-testable
// without spawning the binary. No LLM calls and no pipeline logic — parsing and path arithmetic.
import { statSync } from "node:fs";
import { DEFAULT_TAU } from "#src/distill/extract/route.ts";
import { takeValue } from "#src/core/args.ts";

// ---- arg parsing + io ----
// USAGE is the full `--help` text printed to stdout on `-h`/`--help`: the invocation forms, every
// option, the stdout/stderr output contract, and the exit-code table. It is the human-facing
// counterpart to parseArgs (which enforces the same surface programmatically).
export const USAGE = `distill-text — abstractive idea-compression: extract a note's typed knowledge
graph (concepts / judgements / inferences / procedures / payload) and project it as a
span-anchored seven-section canonical note (## Abstract/Concepts/Judgements/Inferences/
Procedures/Payload/Relations).

Usage:
  distill-text [options] [input.md]              compress a note (stdin when no path or '-')
  distill-text prose [options] [glossary.md]     render prose FROM an already-distilled note

Options:
  --glossary            emit the graph sections with the ## Abstract head omitted
  --lang <en|ru|auto>    language rubric (default: auto-detect)
  --tau <0..1>           payload-density routing threshold (default: ${DEFAULT_TAU})
  --no-gate              skip the residue backstop gates (fidelity + prose coverage)
  --no-revise            skip the revise pass in \`prose\` mode (no-op in compress mode —
                         its settle-chain revise pass was retired with the canonical rebuild)
  --max-words <n>        expand-guard cap: 0 disables it, a positive n is an absolute ceiling
  --dry-run              deterministic front half only (segment→route report); no API call
  --out <dest.md>        compress-mode destination override (default: the input path);
                         required when reading from stdin once a run reaches the emit
  -h, --help             show this help and exit

Output:
  The input file is never modified. A distilled run writes a review intermediary
  sibling to the destination, \`<dest>.tmp.md\` (destination defaults to the input
  path, overridable with --out), then exits — review and apply are a separate step
  (a review subagent, or a hand edit in Obsidian, then \`distill-text apply\`). The
  intermediary holds a decision block per residue item (verbs recover/keep) plus a
  mandatory trailing confirm-all gate stamped with dest=/src=.
  A passthrough run (failsafe, expand-guard, nothing to distill) instead writes a
  fresh temp .md holding the legacy envelope: <result>…</result> is exactly the text
  to write back to source, <residue> (omitted when empty) holds each item that
  failed a gate, with verbatim <source>. Either way, stdout carries exactly the
  data: one line, the written path (nothing on empty input). The one-line summary
  footer prints on stderr, with every other diagnostic. Capture is plain:
    path=$(distill-text input.md); status=$?
  Exit: 0 distilled or prose rendered (a pending review intermediary, residue, and
  gate-inconclusive items still exit 0 — they are surfaced in the footer and the
  intermediary itself) · 1 OPENAI_API_KEY or DASHSCOPE_API_KEY
  missing · 2 usage error (compress mode: stdin without --out once the run reaches
  the emit; --out naming a missing directory) · 3 passthrough (the
  output is the unmodified original — compress failsafe, expand-guard, nothing to
  distill, and every prose-mode skip: no glossary table, empty prose, error; the
  path line still prints, the reason on stderr;
  empty input exits 3 with nothing on stdout) · 4 pending intermediary already
  exists at the sibling .tmp.md path (refused before the key gate and before any
  LLM call — apply or delete it first).

Env: OPENAI_API_KEY + DASHSCOPE_API_KEY (e.g. doppler run --project claude-code --config std --)
`;

// CliOpts is the validated options bag parseArgs hands to main() for a `compress`/`prose`/`apply`
// run: the language rubric, the residue-gate and revise toggles, the glossary/dry-run flags, the
// payload-density threshold, the expand-guard cap, and the input/output paths.
export type CliOpts = {
  lang: "en" | "ru" | "auto";
  noRevise: boolean;
  noGate: boolean;
  glossaryOnly: boolean;
  dryRun: boolean;
  tau: number;
  maxWords?: number;
  path?: string;
  /// Compress-only destination override: the intermediary is written
  /// sibling to THIS path (`<out minus .md>.tmp.md`) and apply derives its
  /// write-back target from it. Required when input is stdin AND the run reaches
  /// the emit (passthrough/no-body/empty paths never need a destination, which is
  /// what keeps the c4e0339 stdin recipe exit-3 behavior byte-identical).
  out?: string;
};

// parseArgs is the whole CLI surface as one pure argv→result function so main() can act
// on help/misuse BEFORE the API-key gate or any network call, and so the surface is unit-
// testable without spawning the binary. It returns a discriminated result:
//   { kind: "help" }                     -> print USAGE, exit 0
//   { kind: "error", message }           -> print to stderr, exit 2 (misuse)
//   { kind: "ok", mode, opts }           -> run
// Flags may appear in any position. Value-flags consume the following token, so that token
// is never mistaken for the positional path. Unknown flags (any dash-prefixed token that is
// not a known flag, single- or double-dash), out-of-set enum values, non-numeric/blank/out-of-
// range numbers, missing values, and extra positionals all fail loudly rather than silently
// falling back to a default (the pre-hardening behavior). `--` is the end-of-options marker: it
// stops flag parsing so a dash-prefixed input path can follow; a bare `-` stays a positional.
// The optional `prose` subcommand is recognized as the FIRST positional (so a leading flag no
// longer hides it, and a stray `prose` in second position errors instead of misparsing).
export type ParseResult =
  | { kind: "help" }
  | { kind: "error"; message: string }
  | { kind: "ok"; mode: "compress" | "prose" | "apply"; opts: CliOpts };

export function parseArgs(argv: string[]): ParseResult {
  let lang: CliOpts["lang"] = "auto";
  let tau = DEFAULT_TAU;
  let maxWords: number | undefined;
  let noExpandGuard = false;
  let noRevise = false;
  let noGate = false;
  let glossaryOnly = false;
  let dryRun = false;
  let out: string | undefined;
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") return { kind: "help" };
    // `--` is the end-of-options marker: everything after it is a positional, so a
    // dash-prefixed input path (e.g. a file literally named `-notes.md`) can be passed.
    if (a === "--") {
      for (let j = i + 1; j < argv.length; j++) positionals.push(argv[j]);
      break;
    }
    if (a === "--no-revise") {
      noRevise = true;
      continue;
    }
    if (a === "--no-gate") {
      noGate = true;
      continue;
    }
    if (a === "--glossary") {
      glossaryOnly = true;
      continue;
    }
    // Renamed surface (2026-07-04): point the muscle-memory forms at the new names
    // instead of letting them die as a generic unknown-flag / extra-argument error.
    if (a === "--core-only")
      return { kind: "error", message: "--core-only was renamed to --glossary" };
    if (a === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (a === "--no-expand-guard") {
      noExpandGuard = true;
      continue;
    }
    if (a === "--lang") {
      const t = takeValue(argv, i, "--lang", "a value (en, ru, or auto)");
      if (!t.ok) return { kind: "error", message: t.message };
      const v = t.value;
      if (v !== "en" && v !== "ru" && v !== "auto")
        return {
          kind: "error",
          message: `--lang expects one of: en, ru, auto (got '${v}')`,
        };
      lang = v;
      i = t.next;
      continue;
    }
    if (a === "--tau") {
      const t = takeValue(argv, i, "--tau", "a number in [0, 1]");
      if (!t.ok) return { kind: "error", message: t.message };
      const v = t.value;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 1)
        return {
          kind: "error",
          message: `--tau expects a number in [0, 1] (got '${v}')`,
        };
      tau = n;
      i = t.next;
      continue;
    }
    // --max-words <n>: customizes the expand-guard cap (expandGuardCap). 0 disables the
    // guard entirely — a debugging escape hatch to see what the model produced even when it
    // grew the note; a positive n sets an absolute ceiling; omitted keeps today's default
    // (revert on any growth past the note's own input size). --no-expand-guard is its alias for 0.
    if (a === "--max-words") {
      const t = takeValue(argv, i, "--max-words", "a non-negative integer");
      if (!t.ok) return { kind: "error", message: t.message };
      const v = t.value;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0)
        return {
          kind: "error",
          message: `--max-words expects a non-negative integer (got '${v}')`,
        };
      maxWords = n;
      i = t.next;
      continue;
    }
    // --out: the compress-mode destination override. Value-checked here at
    // parse time — it must name a real .md destination, never the .tmp.md intermediary
    // itself; the stdin-requires---out refusal is a separate RUNTIME check (main()) so
    // the empty/no-body stdin exit-3 paths stay byte-identical.
    if (a === "--out") {
      const t = takeValue(argv, i, "--out", "a destination .md path");
      if (!t.ok) return { kind: "error", message: t.message };
      const v = t.value;
      if (v.endsWith(".tmp.md"))
        return {
          kind: "error",
          message: `--out must not name a .tmp.md intermediary (got '${v}')`,
        };
      if (!v.endsWith(".md"))
        return {
          kind: "error",
          message: `--out expects a .md destination (got '${v}')`,
        };
      out = v;
      i = t.next;
      continue;
    }
    // Any other dash-prefixed token is a flag typo (single- or double-dash), not a path —
    // name it, rather than misattributing an "extra argument" error to the following values
    // or ENOENT-crashing on it as a bogus filename. A bare `-` stays a positional.
    if (a.startsWith("-") && a !== "-") return { kind: "error", message: `unknown flag '${a}'` };
    positionals.push(a);
  }

  // Interpret positionals: an optional leading `prose` | `apply` subcommand, then the
  // input path. A leading flag no longer hides the subcommand (positionals are already
  // stripped of flags), and a stray subcommand in second position errors as an extra arg.
  let mode: "compress" | "prose" | "apply" = "compress";
  let rest = positionals;
  if (positionals[0] === "render")
    return { kind: "error", message: "the 'render' subcommand was renamed to 'prose'" };
  if (positionals[0] === "prose" || positionals[0] === "apply") {
    mode = positionals[0];
    rest = positionals.slice(1);
  }
  const path = rest[0];
  if (rest.length > 1)
    return {
      kind: "error",
      message: `unexpected extra argument(s): ${rest.slice(1).join(", ")}`,
    };

  // apply consumes exactly one intermediary and never reads stdin, so a missing path
  // is a usage error (not a stdin fallback); --dry-run names an action apply does not
  // have (there is nothing to preview — the intermediary IS the preview), exit 2.
  if (mode === "apply") {
    if (path === undefined)
      return { kind: "error", message: "apply requires an intermediary path (<name>.tmp.md)" };
    if (dryRun) return { kind: "error", message: "apply does not support --dry-run" };
  }

  // --out is compress-only: prose mode never derives a write-back destination.
  if (mode === "prose" && out !== undefined)
    return {
      kind: "error",
      message: "--out is compress-only (prose mode never derives a destination)",
    };

  // A positional `.tmp.md` compress input is the fat-finger for `apply` (it ends `.md`, so
  // the non-.md check below waves it through) — distilling scaffold text and stamping
  // dest=<name>.tmp.md is never intended. Mirror --out's own .tmp.md rejection; point at apply.
  if (mode === "compress" && path !== undefined && path.endsWith(".tmp.md"))
    return {
      kind: "error",
      message: `'${path}' is an intermediary — did you mean 'distill-text apply ${path}'?`,
    };

  // A compress-mode file input with no --out becomes the write-back destination, and the
  // .tmp.md ↔ .md round-trip (tmpPathFor / destinationFor) only closes on a .md name — a
  // `note.txt` would emit `note.txt.tmp.md`, stamp dest=note.txt, and apply would derive
  // note.txt.md, a stamp that can never match (a full LLM run wasted on an un-appliable
  // intermediary). Reject at parse time, before any work; --out (validated .md) or stdin
  // both escape it, since the destination then comes from --out rather than the input.
  // --dry-run never writes back (it prints a routing report), so the round-trip rationale
  // does not apply — it keeps taking any input.
  if (
    mode === "compress" &&
    !dryRun &&
    out === undefined &&
    path !== undefined &&
    path !== "-" &&
    !path.endsWith(".md")
  )
    return {
      kind: "error",
      message: `compress input must be a .md file, or pass --out <dest.md> (got '${path}')`,
    };

  // --no-expand-guard is sugar for --max-words 0; a conflicting positive --max-words is a
  // contradiction, so reject it rather than silently letting one win.
  if (noExpandGuard) {
    if (maxWords !== undefined && maxWords !== 0)
      return {
        kind: "error",
        message: `--no-expand-guard conflicts with --max-words ${maxWords} (it means --max-words 0)`,
      };
    maxWords = 0;
  }

  return {
    kind: "ok",
    mode,
    opts: {
      lang,
      noRevise,
      noGate,
      glossaryOnly,
      dryRun,
      tau,
      maxWords,
      path,
      out,
    },
  };
}

// The pending-review intermediary sibling for a destination. `note.md` →
// `note.tmp.md`; a destination without the .md suffix APPENDS `.tmp.md` instead
// of replacing — a bare replace() no-ops on `note.txt`, making tmpPath === dest,
// so the exit-4 preflight would refuse on the input file's own existence and the
// success write would clobber the input (both observed pre-fix).
export function tmpPathFor(dest: string): string {
  return dest.endsWith(".md") ? dest.replace(/\.md$/, ".tmp.md") : `${dest}.tmp.md`;
}

// The exit-4 pending-intermediary refusal, shared by the pre-key preflight
// and the no-clobber final write (a racing emit's loser). The mtime staleness hint
// tells the reviewer whether the pending file is this morning's review
// or a weeks-old orphan; refusal is loud either way.
export function refusePendingIntermediary(tmpPath: string): never {
  let age = "";
  try {
    const mins = Math.round((Date.now() - statSync(tmpPath).mtimeMs) / 60000);
    const label =
      mins < 60
        ? `${mins}m`
        : mins < 1440
          ? `${Math.round(mins / 60)}h`
          : `${Math.round(mins / 1440)}d`;
    age = ` (${label} old)`;
  } catch {} // a hint only: a vanished/unstattable file changes nothing about the refusal
  console.error(
    `distill: pending intermediary exists: ${tmpPath}${age} — apply it or delete it before re-running`,
  );
  process.exit(4);
}
