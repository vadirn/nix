// cards/prompts — pure prompt builders for the card-extraction LLM stages.
// No LLM call and no transport import lives here: each builder maps typed input
// to a prompt string; the stage wiring feeds it to fw's askJson and validates the
// reply against types.ts (BandJudgeReply / DraftReply / AtomicityReply). D13: this
// module never imports distill-core.ts.
//
// The instruction text carries the whole lexicographer discipline (the vault note
// "The lexicographer" is the source): the runtime models are small and obedient,
// so every rule is explicit and self-contained. Writer/judge split mirrors the
// distill fidelity gate: the band judge and the atomicity judge run on FIDELITY
// (a different model than the writer); the card draft runs on EXTRACT.
//
// Certification boundary the prompts encode: a candidate's def (the glossary def /
// the frontmatter tie) is the CERTIFIED channel; the note body and the parsed
// `## Relations` edges are UNCERTIFIED leads — the draft may take illustration and
// wording from them but may assert nothing the certified def does not support.
//
// Band discipline (D22 context): the verdict these prompts elicit is an ANNOTATION
// a candidate carries into staging, never a filter — nothing here gates.
import { langRule, relText } from "../text.ts";
import type { Candidate, NeighbourHit } from "./types.ts";

// Render the recall neighbours as the judge/writer sees them: title first (the
// [[wikilink]] handle), then the frontmatter description — the card's own
// definition — falling back to the BM25 snippet when the card has none.
function neighbourList(hits: NeighbourHit[]): string {
  if (hits.length === 0) return "(none)";
  return hits
    .map((h, i) => `### N${i + 1}: ${h.title}\n${h.description.trim() || h.snippet.trim()}`)
    .join("\n\n");
}

// Render the candidate block shared by both LLM inputs: headword, arm, certified
// def, and the uncertified relation leads (readable `rel :: to (predicate)` form).
function candidateBlock(candidate: Candidate): string {
  const rels = candidate.relations.length ? candidate.relations.map(relText).join("; ") : "(none)";
  return `term: ${candidate.term}
arm: ${candidate.arm}
def (CERTIFIED): ${candidate.def}
relations (UNCERTIFIED leads): ${rels}`;
}

// ---- stage: novelty band (FIDELITY — the judge, not the writer) ----
// Classifies a candidate into exactly one admission band by comparing its certified
// def against each neighbour's description. "Admission is a band, not a threshold":
// the three bands are named with their deciding distances so a small model can
// place the candidate without inventing a scale. With zero neighbours defer-link
// is impossible by construction, and the prompt says so.
export function noveltyBandPrompt(
  candidate: Candidate,
  hits: NeighbourHit[],
  lang: "en" | "ru",
): string {
  const neighbourRule =
    hits.length === 0
      ? `NEIGHBOURS: (none — recall surfaced no existing card. "defer-link" is impossible: choose between "mint" and "work-through".)`
      : `NEIGHBOURS (existing cards, best match first — each entry is the card's title then its own description):
${neighbourList(hits)}`;
  return `You are the admissions judge for a personal card vault. A CANDIDATE (a headword with its certified definition) was extracted from a note; the NEIGHBOURS are the existing cards recall surfaced. Compare the candidate's def against EACH neighbour's description and classify the candidate into EXACTLY ONE band:
- "defer-link": distance near zero — an existing card ALREADY covers this extension; link to it instead of minting a duplicate. Name that card's title in the rationale.
- "mint": the productive middle band — no neighbour covers the candidate, yet it hooks onto them: it extends, contrasts with, or presupposes a neighbour.
- "work-through": too far — not yet a clean node: the def is vague, bundles several concepts, or connects to nothing; develop it before minting.
Judge by the DEFINITIONS, not the topics: a shared topic is NOT coverage — a neighbour covers the candidate only when its description states the same extension (the same circle of things, or the same claim). ${langRule(lang)}
Return ONLY JSON {"band":"defer-link|mint|work-through","rationale":"..."} — rationale is ONE clause naming the deciding comparison.

CANDIDATE:
${candidateBlock(candidate)}

${neighbourRule}`;
}

// ---- stage: card draft (EXTRACT — the writer) ----
// The lexicographer skeleton. Per arm the description states what the headword IS
// (concept: genus + differentia; thesis: the claim + its ground) over a body that
// illustrates it once. The few-shot exemplar is real corpus material (the concept
// exemplar is Russian, the thesis one English — the corpus is bilingual and the
// exemplar calibrates FORM; langRule pins the output language separately).
const CONCEPT_ARM_RULE = `This is a CONCEPT card. The description defines the concept by genus plus differentia: name the nearest kind, then the ONE feature that separates it from its neighbours. The body is that definition illustrated once; any third restatement is padding.`;

const THESIS_ARM_RULE = `This is a THESIS card. The description states the claim AND the one ground that makes it non-obvious. The body carries ONLY the distinction behind that ground — no background, no hedging, no re-asserting the claim.`;

const CONCEPT_EXEMPLAR = `EXEMPLAR (concept form — calibrates the SHAPE only; your output language follows the language rule above):
Знание о круге предметов, существенные признаки которых отображены в понятии

Знание о круге предметов, [[Существенный признак|существенные признаки]] которых отображены в понятии.`;

const THESIS_EXEMPLAR = `EXEMPLAR (thesis form — calibrates the SHAPE only; your output language follows the language rule above):
Parsers return more specific types than validators, making illegal states unrepresentable.

- A **validator** checks that the input is valid and throws an error if it is not
- A **parser** does the same, but returns a more specific representation of an input. E.g. check that a list is not empty and return \`NonEmptyList\` type

Make illegal states unrepresentable.`;

export function cardDraftPrompt(
  candidate: Candidate,
  hits: NeighbourHit[],
  noteBody: string,
  lang: "en" | "ru",
): string {
  const armRule = candidate.arm === "concept" ? CONCEPT_ARM_RULE : THESIS_ARM_RULE;
  const exemplar = candidate.arm === "concept" ? CONCEPT_EXEMPLAR : THESIS_EXEMPLAR;
  return `You are the lexicographer: you draft catalogued entries for a personal card vault. Draft ONE card for the CANDIDATE below. A card is a dictionary entry: its FIRST line is the description — one sentence stating what the headword IS — then a blank line, then the body that illustrates it ONCE. Nothing restates the description a third time.
${armRule}
Rules:
- ONE extension per card. If the candidate bundles coordinate concepts, draft the PRIMARY one only and add one final line "Split: ..." naming the sibling card(s) to mint separately — never draft both concepts into one body.
- DELTA only. The NEIGHBOURS are existing cards: delegate to them by [[wikilink]] using their exact titles instead of restating their content — write only what the candidate ADDS beyond the supplied neighbour descriptions. Never explain what a [[link]] already carries.
- Specimens verbatim. Copy code blocks, tables, and exact numbers from the note UNCHANGED — never paraphrase a specimen, and wrap it in no prose.
- Certified vs uncertified. Only the candidate's def is CERTIFIED. The NOTE BODY and the relations are UNCERTIFIED leads — mine them for illustrations and wording, but assert NOTHING the certified def does not support.
- Padding test. A token is padding if deleting it leaves the entry's claims unchanged for the reader in six months; cut padding, keep every claim — fidelity outranks brevity.
${langRule(lang)}
Return ONLY JSON {"draft":"..."} — draft is the FULL proposed card: the description line, a blank line, then the body.

${exemplar}

CANDIDATE:
${candidateBlock(candidate)}

NEIGHBOURS (existing cards — delegate by [[wikilink]], write only the delta against these descriptions):
${neighbourList(hits)}

NOTE BODY (UNCERTIFIED — leads for illustration only):
${noteBody}`;
}

// ---- stage: atomicity judge (FIDELITY — the judge, not the writer) ----
// G4, description–body coherence: a card holds exactly one headword, so a body
// claim the description does not name means the entry holds more than one concept.
// The embedded counter-example is the corpus's own ([[Measuring time]]: one named
// technique over a body covering three concepts), anonymized to a pattern.
export function atomicityJudgePrompt(description: string, body: string, lang: "en" | "ru"): string {
  return `You are an independent atomicity judge for a drafted card. You did NOT write it. A card holds exactly ONE headword: the DESCRIPTION states what the headword is; the BODY illustrates that same statement once. Judge ONE thing — description-body coherence: does the BODY carry a claim the DESCRIPTION does not name?
- Illustration is NOT an excess claim: an example, a verbatim specimen (code, table, exact numbers) demonstrating the described concept, or a [[wikilink]] delegation adds no claim of its own.
- A claim IS excess when it introduces a second concept, technique, or thesis the description never names (e.g. a description naming one timing technique over a body that also covers timer precision and page lifecycle states holds three concepts, not one).
If the body carries such a claim, the card is NOT atomic — name the excess claim in "reason" (the cure is widening the headword or splitting into linked siblings). ${langRule(lang)}
Return ONLY JSON {"atomic":true|false,"reason":"..."} — atomic=true ONLY when every body claim is named by the description; reason is ONE clause: the excess claim, or why the card is atomic.

DESCRIPTION:
${description}

BODY:
${body}`;
}
