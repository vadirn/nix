import { linkSync, unlinkSync, writeFileSync } from "node:fs";

// No-clobber link: hardlink an already-written `partial` onto `target`. The
// caller writeFileSync's `partial` BEFORE calling; this helper never writes it
// and never renames. linkSync fails EEXIST instead of overwriting, so a racing
// producer that passed its preflight minutes ago (an LLM run) loses LOUD rather
// than silently clobbering the target. On EEXIST the partial is removed
// (ENOENT-tolerant unlink) and { ok: false, exists: true } is returned — the
// caller applies its own refuse/fail policy. On any OTHER error the partial is
// removed (ENOENT-tolerant) and the error is rethrown. On success the partial is
// left in place for the caller to consume or clean up.
function linkNoClobber(
  partial: string,
  target: string,
): { ok: true } | { ok: false; exists: true } {
  try {
    linkSync(partial, target);
  } catch (e) {
    try {
      unlinkSync(partial);
    } catch {}
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return { ok: false, exists: true };
    throw e;
  }
  return { ok: true };
}

// Write `bytes` to a same-directory `<target><suffix>` sibling, then linkNoClobber it onto
// `target`: a racing writer that passed its own preflight minutes ago loses LOUD on EEXIST
// rather than silently clobbering `target`, and a crash mid-write never leaves a truncated
// file visible at `target`. On success the partial is unlinked and `{ok: true}` returned; on
// EEXIST linkNoClobber has already cleaned the partial, so the caller sees `{ok: false, exists:
// true}` and applies its own refusal policy. Any other write/link error propagates.
export function atomicNoClobberWrite(
  target: string,
  bytes: string,
  suffix = ".partial",
): { ok: true } | { ok: false; exists: true } {
  const partial = `${target}${suffix}`;
  writeFileSync(partial, bytes);
  const link = linkNoClobber(partial, target);
  if (!link.ok) return link;
  unlinkSync(partial);
  return { ok: true };
}
