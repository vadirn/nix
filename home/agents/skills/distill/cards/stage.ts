// cards/stage — render one StagingRecord into a review file. Pure formatting,
// zero I/O (the CLI owns writing the result to disk). No import of pipeline.ts (D13).
//
// A staging file is untyped inbox material, never a vault card: it carries NO
// frontmatter (the vault frontmatter schema owns typed `20 cards/` files — Log 10
// says the only path there is a human commit, so this file is a review packet, not
// a draft-in-place). Every candidate is staged regardless of its band verdict or
// flags (D22) — a null verdict or a failed draft is rendered as a visible notice,
// never as a reason to skip the file.
//
// Layout: H1 (term) → ## Review (arm, band verdict+rationale or the judge-
// inconclusive notice, the neighbours the judge saw, the relation leads with an
// off-registry marker and a blanket uncertified-verify notice, the flags, the
// source note as a link) → ## On commit (the checklist that turns a draft into a
// committed card) → a horizontal rule → the draft (or a draft-failed notice).
//
// Filename collisions: renderStagingFile takes an optional `used` Set (default a fresh
// one per call, so a single standalone call is unaffected) that the caller threads
// across every candidate of one note — see dedupeFilename below.
import { relText, slugSegment } from "../text.ts";
import type { StagingRecord } from "./types.ts";

const DRAFT_FAILED_NOTICE =
  "_Draft failed — the writer call did not return usable content. Draft this card manually from the candidate above._";

const UNCERTIFIED_NOTICE =
  "All relations above are UNCERTIFIED leads (parsed off the source note, never re-verified) — check each against the source before trusting it.";

// slugSegment(noteName) + "--" + slugSegment(term) + ".md" — the double hyphen
// keeps the two slugged segments visually separable (a single slug can itself
// contain many single hyphens) without inventing a second delimiter character.
function stagingFilename(noteName: string, term: string): string {
  return `${slugSegment(noteName)}--${slugSegment(term)}.md`;
}

// Disambiguate `base` against every filename already reserved in `used` (mutated: the
// caller threads ONE Set across every renderStagingFile call for the same note, so each
// candidate reserves its slot before the next is computed). Two candidates collide
// whenever their (noteName, term) pairs slug to the same string: a thesis candidate's
// term is the note's own title, so a glossary entry sharing that term (verbatim, or a
// case/punctuation variant — "Alpha" vs "alpha") collides with it, and any two terms
// that both slug to "" collide with each other. Undetected, the later `writeFile`
// silently clobbers the earlier one's review packet while `staged` keeps counting both
// (Finding 1). Suffix `-2`, `-3`, ... before `.md` until the name is free, then reserve it.
function dedupeFilename(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let n = 2;
  let candidate = base.replace(/\.md$/, `-${n}.md`);
  while (used.has(candidate)) {
    n++;
    candidate = base.replace(/\.md$/, `-${n}.md`);
  }
  used.add(candidate);
  return candidate;
}

function renderVerdictSection(record: StagingRecord): string[] {
  const { verdict } = record;
  if (verdict === null) {
    return ["- **Band:** judge-inconclusive (flagged — the judge returned no usable verdict)"];
  }
  const lines = [
    `- **Band:** ${verdict.band} — ${verdict.rationale}`,
    "- **Neighbours (as the judge saw them):**",
  ];
  if (verdict.nearest.length === 0) {
    lines.push("  - (none)");
  } else {
    for (const h of verdict.nearest) {
      const desc = h.description.trim() || h.snippet.trim();
      lines.push(`  - ${h.title} — ${desc} — \`${h.path}\``);
    }
  }
  return lines;
}

function renderRelationsSection(record: StagingRecord): string[] {
  if (record.edges.length === 0) return ["- **Relations (UNCERTIFIED leads):** (none)"];
  const lines = ["- **Relations (UNCERTIFIED leads):**"];
  for (const e of record.edges) {
    const marker = e.offRegistry ? " [off-registry]" : "";
    lines.push(`  - ${relText(e)}${marker}`);
  }
  lines.push(`- ${UNCERTIFIED_NOTICE}`);
  return lines;
}

export function renderStagingFile(
  record: StagingRecord,
  noteName: string,
  used: Set<string> = new Set(),
): { filename: string; content: string } {
  const { candidate, flags, draft } = record;
  const filename = dedupeFilename(stagingFilename(noteName, candidate.term), used);

  const lines: string[] = [
    `# ${candidate.term}`,
    "",
    "## Review",
    "",
    `- **Arm:** ${candidate.arm}`,
  ];
  lines.push(...renderVerdictSection(record));
  lines.push(...renderRelationsSection(record));
  lines.push(`- **Flags:** ${flags.length ? flags.join(", ") : "(none)"}`);
  lines.push(`- **Source:** [${candidate.sourceNote}](<${candidate.sourceNote}>)`);
  lines.push(
    "",
    "## On commit",
    "",
    "- [ ] Rewrite the draft in your own words",
    "- [ ] Add the `reference:` frontmatter field (a card requires it)",
    "- [ ] Move to `20 cards/` — only the body survives; this Review scaffold is dropped",
    "- [ ] If the draft names a split, split first",
    "",
    "---",
    "",
    draft || DRAFT_FAILED_NOTICE,
    "",
  );

  return { filename, content: lines.join("\n") };
}
