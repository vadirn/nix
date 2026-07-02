#!/usr/bin/env bun
// card-stage — CLI: read one already-emitted distilled note (D13: a file path,
// never a distill() call) and stage a review file per candidate under a
// card-staging inbox. Every candidate is staged regardless of its band verdict or
// any recall/judge/draft flag (D22) — nothing here gates or drops.
//
// Flow per candidate: fetchNeighbours (a spawn/parse failure degrades to the
// recall-unavailable flag with empty hits, never a throw — see neighbours.ts) →
// the novelty-band judge on FIDELITY (a non-bug failure or an unparseable reply
// degrades to the judge-inconclusive flag, verdict null) → the card draft on
// EXTRACT (a non-bug failure or an empty reply degrades to the draft-failed flag,
// draft "") → buildStagingRecord → renderStagingFile → write. Error discipline
// mirrors the pipeline (pipeline.ts's recover-def/recover-steps sites): every
// per-candidate LLM call is wrapped in try/rethrowIfBug, so a programmer bug
// (a real Error, not a TransientError/TruncationError) propagates and aborts the
// run instead of being swallowed as a flake.
//
// --dry-run enumerates candidates and fetches neighbours only — no LLM call, no
// write — and prints a per-candidate report instead of staging anything.
//
// The whole flow is one pure-ish function (stageNote) over injected deps
// (ask/fetchNeighbours/writeFile), mirroring pipeline.ts's parseArgs/main split:
// stageNote is unit-testable with fakes; main() wires the real Fireworks call,
// the real fetchNeighbours, and a real mkdir-then-write, behind the
// import.meta.main guard.
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseDescription, parseFrontmatter } from "../frontmatter.ts";
import {
  askJson,
  EXTRACT,
  EXTRACT_TOKENS,
  FIDELITY,
  FIDELITY_TOKENS,
  rethrowIfBug,
} from "../fw.ts";
import { detectLang, parseConceptGraph, sections } from "../text.ts";
import { annotateEdges, buildStagingRecord, decideCard, enumerateCandidates } from "./cards.ts";
import { fetchNeighbours } from "./neighbours.ts";
import { cardDraftPrompt, noveltyBandPrompt } from "./prompts.ts";
import { renderStagingFile } from "./stage.ts";
import type {
  Arm,
  BandJudgeReply,
  BandVerdict,
  CandidateFlag,
  Candidate,
  DraftReply,
  NeighbourHit,
} from "./types.ts";

// ---- injected I/O seams (mirrors neighbours.ts's RunFn/ReadFn split) ----

export type AskFn = typeof askJson;
export type FetchNeighboursFn = (
  candidate: Candidate,
  opts: { vaultRoot: string; topK: number },
) => Promise<{ hits: NeighbourHit[]; ok: boolean }>;
export type WriteFn = (path: string, content: string) => Promise<void>;

export type StageDeps = {
  ask: AskFn;
  fetchNeighbours: FetchNeighboursFn;
  writeFile: WriteFn;
};

export type StageOpts = {
  vaultRoot: string;
  stagingDir: string;
  topK: number;
  dryRun: boolean;
};

// The extension a title falls back to when the note carries no H1 — the first `#`
// heading anywhere in the body (not anchored to line 1: a note may open with prose
// above its heading), mirroring pipeline.ts's own H1-detection intent. Reuses
// sections()'s fence-masked scan (the d06c6fa fix) instead of a raw regex, so a
// fenced code block's own `# comment` line cannot be misread as the note's title
// (Finding 6) the way sections() itself was fixed to never misread it as a heading.
function extractTitle(body: string): string {
  const h1 = sections(body).find((s) => s.depth === 1);
  return h1 ? h1.heading.trim() : "";
}

export type DryRunEntry = {
  term: string;
  arm: Arm;
  neighbourCount: number;
  neighboursOk: boolean;
  edgeCount: number;
  offRegistryCount: number;
};

export type StagedFlagCounts = Partial<Record<CandidateFlag, number>>;

export type StageRunResult =
  | { mode: "dry-run"; total: number; entries: DryRunEntry[] }
  | { mode: "staged"; total: number; staged: number; flagCounts: StagedFlagCounts };

// The whole staging flow, deps injected so cards/stage.test.ts drives every
// degradation lane with fakes and asserts dry-run calls neither ask nor writeFile.
export async function stageNote(
  noteText: string,
  notePath: string,
  opts: StageOpts,
  deps: StageDeps,
): Promise<StageRunResult> {
  const { front, body } = parseFrontmatter(noteText);
  const tie = parseDescription(front);
  const noteName = basename(notePath).replace(/\.md$/i, "");
  const title = extractTitle(body) || noteName;
  const sourceNote = resolve(notePath);
  const glossary = parseConceptGraph(body);
  const candidates = enumerateCandidates(glossary, { tie, title, sourceNote });
  const lang = detectLang(body);

  if (opts.dryRun) {
    const entries: DryRunEntry[] = [];
    for (const candidate of candidates) {
      const { hits, ok } = await deps.fetchNeighbours(candidate, {
        vaultRoot: opts.vaultRoot,
        topK: opts.topK,
      });
      const edges = annotateEdges(candidate.relations);
      entries.push({
        term: candidate.term,
        arm: candidate.arm,
        neighbourCount: hits.length,
        neighboursOk: ok,
        edgeCount: edges.length,
        offRegistryCount: edges.filter((e) => e.offRegistry).length,
      });
    }
    return { mode: "dry-run", total: candidates.length, entries };
  }

  const flagCounts: StagedFlagCounts = {};
  let staged = 0;
  // Threaded across every candidate of this note so renderStagingFile can dedupe a
  // filename collision (Finding 1: a thesis term equal to a glossary term, a
  // case/punctuation variant, or two terms that both slug to "" would otherwise
  // silently clobber one another's staging file).
  const usedFilenames = new Set<string>();
  for (const candidate of candidates) {
    const flags: CandidateFlag[] = [];
    const { hits, ok } = await deps.fetchNeighbours(candidate, {
      vaultRoot: opts.vaultRoot,
      topK: opts.topK,
    });
    if (!ok) flags.push("recall-unavailable");

    let verdict: BandVerdict | null = null;
    try {
      const reply = await deps.ask<BandJudgeReply>(
        FIDELITY,
        noveltyBandPrompt(candidate, hits, lang),
        FIDELITY_TOKENS,
      );
      verdict = decideCard(reply, hits);
    } catch (e) {
      rethrowIfBug(e, "novelty-band");
    }
    if (verdict === null) flags.push("judge-inconclusive");

    let draft = "";
    try {
      const reply = await deps.ask<DraftReply>(
        EXTRACT,
        cardDraftPrompt(candidate, hits, body, lang),
        EXTRACT_TOKENS,
      );
      if (typeof reply?.draft === "string" && reply.draft.trim()) draft = reply.draft;
    } catch (e) {
      rethrowIfBug(e, "card-draft");
    }
    if (!draft) flags.push("draft-failed");

    const record = buildStagingRecord({ candidate, verdict, flags, lang, draft });
    const { filename, content } = renderStagingFile(record, noteName, usedFilenames);
    await deps.writeFile(join(opts.stagingDir, filename), content);
    staged++;
    for (const f of flags) flagCounts[f] = (flagCounts[f] ?? 0) + 1;
  }

  return { mode: "staged", total: candidates.length, staged, flagCounts };
}

// ---- pure stdout formatting (kept apart from I/O so it's unit-testable too) ----

export function formatDryRunReport(entries: DryRunEntry[]): string {
  if (entries.length === 0) return "(no candidates)";
  return entries
    .map(
      (e) =>
        `${e.term} [${e.arm}] — neighbours: ${e.neighbourCount} (ok=${e.neighboursOk}) ·` +
        ` edges: ${e.edgeCount} (${e.offRegistryCount} off-registry)`,
    )
    .join("\n");
}

export function formatSummary(total: number, staged: number, flagCounts: StagedFlagCounts): string {
  const flagPart = Object.entries(flagCounts)
    .map(([flag, n]) => `${flag}: ${n}`)
    .join(", ");
  return `staged ${staged}/${total}` + (flagPart ? ` · ${flagPart}` : "");
}

// ---- arg parsing (pure, mirrors pipeline.ts's parseArgs discipline: unknown
// flags, missing values, and extra positionals fail loudly) ----

export const USAGE = `card-stage — stage extraction candidates from a distilled note as review
files under a card-staging inbox. Every candidate is staged regardless of its band
verdict or any recall/judge/draft flag (D22) — nothing here gates or drops; a
staging file is a review packet, never a committed card (Log 10).

Usage:
  card-stage <note.md> [options]

Options:
  --staging-dir <dir>   where staging files are written (default: <vault-root>/00 inbox/card-staging)
  --vault-root <dir>    the vault root recall searches (default: $HOME/Documents/vault)
  --top-k <n>           neighbours to recall per candidate (default: 5)
  --dry-run             enumerate + fetch neighbours only; no LLM call, writes nothing
  -h, --help            show this help and exit

Env: FIREWORKS_API_KEY (e.g. doppler run --project claude-code --config std --)
`;

export type RawOpts = {
  vaultRoot?: string;
  stagingDir?: string;
  topK: number;
  dryRun: boolean;
  notePath: string;
};

export type ParseResult =
  | { kind: "help" }
  | { kind: "error"; message: string }
  | { kind: "ok"; opts: RawOpts };

export function parseArgs(argv: string[]): ParseResult {
  let vaultRoot: string | undefined;
  let stagingDir: string | undefined;
  let topK = 5;
  let dryRun = false;
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") return { kind: "help" };
    if (a === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (a === "--staging-dir") {
      const v = argv[++i];
      if (v === undefined)
        return { kind: "error", message: "--staging-dir expects a directory path" };
      stagingDir = v;
      continue;
    }
    if (a === "--vault-root") {
      const v = argv[++i];
      if (v === undefined)
        return { kind: "error", message: "--vault-root expects a directory path" };
      vaultRoot = v;
      continue;
    }
    if (a === "--top-k") {
      const v = argv[++i];
      if (v === undefined || v.trim() === "")
        return { kind: "error", message: "--top-k expects a positive integer" };
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1)
        return { kind: "error", message: `--top-k expects a positive integer (got '${v}')` };
      topK = n;
      continue;
    }
    // Any other dash-prefixed token is a flag typo, not the note path — name it
    // rather than misattributing it to a positional (mirrors pipeline.ts).
    if (a.startsWith("-") && a !== "-") return { kind: "error", message: `unknown flag '${a}'` };
    positionals.push(a);
  }

  if (positionals.length === 0)
    return { kind: "error", message: "missing required argument: <note.md>" };
  if (positionals.length > 1)
    return {
      kind: "error",
      message: `unexpected extra argument(s): ${positionals.slice(1).join(", ")}`,
    };

  return { kind: "ok", opts: { vaultRoot, stagingDir, topK, dryRun, notePath: positionals[0] } };
}

// Default vault-root/staging-dir are relative to $HOME — injected here (rather
// than read from process.env inline) so the default-resolution logic itself is
// testable without an env-var fixture.
export function resolveOpts(raw: RawOpts, homeDir: string): StageOpts & { notePath: string } {
  const vaultRoot = raw.vaultRoot ?? join(homeDir, "Documents", "vault");
  const stagingDir = raw.stagingDir ?? join(vaultRoot, "00 inbox", "card-staging");
  return { vaultRoot, stagingDir, topK: raw.topK, dryRun: raw.dryRun, notePath: raw.notePath };
}

// Real write: mkdir -p the staging dir, then write the file. The only non-injected
// side effect wired into main() — cards/stage.test.ts exercises stageNote with a
// fake instead.
async function writeStagingFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, content);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.kind === "help") {
    process.stdout.write(USAGE);
    return;
  }
  if (parsed.kind === "error") {
    console.error(`card-stage: ${parsed.message}\nTry 'card-stage --help' for usage.`);
    process.exit(2);
    return;
  }
  const opts = resolveOpts(parsed.opts, process.env.HOME ?? "");
  if (!opts.dryRun && !process.env.FIREWORKS_API_KEY) {
    console.error(
      "FIREWORKS_API_KEY not set (run under: doppler run --project claude-code --config std --)",
    );
    process.exit(1);
    return;
  }
  const noteText = readFileSync(opts.notePath, "utf8");
  const result = await stageNote(
    noteText,
    opts.notePath,
    {
      vaultRoot: opts.vaultRoot,
      stagingDir: opts.stagingDir,
      topK: opts.topK,
      dryRun: opts.dryRun,
    },
    { ask: askJson, fetchNeighbours, writeFile: writeStagingFile },
  );
  if (result.mode === "dry-run") {
    process.stdout.write(formatDryRunReport(result.entries) + "\n");
    return;
  }
  process.stdout.write(formatSummary(result.total, result.staged, result.flagCounts) + "\n");
}

if (import.meta.main) main();
