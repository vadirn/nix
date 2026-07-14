// cards.test.ts — pins the pure card-extraction layer: run with
// `bun test cards/cards.test.ts` from the distill skill directory (NOT bare `bun
// test` — sibling build agents' files are still in flight and would fail it).
import { expect, test } from "bun:test";
import {
  annotateEdges,
  buildStagingRecord,
  decideCard,
  enumerateCandidates,
} from "@/cards/cards.ts";
import type {
  BandVerdict,
  Candidate,
  CardEdge,
  HarvestedConcept,
  NeighbourHit,
} from "@/cards/types.ts";

// ---- enumerateCandidates ----

const entry = (term: string, def: string, relations: CardEdge[] = []): HarvestedConcept => ({
  term,
  def,
  relations,
});

test("enumerateCandidates: one concept-arm candidate per concept entry, no tie", () => {
  const entries = [entry("alpha", "def a"), entry("beta", "def b")];
  const out = enumerateCandidates(entries, { tie: null, title: "Note", sourceNote: "/n.md" });
  expect(out).toHaveLength(2);
  expect(out.every((c) => c.arm === "concept")).toBe(true);
  expect(out[0]).toEqual({
    arm: "concept",
    term: "alpha",
    def: "def a",
    relations: [],
    sourceNote: "/n.md",
  });
  expect(out[1].term).toBe("beta");
});

test("enumerateCandidates: appends one thesis-arm candidate when tie is non-empty", () => {
  const entries = [entry("alpha", "def a")];
  const out = enumerateCandidates(entries, {
    tie: "The unifying thesis.",
    title: "Note Title",
    sourceNote: "/n.md",
  });
  expect(out).toHaveLength(2);
  expect(out[1]).toEqual({
    arm: "thesis",
    term: "Note Title",
    def: "The unifying thesis.",
    relations: [],
    sourceNote: "/n.md",
  });
});

test("enumerateCandidates: empty tie string omits the thesis arm", () => {
  const out = enumerateCandidates([entry("alpha", "def a")], {
    tie: "",
    title: "Note",
    sourceNote: "/n.md",
  });
  expect(out).toHaveLength(1);
  expect(out.every((c) => c.arm === "concept")).toBe(true);
});

test("enumerateCandidates: empty concept list with no tie yields no candidates", () => {
  const out = enumerateCandidates([], { tie: null, title: "Note", sourceNote: "/n.md" });
  expect(out).toEqual([]);
});

test("enumerateCandidates: empty concept list with a tie yields just the thesis candidate", () => {
  const out = enumerateCandidates([], { tie: "Tie text", title: "Note", sourceNote: "/n.md" });
  expect(out).toHaveLength(1);
  expect(out[0].arm).toBe("thesis");
});

test("enumerateCandidates: never filters — relations pass through verbatim", () => {
  const rels: CardEdge[] = [{ rel: "depends-on", to: "beta", predicate: null }];
  const out = enumerateCandidates([entry("alpha", "def a", rels)], {
    tie: null,
    title: "Note",
    sourceNote: "/n.md",
  });
  expect(out[0].relations).toBe(rels);
});

// ---- decideCard ----

const NEAREST: NeighbourHit[] = [
  { path: "a.md", title: "A", score: 0.9, description: "d", snippet: "s" },
];

test("decideCard: valid defer-link band", () => {
  const v = decideCard({ band: "defer-link", rationale: "close match" }, NEAREST);
  expect(v).toEqual({ band: "defer-link", rationale: "close match", nearest: NEAREST });
});

test("decideCard: valid mint band", () => {
  const v = decideCard({ band: "mint", rationale: "productive middle" }, NEAREST);
  expect(v?.band).toBe("mint");
});

test("decideCard: valid work-through band", () => {
  const v = decideCard({ band: "work-through", rationale: "too far" }, NEAREST);
  expect(v?.band).toBe("work-through");
});

test("decideCard: normalizes case and surrounding whitespace on band and rationale", () => {
  const v = decideCard({ band: "  MINT  ", rationale: "  trimmed  " }, NEAREST);
  expect(v).toEqual({ band: "mint", rationale: "trimmed", nearest: NEAREST });
});

test("decideCard: internal whitespace hyphenates — 'work through' is work-through, not inconclusive", () => {
  const v = decideCard({ band: "Work  Through", rationale: "too far" }, NEAREST);
  expect(v?.band).toBe("work-through");
  expect(decideCard({ band: "defer link", rationale: "r" }, NEAREST)?.band).toBe("defer-link");
});

test("decideCard: nearest passes through untouched regardless of contents (recall-agnostic)", () => {
  const v = decideCard({ band: "defer-link", rationale: "r" }, []);
  expect(v?.nearest).toEqual([]);
});

test("decideCard: junk band string returns null", () => {
  expect(decideCard({ band: "maybe", rationale: "r" }, NEAREST)).toBeNull();
});

test("decideCard: non-object reply returns null", () => {
  expect(decideCard("mint", NEAREST)).toBeNull();
  expect(decideCard(null, NEAREST)).toBeNull();
  expect(decideCard(undefined, NEAREST)).toBeNull();
  expect(decideCard(42, NEAREST)).toBeNull();
  expect(decideCard(["mint", "r"], NEAREST)).toBeNull();
});

test("decideCard: missing rationale returns null", () => {
  expect(decideCard({ band: "mint" }, NEAREST)).toBeNull();
});

test("decideCard: empty or whitespace-only rationale returns null", () => {
  expect(decideCard({ band: "mint", rationale: "" }, NEAREST)).toBeNull();
  expect(decideCard({ band: "mint", rationale: "   " }, NEAREST)).toBeNull();
});

test("decideCard: non-string band or rationale returns null", () => {
  expect(decideCard({ band: 1, rationale: "r" }, NEAREST)).toBeNull();
  expect(decideCard({ band: "mint", rationale: 1 }, NEAREST)).toBeNull();
});

// ---- annotateEdges ----

test("annotateEdges: on-registry relation is flagged offRegistry: false", () => {
  const rels: CardEdge[] = [{ rel: "subsumes", to: "beta", predicate: null }];
  expect(annotateEdges(rels)).toEqual([
    { rel: "subsumes", to: "beta", predicate: null, offRegistry: false },
  ]);
});

test("annotateEdges: off-registry relation is flagged offRegistry: true, kept not dropped", () => {
  const rels: CardEdge[] = [{ rel: "loosely-related-to", to: "beta", predicate: "hmm" }];
  expect(annotateEdges(rels)).toEqual([
    { rel: "loosely-related-to", to: "beta", predicate: "hmm", offRegistry: true },
  ]);
});

test("annotateEdges: mixed registry membership annotates each independently, order preserved", () => {
  const rels: CardEdge[] = [
    { rel: "part-of", to: "x", predicate: null },
    { rel: "vibes-with", to: "y", predicate: null },
    { rel: "refines", to: "z", predicate: null },
  ];
  const out = annotateEdges(rels);
  expect(out.map((e) => e.offRegistry)).toEqual([false, true, false]);
});

test("annotateEdges: empty relations yields empty edges", () => {
  expect(annotateEdges([])).toEqual([]);
});

// ---- buildStagingRecord ----

const CANDIDATE: Candidate = {
  arm: "concept",
  term: "alpha",
  def: "def a",
  relations: [{ rel: "subsumes", to: "beta", predicate: null }],
  sourceNote: "/n.md",
};

const VERDICT: BandVerdict = { band: "mint", rationale: "r", nearest: [] };

test("buildStagingRecord: verdict present, flags without judge-inconclusive — assembles record", () => {
  const rec = buildStagingRecord({
    candidate: CANDIDATE,
    verdict: VERDICT,
    flags: [],
    lang: "en",
    draft: "drafted body",
  });
  expect(rec.candidate).toBe(CANDIDATE);
  expect(rec.verdict).toBe(VERDICT);
  expect(rec.edges).toEqual([{ rel: "subsumes", to: "beta", predicate: null, offRegistry: false }]);
  expect(rec.flags).toEqual([]);
  expect(rec.lang).toBe("en");
  expect(rec.draft).toBe("drafted body");
});

test("buildStagingRecord: verdict null with judge-inconclusive flag — assembles record", () => {
  const rec = buildStagingRecord({
    candidate: CANDIDATE,
    verdict: null,
    flags: ["judge-inconclusive"],
    lang: "ru",
    draft: "",
  });
  expect(rec.verdict).toBeNull();
  expect(rec.flags).toEqual(["judge-inconclusive"]);
});

test("buildStagingRecord: other flags coexist with a null verdict as long as judge-inconclusive is present", () => {
  const rec = buildStagingRecord({
    candidate: CANDIDATE,
    verdict: null,
    flags: ["recall-unavailable", "judge-inconclusive", "draft-failed"],
    lang: "en",
    draft: "",
  });
  expect(rec.verdict).toBeNull();
  expect(rec.flags).toContain("judge-inconclusive");
});

test("buildStagingRecord: throws when verdict is null but flags omit judge-inconclusive", () => {
  expect(() =>
    buildStagingRecord({
      candidate: CANDIDATE,
      verdict: null,
      flags: ["recall-unavailable"],
      lang: "en",
      draft: "",
    }),
  ).toThrow();
});

test("buildStagingRecord: throws when verdict is non-null but flags include judge-inconclusive", () => {
  expect(() =>
    buildStagingRecord({
      candidate: CANDIDATE,
      verdict: VERDICT,
      flags: ["judge-inconclusive"],
      lang: "en",
      draft: "",
    }),
  ).toThrow();
});
