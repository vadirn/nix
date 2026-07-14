import { linkSync, unlinkSync } from "node:fs";

// No-clobber link: hardlink an already-written `partial` onto `target`. The
// caller writeFileSync's `partial` BEFORE calling; this helper never writes it
// and never renames. linkSync fails EEXIST instead of overwriting, so a racing
// producer that passed its preflight minutes ago (an LLM run) loses LOUD rather
// than silently clobbering the target. On EEXIST the partial is removed
// (ENOENT-tolerant unlink) and { ok: false, exists: true } is returned — the
// caller applies its own refuse/fail policy. On any OTHER error the partial is
// removed (ENOENT-tolerant) and the error is rethrown. On success the partial is
// left in place for the caller to consume or clean up.
export function linkNoClobber(
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
