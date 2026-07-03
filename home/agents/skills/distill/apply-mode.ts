// apply-mode — the second pass of the interactive-text pipeline: consume a
// `<dest>.tmp.md` intermediary a reviewer worked through, fire the checked
// decisions against the real note seams, and write the scaffold-free note back to
// `<dest>.md`. The grammar core (parse/resolve/strip) lives in interact.ts; the
// triage instance (verb vocabulary, the emit that produced this file) lives in
// triage.ts; this module owns the verb ACTIONS and the write-back discipline.
//
// PHASE 4 STATUS: the surface below is FROZEN and the bodies are UNIMPLEMENTED
// (each throws). apply.test.ts is the red corpus that pins the contract ahead of
// the implementation; the green pass turns the bodies on without touching a
// signature. Nothing here reaches production until the user rebuilds the nix-store
// binary (the SKILL.md flip is Phase 6).
//
// ── Check order (plan §4, FROZEN — the sequence every refusal is measured against)
//   1. path exists            ENOENT → exit 2 "no intermediary at <path> — already
//                             applied, or re-run distill" (the fat-finger's first error)
//   2. suffix                 non-`.tmp.md` → exit 2 (destinationFor returns null)
//   3. parse + resolve        parseInteract structural errors, then resolveInteract
//                             against TRIAGE_VERBS — unknown verb, unresolved pick-one,
//                             an UNCHECKED confirm-all gate → exit 2, nothing executed
//   4. gate present           the confirm-all gate is MANDATORY (triage policy): zero
//                             confirm-all blocks — including a blockless file — is
//                             malformed, exit 2 with the same teaching message
//   5. stamp                  dest= basename must equal basename(destinationFor(tmp))
//                             (a renamed tmp refuses); src=sha256 must equal the
//                             destination's current hash (an edited dest refuses);
//                             src=new requires the destination ABSENT (no-clobber)
//   6. key gate               iff ≥1 CHECKED `recover` whose target is a DEF (the only
//                             action that calls an LLM) and FIREWORKS_API_KEY is unset
//                             → exit 1, nothing written. A checked recover of a
//                             workflow group or the thesis is verbatim (no LLM, no key);
//                             a checked `keep` is a no-op (no LLM, no key).
//   7. fire verbs             in document order, IN MEMORY over stripInteract(text):
//                             checked recover def → renderEntryPrompt + one fidelityGate;
//                               grade "residue" (failed again) → verbatimDef splice;
//                               grade "translated"/"inconclusive" → keep the re-render;
//                             checked recover workflow:<idxs> → verbatimDirectives splice
//                               (no LLM); checked recover thesis → payload verbatim after
//                               the H1 (no LLM); checked keep → the entry stays as shipped;
//                             UNCHECKED recover|keep → the entry is REMOVED (glossary row
//                               deleted / workflow steps deleted / thesis absent) — the
//                               uniform per-block default (plan §1).
//   8. re-project             iff ≥1 def was RE-RENDERED (a checked recover def): one
//                             renderProse call over the whole updated entry set replaces
//                             the head prose. Removal-only and keep-only applies SKIP it
//                             and stay fully offline (a reject-all triage needs no key).
//   9. re-hash tmp            re-read the tmp and compare to the hash taken at step 1;
//                             a mismatch (Obsidian Sync rewrote it during the LLM window)
//                             → exit 2 "intermediary changed during apply", nothing written
//  10. strip + epistemic      set `epistemic_status: distilled` (the emit forced
//                             `in-review`; write-back is the promotion)
//  11. atomic dest write      overwrite case → rename a same-dir temp onto dest (atomic
//                             replace); new case → link no-clobber
//  12. unlink tmp             ENOENT tolerated (a racing applier may have removed it)
//
// ── Success stdout (standalone apply): two lines, exit 0.
//   line 1  the destination path (absolute)
//   line 2  `— applied: N recovered · M kept · K removed (V verbatim) · <reproj>`
//           N = checked recover items · M = checked keep items · K = removed
//           (unchecked recover|keep) · V = entries written verbatim (recover defs whose
//           second grade failed + every recover workflow/thesis) · reproj is
//           `re-projected` iff ≥1 def re-rendered, else `re-projection skipped`.
//
// ── Exit codes: 0 applied · 1 key missing AND a checked recover def needed it
//   (nothing written) · 2 everything else refused (missing/malformed/gate/stamp/
//   suffix/dest-mismatch/mid-mutation). Apply has NO exit 3 and NO exit 4 (plan §4,
//   toolsmith fold-in 1): the mandatory gate makes "no decision blocks" a subset of
//   "missing gate", so a no-op code would be dead surface.
//
// PURE by contract for the exported helpers below (no fs, no LLM) so they unit-test
// offline; runApply is the only impure export.

import {
  existsSync,
  linkSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import { createHash } from "node:crypto";
import { parseInteract, resolveInteract, stripInteract } from "./interact.ts";
import { TRIAGE_VERBS, safeHandle } from "./triage.ts";
import { askJson, EXTRACT } from "./fw.ts";
import {
  fidelityGate,
  renderEntryPrompt,
  verbatimDef,
  verbatimDirectives,
} from "./prompts.ts";
import { parseDistilled, renderProse } from "./render-mode.ts";
import { parseDescription, parseFrontmatter } from "./frontmatter.ts";
import { detectLang } from "./text.ts";

// ---- runApply: the orchestrator ----

export type ApplyOpts = {
  /// Overrides body-language detection for the re-render/re-projection prompts;
  /// "auto" detects from the stripped note body (parity with compress mode).
  lang: "en" | "ru" | "auto";
};

/// The stamp hash form the emit and the compress preflight both use: a 12-hex
/// sha256 prefix of the destination's current bytes. Compared against the gate's
/// src= value (step 5) and used to re-hash the tmp across the LLM window (step 9).
function stampHash(bytes: string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}`;
}

/// Classify a residue item's target the way triage's targetFor stamped it:
/// `thesis` → the thesis payload; `workflow:<n,…>` → the numbered `## Workflow`
/// slots; anything else → a glossary def term (the only class that calls an LLM).
function targetKind(target: string): "thesis" | "steps" | "def" {
  if (target === "thesis") return "thesis";
  if (/^workflow:/.test(target)) return "steps";
  return "def";
}

/// `workflow:2,3` → the 0-based list indices [1, 2] (the inverse of triage's
/// 1-based stamp), dropping any malformed slot.
function workflowIdxs(target: string): number[] {
  return target
    .replace(/^workflow:/, "")
    .split(",")
    .map((s) => Number.parseInt(s, 10) - 1)
    .filter((n) => Number.isInteger(n) && n >= 0);
}

/// Promote the intermediary's forced `epistemic_status: in-review` to `distilled`
/// (step 10 — write-back is the promotion). The emit always forces the in-review
/// line into frontmatter, so a bounded first-line replace preserves every other
/// byte; a note missing the line (never emitted) is returned unchanged.
function promoteEpistemic(body: string): string {
  if (!/^epistemic_status:/m.test(body)) return body;
  return body.replace(/^epistemic_status:.*$/m, "epistemic_status: distilled");
}

/// Apply a single intermediary and return the process exit code (0 | 1 | 2).
/// Writes its own two-line success stdout and every refusal to stderr; NEVER
/// prompts, NEVER reads stdin. main() does `process.exit(await runApply(...))`.
/// Before the write-back the destination and the tmp are BOTH untouched on every
/// refusal path (constraint 7, pinned by hash in apply.test.ts).
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
  // 3b. resolve — unknown verb, unresolved pick-one, and an UNCHECKED gate abort here.
  const res = resolveInteract(blocks, { verbs: TRIAGE_VERBS });
  if (res.errors.length > 0) {
    return fail(res.errors.map((e) => e.message).join("; "), 2);
  }

  // 5. stamp — a renamed tmp (dest= basename) or an edited/absent destination
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

  // 6. key gate — only a CHECKED recover DEF calls an LLM. A checked recover of a
  //    workflow group / the thesis is verbatim (no LLM); a checked keep is a no-op.
  const needsKey = items.some(
    (it) => it.state === "checked" && it.verb === "recover" && targetKind(it.target) === "def",
  );
  if (needsKey && !process.env.FIREWORKS_API_KEY) {
    return fail("FIREWORKS_API_KEY not set — a checked recover needs it; nothing written", 1);
  }

  // 7. fire verbs in document order, in memory over the scaffold-free note.
  let body = stripInteract(text);
  const { body: bodyNoFront } = parseFrontmatter(body);
  const lang = opts.lang === "auto" ? detectLang(bodyNoFront) : opts.lang;
  const tie0 = parseDistilled(bodyNoFront).tie;

  let recovered = 0;
  let kept = 0;
  let removed = 0;
  let verbatim = 0;
  let reprojNeeded = false;

  const defRecovers: { term: string; src: string }[] = [];
  const defRemovals: string[] = [];
  const workflowOps: WorkflowOp[] = [];
  let thesisPara: string | null = null;

  for (const it of items) {
    const kind = targetKind(it.target);
    const payload = it.payload ?? "";
    if (it.state === "checked") {
      if (it.verb === "keep") {
        kept++; // held as shipped — no LLM, no removal
        continue;
      }
      // recover
      recovered++;
      if (kind === "def") {
        const term = resolveDefTerm(body, it.target);
        if (term) defRecovers.push({ term, src: payload });
      } else if (kind === "steps") {
        const idxs = workflowIdxs(it.target);
        const clauses = verbatimDirectives(payload);
        idxs.forEach((idx, k) => {
          workflowOps.push({ idx, replace: k === 0 && clauses.length ? clauses : null });
        });
        verbatim++;
      } else {
        thesisPara = payload;
        verbatim++;
      }
    } else {
      // unchecked recover|keep → the entry is REMOVED (uniform per-block default)
      removed++;
      if (kind === "def") {
        const term = resolveDefTerm(body, it.target);
        if (term) defRemovals.push(term);
      } else if (kind === "steps") {
        for (const idx of workflowIdxs(it.target)) workflowOps.push({ idx, replace: null });
      }
      // an unchecked thesis has nothing in the body to remove
    }
  }

  // The LLM window: re-render each checked recover def, re-grade once, and splice
  // either the re-render (translated/inconclusive) or the source's own verbatim
  // clause (a second grade failure). A glossary change forces one re-projection.
  const defSplices: { term: string; def: string }[] = [];
  for (const d of defRecovers) {
    const entry = { term: d.term, def: "", relations: [], source: [] };
    let finalDef: string;
    try {
      const rr = await askJson<{ def: string }>(
        EXTRACT,
        renderEntryPrompt(entry, d.src, lang),
        1024,
      );
      const reRendered = (rr.def ?? "").trim();
      const graded = await fidelityGate(tie0, body, [
        { term: d.term, def: reRendered, sourceText: d.src },
      ]);
      const grade = graded.concepts[0]?.grade ?? "translated";
      if (grade === "residue" || !reRendered) {
        finalDef = verbatimDef(d.term, d.src);
        verbatim++;
      } else {
        finalDef = reRendered;
      }
    } catch {
      // a transient re-render/grade flake floors to the source's own clause rather
      // than dropping the entry — a verbatim splice cannot invert.
      finalDef = verbatimDef(d.term, d.src);
      verbatim++;
    }
    defSplices.push({ term: d.term, def: finalDef });
    reprojNeeded = true;
  }

  for (const s of defSplices) body = spliceDef(body, s.term, s.def);
  for (const term of defRemovals) body = spliceDef(body, term, null);
  if (workflowOps.length) body = editWorkflow(body, workflowOps);

  // 8. re-project the head prose from the whole updated glossary (one call, never
  //    per-entry). Removal-only and keep-only applies never reach this (offline).
  if (reprojNeeded) {
    const { front } = parseFrontmatter(body);
    const { body: noFront } = parseFrontmatter(body);
    const { tie, entries } = parseDistilled(noFront);
    const prose = await renderProse(parseDescription(front), tie, entries, lang);
    if (prose) body = replaceHeadProse(body, prose);
  }
  // A checked recover thesis is prepended AFTER re-projection, not before: replaceHeadProse
  // rewrites the entire H1→first-`##` region, which is exactly where insertThesis lands the
  // paragraph — inserting first would splice the verbatim thesis into the span the
  // re-projection then overwrites, so it would vanish whenever a def was ALSO recovered
  // (reprojNeeded). Prepending last keeps the thesis paragraph verbatim above the
  // re-projected connective prose; a thesis-only recover (reprojNeeded false) is unaffected.
  if (thesisPara !== null) body = insertThesis(body, thesisPara);

  // 9. re-hash the tmp — an Obsidian Sync rewrite during the LLM window invalidates
  //    the decision set we acted on; refuse rather than write a stale apply.
  if (stampHash(readFileSync(tmpPath, "utf8")) !== hashAtStart) {
    return fail("intermediary changed during apply — nothing written; re-run apply", 2);
  }
  // 9b. re-verify the destination stamp for the overwrite case. Step 5's src=sha256 check
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

  // 10. promote the epistemic status, then 11. write atomically and 12. consume.
  const finalBody = promoteEpistemic(body);
  const partial = `${dest}.apply.partial`;
  writeFileSync(partial, finalBody);
  if (gate.src === "new") {
    try {
      linkSync(partial, dest);
    } catch (e) {
      try {
        unlinkSync(partial);
      } catch {}
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        return fail(`destination already exists: ${dest} (src=new refuses to clobber)`, 2);
      }
      throw e;
    }
    unlinkSync(partial);
  } else {
    renameSync(partial, dest); // atomic replace of the verified destination
  }
  unlinkIfPresent(tmpPath);

  const reproj = reprojNeeded ? "re-projected" : "re-projection skipped";
  process.stdout.write(
    `${dest}\n— applied: ${recovered} recovered · ${kept} kept · ${removed} removed (${verbatim} verbatim) · ${reproj}\n`,
  );
  return 0;
}

// ---- pure seams (exported for offline unit tests) ----

/// The write-back destination for an intermediary path: `<x>.tmp.md` → the sibling
/// `<x>.md`, resolved absolute (stdout line 1 must reopen from any later cwd).
/// Returns null when the path does not end `.tmp.md` — the suffix check (step 2)
/// that keeps a fat-fingered `apply note.md` from ever deriving a destination onto
/// the note it was told to read. basename(destinationFor(tmp)) is also the value
/// the gate's `dest=` stamp is verified against (step 5), so a hand-renamed tmp
/// refuses instead of silently creating `<other>.md`.
export function destinationFor(tmpPath: string): string | null {
  if (!tmpPath.endsWith(".tmp.md")) return null;
  return resolve(`${tmpPath.slice(0, -".tmp.md".length)}.md`);
}

// escCell, replicated from assemble.ts (not exported there): a glossary cell holds
// neither a raw pipe nor a newline, so escape the one and collapse the other.
function escCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

// Parse a `| a | b |` table row into its unescaped, trimmed cells; null when the
// line is not a table row. The inverse of escCell + assembleBody's row format.
function tableCells(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith("|")) return null;
  return t
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.replace(/\\\|/g, "|").trim());
}

// A glossary DATA row (not the header, not the `---` separator).
function isGlossDataRow(cells: string[]): boolean {
  if (cells.length < 2) return false;
  const term = cells[0]!;
  if (term.toLowerCase() === "term") return false;
  if (/^:?-{3,}:?$/.test(term.replace(/\s/g, ""))) return false;
  return true;
}

/// Edit the `## Glossary` table in a note body: replace the definition cell of the
/// row whose (unescaped, trimmed) term cell equals `term` when `def` is a string,
/// or DELETE that row when `def` is null. The new def is escCell-normalized (pipes
/// escaped, newlines collapsed — a table cell cannot hold either). A term with no
/// matching row leaves the body unchanged (a removed-then-recovered race is a no-op,
/// not a crash). Other rows, the header, and the separator are byte-preserved.
/// The caller resolves a possibly-degraded target to the real row term via
/// resolveDefTerm BEFORE calling this (spliceDef itself matches by exact term).
export function spliceDef(body: string, term: string, def: string | null): string {
  const lines = body.split("\n");
  const out: string[] = [];
  let matched = false;
  for (const line of lines) {
    if (!matched) {
      const cells = tableCells(line);
      if (cells && isGlossDataRow(cells) && cells[0] === term) {
        matched = true;
        if (def === null) continue; // delete the row
        out.push(`| ${escCell(term)} | ${escCell(def)} |`);
        continue;
      }
    }
    out.push(line);
  }
  return matched ? out.join("\n") : body; // absent term ⇒ byte-identical no-op
}

/// One instruction against the emitted `## Workflow` list, keyed by 0-based index
/// into that list (the same indices `Residue.stepIdxs` carried, which emit rendered
/// as the 1-based `workflow:<n,…>` target). `replace` is the new step text(s) for
/// that slot (a verbatimDirectives splice may yield several); `replace: null`
/// DELETES the slot. A group target like `workflow:2,3` expands to one op per index.
export type WorkflowOp = { idx: number; replace: string[] | null };

/// Apply every WorkflowOp against the `## Workflow` list in one rewrite: all ops are
/// resolved against the ORIGINAL indices, then the list is rebuilt (deletions drop,
/// replacements substitute, untouched slots survive) and RENUMBERED from 1. Applying
/// per-op would shift indices under later ops; batching keeps `workflow:2` meaning
/// the 2nd emitted step regardless of an earlier deletion. A body with no `## Workflow`
/// section is returned unchanged.
export function editWorkflow(body: string, ops: WorkflowOp[]): string {
  const lines = body.split("\n");
  const wfIdx = lines.findIndex((l) => /^##\s+Workflow\b/i.test(l.trim()));
  if (wfIdx < 0) return body; // no ## Workflow section ⇒ unchanged
  const itemRe = /^\s*\d+\.\s(.*)$/;
  let start = -1;
  let end = -1;
  for (let i = wfIdx + 1; i < lines.length; i++) {
    if (itemRe.test(lines[i]!)) {
      if (start < 0) start = i;
      end = i;
    } else if (start >= 0) {
      break; // the numbered list ended
    } else if (lines[i]!.trim() === "") {
      continue; // blank line between heading and list
    } else {
      break; // non-list content before any item
    }
  }
  if (start < 0) return body; // heading with no numbered list
  const orig = lines.slice(start, end + 1).map((l) => l.match(itemRe)![1]!);
  const opByIdx = new Map(ops.map((o) => [o.idx, o]));
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
  return [...lines.slice(0, start), ...rendered, ...lines.slice(end + 1)].join("\n");
}

/// Insert `para` as the note's opening paragraph, immediately after the H1 (or at the
/// top when there is no H1) and before the existing head prose — the checked
/// `recover: thesis` action, verbatim, no LLM. Idempotent shape: exactly one blank
/// line separates the inserted paragraph from what follows.
export function insertThesis(body: string, para: string): string {
  const lines = body.split("\n");
  const h1 = lines.findIndex((l) => /^#\s/.test(l));
  if (h1 < 0) return `${para}\n\n${body}`; // no H1 ⇒ at the very top
  const before = lines.slice(0, h1 + 1);
  const after = lines.slice(h1 + 1);
  let k = 0;
  while (k < after.length && after[k]!.trim() === "") k++; // drop leading blanks
  return [...before, "", para, "", ...after.slice(k)].join("\n");
}

/// Replace the head-prose region (everything between the H1 and the first `## `
/// section heading) with `prose` — the re-projection sink after ≥1 def re-render.
/// The H1, the `## Workflow`/`## Glossary`/tail sections keep their place; only the
/// connective prose the glossary feeds is re-derived. A body with no `## ` heading
/// replaces everything after the H1.
export function replaceHeadProse(body: string, prose: string): string {
  const lines = body.split("\n");
  const h1 = lines.findIndex((l) => /^#\s/.test(l));
  const firstH2 = lines.findIndex((l) => /^##\s/.test(l.trim()));
  const head = h1 < 0 ? [] : lines.slice(0, h1 + 1);
  const tail = firstH2 < 0 ? [] : lines.slice(firstH2);
  const parts: string[] = [];
  if (head.length) parts.push(...head, "");
  parts.push(prose);
  if (tail.length) parts.push("", ...tail);
  return parts.join("\n");
}

/// Resolve a residue item's (possibly degraded) def target back to the actual
/// glossary-row term. Exact match first (the common case: target === term); then the
/// degraded case — the emit shipped `safeHandle(term)` because the term carried a
/// backtick or newline, so match the row whose `safeHandle(rowTerm)` equals the
/// target. Returns the real row term, or null when no row matches (the caller counts
/// it removed/skipped rather than crashing). This is the Phase-3 emit seam closed at
/// apply WITHOUT a handle→term channel in the file — the emit transform run backward.
export function resolveDefTerm(body: string, target: string): string | null {
  const terms: string[] = [];
  for (const line of body.split("\n")) {
    const cells = tableCells(line);
    if (cells && isGlossDataRow(cells)) terms.push(cells[0]!);
  }
  if (terms.includes(target)) return target; // exact (the common case)
  const degraded = terms.find((t) => safeHandle(t) === target); // the emit run backward
  return degraded ?? null;
}

/// Unlink a path, tolerating ENOENT — the final consume step (step 12). A crash
/// between the dest write and this unlink, or a racing second applier, may have
/// already removed the tmp; its absence is success, not an error. Any other errno
/// (EPERM, EISDIR) still throws.
export function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
