// distill-core — the orchestration core: sequences the canonical compress pipeline (distill) —
// extractGraph → locateGraph (hard span gate) → [TTY-gated typing review] → projectMarkdown,
// with the demoted fidelity/prose gates riding as a residue-only backstop over the projection —
// then dispatches the modes and writes the temp-file sink in main(). The focused concerns are
// carved out around it: the backstop gates into gates.ts, the CLI surface + path helpers into
// cli.ts, the interactive terminal halves into tty.ts. main() is invoked by the entrypoint.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import {
  type Block,
  type LinkInventory,
  detectLang,
  segment,
  slugSegment,
  wordCount,
} from "@/core/text.ts";
import {
  harvestExternalLinks,
  harvestProseListItems,
  harvestVaultEdges,
} from "@/distill/extract/harvest.ts";
import {
  type Route,
  type RoutedSection,
  compactSection,
  formatDryRun,
  partition,
  routeNote,
} from "@/distill/extract/route.ts";
import {
  parseDescription,
  parseFrontmatter,
  parseSuperseded,
  parseType,
} from "@/core/frontmatter.ts";
import { askJson, ensureKeys, isTransient, TruncationError } from "@skills/llm/llm.ts";
import { MissingKeyError } from "@skills/llm/keys.ts";
import { DISTILL_EXTRACT, DISTILL_FIDELITY } from "@/core/models.ts";
import { linkNoClobber } from "@/core/fs.ts";
import { tempMdPath } from "@/core/tmp.ts";
import { extractGraph, gradeBlocks } from "@/distill/prompt/prompts.ts";
import {
  formatNameLint,
  nameLintAgainstSource,
  type NameLintResult,
} from "@/core/writing/name-lint.ts";
import { locateGraph, payloadKey } from "@/distill/extract/locate-graph.ts";
import { projectMarkdown, type Projection } from "@/distill/graph/project.ts";
import { computeSource, type Unit } from "@/distill/graph/graph.ts";
import { locate } from "@/distill/extract/locate.ts";
import { type Residue, payloadResidueForProjection } from "@/distill/review/residue.ts";
import { runProse } from "@/distill/app/prose-mode.ts";
import { buildIntermediary } from "@/distill/review/triage.ts";
import { runApply, stampHash } from "@/distill/app/apply-mode.ts";
import { runFidelityBackstop, runProseGate } from "@/distill/review/gates.ts";
import { runTypingReview, runTtySession } from "@/distill/app/tty.ts";
import {
  type CliOpts,
  USAGE,
  parseArgs,
  refusePendingIntermediary,
  tmpPathFor,
} from "@/distill/app/cli.ts";
import { buildPassthroughEnvelope } from "@/distill/app/envelope.ts";

// ---- pipeline ----
// The Residue type and the deterministic loss-surface primitives (wikilinkResidue,
// payloadResidue, payloadResidueForProjection, proseResidue/anchored) live in residue.ts.
// Did distill rewrite the body, or pass it through unchanged? The producer knows this at each
// return site (nothing-to-distill and expand-guard pass through; the normal path compresses);
// the routed build reads it to tag the footer rather than re-deriving it by byte-comparison.
// main() also maps a top-level "passthrough" to exit 3 (exit 3 ⇔ prefer the source); a routed
// note stays "compressed" even with a verbatim head (see distillRouted, below).
type DistillStatus = "compressed" | "passthrough";
// Every compress path now projects the canonical seven-section graph, which carries its own
// `type/source/schema` frontmatter, so `out` is always self-provenanced; main() takes it verbatim
// (no source-front prepend). A passthrough return carries the unmodified source body instead.
type DistillResult = {
  out: string;
  footer: string;
  residue: Residue[];
  status: DistillStatus;
};
// The whole-note (and, via the routed head's recursive call, per-head-scoped) expand-guard's
// threshold. The guard is OFF by default: the canonical note is a STRUCTURED artifact
// (concepts + bullets + judgements + inferences + procedures + relations), so a faithful
// distillation of a short, dense note is legitimately ~its source length — comparing word
// counts vetoed good output. It survives only as an opt-in cap via --max-words: a positive
// value sets an absolute ceiling; 0 (or unset) means no guard, returning null.
export function expandGuardCap(_beforeWords: number, maxWords?: number): number | null {
  if (maxWords !== undefined && maxWords > 0) return maxWords;
  return null;
}

// Both ends must be a real terminal (command substitution and pipes must never see a
// prompt) before the typing review or the Phase-5 gate session take over the process.
function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

// buildFooter renders the success footer line — the one-line summary stderr carries beside the
// temp-file path on stdout. Pure; the nothing-to-distill and expansion guards in distill()
// emit their own footers, so this only renders a real (compressed-or-equal) run.
export function buildFooter(m: {
  entries: number;
  steps: number;
  verbatim: number;
  residue: number;
  gateSkipped: number;
  glossaryOnly: boolean;
  proseGateOffFactsDump: boolean;
  nameLint?: NameLintResult;
}): string {
  const stepsTag = m.steps ? ` · ${m.steps} steps` : "";
  // gate-skipped items are a subset of residue.length — flag them so a batch log
  // distinguishes "judge couldn't verify" from a genuine fidelity miss.
  const gateTag = m.gateSkipped ? ` · ${m.gateSkipped} gate-skipped` : "";
  const shapeTag = m.glossaryOnly ? "gloss" : "prose+gloss";
  // the prose gate would have run (!noGate && !glossaryOnly) but the facts-dump genre gate
  // skipped it — surface the skip so disabling a loss detector is never silent.
  const proseGateTag = m.proseGateOffFactsDump ? ` · prose-gate off (facts-dump)` : "";
  return `— distilled ${shapeTag} · ${m.entries} entries${stepsTag} · ${m.verbatim} verbatim · ${m.residue} residue${gateTag}${proseGateTag}${m.nameLint ? formatNameLint(m.nameLint) : ""}`;
}

// The deterministic, zero-LLM whole-note backstop: payload-coverage residue (irreversible
// loss the LLM fidelity gate never checks) plus name-lint, both keyed on (source, out).
// Runs even under --no-gate; shared by distill()'s homogeneous build and
// assembleRoutedNote()'s per-section-routed build (its one whole-note check).
function deterministicBackstop(
  source: string,
  out: string,
): { residue: Residue[]; nameLint: NameLintResult } {
  return {
    residue: payloadResidueForProjection(source, out),
    nameLint: nameLintAgainstSource(out, source),
  };
}

// Tick a slow stage's progress label with elapsed seconds instead of a frozen label, so a call
// stuck against the transport's 180s ceiling reads as "still working (Ns)" rather than a dead
// hang. TTY-gated through the caller's `progress` sink (undefined off a TTY → scripts and parent
// loops stay silent and no timer runs). The tick overwrites its own line via \r and closes with a
// newline on settle so the next stage or the footer starts clean.
async function withHeartbeat<T>(
  label: string,
  progress: ((line: string) => void) | undefined,
  call: () => Promise<T>,
): Promise<T> {
  if (!progress) return call();
  const t0 = Date.now();
  const tick = (): void =>
    void process.stderr.write(`\r${label}… (${Math.round((Date.now() - t0) / 1000)}s)`);
  tick();
  const timer = setInterval(tick, 5000);
  try {
    return await call();
  } finally {
    clearInterval(timer);
    process.stderr.write("\n");
  }
}

// The canonical compress core: extract native typed units → retain-grade the
// payload lane → locate spans (hard-gate). Returns the span-anchored graph (`result`), the
// pre-graph (`pre`, for the backstop's thesis + section counts), and the retain-graded
// `payloadBlocks`, or null when nothing distills (no unit of any type → passthrough). `bodyForSpans`
// is the text every unit/edge span indexes into: the whole source for both the homogeneous run and
// the routed head (so a routed head's spans index the reassembled source). Reused by
// distill() (default/--glossary/--reference) and distillRouted() (the re-authored head).
async function compressToGraph(
  blocks: Block[],
  bodyForSpans: string,
  path: string,
  frontDescription: string,
  lang: "en" | "ru",
  selfSlug: string,
  linkInventory: LinkInventory,
  opts: { progress?: (line: string) => void; ask?: typeof askJson },
): Promise<{
  pre: Awaited<ReturnType<typeof extractGraph>>;
  result: Projection;
  payloadBlocks: Block[];
} | null> {
  const pre = await withHeartbeat("extract", opts.progress, () =>
    extractGraph(blocks, frontDescription, lang, linkInventory, selfSlug, opts.ask),
  );
  if (
    pre.concepts.length === 0 &&
    pre.judgements.length === 0 &&
    pre.inferences.length === 0 &&
    pre.procedures.length === 0
  ) {
    return null;
  }
  // payload retain lane — the ONE deterministic selection surviving the settle-chain
  // collapse. statement = block.text (verbatim), so its locate can never fail. Units render in
  // extract-emission order (the ordering role dies).
  const grades = await withHeartbeat("grade", opts.progress, () =>
    gradeBlocks(
      pre.thesis,
      pre.concepts.map((c) => ({ term: c.id ?? "", def: c.statement })),
      blocks,
      opts.ask,
    ),
  );
  const payloadBlocks = blocks.filter((b) => grades.get(b.id) === "retain");
  // locate: pre-graph → span-anchored graph. A bad quote HARD-ABORTS here, before any
  // projection — the earliest possible surfacing.
  const result = locateGraph(pre, path, bodyForSpans, payloadBlocks);
  return { pre, result, payloadBlocks };
}

// orchestrator: thread the canonical stages (extract → locate → project → backstop). Routes a
// payload-dense note to distillRouted first; otherwise runs the homogeneous canonical pipeline.
async function distill(
  text: string,
  lang: "en" | "ru",
  frontDescription: string,
  opts: {
    noGate: boolean;
    glossaryOnly: boolean;
    isReference: boolean;
    factsDump: boolean;
    tau: number;
    maxWords?: number;
    // The source file path recorded in the canonical projection's `source:` frontmatter (read on
    // the default-compress path — the seven-section projection). Undefined for stdin.
    path?: string;
    progress?: (line: string) => void;
    // Injected model transport, threaded from main() to compressToGraph and the backstop
    // gates so the pipeline runs off a fake in tests; undefined → real fw everywhere.
    ask?: typeof askJson;
  },
  selfSlug = "",
): Promise<DistillResult> {
  // Per-section render-router. When a note carries any payload-dense section,
  // route: re-author the idea sections into ONE compact head graph, hold the payload sections
  // verbatim as `## Payload` units, and project the merged graph as one canonical note
  // (distillRouted). --glossary bypasses routing (it wants the flat structured extract).
  if (!opts.glossaryOnly) {
    const { title, sections } = partition(text, opts.tau);
    if (sections.some((u) => u.route === "preserve")) {
      return distillRouted(text, title, sections, lang, frontDescription, opts, selfSlug);
    }
  }
  const blocks = segment(text);
  const beforeWords = wordCount(text);

  // The note's own slug — the source endpoint of a note-level edge and the SELF
  // anchor the extractor classifies links against. Prefer the filename slug (what other
  // vault notes wikilink to); fall back to the H1 title slug when reading from stdin (no
  // filename). Computed before extract so prompt and emit use one consistent slug.
  const h1 = blocks.find((b) => /^#\s/.test(b.text))?.text.split("\n")[0] ?? "";
  const effectiveSelfSlug = selfSlug || slugSegment(h1.replace(/^#+\s*/, ""));

  // Every compress run — default, --glossary, --reference — is the canonical graph-native pipeline:
  // extract native typed units → locate (span hard-gate) → project. --glossary omits the synthesized
  // `## Abstract` head; --reference keeps it but suppresses `## Relations` (reference notes stay
  // link-free); every other section renders identically. The deterministic link
  // inventory (every vault edge — [[wikilink]] or scheme-less [text](path) — UNION every external
  // [text](url)) feeds the extractor as a MUST-COVER checklist.
  const linkInventory: LinkInventory = {
    wikilinks: harvestVaultEdges(text),
    external: harvestExternalLinks(text),
  };

  // 1. extract the typed idea-graph (native FINAL statements + per-unit quotes) and 2. locate the
  // spans against the source — a bad quote HARD-ABORTS in locate, BEFORE any projection.
  // Nothing to distill (no unit of any type) → passthrough.
  const core = await compressToGraph(
    blocks,
    text,
    opts.path ?? "",
    frontDescription,
    lang,
    effectiveSelfSlug,
    linkInventory,
    opts,
  );
  if (!core) {
    return {
      out: text,
      footer: `— nothing to distill · ${beforeWords} words`,
      residue: [],
      status: "passthrough",
    };
  }
  const { pre, result, payloadBlocks } = core;

  // 2b. span-typing review: the one place semantic taste re-enters
  // the otherwise-deterministic pipeline — the reviewer confirms each unit's type against its
  // resolved source slice and re-types where wrong, mutating result.units IN PLACE before projection
  // (projectMarkdown re-buckets purely on unit.type via byType, so setting the field is the whole
  // operation). TTY-gated exactly like the residue-triage session below: when EITHER stream is
  // non-TTY (piped, redirected, the test harness, agent callers) the review is skipped and the graph
  // keeps its extract-assigned types, so the default non-interactive pipeline stays
  // extract→locate→project and is byte-identical.
  if (isInteractive()) {
    await withHeartbeat("type", opts.progress, () => runTypingReview(result, text));
  }

  // 3. project the seven-section canonical markdown (carries its own frontmatter). --glossary drops
  // the `## Abstract` head (`Projection.abstract` is optional, so omitting it suppresses the one
  // unanchored block); --reference keeps `## Abstract` but suppresses `## Relations` via the
  // projector's relations opt.
  let out: string;
  if (opts.isReference) {
    out = projectMarkdown(result, { relations: false });
  } else {
    out = projectMarkdown(opts.glossaryOnly ? { ...result, abstract: undefined } : result);
  }

  // 4. demoted fidelity backstop over the projection (residue-only, no recovery).
  let residue: Residue[] = [];
  let gateSkipped = 0;
  if (!opts.noGate) {
    const bs = await withHeartbeat("gate", opts.progress, () =>
      runFidelityBackstop(pre.thesis, result, out, text, lang, opts.ask),
    );
    residue = bs.residue;
    gateSkipped = bs.gateSkipped;
  }
  const entriesCount = pre.concepts.length;
  const stepsCount = pre.procedures.reduce((n, p) => n + p.steps.length, 0);

  const afterWords = wordCount(out);
  // passthrough guard: a distillation that expands the note has failed its one job.
  // Ship the original body rather than the larger output. (the footer's +N% only
  // flagged this after the fact; this prevents it.) Customizable via --max-words: null
  // (--max-words 0) disables the guard entirely — a debugging escape hatch to inspect what
  // the model actually produced even when it grew, without risking a worse note shipping by
  // default (the flag must be passed explicitly every time; there is no sticky/silent bypass).
  const cap = expandGuardCap(beforeWords, opts.maxWords);
  if (cap !== null && afterWords > cap) {
    return {
      out: text,
      footer: `— distillation expanded ${beforeWords}→${afterWords} words; kept original`,
      residue: [],
      status: "passthrough",
    };
  }
  // prose-list-item gate: a glm matcher over a deterministic inventory of explicit
  // list-items under a heading — the must-cover prose class the spine is blind to. An LLM call, so
  // it rides --no-gate; skipped in --glossary (no prose body) and on facts/context dumps (wholesale
  // drop is licensed there, so the inventory would only flood the footer). The canonical projection
  // carries no exclusion set, so the matcher judges every source list-item against the projection
  // body (a broad backstop). Appends to residue only.
  if (!opts.noGate && !opts.glossaryOnly && !opts.factsDump) {
    const units = harvestProseListItems(text, []);
    residue = residue.concat(
      await withHeartbeat("prose-gate", opts.progress, () =>
        runProseGate(units, out, lang, opts.ask),
      ),
    );
  }

  // deterministic payload-coverage backstop: surface any source payload span the projection dropped
  // (payloadResidueForProjection; the wikilink lane is off — the canonical projection drops cross-note edges
  // by design, so a wikilink lane would false-flag every source wikilink). Free, so it runs even
  // under --no-gate — dropped payload is irreversible loss the fidelity backstop never checks.
  // deterministic, zero-LLM, never blocks — findings go to the footer only, never into residue.
  const backstop = deterministicBackstop(text, out);
  residue = residue.concat(backstop.residue);
  const nameLint = backstop.nameLint;
  const footer = buildFooter({
    entries: entriesCount,
    steps: stepsCount,
    verbatim: payloadBlocks.length,
    residue: residue.length,
    gateSkipped,
    glossaryOnly: opts.glossaryOnly,
    // the prose gate is in scope (!noGate && !glossaryOnly) but the facts-dump genre gate
    // skipped it above — flag the disabled loss detector instead of dropping it silently.
    proseGateOffFactsDump: !opts.noGate && !opts.glossaryOnly && opts.factsDump,
    nameLint,
  });
  return { out, footer, residue, status: "compressed" };
}

// The heterogeneous (per-section-routed) build. Re-author the
// idea sections as ONE head graph — a canonical extract→locate of their concatenation, whose spans
// index the WHOLE source — then hold the payload sections verbatim as `## Payload` units and project
// the merged graph as one canonical note. The whole-note expand guard is intentionally NOT applied:
// the preserve sections are held verbatim and cannot shrink, so a whole-note size compare would
// no-op the route on its target class. The head's own LLM fidelity gate is dropped (the deterministic
// payload-coverage backstop, re-run at whole-note scope in assembleRoutedNote, is its residue floor).
async function distillRouted(
  text: string,
  title: string,
  sections: RoutedSection[],
  lang: "en" | "ru",
  frontDescription: string,
  opts: Parameters<typeof distill>[3],
  selfSlug: string,
): Promise<DistillResult> {
  const reauthorSections = sections.filter((u) => u.route === "re-author");
  const reauthorText = reauthorSections
    .map((u) => u.text)
    .join("\n\n")
    .trim();
  const effectiveSelfSlug = selfSlug || slugSegment(title.replace(/^#+\s*/, ""));
  const linkInventory: LinkInventory = {
    wikilinks: harvestVaultEdges(text),
    external: harvestExternalLinks(text),
  };
  // The re-authored head becomes a span-anchored graph via extract→locate of reauthorText, with
  // spans located against the WHOLE source. null = the head distilled to nothing
  // (its prose is then held verbatim as payload by assembleRoutedNote).
  const core = reauthorText
    ? await compressToGraph(
        segment(reauthorText),
        text,
        opts.path ?? "",
        frontDescription,
        lang,
        effectiveSelfSlug,
        linkInventory,
        opts,
      )
    : null;
  // The routed note is itself a compression (prose re-authored, payload held verbatim); its own
  // status is "compressed".
  return {
    ...assembleRoutedNote({
      source: text,
      path: opts.path ?? "",
      title,
      head: core?.result ?? null,
      headVerbatim: reauthorText !== "" && core === null,
      sections,
    }),
    status: "compressed",
  };
}

// Pure seam of the per-section routed build (the no-LLM tail of distillRouted):
// merge the re-authored head graph with the preserve sections (each held verbatim as a `## Payload`
// unit whose span locates the section text in the WHOLE source), project the merged graph as one
// canonical note, re-run the deterministic payload-coverage backstop ONCE at whole-note scope, and
// build the footer. No model and no I/O, so distillRouted's wiring is unit-testable in pure.test.ts.
//
// Payload units are appended in source order (walking `sections`); when the head is null (verbatim
// — extract found nothing to distill), the re-author sections are ALSO held verbatim as payload, so
// no prose is lost. The head's concept/judgement/inference/procedure units and edges ride straight
// into the merged graph; projectMarkdown renders them under their canonical sections, so the note is
// a standard seven-section projection (a deliberate change from the legacy head-first interleave).
export function assembleRoutedNote(a: {
  source: string;
  path: string;
  title: string;
  head: Projection | null;
  headVerbatim: boolean;
  sections: { route: Route; text: string }[];
}): { out: string; footer: string; residue: Residue[] } {
  const units: Unit[] = a.head ? [...a.head.units] : [];
  const edges = a.head?.edges ?? [];
  // Every preserve section — plus, when the head is verbatim, every re-author section — is held
  // byte-verbatim as a `## Payload` unit, spanning the whole source (compactSection v1 = identity).
  let payloadN = units.filter((u) => u.type === "payload").length;
  for (const u of a.sections) {
    const holdVerbatim = u.route === "preserve" || (!a.head && u.route === "re-author");
    if (!holdVerbatim) continue;
    const slice = compactSection(u.text);
    payloadN++;
    units.push({
      id: payloadKey(slice, payloadN),
      type: "payload",
      statement: slice,
      span: locate(a.source, slice),
    });
  }
  const source = a.head?.source ?? computeSource(a.path, a.source);
  const title = a.title.replace(/^#+\s*/, "").trim() || a.head?.title;
  const out = projectMarkdown({ source, units, edges, title, abstract: a.head?.abstract });
  // deterministic, zero-LLM, never blocks — assembleRoutedNote owns the one whole-note check.
  const { residue, nameLint } = deterministicBackstop(a.source, out);
  const reCount = a.sections.filter((u) => u.route === "re-author").length;
  const preserveCount = a.sections.length - reCount;
  const footer =
    `— per-section route: ${reCount} re-author / ${preserveCount} preserve` +
    (a.headVerbatim ? " · head kept verbatim (prose not compressed)" : "") +
    (residue.length ? ` · ${residue.length} residue` : "") +
    formatNameLint(nameLint);
  return { out, footer, residue };
}

// Atomic no-clobber write: write a sibling .partial, then linkNoClobber it onto the
// final name — link fails EEXIST instead of overwriting, so a racing emit that passed the
// preflight minutes ago (LLM run) loses LOUD with the same exit-4 refusal, and a crash mid-write
// never leaves a truncated intermediary visible at the .tmp.md path. {exists:true} maps to the
// exit-4 refusal (never returns); any other link error cleans the .partial and rethrows inside
// the helper. On success the helper leaves the .partial in place for this final unlink.
function writeIntermediaryAtomically(tmpPath: string, intermediary: string): void {
  const partial = `${tmpPath}.partial`;
  writeFileSync(partial, intermediary);
  const link = linkNoClobber(partial, tmpPath);
  if (!link.ok) refusePendingIntermediary(tmpPath);
  unlinkSync(partial);
}

// Phase 3/5 success: write the interactive review intermediary sibling to `destPath` (never the
// source — the input file is never modified), stamped with dest= (the destination basename) and
// src= (a hash of destPath's current bytes, or "new" when it does not yet exist — the creation
// case). `out` is the canonical projection, taken verbatim: it already carries its own
// type/source/schema YAML, so prepending the source front would emit two YAML blocks;
// buildIntermediary stamps epistemic_status: in-review into that single block. At a real terminal
// (both ends) the gate-aware session takes over the SAME process and exits its code; otherwise
// (the common agent-caller case) this returns and main() falls through to exit 0.
async function emitReviewIntermediary(
  destPath: string,
  out: string,
  residue: Residue[],
  footer2: string,
  resolved: "en" | "ru",
): Promise<void> {
  const tmpPath = tmpPathFor(destPath);
  const src = existsSync(destPath) ? stampHash(readFileSync(destPath)) : "new";
  const intermediary = buildIntermediary(out, residue, {
    dest: basename(destPath),
    src,
  });
  writeIntermediaryAtomically(tmpPath, intermediary);
  const reviewSuffix =
    residue.length > 0 ? ` · review: ${residue.length} items + gate` : " · review: gate";
  process.stdout.write(`${tmpPath}\n`);
  process.stderr.write(`${footer2}${reviewSuffix}\n`);
  if (isInteractive()) {
    const reviewLabel = residue.length > 0 ? `${residue.length} items + gate` : "gate";
    process.stderr.write(`review: ${tmpPath} — ${reviewLabel}\n`);
    process.stderr.write(`apply later with: distill-text apply ${tmpPath}\n`);
    // Ctrl-C loses nothing (the intermediary is already on disk) — exit 0 rather than the
    // default SIGINT death, matching decline/EOF's exit code.
    process.once("SIGINT", () => process.exit(0));
    process.exit(await runTtySession(tmpPath, destPath, resolved));
  }
}

// The compress-mode catch: a non-transient throw is a real bug — surface it (a stage catch has
// already logged it on its way up; anything thrown outside a stage prints its own stack on
// propagation) instead of shipping the original as a silent passthrough. A truncation in a
// no-catch core stage (extractGraph, gradeBlocks) is not a transient flake and not a code bug: it
// skips THIS note with a clear actionable footer (raise the stage's cap), never a raw stack crash
// or a "transient" label. A transient flake failsafes to the passthrough. Both skip paths exit 3
// (valid but unmodified original); a real bug rethrows.
function handleCompressError(
  e: unknown,
  input: string,
  emit: (body: string, footer: string) => void,
): never {
  if (e instanceof TruncationError) {
    emit(input, `— distill skipped: output TRUNCATED — ${e.message}`);
    process.exit(3);
  }
  if (!isTransient(e)) throw e;
  // transient failsafe: temp file holds the original (passthrough); path still printed
  emit(input, `— distill skipped (error): ${String(e).slice(0, 160)}`);
  process.exit(3);
}

// resolveDest resolves the compress/prose write-back destination and runs the exit-4 preflight in
// one place. `fromStdin` is stdin (no path, or the '-' convention); `dest` is --out when given,
// else the input path (stdin with no --out has none yet — a runtime refusal in runCompress once the
// run reaches the emit, so the no-body/empty-input exit-3 paths stay byte-identical), resolved
// absolute so stdout line 1 stays openable from any later cwd. The preflight refuses BEFORE the
// API-key gate and any LLM call when a prior review intermediary is still pending at the sibling
// .tmp.md path (nothing written, no stdout); an --out whose directory is absent is a usage error
// (exit 2) caught here too, before the whole LLM budget is burned on a doomed final write.
function resolveDest(
  mode: "compress" | "prose",
  opts: CliOpts,
): { fromStdin: boolean; dest: string | undefined; stdinHint: () => void } {
  const { dryRun, path: inputPath, out: outOpt } = opts;
  const fromStdin = inputPath === undefined || inputPath === "-";
  const destRel = outOpt ?? (fromStdin ? undefined : inputPath);
  const dest = destRel === undefined ? undefined : resolve(destRel);
  // A bare `distill-text` at a terminal would hang silently on fd 0; say so.
  const stdinHint = (): void => {
    if (fromStdin && process.stdin.isTTY)
      console.error("distill: reading stdin — pass a file or pipe input (ctrl-d ends input)");
  };
  if (mode === "compress" && !dryRun && dest !== undefined) {
    if (outOpt !== undefined && !existsSync(dirname(dest))) {
      console.error(`distill: --out directory does not exist: ${dirname(dest)}`);
      process.exit(2);
    }
    const tmpPath = tmpPathFor(dest);
    if (existsSync(tmpPath)) refusePendingIntermediary(tmpPath);
  }
  return { fromStdin, dest, stdinHint };
}

// runDryRun: the deterministic front half only — segment → per-section payload density → route.
// Prints the report, writing nothing, making no LLM call, needing no API key. Runs on the note
// body (frontmatter stripped).
function runDryRun(o: {
  fromStdin: boolean;
  inputPath?: string;
  stdinHint: () => void;
  tau: number;
}): void {
  o.stdinHint();
  const input = readFileSync(o.fromStdin ? 0 : (o.inputPath as string), "utf8");
  const { body } = parseFrontmatter(input);
  const label = o.fromStdin ? "(stdin)" : (o.inputPath as string);
  process.stdout.write(formatDryRun(label, routeNote(body, o.tau)) + "\n");
}

// runCompress: the default verb. Strip leading frontmatter (it passes through verbatim; the
// pipeline + language detection operate on the body only), run distill(), and write either the
// interactive review intermediary or a passthrough envelope beside `dest`. Sets its own exit code
// (3 passthrough/no-body, 2 stdin-without---out) or falls through to the emit's exit 0.
async function runCompress(o: {
  input: string;
  opts: CliOpts;
  dest: string | undefined;
  fromStdin: boolean;
  progress?: (line: string) => void;
  ask: typeof askJson;
  emit: (body: string, footer: string) => void;
}): Promise<void> {
  const { input, opts, dest, fromStdin, progress, ask, emit } = o;
  const { lang, noGate, glossaryOnly, tau, maxWords, path: inputPath } = opts;
  // A block whose YAML failed to parse is flagged (not demoted to body) so it is surfaced in the
  // footer rather than silently reworded as prose.
  const { front, body, error: fmError } = parseFrontmatter(input);
  if (!body.trim()) {
    emit(input, "— no body to distill");
    process.exit(3);
  }
  // stdin without --out: a real body means this run WILL reach the emit, and stdin has no
  // destination to name the sibling .tmp.md after. Fires here (after the no-body check, not in
  // parseArgs) so the empty/no-body stdin exit-3 paths stay byte-identical (stages.test.ts:656's
  // recipe test pins that).
  if (dest === undefined) {
    console.error("distill: stdin input requires --out to name the destination");
    process.exit(2);
  }
  const resolved = lang === "auto" ? detectLang(body) : lang;
  const frontDescription = parseDescription(front);
  // A source note whose own frontmatter is `type: reference` renders without `## Relations`
  // (a reference body stays link-free) — automatic from the source frontmatter, not a flag.
  // distill emits no references today, so this only future-proofs a reference-distill path.
  const isReference = parseType(front) === "reference";
  // genre gate: a superseded note or a "Context document" is licensed to drop wholesale, so the
  // prose-list-item gate would only flood the footer — skip it there (the deterministic spine
  // still runs). Computed here, where the raw frontmatter is in scope.
  const factsDump = parseSuperseded(front) || /context document/i.test(frontDescription);
  // the note's canonical self-slug is its filename slug (what other vault notes wikilink to);
  // empty when reading from stdin (including the '-' convention), where distill() falls back to the H1.
  const selfSlug =
    !fromStdin && inputPath ? slugSegment(basename(inputPath).replace(/\.md$/, "")) : "";
  try {
    const { out, footer, residue, status } = await distill(
      body,
      resolved,
      frontDescription,
      {
        noGate,
        glossaryOnly,
        isReference,
        factsDump,
        tau,
        maxWords,
        path: inputPath,
        progress,
        ask,
      },
      selfSlug,
    );
    const footer2 = fmError
      ? `${footer} · frontmatter not parsed (kept verbatim): ${fmError.slice(0, 80)}`
      : footer;
    // exit 3: covers nothing-to-distill and the expand-guard revert — the output is the
    // unmodified original. A routed note is always "compressed" (its preserves were compacted),
    // so head-kept-verbatim exits 0 with the footer tag as the signal.
    if (status === "passthrough") {
      emit(buildPassthroughEnvelope(front, out, residue), footer2);
      process.exit(3);
    }
    // Phase 3/5 success: hand the canonical projection to the interactive review intermediary,
    // atomically written beside `dest`. narrowed above: stdin without --out already exited.
    const destPath = dest as string;
    await emitReviewIntermediary(destPath, out, residue, footer2, resolved);
  } catch (e) {
    handleCompressError(e, input, emit);
  }
}

// main is the CLI entrypoint (invoked by distill.ts when the module is run as a binary): it parses
// argv, acts on --help and misuse before the API-key gate or any network call, then dispatches the
// verb — `apply` resolves a pending review intermediary offline, `prose` reconstructs prose from an
// already-distilled note, and the default `compress` path runs distill() and writes either the
// interactive review intermediary or a passthrough envelope beside the destination. It returns no
// value; it sets the process exit code (0 success/passthrough-prose, 1 missing key, 2 misuse,
// 3 passthrough, 4 pending intermediary).
// `ask` is the model transport, injected so emit.test.ts / session.test.ts drive the
// whole five-stage pipeline off a fake without a process-global module mock (it threads
// down through distill → compressToGraph/extractGraph/gradeBlocks and the backstop gates).
// The CLI entrypoint calls main() with no argument → real fw transport.
export async function main(ask: typeof askJson = askJson) {
  // The whole CLI surface resolves in parseArgs (help/misuse/ok). Act on help and misuse
  // here, before the API-key gate or any network call: help prints usage to stdout and exits
  // 0; a parse error prints to stderr and exits 2 (distinct from the runtime exit 1/0 paths).
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.kind === "help") {
    process.stdout.write(USAGE);
    return;
  }
  if (parsed.kind === "error") {
    console.error(`distill: ${parsed.message}\nTry 'distill-text --help' for usage.`);
    process.exit(2);
    return; // process.exit ends the run; the explicit return also narrows `parsed` to "ok" below
  }
  const { mode, opts } = parsed;
  // apply is a structurally distinct verb: it consumes a previously-emitted intermediary, checks
  // the key LAZILY (only a checked recover DEF needs an LLM), and does its own path-on-stdout +
  // footer/refusal-on-stderr. Dispatched BEFORE the compress-mode exit-4 preflight and the API-key
  // gate below, so a keyless reject-all triage applies offline. parseArgs guarantees opts.path is
  // present in this mode.
  if (mode === "apply") {
    process.exit(await runApply(opts.path as string, { lang: opts.lang }));
  }
  const { fromStdin, dest, stdinHint } = resolveDest(mode, opts);
  // --dry-run: the deterministic front half only — prints the report and returns, writing nothing,
  // making no LLM call, needing no API key.
  if (opts.dryRun) {
    runDryRun({ fromStdin, inputPath: opts.path, stdinHint, tau: opts.tau });
    return;
  }
  // Resolve the keys distill actually uses — EXTRACT (OpenAI) + FIDELITY (qwencloud) — up front,
  // so a missing key exits 1 here rather than mid-pipeline. keys.ts resolves each from env →
  // Keychain → Doppler (claude-code/std).
  try {
    ensureKeys([DISTILL_EXTRACT, DISTILL_FIDELITY]);
  } catch (e) {
    if (e instanceof MissingKeyError) {
      console.error(`${e.message}\nSeed it in the Keychain or Doppler (claude-code/std).`);
      process.exit(1);
    }
    throw e;
  }
  stdinHint();
  const input = readFileSync(fromStdin ? 0 : (opts.path as string), "utf8");
  if (!input.trim()) {
    console.error("distill skipped: empty input");
    process.exit(3);
  }
  // Lazy: mktemp CREATES the file, and the Phase-3 success path never uses it —
  // an eager call would orphan one empty temp file per successful distill. Only
  // the passthrough/error/no-body/prose paths (the `emit` callers) pay for it.
  let mktempPath: string | undefined;
  const emit = (body: string, footer: string): void => {
    const path = (mktempPath ??= tempMdPath("distill-"));
    writeFileSync(path, body);
    process.stdout.write(`${path}\n`);
    process.stderr.write(`${footer}\n`);
  };
  // A full run is tens of seconds of LLM calls; tick per stage, TTY-gated so
  // scripts and parent loops never see it.
  const progress = process.stderr.isTTY
    ? (line: string): void => void process.stderr.write(`${line}\n`)
    : undefined;
  if (mode === "prose") {
    // runProse returns the exit code: 0 rendered, 3 skipped (output = the
    // unmodified input — the same code compress passthrough uses).
    process.exit(await runProse(input, { lang: opts.lang, noRevise: opts.noRevise }, emit));
  }
  await runCompress({ input, opts, dest, fromStdin, progress, ask, emit });
}
