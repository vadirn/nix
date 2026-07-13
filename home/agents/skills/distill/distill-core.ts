// distill-core — the orchestration core: sequences the canonical compress pipeline (distill) —
// extractGraph → locateGraph (hard span gate) → [TTY-gated typing review] → projectMarkdown,
// with the demoted fidelity/prose gates riding as a residue-only backstop over the projection —
// then dispatches the modes and writes the temp-file sink in main(). The focused concerns are
// carved out around it: the backstop gates into gates.ts, the CLI surface + path helpers into
// cli.ts, the interactive terminal halves into tty.ts. main() is invoked by the entrypoint.
import { existsSync, linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  type Block,
  type LinkInventory,
  type PayloadSpan,
  type Route,
  type RoutedSection,
  compactSection,
  detectLang,
  formatDryRun,
  harvestBlockquotes,
  harvestCitations,
  harvestExternalLinks,
  harvestFences,
  harvestImages,
  harvestMath,
  harvestNumbers,
  harvestProseListItems,
  harvestTableRows,
  harvestVaultEdges,
  normalizeForContainment,
  partition,
  routeNote,
  segment,
  slugSegment,
  wordCount,
} from "./text.ts";
import {
  ensureEpistemicStatus,
  parseDescription,
  parseFrontmatter,
  parseSuperseded,
  parseType,
} from "./frontmatter.ts";
import { askJson, EXTRACT, isTransient, rethrowIfBug, TruncationError } from "./fw.ts";
import { extractGraph, gradeBlocks } from "./prompts.ts";
import { formatNameLint, nameLintAgainstSource, type NameLintResult } from "./writing/name-lint.ts";
import { locateGraph, payloadKey } from "./locate-graph.ts";
import { projectMarkdown, type Projection } from "./project.ts";
import { computeSource, type Unit } from "./graph.ts";
import { locate } from "./locate.ts";
import { type Residue, edgePayloadResidue } from "./residue.ts";
import { runProse } from "./prose-mode.ts";
import { buildIntermediary } from "./triage.ts";
import { runApply, stampHash } from "./apply-mode.ts";
import { runFidelityBackstop, runProseGate } from "./gates.ts";
import { runTypingReview, runTtySession } from "./tty.ts";
import { USAGE, parseArgs, refusePendingIntermediary, tempMdPath, tmpPathFor } from "./cli.ts";

// Escape the three characters an XML attribute value cannot carry raw. The passthrough envelope
// (main(), the exit-3 legacy sink) stamps residue labels/reasons into `<entry term=… reason=…>`.
const escAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

// ---- pipeline ----
// The Residue type and the deterministic loss-surface primitives (wikilinkResidue,
// payloadResidue, edgePayloadResidue, proseResidue/anchored) live in residue.ts.
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
// threshold, customizable via --max-words: unset defaults to the note's own input size
// (today's behavior — any growth at all reverts to the original); a positive value sets an
// absolute ceiling instead; 0 disables the guard entirely, returning null (a debugging escape
// hatch to inspect what the model actually produced even when it grew).
export function expandGuardCap(beforeWords: number, maxWords?: number): number | null {
  if (maxWords === 0) return null;
  if (maxWords !== undefined && maxWords > 0) return maxWords;
  return beforeWords;
}

// build the success footer line — the one-line summary stderr carries beside the
// temp-file path on stdout. Pure; the nothing-to-distill and expansion guards in distill()
// emit their own footers, so this only renders a real (compressed-or-equal) run.
export function buildFooter(m: {
  beforeWords: number;
  afterWords: number;
  entries: number;
  steps: number;
  verbatim: number;
  residue: number;
  gateSkipped: number;
  glossaryOnly: boolean;
  proseGateOffFactsDump: boolean;
  nameLint?: NameLintResult;
}): string {
  const pct = m.beforeWords
    ? Math.round((100 * (m.beforeWords - m.afterWords)) / m.beforeWords)
    : 0;
  const sizeTag = `${pct > 0 ? "-" : pct < 0 ? "+" : "±"}${Math.abs(pct)}%`; // expansion is guarded in distill(), so this is -N% or ±0%
  const stepsTag = m.steps ? ` · ${m.steps} steps` : "";
  // gate-skipped items are a subset of residue.length — flag them so a batch log
  // distinguishes "judge couldn't verify" from a genuine fidelity miss.
  const gateTag = m.gateSkipped ? ` · ${m.gateSkipped} gate-skipped` : "";
  const shapeTag = m.glossaryOnly ? "gloss" : "prose+gloss";
  // the prose gate would have run (!noGate && !glossaryOnly) but the facts-dump genre gate
  // skipped it — surface the skip so disabling a loss detector is never silent.
  const proseGateTag = m.proseGateOffFactsDump ? ` · prose-gate off (facts-dump)` : "";
  return `— distilled ${shapeTag} · ${m.beforeWords}→${m.afterWords} words (${sizeTag}) · ${m.entries} entries${stepsTag} · ${m.verbatim} verbatim · ${m.residue} residue${gateTag}${proseGateTag}${m.nameLint ? formatNameLint(m.nameLint) : ""}`;
}

// The canonical compress core (blueprint §0): extract native typed units → retain-grade the
// payload lane → locate spans (hard-gate). Returns the span-anchored graph (`result`), the
// pre-graph (`pre`, for the backstop's thesis + section counts), and the retain-graded
// `payloadBlocks`, or null when nothing distills (no unit of any type → passthrough). `bodyForSpans`
// is the text every unit/edge span indexes into: the whole source for both the homogeneous run and
// the routed head (so a routed head's spans index the reassembled source, blueprint §6.3). Reused by
// distill() (default/--glossary/--reference) and distillRouted() (the re-authored head).
async function compressToGraph(
  blocks: Block[],
  bodyForSpans: string,
  path: string,
  frontDescription: string,
  lang: "en" | "ru",
  selfSlug: string,
  linkInventory: LinkInventory,
  opts: { progress?: (line: string) => void },
): Promise<{
  pre: Awaited<ReturnType<typeof extractGraph>>;
  result: Projection;
  payloadBlocks: Block[];
} | null> {
  opts.progress?.("extract…");
  const pre = await extractGraph(blocks, frontDescription, lang, linkInventory, selfSlug);
  if (
    pre.concepts.length === 0 &&
    pre.judgements.length === 0 &&
    pre.inferences.length === 0 &&
    pre.procedures.length === 0
  ) {
    return null;
  }
  // payload retain lane (blueprint §1.1) — the ONE deterministic selection surviving the settle-chain
  // collapse. statement = block.text (verbatim), so its locate can never fail. Units render in
  // extract-emission order (the ordering role dies).
  opts.progress?.("grade…");
  const grades = await gradeBlocks(
    pre.thesis,
    pre.concepts.map((c) => ({ term: c.id ?? "", def: c.statement })),
    blocks,
  );
  const payloadBlocks = blocks.filter((b) => grades.get(b.id) === "retain");
  // locate: pre-graph → span-anchored graph. A bad quote HARD-ABORTS here (spec §2), before any
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
  },
  selfSlug = "",
): Promise<DistillResult> {
  // Per-section render-router (D12/D16, Backlog 10). When a note carries any payload-dense section,
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
  const blockById = new Map(blocks.map((b) => [b.id, b]));
  const beforeWords = wordCount(text);

  // The note's own slug — the source endpoint of a note-level edge (D38) and the SELF
  // anchor the extractor classifies links against. Prefer the filename slug (what other
  // vault notes wikilink to); fall back to the H1 title slug when reading from stdin (no
  // filename). Computed before extract so prompt and emit use one consistent slug.
  const h1 = blocks.find((b) => /^#\s/.test(b.text))?.text.split("\n")[0] ?? "";
  const effectiveSelfSlug = selfSlug || slugSegment(h1.replace(/^#+\s*/, ""));

  // Every compress run — default, --glossary, --reference — is the canonical graph-native pipeline:
  // extract native typed units → locate (span hard-gate) → project. --glossary omits the synthesized
  // `## Abstract` head (§6.1); --reference keeps it but suppresses `## Relations` (§6.2, D30 —
  // reference notes stay link-free); every other section renders identically. The deterministic link
  // inventory (every vault edge — [[wikilink]] or scheme-less [text](path) — UNION every external
  // [text](url)) feeds the extractor as a MUST-COVER checklist.
  const linkInventory: LinkInventory = {
    wikilinks: harvestVaultEdges(text),
    external: harvestExternalLinks(text),
  };

  // 1. extract the typed idea-graph (native FINAL statements + per-unit quotes) and 2. locate the
  // spans against the source — a bad quote HARD-ABORTS in locate, BEFORE any projection (spec §2).
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

  // 2b. span-typing review (spec §4 step 3; blueprint §11): the one place semantic taste re-enters
  // the otherwise-deterministic pipeline — the reviewer confirms each unit's type against its
  // resolved source slice and re-types where wrong, mutating result.units IN PLACE before projection
  // (projectMarkdown re-buckets purely on unit.type via byType, so setting the field is the whole
  // operation). TTY-gated exactly like the residue-triage session below: when EITHER stream is
  // non-TTY (piped, redirected, the test harness, agent callers) the review is skipped and the graph
  // keeps its extract-assigned types, so the default non-interactive pipeline stays
  // extract→locate→project and is byte-identical.
  if (process.stdin.isTTY && process.stdout.isTTY) {
    opts.progress?.("type…");
    await runTypingReview(result, text);
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

  // 4. demoted fidelity backstop over the projection (residue-only, no recovery; blueprint §4.2).
  let residue: Residue[] = [];
  let gateSkipped = 0;
  if (!opts.noGate) {
    opts.progress?.("gate…");
    const bs = await runFidelityBackstop(pre.thesis, result, out, text, lang);
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
  // prose-list-item gate (D46): a glm matcher over a deterministic inventory of explicit
  // list-items under a heading — the must-cover prose class the spine is blind to. An LLM call, so
  // it rides --no-gate; skipped in --glossary (no prose body) and on facts/context dumps (wholesale
  // drop is licensed there, so the inventory would only flood the footer). The canonical projection
  // carries no exclusion set, so the matcher judges every source list-item against the projection
  // body (a broad backstop). Appends to residue only.
  if (!opts.noGate && !opts.glossaryOnly && !opts.factsDump) {
    const units = harvestProseListItems(text, []);
    opts.progress?.("prose-gate…");
    residue = residue.concat(await runProseGate(units, out, lang));
  }

  // deterministic payload-coverage backstop: surface any source payload span the projection dropped
  // (edgePayloadResidue; the wikilink lane is off — the canonical projection drops cross-note edges
  // by design, so a wikilink lane would false-flag every source wikilink). Free, so it runs even
  // under --no-gate — dropped payload is irreversible loss the fidelity backstop never checks.
  residue = residue.concat(edgePayloadResidue(text, out));
  // deterministic, zero-LLM, never blocks — findings go to the footer only, never into residue.
  const nameLint = nameLintAgainstSource(out, text);
  const footer = buildFooter({
    beforeWords,
    afterWords,
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

// The heterogeneous (per-section-routed) build (D12/D16, Backlog 10; blueprint §6.3). Re-author the
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
  // spans located against the WHOLE source (blueprint §6.3). null = the head distilled to nothing
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

// Pure seam of the per-section routed build (the no-LLM tail of distillRouted; blueprint §6.3):
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
  const beforeWords = wordCount(a.source);
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
  const afterWords = wordCount(out);
  const residue = edgePayloadResidue(a.source, out);
  const reCount = a.sections.filter((u) => u.route === "re-author").length;
  const preserveCount = a.sections.length - reCount;
  // deterministic, zero-LLM, never blocks — assembleRoutedNote owns the one whole-note check.
  const nameLint = nameLintAgainstSource(out, a.source);
  const footer =
    `— per-section route: ${reCount} re-author / ${preserveCount} preserve` +
    ` · ${beforeWords}→${afterWords} words` +
    (a.headVerbatim ? " · head kept verbatim (prose not compressed)" : "") +
    (residue.length ? ` · ${residue.length} residue` : "") +
    formatNameLint(nameLint);
  return { out, footer, residue };
}

export async function main() {
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
  const { mode } = parsed;
  const {
    lang,
    noRevise,
    noGate,
    glossaryOnly,
    dryRun,
    tau,
    maxWords,
    path: inputPath,
    out: outOpt,
  } = parsed.opts;
  // apply is a structurally distinct verb: it consumes a previously-emitted
  // intermediary, checks the key LAZILY (only a checked recover DEF needs an LLM), and
  // does its own path-on-stdout + footer/refusal-on-stderr. Dispatched BEFORE the compress-mode
  // exit-4 preflight and the API-key gate below, so a keyless reject-all triage applies
  // offline. parseArgs guarantees inputPath is present in this mode.
  if (mode === "apply") {
    process.exit(await runApply(inputPath as string, { lang }));
  }
  const fromStdin = inputPath === undefined || inputPath === "-";
  // The compress-mode write-back destination: --out when given, else the input path
  // (stdin with no --out has none yet — that is a runtime refusal below, once the
  // run actually reaches the emit, so the no-body/empty-input exit-3 paths stay
  // byte-identical). Both the exit-4 preflight and the success emit key off this.
  // Resolved to absolute so stdout line 1 stays openable from any later cwd (the
  // mktemp contract was always absolute; the plan-§4 transcript shows an absolute
  // line 1 for a relative invocation) — agent callers re-open $path after a cwd reset.
  const destRel = outOpt ?? (fromStdin ? undefined : inputPath);
  const dest = destRel === undefined ? undefined : resolve(destRel);
  // A bare `distill-text` at a terminal would hang silently on fd 0; say so.
  const stdinHint = (): void => {
    if (fromStdin && process.stdin.isTTY)
      console.error("distill: reading stdin — pass a file or pipe input (ctrl-d ends input)");
  };
  // Phase 3 preflight: refuse BEFORE the API-key gate and before any LLM call when a
  // prior review intermediary is still pending at the sibling .tmp.md path — nothing
  // written, no stdout, so a stuck run never masquerades as fresh progress. An --out
  // whose directory is absent is a usage error caught here too: the destination file
  // may be new (creation case) but its directory must exist, or the run would burn
  // the whole LLM budget and die on the final write.
  if (mode === "compress" && !dryRun && dest !== undefined) {
    if (outOpt !== undefined && !existsSync(dirname(dest))) {
      console.error(`distill: --out directory does not exist: ${dirname(dest)}`);
      process.exit(2);
      return;
    }
    const tmpPath = tmpPathFor(dest);
    if (existsSync(tmpPath)) refusePendingIntermediary(tmpPath);
  }
  // --dry-run (Backlog 9): the deterministic front half only — segment → per-section
  // payload density → route. Prints the report and returns, writing nothing, making no
  // LLM call, needing no API key. Runs on the note body (frontmatter stripped).
  if (dryRun) {
    stdinHint();
    const input = readFileSync(fromStdin ? 0 : (inputPath as string), "utf8");
    const { body } = parseFrontmatter(input);
    const label = fromStdin ? "(stdin)" : (inputPath as string);
    process.stdout.write(formatDryRun(label, routeNote(body, tau)) + "\n");
    return;
  }
  if (!process.env.FIREWORKS_API_KEY) {
    console.error(
      "FIREWORKS_API_KEY not set (run under: doppler run --project claude-code --config std --)",
    );
    process.exit(1);
  }
  stdinHint();
  const input = readFileSync(fromStdin ? 0 : (inputPath as string), "utf8");
  if (!input.trim()) {
    console.error("distill skipped: empty input");
    process.exit(3);
  }
  // Lazy: mktemp CREATES the file, and the Phase-3 success path never uses it —
  // an eager call would orphan one empty temp file per successful distill. Only
  // the passthrough/error/no-body/prose paths (the `emit` callers) pay for it.
  let mktempPath: string | undefined;
  const emit = (body: string, footer: string): void => {
    const path = (mktempPath ??= tempMdPath());
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
    process.exit(await runProse(input, { lang, noRevise }, emit));
  }
  // compress mode: strip leading frontmatter (it passes through verbatim; the
  // pipeline + language detection operate on the body only). A block whose YAML
  // failed to parse is flagged (not demoted to body) so it is surfaced in the
  // footer rather than silently reworded as prose.
  const { front, body, error: fmError } = parseFrontmatter(input);
  if (!body.trim()) {
    emit(input, "— no body to distill");
    process.exit(3);
  }
  // stdin without --out: a real body means this run WILL reach the emit, and stdin
  // has no destination to name the sibling .tmp.md after. Fires here (after the
  // no-body check, not in parseArgs) so the empty/no-body stdin exit-3 paths above
  // stay byte-identical (stages.test.ts:656's recipe test pins that).
  if (dest === undefined) {
    console.error("distill: stdin input requires --out to name the destination");
    process.exit(2);
  }
  const resolved = lang === "auto" ? detectLang(body) : lang;
  const frontDescription = parseDescription(front);
  // D30: a type:reference body must stay link-free (no ## Relations). distill emits
  // no references today, so this only future-proofs a reference-distill path.
  const isReference = parseType(front) === "reference";
  // D46 genre gate: a superseded note or a "Context document" is licensed to drop wholesale,
  // so the prose-list-item gate would only flood the footer — skip it there (the deterministic
  // spine still runs). Computed here, where the raw frontmatter is in scope.
  const factsDump = parseSuperseded(front) || /context document/i.test(frontDescription);
  // the note's canonical self-slug is its filename slug (what other vault notes
  // wikilink to); empty when reading from stdin (including the '-' convention), where
  // distill() falls back to the H1.
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
      },
      selfSlug,
    );
    const footer2 = fmError
      ? `${footer} · frontmatter not parsed (kept verbatim): ${fmError.slice(0, 80)}`
      : footer;
    // exit 3: covers nothing-to-distill and the expand-guard revert — the output is the
    // unmodified original. A routed note is always "compressed" (its preserves were
    // compacted), so head-kept-verbatim exits 0 with the footer tag as the signal. This
    // legacy passthrough envelope (mktemp <result>/<residue>) is untouched — Phase 3
    // only swaps the SUCCESS path below to the review intermediary.
    if (status === "passthrough") {
      const front2 = ensureEpistemicStatus(front);
      const result = front2 ? front2 + "\n" + out : out;
      let fileBody = `<result>\n${result}\n</result>\n`;
      if (residue.length) {
        const entries = residue
          .map(
            (r) =>
              `<entry term="${escAttr(r.label)}" reason="${escAttr(r.reason)}">\n<source>\n${r.source}\n</source>\n</entry>`,
          )
          .join("\n");
        fileBody += `\n<residue>\n${entries}\n</residue>\n`;
      }
      emit(fileBody, footer2);
      process.exit(3);
    }
    // Phase 3 success: write the interactive review intermediary sibling to `dest`
    // (never the source itself — the input file is never modified), stamped with
    // dest= (the destination basename) and src= (a hash of dest's current bytes, or
    // "new" when it does not yet exist — the creation case).
    const destPath = dest as string; // narrowed above: stdin without --out already exited
    const tmpPath = tmpPathFor(destPath);
    // ONE frontmatter block. Every compress path now projects the canonical graph, whose `out`
    // already carries its own `type: distillation` / `source:` / `schema:` YAML, so main() takes it
    // verbatim — prepending the source note's `front` would emit two YAML blocks. buildIntermediary
    // then stamps `epistemic_status: in-review` into that single block. Source-note-only fields
    // (aliases/tags/description) drop with the source front — a distillation is a derived artifact
    // stamped with its own provenance (Backlog).
    const noteForIntermediary = out;
    const src = existsSync(destPath) ? stampHash(readFileSync(destPath)) : "new";
    const intermediary = buildIntermediary(noteForIntermediary, residue, {
      dest: basename(destPath),
      src,
    });
    // Atomic no-clobber (plan §4, atomicity F2/F7): write a sibling .partial, then
    // linkSync to the final name — link fails EEXIST instead of overwriting, so a
    // racing emit that passed the preflight minutes ago (LLM run) loses LOUD with
    // the same exit-4 refusal, and a crash mid-write never leaves a truncated
    // intermediary visible at the .tmp.md path.
    const partial = `${tmpPath}.partial`;
    writeFileSync(partial, intermediary);
    try {
      linkSync(partial, tmpPath);
    } catch (e) {
      try {
        unlinkSync(partial);
      } catch {}
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        refusePendingIntermediary(tmpPath);
      }
      throw e;
    }
    unlinkSync(partial);
    const reviewSuffix =
      residue.length > 0 ? ` · review: ${residue.length} items + gate` : " · review: gate";
    process.stdout.write(`${tmpPath}\n`);
    process.stderr.write(`${footer2}${reviewSuffix}\n`);
    // Phase 5: at a real terminal (both ends — command substitution and pipes must
    // never see a prompt), emit's success hands off to the gate-aware session in the
    // SAME process. Everything below this line is stderr; stdout is already frozen
    // at the path line above. Not a TTY (the overwhelmingly common agent-caller
    // case): fall through unchanged, exiting 0 exactly as before Phase 5.
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const reviewLabel = residue.length > 0 ? `${residue.length} items + gate` : "gate";
      process.stderr.write(`review: ${tmpPath} — ${reviewLabel}\n`);
      process.stderr.write(`apply later with: distill-text apply ${tmpPath}\n`);
      // Ctrl-C loses nothing (the intermediary is already on disk) — exit 0 rather
      // than the default SIGINT death, matching decline/EOF's exit code.
      process.once("SIGINT", () => process.exit(0));
      process.exit(await runTtySession(tmpPath, destPath, resolved));
    }
  } catch (e) {
    // A non-transient throw is a real bug — surface it (a stage catch has already
    // logged it on its way up; anything thrown outside a stage prints its own stack
    // on propagation) instead of shipping the original as a silent passthrough.
    // a truncation in a NO-CATCH core stage (extractGraph, gradeBlocks) is not a
    // transient flake and not a code bug: it skips THIS note with a clear actionable
    // footer (raise the stage's cap), never a raw stack crash or a "transient" label.
    // exit 3: valid but unmodified original.
    if (e instanceof TruncationError) {
      emit(input, `— distill skipped: output TRUNCATED — ${e.message}`);
      process.exit(3);
    }
    if (!isTransient(e)) throw e;
    // transient failsafe: temp file holds the original (passthrough); path still printed
    emit(input, `— distill skipped (error): ${String(e).slice(0, 160)}`);
    process.exit(3);
  }
}
