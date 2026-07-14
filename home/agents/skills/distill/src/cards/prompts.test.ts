// cards/prompts tests — run with `bun test cards/prompts.test.ts` from the distill root.
//
// The three builders are pure string functions (no model call); this suite pins
// their load-bearing instruction substrings in the exact-substring idiom of
// stages.test.ts / prompts.test.ts: the three band tokens, the delta instruction,
// the one-extension rule, the uncertified warning, the verbatim-specimen rule,
// the embedded inputs (term, def, neighbour descriptions), langRule for both
// languages, and each builder's strict-JSON shape demand.
import { expect, test } from "bun:test";
import { langRule } from "@/kernel/text.ts";
import { atomicityJudgePrompt, cardDraftPrompt, noveltyBandPrompt } from "@/cards/prompts.ts";
import type { Candidate, NeighbourHit } from "@/cards/types.ts";

const conceptCandidate: Candidate = {
  arm: "concept",
  term: "Target distance",
  def: "The gap between the current draft and the elegant form, closed only by iteration.",
  relations: [{ rel: "contrast-to", to: "elegant-solution", predicate: "names the gap it closes" }],
  sourceNote: "/abs/path/note.md",
};

const thesisCandidate: Candidate = {
  arm: "thesis",
  term: "Pragmatic first is reconnaissance",
  def: "A pragmatic first version is reconnaissance for the elegant one, not its replacement.",
  relations: [],
  sourceNote: "/abs/path/note.md",
};

const hits: NeighbourHit[] = [
  {
    path: "20 cards/Elegant solution.md",
    title: "Elegant solution",
    score: 12.3,
    description: "A solution whose form matches the problem's own structure.",
    snippet: "…form matches the problem…",
  },
  {
    path: "20 cards/Outline speedrunning.md",
    title: "Outline speedrunning",
    score: 8.1,
    description: "", // no frontmatter description — the judge falls back on the snippet
    snippet: "Build the full skeleton first, then fill each node.",
  },
];

// ---- noveltyBandPrompt ----

test("noveltyBandPrompt: names all three band tokens with their deciding distances", () => {
  const p = noveltyBandPrompt(conceptCandidate, hits, "en");
  expect(p).toContain('"defer-link"');
  expect(p).toContain('"mint"');
  expect(p).toContain('"work-through"');
  // defer-link must name the covering card; the middle band hooks onto neighbours
  expect(p).toContain("Name that card's title in the rationale");
  expect(p).toContain("EXACTLY ONE band");
});

test("noveltyBandPrompt: embeds the candidate term and def and each neighbour description", () => {
  const p = noveltyBandPrompt(conceptCandidate, hits, "en");
  expect(p).toContain("Target distance");
  expect(p).toContain(conceptCandidate.def);
  expect(p).toContain("Elegant solution");
  expect(p).toContain("A solution whose form matches the problem's own structure.");
});

test("noveltyBandPrompt: an empty description falls back to the neighbour's snippet", () => {
  const p = noveltyBandPrompt(conceptCandidate, hits, "en");
  expect(p).toContain("Outline speedrunning");
  expect(p).toContain("Build the full skeleton first, then fill each node.");
});

test("noveltyBandPrompt: zero neighbours narrows the choice to mint vs work-through", () => {
  const p = noveltyBandPrompt(conceptCandidate, [], "en");
  expect(p).toContain('"defer-link" is impossible');
  expect(p).toContain('choose between "mint" and "work-through"');
});

test("noveltyBandPrompt: demands the strict JSON verdict shape with a one-clause rationale", () => {
  const p = noveltyBandPrompt(conceptCandidate, hits, "en");
  expect(p).toContain('Return ONLY JSON {"band":"defer-link|mint|work-through","rationale":"..."}');
  expect(p).toContain("ONE clause");
});

test("noveltyBandPrompt: pins the output language for both en and ru", () => {
  expect(noveltyBandPrompt(conceptCandidate, hits, "en")).toContain(langRule("en"));
  expect(noveltyBandPrompt(conceptCandidate, hits, "ru")).toContain(langRule("ru"));
});

// ---- cardDraftPrompt ----

test("cardDraftPrompt: states the delta instruction (wikilink delegation over restatement)", () => {
  const p = cardDraftPrompt(conceptCandidate, hits, "note body text", "en");
  expect(p).toContain("DELTA only");
  expect(p).toContain("delegate to them by [[wikilink]]");
  expect(p).toContain(
    "write only what the candidate ADDS beyond the supplied neighbour descriptions",
  );
  expect(p).toContain("Never explain what a [[link]] already carries");
});

test("cardDraftPrompt: states the one-extension rule with the split-note escape", () => {
  const p = cardDraftPrompt(conceptCandidate, hits, "note body text", "en");
  expect(p).toContain("ONE extension per card");
  expect(p).toContain('"Split: ..."');
  expect(p).toContain("never draft both");
});

test("cardDraftPrompt: warns that the note body and relations are uncertified leads", () => {
  const p = cardDraftPrompt(conceptCandidate, hits, "note body text", "en");
  expect(p).toContain("UNCERTIFIED");
  expect(p).toContain("assert NOTHING the certified def does not support");
});

test("cardDraftPrompt: states the verbatim-specimen rule", () => {
  const p = cardDraftPrompt(conceptCandidate, hits, "note body text", "en");
  expect(p).toContain("Specimens verbatim");
  expect(p).toContain("never paraphrase a specimen");
});

test("cardDraftPrompt: embeds the candidate, its relations, each neighbour, and the note body", () => {
  const body = "The note prose with a specimen: exactly 47 percent.";
  const p = cardDraftPrompt(conceptCandidate, hits, body, "en");
  expect(p).toContain("Target distance");
  expect(p).toContain(conceptCandidate.def);
  // relations render in relText form on the uncertified channel
  expect(p).toContain("contrast-to :: elegant-solution (names the gap it closes)");
  expect(p).toContain("Elegant solution");
  expect(p).toContain("A solution whose form matches the problem's own structure.");
  expect(p).toContain("Build the full skeleton first, then fill each node.");
  expect(p).toContain(body);
});

test("cardDraftPrompt: the concept arm gets genus + differentia and the concept exemplar", () => {
  const p = cardDraftPrompt(conceptCandidate, hits, "body", "en");
  expect(p).toContain("genus plus differentia");
  expect(p).toContain("Знание о круге предметов");
  expect(p).not.toContain("THESIS card");
});

test("cardDraftPrompt: the thesis arm gets claim + ground and the thesis exemplar", () => {
  const p = cardDraftPrompt(thesisCandidate, hits, "body", "en");
  expect(p).toContain("the claim AND the one ground that makes it non-obvious");
  expect(p).toContain("Parsers return more specific types than validators");
  expect(p).not.toContain("CONCEPT card");
});

test("cardDraftPrompt: demands the strict JSON draft shape (description line then body)", () => {
  const p = cardDraftPrompt(conceptCandidate, hits, "body", "en");
  expect(p).toContain('Return ONLY JSON {"draft":"..."}');
  expect(p).toContain("the description line, a blank line, then the body");
});

test("cardDraftPrompt: pins the output language for both en and ru", () => {
  expect(cardDraftPrompt(conceptCandidate, hits, "body", "en")).toContain(langRule("en"));
  expect(cardDraftPrompt(conceptCandidate, hits, "body", "ru")).toContain(langRule("ru"));
});

// ---- atomicityJudgePrompt ----

test("atomicityJudgePrompt: states G4 (a body claim the description does not name) and embeds both inputs", () => {
  const desc = "A pure function maps input to output with no side effects.";
  const body = "Purity example.\n\nAlso, memoization caches results by argument identity.";
  const p = atomicityJudgePrompt(desc, body, "en");
  expect(p).toContain("does the BODY carry a claim the DESCRIPTION does not name?");
  expect(p).toContain("NOT atomic");
  expect(p).toContain("name the excess claim");
  expect(p).toContain(desc);
  expect(p).toContain(body);
});

test("atomicityJudgePrompt: illustration and wikilink delegation are exempt from excess", () => {
  const p = atomicityJudgePrompt("d", "b", "en");
  expect(p).toContain("Illustration is NOT an excess claim");
  expect(p).toContain("[[wikilink]] delegation adds no claim");
});

test("atomicityJudgePrompt: demands the strict JSON atomic/reason shape", () => {
  const p = atomicityJudgePrompt("d", "b", "en");
  expect(p).toContain('Return ONLY JSON {"atomic":true|false,"reason":"..."}');
});

test("atomicityJudgePrompt: pins the output language for both en and ru", () => {
  expect(atomicityJudgePrompt("d", "b", "en")).toContain(langRule("en"));
  expect(atomicityJudgePrompt("d", "b", "ru")).toContain(langRule("ru"));
});
