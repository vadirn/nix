// execute — the GENERIC interact executor: the producer-agnostic half of the
// interact write-back protocol. An interact intermediary (`<dest>.tmp.md`) is a
// review artifact whose grammar core (parse/resolve/strip) lives in interact.ts;
// this module owns the surrounding DISCIPLINE — the stamp preflight, the mid-run
// re-verification, and the atomic write-back — with the producer's own actions
// supplied as a single `InteractBinding`.
//
// Nothing here knows any producer's verb vocabulary. Distill's binding lives in
// `@/distill/app/apply-mode.ts` (`distillApplyHook`) — the only binding today. A
// card-inbox or destination-triage consumer could bind the same seam later; the
// executor is generic precisely so they would not need their own write-back discipline.
//
// ── Check order — the sequence every refusal is measured against, in order.
//    Steps 7–9 and 12 are the BINDING's (they run inside `binding.apply`); every
//    other step is this module's.
//   1. path exists            ENOENT → exit 2 "no intermediary at <path> — already
//                             applied, or re-run distill" (the fat-finger's first error)
//   2. suffix                 non-`.tmp.md` → exit 2 (destinationFor returns null)
//   3. parse                  parseInteract structural errors → exit 2, nothing executed
//   4. gate present           the confirm-all gate is MANDATORY (triage policy): zero
//                             confirm-all blocks — including a blockless file — is
//                             malformed, exit 2 with the same teaching message
//   5. resolve                resolveInteract against `binding.verbs` — unknown verb,
//                             unresolved pick-one, or an UNCHECKED confirm-all gate →
//                             exit 2, nothing executed
//   6. stamp                  dest= basename must equal basename(destinationFor(tmp))
//                             (a renamed tmp refuses); src=sha256 must equal the
//                             destination's current hash (an edited dest refuses);
//                             src=new requires the destination ABSENT (no-clobber)
//  7–9, 12  BINDING           `binding.apply(ctx)` classifies the items, refuses a lost
//                             reviewer decision (exit 2) or a missing key (exit 1), fires
//                             the producer's verbs IN MEMORY over stripInteract(text), and
//                             returns the final body plus the stderr footer. This is the
//                             ONLY producer-specific input.
//  10. re-hash tmp            re-read the tmp and compare to the hash taken at step 1;
//                             a mismatch (Obsidian Sync rewrote it during the binding's
//                             LLM window) → exit 2, nothing written
//  11. re-verify dest         overwrite case only: re-read the destination's hash and
//                             compare to step 6's src= value again, since that check ran
//                             before the (seconds-long) binding window → a mismatch exits 2
//  13. atomic dest write      overwrite case → rename a same-dir temp onto dest (atomic
//                             replace); new case → link no-clobber
//  14. unlink tmp             ENOENT tolerated (a racing applier may have removed it)
//
// ── Success output: the destination path on stdout (the only stdout line), the
//    binding's footer on stderr, exit 0.
//
// ── Exit codes: 0 applied · 1 the binding refused for a missing key (nothing
//    written) · 2 everything else refused. Refusal text is prefixed with
//    `binding.label` so each consumer names itself.

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  type Item,
  parseInteract,
  resolveInteract,
  stripInteract,
} from "@/distill/review/interact.ts";
import type { askJson } from "@skills/llm/llm.ts";
import { linkNoClobber } from "@/core/fs.ts";
import { stampSha } from "@/distill/graph/graph.ts";

// ---- the seam ----

// What a binding's apply hook returns: either a refusal (carrying the exit code and the
// message the executor prints under the binding's label) or the final note body plus the
// stderr footer the success path prints.
export type InteractApplyResult =
  | { kind: "refuse"; code: 1 | 2; message: string } // key-missing → 1, lost-decision → 2
  | { kind: "write"; body: string; footer: string }; // final body + stderr footer

// The producer-specific middle of the run: classify → refuse-on-lost-decision → key gate →
// mutate → return the final body. Receives the resolved items, the scaffold-free body to
// edit, and the run options (lang, ask) runInteractApply forwards from its own opts argument.
// Every field here is read by the one binding that exists (apply-mode.ts); a field a real
// consumer needs but this ctx lacks — the raw intermediary text, the derived destination, the
// gate block — returns when that consumer arrives, not before.
export type InteractApplyHook = (ctx: {
  items: Item[];
  strippedBody: string;
  lang: "en" | "ru" | "auto";
  ask?: typeof askJson;
}) => Promise<InteractApplyResult>;

// One producer bound to the protocol: the label every refusal is prefixed with, the verb
// vocabulary step 5 resolves against, and the apply hook.
export type InteractBinding = {
  label: string;
  verbs: readonly string[];
  apply: InteractApplyHook;
};

// The run options threaded from the caller through to the hook.
export type InteractApplyOpts = {
  // Overrides body-language detection for a binding's re-render prompts; "auto" lets the
  // binding detect from the body.
  lang: "en" | "ru" | "auto";
  // The model call, injected so tests drive a binding's LLM window without a
  // process-global fetch/module mock. Production callers omit it → the real transport.
  ask?: typeof askJson;
};

// The stamp hash form the emit and the compress preflight both use: the shared 12-hex
// stampSha (graph.ts) under a `sha256:` label. Compared against the gate's src= value
// (step 6) and used to re-hash the tmp across the binding window (step 10). Exported so the
// emit preflight (distill-core.ts) stamps through this ONE prefixed form, not a copy.
export function stampHash(bytes: string | Buffer): string {
  return `sha256:${stampSha(bytes)}`;
}

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

// Write one refusal to stderr under the binding's label and return its exit code.
function fail(label: string, msg: string, code: number): number {
  process.stderr.write(`${label}: ${msg}\n`);
  return code;
}

// Apply a single intermediary through `binding` and return the process exit code (0 | 1 | 2).
// Writes the destination path to stdout, the binding's footer and every refusal to stderr;
// NEVER prompts, NEVER reads stdin. Before the write-back, the destination and the tmp are
// BOTH untouched on every refusal path.
export async function runInteractApply(
  tmpPath: string,
  binding: InteractBinding,
  opts: InteractApplyOpts,
): Promise<number> {
  const label = binding.label;

  // 1. path exists — a fat-finger at an already-consumed (or never-emitted) path.
  if (!existsSync(tmpPath)) {
    return fail(label, `no intermediary at ${tmpPath} — already applied, or re-run distill`, 2);
  }
  // 2. suffix — a non-`.tmp.md` path never derives a destination onto itself.
  const dest = destinationFor(tmpPath);
  if (dest === null) {
    return fail(label, `${tmpPath} is not a .tmp.md intermediary`, 2);
  }

  // 3. parse — structural grammar errors abort before any action.
  const text = readFileSync(tmpPath, "utf8");
  const hashAtStart = stampHash(text);
  const { blocks, errors: parseErrors } = parseInteract(text);
  if (parseErrors.length > 0) {
    return fail(label, parseErrors.map((e) => `${e.line}: ${e.message}`).join("; "), 2);
  }
  // 4. gate present — the confirm-all gate is mandatory triage policy; a blockless
  //    or gate-less intermediary is malformed (same teaching message either way).
  const gate = blocks.find((b) => b.kind === "confirm-all");
  if (!gate) {
    return fail(
      label,
      "no confirm-all gate — this is not a triage intermediary (re-run distill)",
      2,
    );
  }
  // 5. resolve — unknown verb, unresolved pick-one, and an UNCHECKED gate abort here.
  const res = resolveInteract(blocks, { verbs: binding.verbs });
  if (res.errors.length > 0) {
    return fail(label, res.errors.map((e) => e.message).join("; "), 2);
  }

  // 6. stamp — a renamed tmp (dest= basename) or an edited/absent destination
  //    (src= hash, or src=new no-clobber) refuses before the destination is derived.
  const destBase = basename(dest);
  if (gate.dest !== destBase) {
    return fail(
      label,
      `intermediary dest=${gate.dest ?? "(none)"} does not match ${destBase} — was the tmp renamed?`,
      2,
    );
  }
  if (gate.src === "new") {
    if (existsSync(dest)) {
      return fail(label, `destination already exists: ${dest} (src=new refuses to clobber)`, 2);
    }
  } else {
    const current = existsSync(dest) ? stampHash(readFileSync(dest, "utf8")) : null;
    if (current !== gate.src) {
      return fail(label, `destination changed since distill: ${dest} — re-run distill`, 2);
    }
  }

  // The residue items (every non-gate block); the gate itself is skipped.
  const items = blocks.filter((b) => b.kind !== "confirm-all").flatMap((b) => b.items);

  // 7–9, 12 — the binding's middle: classify, refuse a lost decision or a missing key,
  // fire its verbs IN MEMORY over the scaffold-free body, and hand back the final body.
  const applied = await binding.apply({
    items,
    strippedBody: stripInteract(text),
    lang: opts.lang,
    ask: opts.ask,
  });
  if (applied.kind === "refuse") {
    return fail(label, applied.message, applied.code);
  }

  // 10. re-hash the tmp — an Obsidian Sync rewrite during the binding window invalidates
  //     the decision set we acted on; refuse rather than write a stale apply.
  if (stampHash(readFileSync(tmpPath, "utf8")) !== hashAtStart) {
    return fail(label, "intermediary changed during apply — nothing written; re-run apply", 2);
  }
  // 11. re-verify the destination stamp for the overwrite case. Step 6's src=sha256 check
  //     read dest BEFORE the (seconds-long) binding window; an edit landing during that window
  //     (a cross-device Sync push, a hand edit) would otherwise be clobbered by the atomic
  //     replace below — the same class of loss the start-of-run stamp exists to refuse, just
  //     inside the apply's own window. The src=new case needs no re-check: its linkSync is
  //     no-clobber, so a destination that appeared meanwhile fails EEXIST (handled below).
  if (gate.src !== "new") {
    const current = existsSync(dest) ? stampHash(readFileSync(dest, "utf8")) : null;
    if (current !== gate.src) {
      return fail(
        label,
        `destination changed during apply: ${dest} — nothing written; re-run distill`,
        2,
      );
    }
  }

  // 13. write atomically and 14. consume.
  const partial = `${dest}.apply.partial`;
  writeFileSync(partial, applied.body);
  if (gate.src === "new") {
    // no-clobber link: EEXIST maps to the src=new refusal (exit 2); the helper
    // cleans the partial itself on any failure, so only the success unlink remains here.
    const link = linkNoClobber(partial, dest);
    if (!link.ok) {
      return fail(label, `destination already exists: ${dest} (src=new refuses to clobber)`, 2);
    }
    unlinkSync(partial);
  } else {
    renameSync(partial, dest); // atomic replace of the verified destination
  }
  unlinkIfPresent(tmpPath);

  process.stdout.write(`${dest}\n`);
  process.stderr.write(`${applied.footer}\n`);
  return 0;
}
