#!/usr/bin/env bun
// card-stage — CLI: read one already-emitted distilled note (a file path, never a
// distill() call) and stage a review file per candidate under a card-staging
// inbox. Every candidate is staged regardless of its band verdict or any
// recall/judge/draft flag — nothing here gates or drops.
//
// Flow per candidate: fetchNeighbours (a spawn/parse failure degrades to the
// recall-unavailable flag with empty hits, never a throw — see neighbours.ts) →
// the novelty-band judge on CARD_JUDGE (a non-bug failure or an unparseable reply
// degrades to the judge-inconclusive flag, verdict null) → the card draft on
// CARD_DRAFT (a non-bug failure or an empty reply degrades to the draft-failed flag,
// draft "") → buildStagingRecord → renderStagingFile → write. Error discipline
// mirrors the pipeline (distill-core.ts's recover-def/recover-steps sites): every
// per-candidate LLM call is wrapped in try/rethrowIfBug, so a programmer bug
// (a real Error, not a TransientError/TruncationError) propagates and aborts the
// run instead of being swallowed as a flake.
//
// --dry-run enumerates candidates and fetches neighbours only — no LLM call, no
// write — and prints a per-candidate report instead of staging anything.
//
// The whole flow is one pure-ish function (stageNote) over injected deps
// (ask/fetchNeighbours/writeFile), mirroring the parseArgs (cli.ts) / main (distill-core.ts) split:
// stageNote is unit-testable with fakes; main() wires the real Fireworks call,
// the real fetchNeighbours, and a real mkdir-then-write, behind the
// import.meta.main guard.
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseDescription, parseFrontmatter } from "#src/core/frontmatter.ts";
import { InteractFormatError, sections, stripInteract } from "#src/distill/emit.ts";
import { askJson, ensureKeys } from "@skills/llm/llm.ts";
import { MissingKeyError } from "@skills/llm/keys.ts";
import { cardStageDegrade as rethrowIfBug } from "#src/core/degrade.ts";
import { CARD_DRAFT, CARD_DRAFT_TOKENS, CARD_JUDGE, CARD_JUDGE_TOKENS } from "#src/core/models.ts";
import { takeValue } from "#src/core/args.ts";
import { detectLang } from "#src/core/text.ts";
import { nameLintAgainstSource } from "#src/core/writing/name-lint.ts";
import {
  annotateEdges,
  buildStagingRecord,
  decideCard,
  enumerateCandidates,
  harvestConcepts,
} from "#src/cards/cards.ts";
import { fetchNeighbours } from "#src/cards/neighbours.ts";
import { cardDraftPrompt, noveltyBandPrompt } from "#src/cards/prompts.ts";
import { renderStagingFile } from "#src/cards/stage.ts";
import type {
  Arm,
  BandJudgeReply,
  BandVerdict,
  CandidateFlag,
  Candidate,
  DraftReply,
  NeighbourHit,
  StagingRecord,
} from "#src/cards/types.ts";

// ---- injected I/O seams (mirrors neighbours.ts's RunFn/ReadFn split) ----

// AskFn is the shape of llm.ts's askJson — the LLM-call seam stageNote calls through
// for both the band judge and the card draft.
export type AskFn = typeof askJson;

// FetchNeighboursFn is the shape of neighbours.ts's fetchNeighbours — the recall
// seam stageNote calls through for each candidate.
export type FetchNeighboursFn = (
  candidate: Candidate,
  opts: { vaultRoot: string; topK: number },
) => Promise<{ hits: NeighbourHit[]; ok: boolean }>;

// WriteFn writes `content` to `path` — the filesystem seam stageNote calls through
// to persist one rendered staging file.
export type WriteFn = (path: string, content: string) => Promise<void>;

// StageDeps bundles the three injected seams (AskFn/FetchNeighboursFn/WriteFn)
// stageNote needs, so cards/stage.test.ts can drive every degradation lane with
// fakes instead of the real Fireworks call, recall, and disk write.
export type StageDeps = {
  ask: AskFn;
  fetchNeighbours: FetchNeighboursFn;
  writeFile: WriteFn;
};

// StageOpts is the resolved run configuration for one stageNote call: where recall
// searches, where staging files are written, how many neighbours to fetch, and
// whether to run in dry-run mode.
export type StageOpts = {
  vaultRoot: string;
  stagingDir: string;
  topK: number;
  dryRun: boolean;
  // The durable source entry (e.g. the inbox reference stub) when the note path is
  // ephemeral — distill hands over a temp file that is dead by commit time (live-run
  // finding). Overrides the staged Source line, the staging filename prefix, and the
  // thesis-term fallback.
  source?: string;
};

// The extension a title falls back to when the note carries no H1 — the first `#`
// heading anywhere in the body (not anchored to line 1: a note may open with prose
// above its heading), mirroring distill-core.ts's own H1-detection intent. Reuses
// sections()'s fence-masked scan (the d06c6fa fix) instead of a raw regex, so a
// fenced code block's own `# comment` line cannot be misread as the note's title,
// the same way sections() itself was fixed to never misread it as a heading.
function extractTitle(body: string): string {
  const h1 = sections(body).find((s) => s.depth === 1);
  return h1 ? h1.heading.trim() : "";
}

// DryRunEntry summarizes one candidate's --dry-run report: its term and arm, how
// many neighbours recall found and whether recall succeeded, and how many
// relation edges it carries with how many of those off-registry.
export type DryRunEntry = {
  term: string;
  arm: Arm;
  neighbourCount: number;
  neighboursOk: boolean;
  edgeCount: number;
  offRegistryCount: number;
};

// StagedFlagCounts tallies how many staged candidates carried each CandidateFlag,
// keyed by flag with absent keys meaning zero.
export type StagedFlagCounts = Partial<Record<CandidateFlag, number>>;

// StageRunResult is stageNote's outcome: either the dry-run report (total
// candidates plus one DryRunEntry each) or the staged-run summary (total
// candidates, how many were staged, the flag tally, and how many drafts carried a
// corrupted name per name-lint).
export type StageRunResult =
  | { mode: "dry-run"; total: number; entries: DryRunEntry[] }
  | {
      mode: "staged";
      total: number;
      staged: number;
      flagCounts: StagedFlagCounts;
      corruptedNames: number;
    };

// distill writes its emitted note inside an XML envelope (`<result>…</result>`,
// plus an optional `<residue>` sibling) for a parent process to consume; the note
// itself — frontmatter and all — is the envelope's payload. Since that file is
// exactly the emitted note this layer expects to receive, accept it directly:
// unwrap when present, pass a bare note through untouched. Without this,
// parseFrontmatter sees `<result>` at byte 0, the tie reads as absent, and the
// thesis candidate silently vanishes (live-run finding).
export function unwrapResult(text: string): string {
  const m = /^\s*<result>\n?([\s\S]*?)<\/result>/.exec(text);
  return m ? m[1] : text;
}

// Belt for the interactive-text flow: card-stage's input is the APPLIED note
// (scaffold-free), but a reviewer can point it at an un-applied `<name>.tmp.md`
// intermediary by mistake. stripInteract removes the decision blocks (an applied
// note has none and returns byte-identical); a malformed intermediary is left
// untouched so it is not silently mangled — it fails downstream loudly instead.
export function stripInteractBelt(text: string): string {
  try {
    return stripInteract(text);
  } catch (e) {
    if (e instanceof InteractFormatError) return text;
    throw e;
  }
}

// Stage one candidate end-to-end: recall its neighbours, run the band judge and the
// card draft (each degrading to a flag on a non-bug failure, never a throw), name-lint
// the draft, and fold it all into a StagingRecord. Returns the record plus how many
// corrupted names the lint found (the caller tallies them). No filename or write concern
// lives here — stageNote owns dedupe and the disk write.
async function stageCandidate(
  candidate: Candidate,
  body: string,
  lang: "en" | "ru",
  opts: StageOpts,
  deps: StageDeps,
): Promise<{ record: StagingRecord; corruptedNames: number }> {
  const flags: CandidateFlag[] = [];
  const { hits, ok } = await deps.fetchNeighbours(candidate, {
    vaultRoot: opts.vaultRoot,
    topK: opts.topK,
  });
  if (!ok) flags.push("recall-unavailable");

  let verdict: BandVerdict | null = null;
  try {
    const reply = await deps.ask<BandJudgeReply>(
      CARD_JUDGE,
      noveltyBandPrompt(candidate, hits, lang),
      CARD_JUDGE_TOKENS,
    );
    verdict = decideCard(reply, hits);
  } catch (e) {
    rethrowIfBug(e, "novelty-band");
  }
  if (verdict === null) flags.push("judge-inconclusive");

  let draft = "";
  try {
    const reply = await deps.ask<DraftReply>(
      CARD_DRAFT,
      cardDraftPrompt(candidate, hits, body, lang),
      CARD_DRAFT_TOKENS,
    );
    if (typeof reply?.draft === "string" && reply.draft.trim()) draft = reply.draft;
  } catch (e) {
    rethrowIfBug(e, "card-draft");
  }
  if (!draft) flags.push("draft-failed");

  // deterministic, zero-LLM, never blocks. The draft is the only newly generated
  // text — candidate.def is copied verbatim from the note, so linting it is a no-op.
  const nameLint = draft ? nameLintAgainstSource(draft, body) : { corrupted: [], invented: [] };

  const record = buildStagingRecord({ candidate, verdict, flags, lang, draft, nameLint });
  return { record, corruptedNames: nameLint.corrupted.length };
}

// The whole staging flow, deps injected so cards/stage.test.ts drives every
// degradation lane with fakes and asserts dry-run calls neither ask nor writeFile.
export async function stageNote(
  noteText: string,
  notePath: string,
  opts: StageOpts,
  deps: StageDeps,
): Promise<StageRunResult> {
  const { front, body } = parseFrontmatter(stripInteractBelt(unwrapResult(noteText)));
  const tie = parseDescription(front);
  const noteName = basename(opts.source ?? notePath).replace(/\.md$/i, "");
  const title = extractTitle(body) || noteName;
  const sourceNote = resolve(opts.source ?? notePath);
  const concepts = harvestConcepts(body);
  const candidates = enumerateCandidates(concepts, { tie, title, sourceNote });
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
  let corruptedNames = 0;
  // Threaded across every candidate of this note so renderStagingFile can dedupe a
  // filename collision: a thesis term equal to a concept term, a case/punctuation
  // variant, or two terms that both slug to "" would otherwise silently clobber
  // one another's staging file.
  const usedFilenames = new Set<string>();
  for (const candidate of candidates) {
    const { record, corruptedNames: corrupted } = await stageCandidate(
      candidate,
      body,
      lang,
      opts,
      deps,
    );
    corruptedNames += corrupted;
    const { filename, content } = renderStagingFile(record, noteName, usedFilenames);
    await deps.writeFile(join(opts.stagingDir, filename), content);
    staged++;
    for (const f of record.flags) flagCounts[f] = (flagCounts[f] ?? 0) + 1;
  }

  return { mode: "staged", total: candidates.length, staged, flagCounts, corruptedNames };
}

// ---- pure stdout formatting (kept apart from I/O so it's unit-testable too) ----

// Render a --dry-run report as one line per DryRunEntry, or a placeholder when the
// note yielded no candidates.
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

// Render a staged-run summary line: how many candidates were staged out of the
// total, the per-flag tally when any flag fired, and the corrupted-name count
// when name-lint found one.
export function formatSummary(
  total: number,
  staged: number,
  flagCounts: StagedFlagCounts,
  corruptedNames = 0,
): string {
  const flagPart = Object.entries(flagCounts)
    .map(([flag, n]) => `${flag}: ${n}`)
    .join(", ");
  return (
    `staged ${staged}/${total}` +
    (flagPart ? ` · ${flagPart}` : "") +
    (corruptedNames > 0 ? ` · corrupted-names: ${corruptedNames}` : "")
  );
}

// ---- arg parsing (pure, mirrors cli.ts's parseArgs discipline: unknown
// flags, missing values, and extra positionals fail loudly) ----

// USAGE is the CLI's help text, printed verbatim on `-h`/`--help` and on an arg-parse error.
export const USAGE = `card-stage — stage extraction candidates from a distilled note as review
files under a card-staging inbox. Every candidate is staged regardless of its band
verdict or any recall/judge/draft flag — nothing here gates or drops; a
staging file is a review packet, never a committed card.

Usage:
  card-stage <note.md> [options]

Options:
  --staging-dir <dir>   where staging files are written (default: <vault-root>/00 inbox/card-staging)
  --vault-root <dir>    the vault root recall searches (default: $HOME/Documents/vault)
  --top-k <n>           neighbours to recall per candidate (default: 5)
  --source <file.md>    the durable source entry (e.g. the inbox reference stub) when
                        <note.md> is a temp file; drives the Source line, the staging
                        filename prefix, and the thesis-term fallback
  --dry-run             enumerate + fetch neighbours only; no LLM call, writes nothing
  -h, --help            show this help and exit

Env: OPENAI_API_KEY + DASHSCOPE_API_KEY (Doppler claude-code/std; e.g.
     doppler run --project claude-code --config std --)
`;

// RawOpts is the argv-parsed options, still unresolved: vaultRoot/stagingDir may
// be absent (resolveOpts fills their $HOME-relative defaults) and every value is
// exactly as the user typed it.
export type RawOpts = {
  vaultRoot?: string;
  stagingDir?: string;
  topK: number;
  dryRun: boolean;
  source?: string;
  notePath: string;
};

// ParseResult is parseArgs's outcome: "help" when -h/--help was passed, "error"
// with a human-readable message on a bad or missing argument, or "ok" with the
// parsed RawOpts.
export type ParseResult =
  | { kind: "help" }
  | { kind: "error"; message: string }
  | { kind: "ok"; opts: RawOpts };

// Parse argv into a ParseResult. Unknown flags, a flag missing its value, and
// extra positionals all fail with a named "error" result rather than throwing
// (mirrors cli.ts's parseArgs discipline).
export function parseArgs(argv: string[]): ParseResult {
  let vaultRoot: string | undefined;
  let stagingDir: string | undefined;
  let topK = 5;
  let dryRun = false;
  let source: string | undefined;
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") return { kind: "help" };
    if (a === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (a === "--staging-dir") {
      const r = takeValue(argv, i, "--staging-dir", "a directory path");
      if (!r.ok) return { kind: "error", message: r.message };
      stagingDir = r.value;
      i = r.next;
      continue;
    }
    if (a === "--vault-root") {
      const r = takeValue(argv, i, "--vault-root", "a directory path");
      if (!r.ok) return { kind: "error", message: r.message };
      vaultRoot = r.value;
      i = r.next;
      continue;
    }
    if (a === "--source") {
      const r = takeValue(argv, i, "--source", "a file path");
      if (!r.ok) return { kind: "error", message: r.message };
      source = r.value;
      i = r.next;
      continue;
    }
    if (a === "--top-k") {
      const r = takeValue(argv, i, "--top-k", "a positive integer");
      if (!r.ok) return { kind: "error", message: r.message };
      i = r.next;
      const n = Number(r.value);
      if (!Number.isInteger(n) || n < 1)
        return { kind: "error", message: `--top-k expects a positive integer (got '${r.value}')` };
      topK = n;
      continue;
    }
    // Any other dash-prefixed token is a flag typo, not the note path — name it
    // rather than misattributing it to a positional (mirrors cli.ts).
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

  return {
    kind: "ok",
    opts: { vaultRoot, stagingDir, topK, dryRun, source, notePath: positionals[0] },
  };
}

// Default vault-root/staging-dir are relative to $HOME — injected here (rather
// than read from process.env inline) so the default-resolution logic itself is
// testable without an env-var fixture.
export function resolveOpts(raw: RawOpts, homeDir: string): StageOpts & { notePath: string } {
  const vaultRoot = raw.vaultRoot ?? join(homeDir, "Documents", "vault");
  const stagingDir = raw.stagingDir ?? join(vaultRoot, "00 inbox", "card-staging");
  return {
    vaultRoot,
    stagingDir,
    topK: raw.topK,
    dryRun: raw.dryRun,
    source: raw.source,
    notePath: raw.notePath,
  };
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
  if (!opts.dryRun) {
    try {
      ensureKeys([CARD_DRAFT, CARD_JUDGE]);
    } catch (e) {
      if (e instanceof MissingKeyError) {
        console.error(`${e.message}\nSeed it in the Keychain or Doppler (claude-code/std).`);
        process.exit(1);
        return;
      }
      throw e;
    }
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
      source: opts.source,
    },
    { ask: askJson, fetchNeighbours, writeFile: writeStagingFile },
  );
  if (result.mode === "dry-run") {
    process.stdout.write(formatDryRunReport(result.entries) + "\n");
    return;
  }
  process.stdout.write(
    formatSummary(result.total, result.staged, result.flagCounts, result.corruptedNames) + "\n",
  );
}

if (import.meta.main) main();
