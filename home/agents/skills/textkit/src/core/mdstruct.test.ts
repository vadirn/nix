// mdstruct wrapper tests — run with `bun test` from this directory (needs the
// `mdstruct` binary on PATH; the nix host has it at /etc/profiles/per-user/vadim/bin/mdstruct).
//
// These pin the wrapper's own contract: region extraction, fence-aware scanning, the parse
// cache, and the schema-version floor. The harvester/router golden tests that exercise this
// wrapper through distill's `harvest.ts`/`route.ts` live in
// `src/distill/extract/harvest-route.test.ts` — this file (core) cannot import distill.
import { expect, test } from "bun:test";
import { checkSchemaVersion, parseDoc, sliceBytes } from "textkit/core/mdstruct.ts";

// Region extraction is always-on and complete: every comment-anchor pair surfaces in `doc.regions`
// with byte-exact `span`/`bodySpan` and the whole post-`interact:` string as `info`. There is no
// registration flag -- `parseDoc(text)` alone emits the region -- and the cache keys on `text`
// alone, so repeated calls hit the same entry.
test("parseDoc: the interact anchor pair surfaces unconditionally; repeat calls hit the same key", () => {
  const doc =
    "# T\n\n<!-- interact: click to expand -->\nhidden body\n<!-- /interact -->\n\nAfter.\n";

  const first = parseDoc(doc);
  const { doc: parsed, buf } = first;
  expect(parsed.regions?.length).toBe(1);
  const r = parsed.regions![0];
  expect(r.label).toBe("interact");
  expect(r.info).toBe("click to expand"); // the whole post-`interact:` string
  // span covers both anchor lines; bodySpan is the raw bytes between them.
  expect(sliceBytes(buf, r.span)).toBe(
    "<!-- interact: click to expand -->\nhidden body\n<!-- /interact -->\n",
  );
  expect(sliceBytes(buf, r.bodySpan)).toBe("hidden body\n");

  // Cache keys on `text` alone: a repeated call hits the same entry.
  expect(parseDoc(doc)).toBe(first);
});

// S7 fence-skip is now the SOLE path: fence-awareness is unconditional. The `interact` OPEN sits
// outside any fence; a STRAY `<!-- /interact -->` sits inside a real fenced code block; the REAL
// close follows after the fence. The scanner masks the fenced anchor, so the open pairs with the
// real close and the region spans the full payload -- no flag, no fence-blind alternative.
const S7_DOC =
  "# T\n\n<!-- interact: demo -->\nreal body line\n\n```text\n<!-- /interact -->\n```\n\nmore real body\n<!-- /interact -->\n\nAfter.\n";

test("parseDoc: fence-aware extraction spans past a stray fenced close to the REAL close (S7)", () => {
  const { doc: parsed, buf } = parseDoc(S7_DOC);
  const r = parsed.regions![0];

  // The region reaches the real close -- its body carries the post-fence payload.
  expect(sliceBytes(buf, r.bodySpan)).toBe(
    "real body line\n\n```text\n<!-- /interact -->\n```\n\nmore real body\n",
  );
  expect(sliceBytes(buf, r.span)).toContain("more real body");
});

// Cache invariant: `parseDoc` keys on `text` alone, so a repeated call resolves to the SAME cached
// object.
test("parseDoc: repeated calls on the same text resolve to the same cached object", () => {
  expect(parseDoc(S7_DOC)).toBe(parseDoc(S7_DOC));
});

// ---- checkSchemaVersion: the floor comparison parseDoc enforces (ticket
// mdstruct-schema-version-floor) ----
// Unit-tested directly against the pure predicate rather than through parseDoc, so the six
// accept/reject cases run without spawning the `mdstruct` binary. The module's floor is the
// hardcoded "1.2" (MINIMUM_SCHEMA_VERSION); each case below picks a `reported` version relative
// to that floor. A revert to the old exact-equality check (`doc.schemaVersion !==
// EXPECTED_SCHEMA_VERSION`) would flip the two higher-minor cases from accept to reject, so
// those are the ones that actually pin the floor behavior rather than just re-testing equality.

test("checkSchemaVersion: an exact match on the floor is accepted", () => {
  expect(checkSchemaVersion("1.2", "mdstruct")).toEqual({ ok: true });
});

test("checkSchemaVersion: a higher minor than the floor is accepted (the case exact-equality broke)", () => {
  expect(checkSchemaVersion("1.3", "mdstruct")).toEqual({ ok: true });
  expect(checkSchemaVersion("1.10", "mdstruct")).toEqual({ ok: true });
});

test("checkSchemaVersion: a lower minor than the floor is rejected with the stale-binary wording", () => {
  const result = checkSchemaVersion("1.1", "mdstruct");
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.message).toContain("Rebuild mdstruct (the installed binary is stale)");
  expect(result.message).toContain('"1.1"');
});

test("checkSchemaVersion: a higher major than the floor is rejected, and NOT with the stale wording", () => {
  const result = checkSchemaVersion("2.0", "mdstruct");
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.message).not.toContain("is stale");
  expect(result.message).toContain("MAJOR");
});

test("checkSchemaVersion: a lower major than the floor is rejected, and NOT with the stale wording", () => {
  const result = checkSchemaVersion("0.9", "mdstruct");
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.message).not.toContain("is stale");
  expect(result.message).toContain("MAJOR");
});

test("checkSchemaVersion: a value that doesn't parse as major.minor is rejected, not treated as satisfying the floor", () => {
  for (const bad of [undefined, "", "1", "1.2.3", "abc", "v1.2"]) {
    const result = checkSchemaVersion(bad, "mdstruct");
    expect(result.ok).toBe(false);
  }
});
