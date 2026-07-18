// apply-mode — the second pass of the interactive-text pipeline: consume a
// `<dest>.tmp.md` intermediary a reviewer worked through, fire the checked
// decisions against the real note seams, and write the scaffold-free note back to
// `<dest>.md`. The grammar core (parse/resolve/strip) lives in interact.ts; the
// triage instance (verb vocabulary, the emit that produced this file) lives in
// triage.ts; this module owns distill's verb ACTIONS. The write-back DISCIPLINE —
// the stamp preflight, the mid-run re-verification, the atomic write — is generic
// and lives in execute.ts, which this module binds via `distillApplyHook`.
// `distill-text apply <path>` (distill-core.ts's runApply) is the production
// caller; apply.test.ts is its contract suite.
//
// ── Check order — execute.ts documents the full 14-step sequence. This module owns
//    steps 7–9 and 12, run inside distillApplyHook:
//   7. classify               classifyItems turns every item into deterministic ops,
//                             pure and I/O-free; a checked recover with no applicable
//                             action (an unrecoverable target) → exit 2, nothing written
//   8. key gate               iff ≥1 CHECKED `recover` whose target is a concept DEF (the
//                             only action that calls an LLM) and OPENAI_API_KEY or
//                             DASHSCOPE_API_KEY is unset
//                             → exit 1, nothing written. A checked recover of procedure
//                             steps or the thesis is verbatim (no LLM, no key); a checked
//                             `keep` is a no-op (no LLM, no key).
//   9. fire verbs             in document order, IN MEMORY over stripInteract(text):
//                             checked recover def → renderEntryPrompt + one fidelityGate;
//                               grade "residue" (failed again) → verbatimDef splice;
//                               grade "translated"/"inconclusive" → keep the re-render;
//                             checked recover procedure:<headword>:<idxs> → verbatimDirectives
//                               splice into that headword's numbered steps (no LLM); checked
//                               recover thesis → payload verbatim as the ## Abstract body (no
//                               LLM); checked keep → the entry stays as shipped;
//                             UNCHECKED recover|keep → the entry is REMOVED (`### headword`
//                               concept subsection deleted / procedure steps deleted / thesis
//                               absent) — the uniform default for every unchecked block.
//                             (No re-projection step: on a canonical note the ## Abstract is
//                             authored at extract time, not re-derived from concept defs, so a
//                             def recover leaves it as-authored.)
//  12. promote epistemic      set `epistemic_status: distilled` (the emit forced
//                             `in-review`; write-back is the promotion)
//
// ── Success output (standalone apply): path on stdout, footer on stderr, exit 0.
//   stdout  the destination path (absolute) — the only stdout line
//   stderr  `— applied: N recovered · M kept · K removed (V verbatim)`, plus
//           ` (D degraded)` appended ONLY when D > 0
//           N = checked recover items · M = checked keep items · K = removed
//           (unchecked recover|keep) · V = entries written verbatim (recover defs whose
//           second grade failed + every recover procedure/thesis) · D = of V, how many
//           were forced verbatim by a caught LLM transport flake (rethrowIfBug let it
//           through) rather than a legitimate residue-grade verdict — a total transport
//           outage would otherwise exit 0 looking identical to a clean run. Each caught
//           flake also gets its own stderr diagnostic line (recoverDefs), so an operator
//           gets the per-entry cause, not just the count. A run with zero degradations
//           produces the exact byte-identical footer as before this suffix existed.
//
// ── Exit codes: 0 applied · 1 key missing AND a checked recover def needed it
//   (nothing written) · 2 everything else refused (missing/malformed/gate/stamp/
//   suffix/dest-mismatch/mid-mutation). There is no exit 3 or exit 4: the mandatory
//   gate makes "no decision blocks" a subset of "missing gate", so a separate no-op
//   code would be dead surface.
//
// PURE by contract for the exported helpers below (no fs, no LLM) so they unit-test
// offline. distillApplyHook is the one partial exception: it reaches an LLM, but only
// through the injected `ask` seam and NEVER the filesystem, which is what lets
// apply.test.ts drive the whole apply middle (classify → gates → mutate → footer) with
// no temp files. runApply is the only export that touches disk.

import type { Item } from "#src/distill/review/interact.ts";
import {
  type InteractApplyHook,
  type InteractApplyOpts,
  type InteractApplyResult,
  runInteractApply,
} from "#src/distill/review/execute.ts";
import { TRIAGE_VERBS, safeHandle } from "#src/distill/review/triage.ts";
import { askJson, ensureKeys } from "@skills/llm/llm.ts";
import { MissingKeyError } from "@skills/llm/keys.ts";
import { distillDegrade as rethrowIfBug } from "#src/core/degrade.ts";
import { DISTILL_EXTRACT } from "#src/core/models.ts";
import {
  fidelityGate,
  renderEntryPrompt,
  verbatimDef,
  verbatimDirectives,
} from "#src/distill/prompt/prompts.ts";
import {
  parseCanonicalNote,
  splitSections,
  subsectionRanges,
} from "#src/distill/graph/parse-projection.ts";
import { parseFrontmatter } from "#src/core/frontmatter.ts";
import { detectLang } from "#src/core/text.ts";
import { TRAILING_ANCHOR_RE } from "#src/distill/graph/graph.ts";

// ---- runApply: the orchestrator ----

// Options threading through runApply — the executor's InteractApplyOpts, unchanged: distill
// has no options of its own beyond what every binding needs (lang, ask). Kept as a named
// export so distill-core.ts's call site reads `ApplyOpts` rather than reaching into execute.ts.
export type ApplyOpts = InteractApplyOpts;

// ---- the residue-target grammar ----

// A residue item's target, parsed. triage's targetFor stamps ONE of three shapes into the
// intermediary — `thesis`, `procedure:<headword>[:<n,…>]`, or a bare concept term — and this
// union is that grammar decoded: the string is inspected ONCE, at parseTarget, and every
// downstream branch reads a field rather than re-testing a prefix. `steps.idxs` is the 0-based
// step address; empty means the target named the WHOLE procedure (per-step spans deferred, so a
// whole-procedure recover is not actionable — apply refuses it loud). `def.term` is the only
// class that calls an LLM.
type StepsTarget = { kind: "steps"; headword: string; idxs: number[] };
type ResidueTarget = { kind: "thesis" } | StepsTarget | { kind: "def"; term: string };

// Parse a stamped target into the union. The `procedure:` case takes a TRAILING numeric segment
// as the 1-based comma-joined step list and everything before it as the headword (which may
// itself carry `:` — the parse anchors on the numeric tail, matching triage's stamp); a
// 1-based index below 1 is dropped rather than wrapping to a negative slot.
function parseTarget(target: string): ResidueTarget {
  if (target === "thesis") return { kind: "thesis" };
  if (!target.startsWith("procedure:")) return { kind: "def", term: target };
  const rest = target.replace(/^procedure:/, "");
  const m = rest.match(/^(.*):(\d+(?:,\d+)*)$/);
  if (!m) return { kind: "steps", headword: rest, idxs: [] };
  const idxs = m[2]!
    .split(",")
    .map((s) => Number.parseInt(s, 10) - 1)
    .filter((n) => Number.isInteger(n) && n >= 0);
  return { kind: "steps", headword: m[1]!, idxs };
}

// A headword that resolveHeadword has already matched against the note body — the exact
// `### headword` string, not the possibly-degraded target the reviewer's file carried. The
// brand is nominal and erases at runtime; its job is to make the resolve-BEFORE-splice
// invariant a compile error rather than a doc comment, since spliceDef and editProcedure
// match by exact headword and would silently no-op on an unresolved one. Minted in exactly
// one place (resolveHeadword) plus asResolvedHeadword for callers holding a headword read
// straight out of a body.
type ResolvedHeadword = string & { readonly __resolved: unique symbol };

// Assert that a string IS an exact `### headword` from the body — the escape hatch for a
// caller that obtained one without going through resolveHeadword (a fixture, a headword read
// off the note directly). Erases at runtime.
export function asResolvedHeadword(headword: string): ResolvedHeadword {
  return headword as ResolvedHeadword;
}

// Promote the intermediary's forced `epistemic_status: in-review` to `distilled`
// (step 12 — write-back is the promotion). The emit always forces the in-review
// line into frontmatter, so a bounded first-line replace preserves every other
// byte; a note missing the line (never emitted) is returned unchanged.
function promoteEpistemic(body: string): string {
  if (!/^epistemic_status:/m.test(body)) return body;
  return body.replace(/^epistemic_status:.*$/m, "epistemic_status: distilled");
}

// Resolve a parsed steps target against the note body into its resolved headword and the
// in-range subset of its 0-based step indices (an out-of-range slot is dropped). Apply's two
// step lanes — checked recover and unchecked remove — both resolve a step target through this
// ONE function, so the resolution is stated once and the two lanes can't drift apart. The
// return type is the invariant: idxs is non-empty only alongside a resolved hw, so callers
// narrow on `hw === null` rather than asserting past it.
type StepResolution = { hw: ResolvedHeadword; idxs: number[] } | { hw: null; idxs: [] };

function resolveSteps(body: string, t: StepsTarget): StepResolution {
  const hw = resolveHeadword(body, "procedures", t.headword);
  if (hw === null) return { hw: null, idxs: [] };
  const range = procedureStepRange(body.split("\n"), hw);
  const idxs = t.idxs.filter((idx) => idx < (range?.count ?? 0));
  return { hw, idxs };
}

// The stamped-string form of resolveSteps: parse the target, then resolve. A target that is not
// a `procedure:` one names no procedure and resolves to nothing. Exported as apply's
// step-resolution contract (apply.test.ts drives it with the stamped strings triage writes);
// the classify lanes call resolveSteps directly on the already-parsed target.
export function resolveStepTarget(body: string, target: string): StepResolution {
  const t = parseTarget(target);
  return t.kind === "steps" ? resolveSteps(body, t) : { hw: null, idxs: [] };
}

// The classification result distillApplyHook fires: the deterministic op set (def
// re-renders, def removals, procedure edits, a verbatim thesis) plus the effect counters
// the footer reports. `verbatim` counts only the pre-LLM verbatim splices this pure pass
// makes (recover steps + thesis) — applyFooter adds the def-recover lane's own count for
// the reported total.
export type ClassifyResult = {
  recovered: number;
  kept: number;
  removed: number;
  verbatim: number;
  // Checked recover defs → (resolved term, source clause) to re-render under the key gate.
  defRecovers: { term: ResolvedHeadword; src: string }[];
  // Unchecked def entries whose `### headword` subsection is spliced out.
  defRemovals: ResolvedHeadword[];
  // Checked recover steps (replace) and unchecked step removals (replace:null), batched.
  procedureOps: ProcedureOp[];
  // The checked recover thesis payload set verbatim as the ## Abstract body, else null.
  thesisPara: string | null;
  // Checked recover targets with no applicable action — distillApplyHook refuses these LOUD.
  unrecoverable: string[];
};

// Classify every residue item against the note body into the op set distillApplyHook
// executes — the PURE core of the apply pass: no LLM, no fs, no stdout, a transform from
// (items, body) to a ClassifyResult. Kept as a standalone exported function, separate from
// the impure distillApplyHook, so the branch matrix (checked/unchecked × def/steps/thesis/
// keep, with target-resolution misses) is unit-testable offline, per the module's own
// helpers-test-offline contract.
//
// Counts reflect EFFECTS, not decisions: a checked keep is `kept`; a checked recover that
// resolves is `recovered`; an unchecked recover|keep that had a real removal is `removed`;
// a non-recoverable class (edge/payload/prose def with no glossary row, an out-of-range or
// whole-procedure step target, an empty payload) is collected in `unrecoverable` when
// CHECKED (distillApplyHook aborts) and silently dropped when unchecked (never in the
// output).
export function classifyItems(items: Item[], body: string): ClassifyResult {
  const out: ClassifyResult = {
    recovered: 0,
    kept: 0,
    removed: 0,
    verbatim: 0,
    defRecovers: [],
    defRemovals: [],
    procedureOps: [],
    thesisPara: null,
    unrecoverable: [],
  };
  for (const it of items) {
    const eff = it.state === "checked" ? classifyChecked(it, body) : classifyUnchecked(it, body);
    if (eff.recovered) out.recovered++;
    if (eff.kept) out.kept++;
    if (eff.removed) out.removed++;
    if (eff.verbatim) out.verbatim++;
    if (eff.defRecover) out.defRecovers.push(eff.defRecover);
    if (eff.defRemoval !== undefined) out.defRemovals.push(eff.defRemoval);
    if (eff.procedureOps) out.procedureOps.push(...eff.procedureOps);
    if (eff.thesisPara !== undefined) out.thesisPara = eff.thesisPara; // last checked thesis wins
    if (eff.unrecoverable !== undefined) out.unrecoverable.push(eff.unrecoverable);
  }
  return out;
}

// What ONE item contributes to the accumulating ClassifyResult. Every field is optional and
// absence means "this lane is untouched", so a branch names only the effect it has; the
// counters are flags rather than numbers because a single item bumps each counter at most
// once. classifyItems folds these in document order, which is what keeps procedureOps,
// defRecovers and unrecoverable in the order the reviewer's file listed them.
type ItemEffect = {
  recovered?: true;
  kept?: true;
  removed?: true;
  verbatim?: true;
  defRecover?: { term: ResolvedHeadword; src: string };
  defRemoval?: ResolvedHeadword;
  procedureOps?: ProcedureOp[];
  thesisPara?: string;
  unrecoverable?: string;
};

// A CHECKED item's effect: keep holds the entry as shipped, recover must be executable in its
// own lane or land in `unrecoverable` — every lane refuses rather than no-ops, because a
// checked decision that silently does nothing is a LOST reviewer decision.
function classifyChecked(it: Item, body: string): ItemEffect {
  if (it.verb === "keep") return { kept: true }; // held as shipped — no LLM, no removal
  const payload = it.payload ?? "";
  const t = parseTarget(it.target);
  switch (t.kind) {
    case "def": {
      const term = resolveDefTerm(body, t.term);
      if (term === null) return { unrecoverable: it.target }; // no concept subsection → no action
      return { recovered: true, defRecover: { term, src: payload } };
    }
    case "steps": {
      // A recover with no in-range slot (out-of-range or whole-procedure target — per-step
      // spans deferred) or no source directive (empty payload) cannot execute — and an empty
      // payload would DELETE the slot (replace:null), the opposite of recover. Refuse all
      // rather than no-op or delete.
      const stepTarget = resolveSteps(body, t);
      const clauses = verbatimDirectives(payload);
      if (stepTarget.hw === null || stepTarget.idxs.length === 0 || clauses.length === 0) {
        return { unrecoverable: it.target };
      }
      const { hw, idxs } = stepTarget;
      return {
        recovered: true,
        verbatim: true,
        procedureOps: idxs.map((idx, k) => ({
          headword: hw,
          idx,
          replace: k === 0 ? clauses : null,
        })),
      };
    }
    case "thesis": {
      // an empty payload is nothing to recover; refuse rather than insert a blank.
      if (payload.trim() === "") return { unrecoverable: it.target };
      return { recovered: true, verbatim: true, thesisPara: payload };
    }
  }
}

// An UNCHECKED recover|keep: the entry is REMOVED, but only COUNTED when there is a real
// removal — a non-recoverable class (or an out-of-range slot) was never in the output, so it
// stays dropped with no effect rather than a phantom "removed". An unchecked thesis and an
// unresolvable target both have nothing to remove and return the empty effect.
function classifyUnchecked(it: Item, body: string): ItemEffect {
  const t = parseTarget(it.target);
  switch (t.kind) {
    case "def": {
      const term = resolveDefTerm(body, t.term);
      return term === null ? {} : { removed: true, defRemoval: term };
    }
    case "steps": {
      const { hw, idxs } = resolveSteps(body, t);
      if (hw === null || idxs.length === 0) return {};
      return {
        removed: true,
        procedureOps: idxs.map((idx) => ({ headword: hw, idx, replace: null })),
      };
    }
    case "thesis":
      return {}; // nothing was projected for a thesis residue ⇒ nothing to remove
  }
}

// The footer grammar distillApplyHook reports on stderr — the ONE place
// `— applied: N recovered · M kept · K removed (V verbatim)` is constructed. V sums the
// pure classification's own verbatim splices (recover steps + thesis, cls.verbatim) with
// the def-recover lane's own count (a re-render whose second grade failed, or a caught
// re-render/grade flake floored to the source's own clause) — both are verbatim by the
// same definition, written unchanged from the source rather than LLM-authored, so they
// contribute to one total. `degraded` is the of-V subset forced verbatim by a caught
// transport flake rather than a legitimate residue grade; it is appended as
// ` (D degraded)` ONLY when D > 0, so a clean run's footer stays byte-identical to
// before this parameter existed — the design constraint every zero-degradation
// assertion in apply.test.ts depends on.
function applyFooter(cls: ClassifyResult, defVerbatim: number, degraded: number): string {
  const base = `— applied: ${cls.recovered} recovered · ${cls.kept} kept · ${cls.removed} removed (${cls.verbatim + defVerbatim} verbatim)`;
  return degraded > 0 ? `${base} (${degraded} degraded)` : base;
}

// A checked recover apply cannot execute is refused LOUD — never silently swallowed; a lost
// reviewer decision is the format's disaster class (interact.ts fails a mistyped item for the
// same reason). Returns the refusal, or null when every checked decision is executable. Fires
// before the key gate and before any write.
function lostDecisionGate(unrecoverable: string[]): InteractApplyResult | null {
  if (unrecoverable.length === 0) return null;
  return {
    kind: "refuse",
    code: 2,
    message: `checked recover with no applicable action: ${unrecoverable.join(", ")} — this residue is not recoverable via apply; uncheck it (the source is unchanged) and re-add by hand if needed`,
  };
}

// 8. key gate — only a checked recover DEF that resolved calls an LLM, so an empty
// `defRecovers` passes the gate unconditionally. A checked recover of procedure steps / the
// thesis is verbatim (no LLM); keep is a no-op. Returns the exit-1 refusal when the key the
// def lane needs is unset, null when the run may proceed; a non-key failure propagates.
function keyGate(defRecovers: ClassifyResult["defRecovers"]): InteractApplyResult | null {
  if (defRecovers.length === 0) return null;
  try {
    ensureKeys([DISTILL_EXTRACT]);
    return null;
  } catch (e) {
    if (e instanceof MissingKeyError) {
      return { kind: "refuse", code: 1, message: `${e.message}; nothing written` };
    }
    throw e;
  }
}

// 9. fire verbs, def lane — the whole LLM window. Re-render each checked recover def, re-grade
// it once against `tie0` (the ## Abstract orientation, the canonical analogue of the old
// tie-together line), and settle on either the re-render (grade translated/inconclusive) or the
// source's own verbatim clause (a second grade failure, an empty re-render, or a caught
// re-render/grade flake — a verbatim splice cannot invert, so flooring beats dropping the
// entry). Returns the splices in document order plus this lane's own verbatim count, which
// applyFooter sums with the pure pass's. `degraded` is the of-defVerbatim subset forced
// verbatim by a CAUGHT flake (the catch branch) rather than a legitimate residue grade — a
// total transport outage bumps defVerbatim exactly as a real residue grade would, so without
// this separate count the run would exit 0 looking clean. Each caught flake also gets its own
// stderr line here, naming the term and the underlying error, so an operator sees the cause
// per entry rather than a single opaque number.
async function recoverDefs(args: {
  defRecovers: ClassifyResult["defRecovers"];
  body: string;
  tie0: string;
  lang: "en" | "ru";
  ask: typeof askJson;
}): Promise<{
  splices: { term: ResolvedHeadword; def: string }[];
  defVerbatim: number;
  degraded: number;
}> {
  const { defRecovers, body, tie0, lang, ask } = args;
  const splices: { term: ResolvedHeadword; def: string }[] = [];
  let defVerbatim = 0;
  let degraded = 0;
  for (const d of defRecovers) {
    let finalDef: string;
    try {
      const rr = await ask<{ def: string }>(
        DISTILL_EXTRACT,
        renderEntryPrompt({ term: d.term, def: "" }, d.src, lang),
        1024,
      );
      const reRendered = (rr.def ?? "").trim();
      const graded = await fidelityGate(
        tie0,
        body,
        [{ term: d.term, def: reRendered, sourceText: d.src }],
        ask,
      );
      const grade = graded.concepts[0]?.grade ?? "translated";
      if (grade === "residue" || !reRendered) {
        finalDef = verbatimDef(d.term, d.src);
        defVerbatim++;
      } else {
        finalDef = reRendered;
      }
    } catch (e) {
      rethrowIfBug(e, "apply-recover-def");
      // a transient re-render/grade flake floors to the source's own clause rather
      // than dropping the entry — a verbatim splice cannot invert. Unlike a legitimate
      // residue grade, this fallback is a DEGRADATION: the operator gets one stderr
      // line per flake here (process.stderr.write, matching execute.ts's own footer
      // write rather than console.error, so apply.test.ts's stdout/stderr capture sees
      // it), and the footer's `(D degraded)` suffix below.
      process.stderr.write(
        `distill apply: recover def "${d.term}" degraded to verbatim after a caught LLM flake: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      finalDef = verbatimDef(d.term, d.src);
      defVerbatim++;
      degraded++;
    }
    splices.push({ term: d.term, def: finalDef });
  }
  return { splices, defVerbatim, degraded };
}

// 9. fire verbs, body lane — every deterministic edit, in the one order that makes the splices
// address the body they were classified against: settled def re-renders, then unchecked def
// removals, then the batched procedure edits, then the checked recover thesis (verbatim, as the
// ## Abstract body). There is NO re-projection step on a canonical note: the abstract is
// authored at extract time, not re-derived from concept defs, so a def recover leaves it
// as-authored — the old renderProse/replaceHeadProse head-prose chain has no canonical analogue.
function mutateBody(
  body: string,
  cls: ClassifyResult,
  splices: { term: ResolvedHeadword; def: string }[],
): string {
  let out = body;
  for (const s of splices) out = spliceDef(out, s.term, s.def);
  for (const term of cls.defRemovals) out = spliceDef(out, term, null);
  if (cls.procedureOps.length) out = editProcedure(out, cls.procedureOps);
  if (cls.thesisPara !== null) out = insertThesis(out, cls.thesisPara);
  return out;
}

// Distill's action binding: steps 7–9 and 12 of the interact check order, read as that
// sequence — classify, refuse a lost decision, gate on the key, run the def lane's LLM window,
// mutate the body, promote the epistemic status. Its run options (lang, ask) arrive through ctx
// — runInteractApply forwards its own opts argument into every ctx it builds — so this hook is
// a plain constant, not a factory closing over them. The generic half of the run — the stamp
// preflight (1–6), the mid-run re-verification (10–11), and the atomic write-back (13–14) —
// belongs to the executor (execute.ts) and calls this hook for the middle. A refusal here
// carries its own exit code (a lost reviewer decision → 2, a missing key → 1); the success case
// hands back the final body and the stderr footer. Exported for apply.test.ts, which drives
// this middle offline with an injected `ask` and no filesystem; runApply below is the
// production caller.
export const distillApplyHook: InteractApplyHook = async ({
  items,
  strippedBody,
  lang: rawLang,
  ask: rawAsk,
}): Promise<InteractApplyResult> => {
  const body = strippedBody;
  const { body: bodyNoFront } = parseFrontmatter(body);
  const lang = rawLang === "auto" ? detectLang(bodyNoFront) : rawLang;
  const ask = rawAsk ?? askJson;
  // The ## Abstract orientation seeds the fidelity re-grade's thesis arg (the canonical
  // analogue of the old tie-together line).
  const tie0 = parseCanonicalNote(bodyNoFront).abstract;

  // 7. classify every item into deterministic ops (no LLM, no write) — the pure core
  //    (classifyItems): a transform from (items, body) to the op set + counters, with NO I/O,
  //    so every field of `cls` is final. This precedes the key gate on purpose: a checked
  //    recover that resolves to no actionable target (an edge/payload/prose residue class, or a
  //    def whose concept subsection is gone) is a LOST reviewer decision if allowed to no-op,
  //    so it aborts LOUD below — and only a checked recover DEF that actually resolves is what
  //    forces the key gate.
  const cls = classifyItems(items, body);

  const lost = lostDecisionGate(cls.unrecoverable);
  if (lost) return lost;

  const keyless = keyGate(cls.defRecovers);
  if (keyless) return keyless;

  const { splices, defVerbatim, degraded } = await recoverDefs({
    defRecovers: cls.defRecovers,
    body,
    tie0,
    lang,
    ask,
  });

  // 12. promote the epistemic status. Pure over the mutated body — the executor's steps 10–11
  // read the tmp and the destination off disk, never this string, so promoting here rather than
  // after them changes nothing that reaches the write.
  return {
    kind: "write",
    body: promoteEpistemic(mutateBody(body, cls, splices)),
    footer: applyFooter(cls, defVerbatim, degraded),
  };
};

// Apply a single intermediary and return the process exit code (0 | 1 | 2). Writes the
// destination path to stdout, the applied-summary footer and every refusal to stderr;
// NEVER prompts, NEVER reads stdin. main() does `process.exit(await runApply(...))`.
// Before the write-back, the destination and the tmp are BOTH untouched on every refusal
// path — pinned by hash in apply.test.ts. Distill's binding of the generic interact
// executor: the label every refusal is prefixed with, the triage verb vocabulary step 5
// resolves against, and the action hook above. `opts` reaches distillApplyHook through this
// one call's third argument — runInteractApply forwards it into every ctx it builds, so the
// hook never closes over it. `opts.lang: "auto"` detects from the stripped note body, parity
// with compress mode's own auto-detection; `opts.ask` is the injected-transport seam
// apply.test.ts drives.
export function runApply(tmpPath: string, opts: ApplyOpts): Promise<number> {
  return runInteractApply(
    tmpPath,
    {
      label: "distill apply",
      verbs: TRIAGE_VERBS,
      apply: distillApplyHook,
    },
    opts,
  );
}

// ---- canonical section/subsection locators (shared by the body-editing primitives) ----

const STEP_RE = /^\s*\d+\.\s(.*)$/; // a numbered `N. step` line, capturing the step text

// The line range of a `### headword` subsection under `## <section>`: [subStart, subEnd) where
// subStart is the `### headword` line and subEnd is the next `### ` (or the section's end),
// in WHOLE-NOTE line numbers. Fence-aware at both levels — splitSections finds the section,
// subsectionRanges finds the subsections within it, so a `### ` inside a ``` block is literal
// content rather than a heading (a hand-rolled scan here treated it as a boundary and cut the
// range short at the fake heading). null when the section or the headword is absent.
function subsectionRange(
  lines: string[],
  section: string,
  headword: string,
): { subStart: number; subEnd: number } | null {
  const sec = splitSections(lines.join("\n")).find((s) => s.name === section);
  if (!sec) return null;
  const hit = subsectionRanges(sec.bodyLines).find((r) => r.headword === headword);
  if (!hit) return null;
  const base = sec.start + 1; // subsectionRanges indexes bodyLines; rebase to whole-note lines
  return { subStart: base + hit.start, subEnd: base + hit.end };
}

// The inclusive line range and count of the numbered step list under a `## Procedures`
// `### headword` subsection (null when absent) — used to validate a step target's indices
// and to locate the list for editing. The subsection boundary is fence-aware (subsectionRange),
// so a fenced markdown sample quoting `N. ` lines below the real list is outside it: the scan
// stops at the first non-step, non-blank line, which the opening fence is. A fence placed
// BEFORE the list likewise stops the scan and reads as "no list" — canonical projections put
// the numbered list first, and a hand edit that does not is unaddressable rather than miscounted.
function procedureStepRange(
  lines: string[],
  headword: string,
): { start: number; end: number; count: number } | null {
  const sub = subsectionRange(lines, "procedures", headword);
  if (!sub) return null;
  let start = -1;
  let end = -1;
  for (let i = sub.subStart + 1; i < sub.subEnd; i++) {
    if (STEP_RE.test(lines[i]!)) {
      if (start < 0) start = i;
      end = i;
    } else if (start >= 0) {
      break; // the numbered list ended
    } else if (lines[i]!.trim() === "") {
      continue; // blank between heading and list
    } else {
      break; // non-list content before any item
    }
  }
  if (start < 0) return null;
  return { start, end, count: end - start + 1 };
}

// The `### headword`s under a `## <section>` block, in document order. Same fence-aware walk
// subsectionRange uses, so a fenced `### ` look-alike never surfaces as a resolvable headword.
function headwordsUnder(body: string, section: string): string[] {
  const sec = splitSections(body).find((s) => s.name === section);
  if (!sec) return [];
  return subsectionRanges(sec.bodyLines).map((r) => r.headword);
}

// Edit the `## Concepts` note body: replace the DEFINITION LINE (the first non-blank,
// non-bullet line — its trailing byte-anchor preserved) of the `### headword` subsection when
// `def` is a string, or DELETE the whole subsection (with its preceding blank separator) when
// `def` is null. A headword with no matching subsection leaves the body unchanged (a
// removed-then-recovered race is a no-op, not a crash). Every other subsection, its bullets,
// and the anchors are byte-preserved. `term` is a ResolvedHeadword because spliceDef matches by
// EXACT headword: the resolve-before-splice step is the brand, so a possibly-degraded target
// fails to compile here rather than no-opping at runtime.
export function spliceDef(body: string, term: ResolvedHeadword, def: string | null): string {
  const lines = body.split("\n");
  const sub = subsectionRange(lines, "concepts", term);
  if (!sub) return body; // absent headword ⇒ byte-identical no-op
  const { subStart, subEnd } = sub;
  if (def === null) {
    let start = subStart;
    if (start > 0 && lines[start - 1]!.trim() === "") start -= 1; // absorb the blank separator
    return [...lines.slice(0, start), ...lines.slice(subEnd)].join("\n");
  }
  const flat = def.replace(/\n+/g, " ").trim(); // a definition line is one line
  for (let i = subStart + 1; i < subEnd; i++) {
    const t = lines[i]!.trim();
    if (t === "" || t.startsWith("- ")) continue; // the def line precedes any bullet
    // Reads the anchor's raw substring off the shared TRAILING_ANCHOR_RE (graph.ts) rather
    // than parsing it, so a hand-edited bracketed anchor (`[128..192]`) re-appends unchanged
    // instead of silently vanishing — a bare-only regex (`/\s(\d+\.\.\d+)\s*$/`) couldn't
    // match it and would drop it.
    const anchor = lines[i]!.match(TRAILING_ANCHOR_RE);
    lines[i] = anchor ? `${flat} ${anchor[1]}` : flat;
    return lines.join("\n");
  }
  // a bare `### headword` with no def line — insert the def right after the heading
  return [...lines.slice(0, subStart + 1), "", flat, ...lines.slice(subStart + 1)].join("\n");
}

// One instruction against a `## Procedures` `### headword` numbered list, keyed by the
// headword and the 0-based step index within THAT headword's list (the (headword, stepIdx)
// addressing the canonical grouping forces). `replace` is the new step text(s) for the slot
// (a verbatimDirectives splice may yield several); `replace: null` DELETES the slot. A group
// target like `procedure:<hw>:2,3` expands to one op per index (all sharing the headword). The
// headword is branded for the same reason spliceDef's term is: editProcedure locates the list by
// exact heading and skips what it cannot find.
export type ProcedureOp = { headword: ResolvedHeadword; idx: number; replace: string[] | null };

// Apply every ProcedureOp in one rewrite, PER HEADWORD: ops are grouped by headword, and each
// headword's numbered list is rebuilt against its ORIGINAL indices (deletions drop,
// replacements substitute, untouched slots survive) and RENUMBERED from 1. Batching per list
// keeps `procedure:<hw>:2` meaning that headword's 2nd step regardless of an earlier deletion.
// A headword with no `### headword` procedure list is skipped (the caller already validated
// in-range targets; a stale one is a no-op, not a crash).
export function editProcedure(body: string, ops: ProcedureOp[]): string {
  let lines = body.split("\n");
  const byHead = new Map<ResolvedHeadword, ProcedureOp[]>();
  for (const op of ops) {
    const g = byHead.get(op.headword);
    if (g) g.push(op);
    else byHead.set(op.headword, [op]);
  }
  for (const [headword, hops] of byHead) {
    const range = procedureStepRange(lines, headword);
    if (!range) continue; // no such procedure list ⇒ skip
    const { start, end } = range;
    const orig = lines.slice(start, end + 1).map((l) => l.match(STEP_RE)![1]!);
    const opByIdx = new Map(hops.map((o) => [o.idx, o]));
    const next: string[] = [];
    orig.forEach((textLine, i) => {
      const op = opByIdx.get(i);
      if (op) {
        if (op.replace !== null) for (const s of op.replace) next.push(s);
      } else {
        next.push(textLine);
      }
    });
    const rendered = next.map((s, i) => `${i + 1}. ${s}`);
    lines = [...lines.slice(0, start), ...rendered, ...lines.slice(end + 1)];
  }
  return lines.join("\n");
}

// Set the `## Abstract` body to `para` — the canonical home for the synthesized orientation
// (the checked `recover: thesis` action, verbatim, no LLM). When a `## Abstract` section
// exists, its body is replaced (heading kept); otherwise a `## Abstract` block is inserted
// right after the H1 (or at the top when there is no H1), before the first `## ` section.
export function insertThesis(body: string, para: string): string {
  const lines = body.split("\n");
  const flat = para.trim();
  const abstract = splitSections(body).find((s) => s.name === "abstract");
  if (abstract) {
    return [...lines.slice(0, abstract.start + 1), "", flat, "", ...lines.slice(abstract.end)].join(
      "\n",
    );
  }
  const h1 = lines.findIndex((l) => /^#\s/.test(l));
  const insertAt = h1 >= 0 ? h1 + 1 : 0;
  const before = lines.slice(0, insertAt);
  const after = lines.slice(insertAt);
  let k = 0;
  while (k < after.length && after[k]!.trim() === "") k++; // drop leading blanks
  const block = ["## Abstract", "", flat, ""];
  const head = before.length ? [...before, ""] : [];
  return [...head, ...block, ...after.slice(k)].join("\n");
}

// Resolve a target back to the actual `### headword` under `## <section>`. Exact match first
// (the common case: target === headword); then the degraded case — the emit shipped
// `safeHandle(headword)` because the headword carried a backtick or newline, so match the
// headword whose `safeHandle` equals the target. Returns the real headword, or null when none
// matches (the caller counts it removed/skipped rather than crashing) — the emit transform run
// backward, no handle→headword channel in the file. Holds the resolution fact once for both
// the concepts side (resolveDefTerm) and the procedures side (resolveStepTarget).
// The ONE place a ResolvedHeadword is minted from a raw target.
function resolveHeadword(body: string, section: string, target: string): ResolvedHeadword | null {
  const heads = headwordsUnder(body, section);
  const hit = heads.includes(target)
    ? target // exact (the common case)
    : (heads.find((h) => safeHandle(h) === target) ?? null); // the emit run backward
  return hit === null ? null : asResolvedHeadword(hit);
}

// Resolve a residue item's (possibly degraded) def target back to the actual `### headword`
// under `## Concepts`. See resolveHeadword for the resolution fact; this is a one-line binding
// of section "concepts".
export function resolveDefTerm(body: string, target: string): ResolvedHeadword | null {
  return resolveHeadword(body, "concepts", target);
}
