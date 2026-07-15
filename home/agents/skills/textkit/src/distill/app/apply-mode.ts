// apply-mode — the second pass of the interactive-text pipeline: consume a
// `<dest>.tmp.md` intermediary a reviewer worked through, fire the checked
// decisions against the real note seams, and write the scaffold-free note back to
// `<dest>.md`. The grammar core (parse/resolve/strip) lives in interact.ts; the
// triage instance (verb vocabulary, the emit that produced this file) lives in
// triage.ts; this module owns the verb ACTIONS and the write-back discipline.
// `distill-text apply <path>` (distill-core.ts's runApply) is the production
// caller; apply.test.ts is its contract suite.
//
// ── Check order — the sequence every refusal in runApply is measured against, in order:
//   1. path exists            ENOENT → exit 2 "no intermediary at <path> — already
//                             applied, or re-run distill" (the fat-finger's first error)
//   2. suffix                 non-`.tmp.md` → exit 2 (destinationFor returns null)
//   3. parse                  parseInteract structural errors → exit 2, nothing executed
//   4. gate present           the confirm-all gate is MANDATORY (triage policy): zero
//                             confirm-all blocks — including a blockless file — is
//                             malformed, exit 2 with the same teaching message
//   5. resolve                resolveInteract against TRIAGE_VERBS — unknown verb,
//                             unresolved pick-one, or an UNCHECKED confirm-all gate →
//                             exit 2, nothing executed
//   6. stamp                  dest= basename must equal basename(destinationFor(tmp))
//                             (a renamed tmp refuses); src=sha256 must equal the
//                             destination's current hash (an edited dest refuses);
//                             src=new requires the destination ABSENT (no-clobber)
//   7. classify               classifyItems turns every item into deterministic ops,
//                             pure and I/O-free; a checked recover with no applicable
//                             action (an unrecoverable target) → exit 2, nothing written
//   8. key gate               iff ≥1 CHECKED `recover` whose target is a concept DEF (the
//                             only action that calls an LLM) and FIREWORKS_API_KEY is unset
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
//  10. re-hash tmp            re-read the tmp and compare to the hash taken at step 1;
//                             a mismatch (Obsidian Sync rewrote it during the LLM window)
//                             → exit 2 "intermediary changed during apply", nothing written
//  11. re-verify dest         overwrite case only: re-read the destination's hash and
//                             compare to step 6's src= value again, since that check ran
//                             before the (seconds-long) LLM window → a mismatch exits 2
//  12. promote epistemic      set `epistemic_status: distilled` (the emit forced
//                             `in-review`; write-back is the promotion)
//  13. atomic dest write      overwrite case → rename a same-dir temp onto dest (atomic
//                             replace); new case → link no-clobber
//  14. unlink tmp             ENOENT tolerated (a racing applier may have removed it)
//
// ── Success output (standalone apply): path on stdout, footer on stderr, exit 0.
//   stdout  the destination path (absolute) — the only stdout line
//   stderr  `— applied: N recovered · M kept · K removed (V verbatim)`
//           N = checked recover items · M = checked keep items · K = removed
//           (unchecked recover|keep) · V = entries written verbatim (recover defs whose
//           second grade failed + every recover procedure/thesis).
//
// ── Exit codes: 0 applied · 1 key missing AND a checked recover def needed it
//   (nothing written) · 2 everything else refused (missing/malformed/gate/stamp/
//   suffix/dest-mismatch/mid-mutation). There is no exit 3 or exit 4: the mandatory
//   gate makes "no decision blocks" a subset of "missing gate", so a separate no-op
//   code would be dead surface.
//
// PURE by contract for the exported helpers below (no fs, no LLM) so they unit-test
// offline; runApply is the only impure export.

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  type Item,
  parseInteract,
  resolveInteract,
  stripInteract,
} from "@/distill/review/interact.ts";
import { TRIAGE_VERBS, safeHandle } from "@/distill/review/triage.ts";
import { askJson } from "@shared/llm/llm.ts";
import { distillDegrade as rethrowIfBug } from "@/core/degrade.ts";
import { EXTRACT } from "@/core/models.ts";
import { linkNoClobber } from "@/core/fs.ts";
import {
  fidelityGate,
  renderEntryPrompt,
  verbatimDef,
  verbatimDirectives,
} from "@/distill/prompt/prompts.ts";
import { parseCanonicalNote, splitSections } from "@/distill/graph/parse-projection.ts";
import { parseFrontmatter } from "@/core/frontmatter.ts";
import { detectLang } from "@/core/text.ts";
import { stampSha, TRAILING_ANCHOR_RE } from "@/distill/graph/graph.ts";

// ---- runApply: the orchestrator ----

// Options threading through runApply.
export type ApplyOpts = {
  // Overrides body-language detection for the re-render/re-projection prompts;
  // "auto" detects from the stripped note body (parity with compress mode).
  lang: "en" | "ru" | "auto";
  // The model call, injected so tests drive the recover-def LLM window (re-render +
  // re-grade) without a process-global fetch/module mock (see fidelityGate in
  // prompts.ts). Production callers (main/tty) omit it → real fw transport.
  ask?: typeof askJson;
};

// The stamp hash form the emit and the compress preflight both use: the shared 12-hex
// stampSha (graph.ts) under a `sha256:` label. Compared against the gate's src= value
// (step 6) and used to re-hash the tmp across the LLM window (step 10). Exported so the
// emit preflight (distill-core.ts) stamps through this ONE prefixed form, not a copy.
export function stampHash(bytes: string | Buffer): string {
  return `sha256:${stampSha(bytes)}`;
}

// Classify a residue item's target the way triage's targetFor stamped it:
// `thesis` → the thesis payload; `procedure:<headword>[:<n,…>]` → numbered steps under a
// `## Procedures` `### headword` subsection; anything else → a concept def term (the only
// class that calls an LLM).
function targetKind(target: string): "thesis" | "steps" | "def" {
  if (target === "thesis") return "thesis";
  if (target.startsWith("procedure:")) return "steps";
  return "def";
}

// Decode a `procedure:<headword>[:<n,…>]` steps target into its (headword, 0-based step
// indices). The trailing `:<n,…>` (1-based, comma-joined) is the step address; when absent
// the target names the WHOLE procedure and `idxs` is empty (per-step spans deferred, so a
// whole-procedure recover is not actionable — apply refuses it loud). A trailing numeric
// segment is parsed as the step list; everything before it is the headword (which may itself
// carry `:` — the parse anchors on a numeric tail, matching triage's stamp).
function procedureTarget(target: string): { headword: string; idxs: number[] } {
  const rest = target.replace(/^procedure:/, "");
  const m = rest.match(/^(.*):(\d+(?:,\d+)*)$/);
  if (!m) return { headword: rest, idxs: [] };
  const idxs = m[2]!
    .split(",")
    .map((s) => Number.parseInt(s, 10) - 1)
    .filter((n) => Number.isInteger(n) && n >= 0);
  return { headword: m[1]!, idxs };
}

// The count of numbered steps under the `### headword` subsection of `## Procedures` (0 when
// the headword or the section is absent) — used to validate a step target's indices before
// acting, so an out-of-range slot is refused (a checked recover) or ignored (an unchecked
// remove) rather than silently no-oped, or worse, deleting the wrong step. Mirrors
// editProcedure's list scan.
function procedureLen(body: string, headword: string): number {
  const range = procedureStepRange(body.split("\n"), headword);
  return range ? range.count : 0;
}

// Promote the intermediary's forced `epistemic_status: in-review` to `distilled`
// (step 12 — write-back is the promotion). The emit always forces the in-review
// line into frontmatter, so a bounded first-line replace preserves every other
// byte; a note missing the line (never emitted) is returned unchanged.
function promoteEpistemic(body: string): string {
  if (!/^epistemic_status:/m.test(body)) return body;
  return body.replace(/^epistemic_status:.*$/m, "epistemic_status: distilled");
}

// Resolve a `procedure:<headword>[:<n,…>]` steps target against the note body into its
// resolved headword (null when the `### headword` subsection is absent) and the in-range
// subset of its 0-based step indices (an out-of-range slot is dropped; the list is empty
// when the headword is gone). Apply's two step lanes — checked recover and unchecked
// remove — both resolve a step target through this ONE function, so the resolution is
// stated once and the two lanes can't drift apart.
export function resolveStepTarget(
  body: string,
  target: string,
): { hw: string | null; idxs: number[] } {
  const { headword, idxs: raw } = procedureTarget(target);
  const hw = resolveProcedureHeadword(body, headword);
  const idxs = hw ? raw.filter((idx) => idx < procedureLen(body, hw)) : [];
  return { hw, idxs };
}

// The classification result runApply fires: the deterministic op set (def re-renders,
// def removals, procedure edits, a verbatim thesis) plus the effect counters the footer
// reports. `verbatim` here counts only the pre-LLM verbatim splices (recover steps +
// thesis); the def-recover lane bumps it again per second-grade failure in runApply.
export type ClassifyResult = {
  recovered: number;
  kept: number;
  removed: number;
  verbatim: number;
  // Checked recover defs → (resolved term, source clause) to re-render under the key gate.
  defRecovers: { term: string; src: string }[];
  // Unchecked def entries whose `### headword` subsection is spliced out.
  defRemovals: string[];
  // Checked recover steps (replace) and unchecked step removals (replace:null), batched.
  procedureOps: ProcedureOp[];
  // The checked recover thesis payload set verbatim as the ## Abstract body, else null.
  thesisPara: string | null;
  // Checked recover targets with no applicable action — runApply refuses these LOUD.
  unrecoverable: string[];
};

// Classify every residue item against the note body into the op set runApply executes —
// the PURE core of the apply pass: no LLM, no fs, no stdout, a transform from (items,
// body) to a ClassifyResult. Kept as a standalone exported function, separate from the
// impure runApply, so the branch matrix (checked/unchecked × def/steps/thesis/keep, with
// target-resolution misses) is unit-testable offline, per the module's own
// helpers-test-offline contract.
//
// Counts reflect EFFECTS, not decisions: a checked keep is `kept`; a checked recover that
// resolves is `recovered`; an unchecked recover|keep that had a real removal is `removed`;
// a non-recoverable class (edge/payload/prose def with no glossary row, an out-of-range or
// whole-procedure step target, an empty payload) is collected in `unrecoverable` when
// CHECKED (runApply aborts) and silently dropped when unchecked (never in the output).
export function classifyItems(items: Item[], body: string): ClassifyResult {
  let recovered = 0;
  let kept = 0;
  let removed = 0;
  let verbatim = 0;

  const defRecovers: { term: string; src: string }[] = [];
  const defRemovals: string[] = [];
  const procedureOps: ProcedureOp[] = [];
  let thesisPara: string | null = null;
  const unrecoverable: string[] = [];

  for (const it of items) {
    const kind = targetKind(it.target);
    const payload = it.payload ?? "";
    if (it.state === "checked") {
      if (it.verb === "keep") {
        kept++; // held as shipped — no LLM, no removal
        continue;
      }
      // recover — every lane must be executable or refuse; counts reflect EFFECTS.
      if (kind === "def") {
        const term = resolveDefTerm(body, it.target);
        if (term === null) {
          unrecoverable.push(it.target); // no concept subsection → apply has no action
          continue;
        }
        defRecovers.push({ term, src: payload });
        recovered++;
      } else if (kind === "steps") {
        // A recover with no in-range slot (out-of-range or whole-procedure target — per-step
        // spans deferred) or no source directive (empty payload) cannot execute — and an empty
        // payload would DELETE the slot (replace:null), the opposite of recover. Refuse all
        // rather than no-op or delete.
        const { hw, idxs } = resolveStepTarget(body, it.target);
        const clauses = verbatimDirectives(payload);
        if (hw === null || idxs.length === 0 || clauses.length === 0) {
          unrecoverable.push(it.target);
          continue;
        }
        idxs.forEach((idx, k) => {
          procedureOps.push({ headword: hw, idx, replace: k === 0 ? clauses : null });
        });
        recovered++;
        verbatim++;
      } else {
        // thesis — an empty payload is nothing to recover; refuse rather than insert a blank.
        if (payload.trim() === "") {
          unrecoverable.push(it.target);
          continue;
        }
        thesisPara = payload;
        recovered++;
        verbatim++;
      }
    } else {
      // unchecked recover|keep → the entry is REMOVED, but only counted when there is a
      // real removal: a non-recoverable class (or an out-of-range slot) was never in the
      // output, so it stays dropped with no effect (not a phantom "removed").
      if (kind === "def") {
        const term = resolveDefTerm(body, it.target);
        if (term !== null) {
          defRemovals.push(term);
          removed++;
        }
      } else if (kind === "steps") {
        const { hw, idxs } = resolveStepTarget(body, it.target);
        for (const idx of idxs) procedureOps.push({ headword: hw!, idx, replace: null });
        if (idxs.length > 0) removed++;
      }
      // an unchecked thesis / a non-recoverable unchecked item has nothing to remove
    }
  }

  return {
    recovered,
    kept,
    removed,
    verbatim,
    defRecovers,
    defRemovals,
    procedureOps,
    thesisPara,
    unrecoverable,
  };
}

// Apply a single intermediary and return the process exit code (0 | 1 | 2). Writes the
// destination path to stdout, the applied-summary footer and every refusal to stderr;
// NEVER prompts, NEVER reads stdin. main() does `process.exit(await runApply(...))`.
// Before the write-back, the destination and the tmp are BOTH untouched on every refusal
// path — pinned by hash in apply.test.ts.
export async function runApply(tmpPath: string, opts: ApplyOpts): Promise<number> {
  const fail = (msg: string, code: number): number => {
    process.stderr.write(`distill apply: ${msg}\n`);
    return code;
  };

  // 1. path exists — a fat-finger at an already-consumed (or never-emitted) path.
  if (!existsSync(tmpPath)) {
    return fail(`no intermediary at ${tmpPath} — already applied, or re-run distill`, 2);
  }
  // 2. suffix — a non-`.tmp.md` path never derives a destination onto itself.
  const dest = destinationFor(tmpPath);
  if (dest === null) {
    return fail(`${tmpPath} is not a .tmp.md intermediary`, 2);
  }

  // 3. parse — structural grammar errors abort before any action.
  const text = readFileSync(tmpPath, "utf8");
  const hashAtStart = stampHash(text);
  const { blocks, errors: parseErrors } = parseInteract(text);
  if (parseErrors.length > 0) {
    return fail(parseErrors.map((e) => `${e.line}: ${e.message}`).join("; "), 2);
  }
  // 4. gate present — the confirm-all gate is mandatory triage policy; a blockless
  //    or gate-less intermediary is malformed (same teaching message either way).
  const gate = blocks.find((b) => b.kind === "confirm-all");
  if (!gate) {
    return fail("no confirm-all gate — this is not a triage intermediary (re-run distill)", 2);
  }
  // 5. resolve — unknown verb, unresolved pick-one, and an UNCHECKED gate abort here.
  const res = resolveInteract(blocks, { verbs: TRIAGE_VERBS });
  if (res.errors.length > 0) {
    return fail(res.errors.map((e) => e.message).join("; "), 2);
  }

  // 6. stamp — a renamed tmp (dest= basename) or an edited/absent destination
  //    (src= hash, or src=new no-clobber) refuses before the destination is derived.
  const destBase = basename(dest);
  if (gate.dest !== destBase) {
    return fail(
      `intermediary dest=${gate.dest ?? "(none)"} does not match ${destBase} — was the tmp renamed?`,
      2,
    );
  }
  if (gate.src === "new") {
    if (existsSync(dest)) {
      return fail(`destination already exists: ${dest} (src=new refuses to clobber)`, 2);
    }
  } else {
    const current = existsSync(dest) ? stampHash(readFileSync(dest, "utf8")) : null;
    if (current !== gate.src) {
      return fail(`destination changed since distill: ${dest} — re-run distill`, 2);
    }
  }

  // The residue items (every non-gate block); the gate itself is skipped.
  const items = blocks.filter((b) => b.kind !== "confirm-all").flatMap((b) => b.items);

  // 7. classify every item into deterministic ops (no LLM, no write). This precedes
  //    the key gate on purpose: a checked recover that resolves to no actionable target
  //    (an edge/payload/prose residue class, or a def whose concept subsection is gone) is a
  //    LOST reviewer decision if allowed to no-op, so it aborts LOUD below — and only a
  //    checked recover DEF that actually resolves is what forces the key gate.
  let body = stripInteract(text);
  const { body: bodyNoFront } = parseFrontmatter(body);
  const lang = opts.lang === "auto" ? detectLang(bodyNoFront) : opts.lang;
  const ask = opts.ask ?? askJson;
  // The ## Abstract orientation seeds the fidelity re-grade's thesis arg (the canonical
  // analogue of the old tie-together line).
  const tie0 = parseCanonicalNote(bodyNoFront).abstract;

  // The classification is the pure core (classifyItems): a transform from (items, body)
  // to the op set + counters, with NO I/O. `verbatim` is `let` because the def-recover lane
  // below bumps it per second-grade failure; every other field is final here.
  const cls = classifyItems(items, body);
  const {
    recovered,
    kept,
    removed,
    defRecovers,
    defRemovals,
    procedureOps,
    thesisPara,
    unrecoverable,
  } = cls;
  let verbatim = cls.verbatim;

  // A checked recover apply cannot execute is refused LOUD — never silently swallowed;
  // a lost reviewer decision is the format's disaster class (interact.ts fails a mistyped
  // item for the same reason). Fires before the key gate and before any write.
  if (unrecoverable.length > 0) {
    return fail(
      `checked recover with no applicable action: ${unrecoverable.join(", ")} — this residue is not recoverable via apply; uncheck it (the source is unchanged) and re-add by hand if needed`,
      2,
    );
  }

  // 8. key gate — only a checked recover DEF that resolved calls an LLM. A checked
  //    recover of procedure steps / the thesis is verbatim (no LLM); keep is a no-op.
  if (defRecovers.length > 0 && !process.env.FIREWORKS_API_KEY) {
    return fail("FIREWORKS_API_KEY not set — a checked recover needs it; nothing written", 1);
  }

  // 9. fire verbs — the LLM window: re-render each checked recover def, re-grade once, and
  // splice either the re-render (translated/inconclusive) or the source's own verbatim
  // clause (a second grade failure) into its `### headword` concept subsection.
  const defSplices: { term: string; def: string }[] = [];
  for (const d of defRecovers) {
    let finalDef: string;
    try {
      const rr = await ask<{ def: string }>(
        EXTRACT,
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
        verbatim++;
      } else {
        finalDef = reRendered;
      }
    } catch (e) {
      rethrowIfBug(e, "apply-recover-def");
      // a transient re-render/grade flake floors to the source's own clause rather
      // than dropping the entry — a verbatim splice cannot invert.
      finalDef = verbatimDef(d.term, d.src);
      verbatim++;
    }
    defSplices.push({ term: d.term, def: finalDef });
  }

  for (const s of defSplices) body = spliceDef(body, s.term, s.def);
  for (const term of defRemovals) body = spliceDef(body, term, null);
  if (procedureOps.length) body = editProcedure(body, procedureOps);

  // A checked recover thesis sets the ## Abstract body verbatim. There is NO re-projection
  // step on a canonical note: the abstract is authored at extract time, not re-derived from
  // concept defs, so a def recover leaves it as-authored — the old renderProse/
  // replaceHeadProse head-prose chain has no canonical analogue.
  if (thesisPara !== null) body = insertThesis(body, thesisPara);

  // 10. re-hash the tmp — an Obsidian Sync rewrite during the LLM window invalidates
  //     the decision set we acted on; refuse rather than write a stale apply.
  if (stampHash(readFileSync(tmpPath, "utf8")) !== hashAtStart) {
    return fail("intermediary changed during apply — nothing written; re-run apply", 2);
  }
  // 11. re-verify the destination stamp for the overwrite case. Step 6's src=sha256 check
  //     read dest BEFORE the (seconds-long) LLM window; an edit landing during that window
  //     (a cross-device Sync push, a hand edit) would otherwise be clobbered by the atomic
  //     replace below — the same class of loss the start-of-run stamp exists to refuse, just
  //     inside the apply's own window. The src=new case needs no re-check: its linkSync is
  //     no-clobber, so a destination that appeared meanwhile fails EEXIST (handled below).
  if (gate.src !== "new") {
    const current = existsSync(dest) ? stampHash(readFileSync(dest, "utf8")) : null;
    if (current !== gate.src) {
      return fail(`destination changed during apply: ${dest} — nothing written; re-run distill`, 2);
    }
  }

  // 12. promote the epistemic status, then 13. write atomically and 14. consume.
  const finalBody = promoteEpistemic(body);
  const partial = `${dest}.apply.partial`;
  writeFileSync(partial, finalBody);
  if (gate.src === "new") {
    // no-clobber link: EEXIST maps to the src=new refusal (exit 2); the helper
    // cleans the partial itself on any failure, so only the success unlink remains here.
    const link = linkNoClobber(partial, dest);
    if (!link.ok) {
      return fail(`destination already exists: ${dest} (src=new refuses to clobber)`, 2);
    }
    unlinkSync(partial);
  } else {
    renameSync(partial, dest); // atomic replace of the verified destination
  }
  unlinkIfPresent(tmpPath);

  process.stdout.write(`${dest}\n`);
  process.stderr.write(
    `— applied: ${recovered} recovered · ${kept} kept · ${removed} removed (${verbatim} verbatim)\n`,
  );
  return 0;
}

// ---- pure seams (exported for offline unit tests) ----

// The write-back destination for an intermediary path: `<x>.tmp.md` → the sibling
// `<x>.md`, resolved absolute (stdout line 1 must reopen from any later cwd).
// Returns null when the path does not end `.tmp.md` — the suffix check (step 2)
// that keeps a fat-fingered `apply note.md` from ever deriving a destination onto
// the note it was told to read. basename(destinationFor(tmp)) is also the value
// the gate's `dest=` stamp is verified against (step 6), so a hand-renamed tmp
// refuses instead of silently creating `<other>.md`.
export function destinationFor(tmpPath: string): string | null {
  if (!tmpPath.endsWith(".tmp.md")) return null;
  return resolve(`${tmpPath.slice(0, -".tmp.md".length)}.md`);
}

// ---- canonical section/subsection locators (shared by the body-editing primitives) ----

const SUB_HEAD_RE = /^###\s+(.+?)\s*$/; // a `### headword` subsection heading
const STEP_RE = /^\s*\d+\.\s(.*)$/; // a numbered `N. step` line, capturing the step text

// The line range of a `### headword` subsection under `## <section>`: [subStart, subEnd) where
// subStart is the `### headword` line and subEnd is the next `### ` (or the section's end).
// Fence-aware via splitSections. null when the section or the headword is absent.
function subsectionRange(
  lines: string[],
  section: string,
  headword: string,
): { subStart: number; subEnd: number } | null {
  const sec = splitSections(lines.join("\n")).find((s) => s.name === section);
  if (!sec) return null;
  let subStart = -1;
  for (let i = sec.start + 1; i < sec.end; i++) {
    const m = SUB_HEAD_RE.exec(lines[i]!);
    if (m && m[1] === headword) {
      subStart = i;
      break;
    }
  }
  if (subStart < 0) return null;
  let subEnd = sec.end;
  for (let i = subStart + 1; i < sec.end; i++) {
    if (/^###\s/.test(lines[i]!)) {
      subEnd = i;
      break;
    }
  }
  return { subStart, subEnd };
}

// The inclusive line range and count of the numbered step list under a `## Procedures`
// `### headword` subsection (null when absent) — used to validate a step target's indices
// and to locate the list for editing.
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

// The `### headword`s under a `## <section>` block, in document order.
function headwordsUnder(body: string, section: string): string[] {
  const lines = body.split("\n");
  const sec = splitSections(body).find((s) => s.name === section);
  if (!sec) return [];
  const out: string[] = [];
  for (let i = sec.start + 1; i < sec.end; i++) {
    const m = SUB_HEAD_RE.exec(lines[i]!);
    if (m) out.push(m[1]!);
  }
  return out;
}

// Edit the `## Concepts` note body: replace the DEFINITION LINE (the first non-blank,
// non-bullet line — its trailing byte-anchor preserved) of the `### headword` subsection when
// `def` is a string, or DELETE the whole subsection (with its preceding blank separator) when
// `def` is null. A headword with no matching subsection leaves the body unchanged (a
// removed-then-recovered race is a no-op, not a crash). Every other subsection, its bullets,
// and the anchors are byte-preserved. The caller resolves a possibly-degraded target to the
// real headword via resolveDefTerm BEFORE calling this (spliceDef matches by exact headword).
export function spliceDef(body: string, term: string, def: string | null): string {
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
// target like `procedure:<hw>:2,3` expands to one op per index (all sharing the headword).
export type ProcedureOp = { headword: string; idx: number; replace: string[] | null };

// Apply every ProcedureOp in one rewrite, PER HEADWORD: ops are grouped by headword, and each
// headword's numbered list is rebuilt against its ORIGINAL indices (deletions drop,
// replacements substitute, untouched slots survive) and RENUMBERED from 1. Batching per list
// keeps `procedure:<hw>:2` meaning that headword's 2nd step regardless of an earlier deletion.
// A headword with no `### headword` procedure list is skipped (the caller already validated
// in-range targets; a stale one is a no-op, not a crash).
export function editProcedure(body: string, ops: ProcedureOp[]): string {
  let lines = body.split("\n");
  const byHead = new Map<string, ProcedureOp[]>();
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

// Resolve a residue item's (possibly degraded) def target back to the actual `### headword`
// under `## Concepts`. Exact match first (the common case: target === headword); then the
// degraded case — the emit shipped `safeHandle(headword)` because the headword carried a
// backtick or newline, so match the headword whose `safeHandle` equals the target. Returns the
// real headword, or null when none matches (the caller counts it removed/skipped rather than
// crashing) — the emit transform run backward, no handle→headword channel in the file.
export function resolveDefTerm(body: string, target: string): string | null {
  const heads = headwordsUnder(body, "concepts");
  if (heads.includes(target)) return target; // exact (the common case)
  return heads.find((h) => safeHandle(h) === target) ?? null; // the emit run backward
}

// Resolve a `procedure:<headword>` target back to the actual `### headword` under
// `## Procedures` — exact then safeHandle-degraded, the procedure-side twin of resolveDefTerm.
function resolveProcedureHeadword(body: string, target: string): string | null {
  const heads = headwordsUnder(body, "procedures");
  if (heads.includes(target)) return target;
  return heads.find((h) => safeHandle(h) === target) ?? null;
}

// Unlink a path, tolerating ENOENT — the final consume step (step 14). A crash
// between the dest write and this unlink, or a racing second applier, may have
// already removed the tmp; its absence is success, not an error. Any other errno
// (EPERM, EISDIR) still throws.
export function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
