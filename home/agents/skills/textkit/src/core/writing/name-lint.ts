// writing/name-lint — deterministic, zero-LLM check for names the writing/revise
// passes may have corrupted (a proper noun mangled toward a near neighbor) or
// invented (a capitalized token with no source counterpart). Both modes are
// total (never throw) and never block: callers only render the result into a
// footer or Flags line. Imports only leaf-tier core helpers (levenshtein, mask's
// token regex, and the frontmatter scanner — all free of a back-edge to this
// module), so the core can depend on it without a cycle.
import { parseFrontmatter } from "#src/core/frontmatter.ts";
import { levenshtein } from "#src/core/writing/levenshtein.ts";
import { MASK_TOKEN_RE } from "#src/core/writing/mask.ts";

// NameFinding pairs a name found in the output with the source name it likely corrupted from.
type NameFinding = { found: string; wanted: string };
// NameLintResult is the outcome of one name-lint pass: `corrupted` lists names probably
// mangled from a source name (see NameFinding), `invented` lists names with no source
// counterpart at all (nameLintSelfConsistency always leaves this empty).
export type NameLintResult = { corrupted: NameFinding[]; invented: string[] };

// Corruption tolerance: how many edits still read as "the same name" scales with length,
// capped at 3 so a long name doesn't drown short ones in false positives. Shared by both
// lanes — against-source compares a candidate to its nearest source name; self-consistency
// compares two candidates to each other.
function corruptionCap(a: string, b: string): number {
  return Math.min(3, Math.floor(Math.max(a.length, b.length) / 3));
}

// Sentence-initial-only groups are usually ordinary capitalization ("So", "Note", table
// headers), but a revise pass can front a corrupted name too. Flag one as corrupted only
// when it never occurs lowercase AND its counterpart is attested mid-sentence (a real proper
// noun, not another structurally capitalized ordinary word). Shared relaxation rule between
// against-source (a candidate vs. its nearest source name) and self-consistency (the minority
// spelling vs. the majority).
function initialOnlyRelaxed(
  initialOnly: boolean,
  everLowercase: boolean,
  counterpartAttestedNonInitial: boolean,
): boolean {
  return initialOnly && (everLowercase || !counterpartAttestedNonInitial);
}

// stripZones blanks zones where capitalization is not a meaningful proper-noun signal — the
// leading YAML frontmatter block, code spans, mask tokens, wikilink/embed brackets, markdown
// link targets, and bare URLs — so tokens() below only sees prose capitalization. Frontmatter
// is metadata, not authored prose: a capitalized token inside it (e.g. the `/Users/Documents/…`
// segments of a `source:` path) is neither an invented nor a corrupted NAME, so it is dropped
// up front via the leaf-tier parseFrontmatter scanner rather than re-encoding the `---` fence
// rule here (parseFrontmatter is a no-op on text without a leading block).
function stripZones(text: string): string {
  return parseFrontmatter(text)
    .body.replace(/```[\s\S]*?```/g, " ") // fenced code
    .replace(/`[^`\n]+`/g, " ") // inline code
    .replace(MASK_TOKEN_RE, " ") // mask tokens
    .replace(/!?\[\[[^\]]+\]\]/g, " ") // wikilinks / embeds
    .replace(/\]\(([^)\s]+)(\s+"[^"]*")?\)/g, "] ") // markdown link targets (link TEXT survives)
    .replace(/https?:\/\/\S+/g, " "); // bare URLs
}

type Tok = { word: string; initial: boolean; idx: number; line: number };

// tokens splits text into word tokens with per-token sentence-initial and line-index metadata,
// after stripZones removes capitalization-irrelevant zones. Unicode-aware (Cyrillic included);
// \p{M} keeps combining marks (accents, Cyrillic stress) inside a token instead of splitting
// it, and NFC canonicalizes the surface form first so `found`/`wanted` render composed. A
// token is sentence-initial when it is the line's first token, follows sentence-ending
// punctuation or an opening quote/bracket, or everything before it on the line is list/heading
// markup (`-`, `*`, `>`, `#`, digits, `.`).
function tokens(text: string): Tok[] {
  const out: Tok[] = [];
  const re = /[\p{L}\p{N}][\p{L}\p{N}\p{M}'’]*/gu;
  const lines = stripZones(text.normalize("NFC")).split("\n");
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    let m: RegExpExecArray | null;
    let prevEnd = -1;
    let first = true;
    let idx = 0;
    while ((m = re.exec(line))) {
      const before = line.slice(prevEnd < 0 ? 0 : prevEnd, m.index);
      const initial =
        first ||
        /[.!?:;|—]\s*$|["«([]\s*$/.test(before) ||
        /^\s*[-*>#\d.]+\s*$/.test(line.slice(0, m.index));
      out.push({ word: m[0], initial, idx: idx++, line: li });
      prevEnd = m.index + m[0].length;
      first = false;
    }
  }
  return out;
}

// Mark-insensitive lowercase key: NFC/NFD spellings of one name compare equal, and
// accent/stress variants fold into one group (an accent is never the letter-mangling
// corruption this lint chases).
const foldKey = (w: string): string =>
  w
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();

// Membership folds: mark-insensitive lowercase, strip a possessive 's or trailing apostrophe,
// and strip a plural s/es suffix.
const foldSet = (w: string): string[] => {
  const l = foldKey(w)
    .replace(/[’']s$/, "")
    .replace(/[’']$/, "");
  const alts = [l];
  if (l.endsWith("es")) alts.push(l.slice(0, -2));
  if (l.endsWith("s")) alts.push(l.slice(0, -1));
  return alts;
};

// Candidate name shape: starts uppercase; not ALL-CAPS/acronym (HEY, SEO, N3's); not an
// acronym plural/possessive (URLs, APIs, PR's); letters and apostrophes only (digit-bearing
// tokens excluded); at least 4 letters, ignoring apostrophes.
const isCandidateShape = (w: string): boolean =>
  /^\p{Lu}/u.test(w) &&
  !/^[\p{Lu}\p{N}\p{M}'’]+$/u.test(w) &&
  !/^[\p{Lu}\p{N}\p{M}]+[’']?s$/u.test(w) &&
  /^[\p{L}\p{M}'’]+$/u.test(w) &&
  w.replace(/[’']|\p{M}/gu, "").length >= 4;
const isCapWord = (w: string): boolean => /^\p{Lu}/u.test(w);

// A candidate name grouped by its fold key: the first-seen surface `word`, how many times it
// occurs (`count`), and how many of those are mid-sentence (`nonInitial`). against-source
// ignores `count`; self-consistency uses all three.
type CandidateGroup = { word: string; count: number; nonInitial: number };

// buildCandidateGroups folds every candidate-shape token (see isCandidateShape) into one group
// per name, keyed by foldKey. Shared by both lanes.
function buildCandidateGroups(toks: Tok[]): Map<string, CandidateGroup> {
  const groups = new Map<string, CandidateGroup>();
  for (const t of toks) {
    if (!isCandidateShape(t.word)) continue;
    const k = foldKey(t.word);
    const g = groups.get(k) ?? { word: t.word, count: 0, nonInitial: 0 };
    g.count++;
    if (!t.initial) g.nonInitial++;
    groups.set(k, g);
  }
  return groups;
}

// lowercaseKeys is the set of fold keys for tokens seen uncapitalized — evidence that a name
// occurs lowercase, which relaxes the sentence-initial-only rule (see initialOnlyRelaxed).
function lowercaseKeys(toks: Tok[]): Set<string> {
  const s = new Set<string>();
  for (const t of toks) if (!isCapWord(t.word)) s.add(foldKey(t.word));
  return s;
}

// SourceIndex is the folded view of the source that against-source classifies output against:
// `srcSet` is ALL source words (for the covered() membership test), `srcCapSurface` maps a
// candidate's fold key to its first-seen surface form, `srcNonInitial` holds keys attested
// mid-sentence, and `srcCaps` is the candidate-key list scanned for nearest-name matches.
type SourceIndex = {
  srcSet: Set<string>;
  srcCapSurface: Map<string, string>;
  srcNonInitial: Set<string>;
  srcCaps: string[];
};

function buildSourceIndex(source: string): SourceIndex {
  const srcToks = tokens(source);
  const srcSet = new Set(srcToks.flatMap((t) => foldSet(t.word))); // ALL source words, folded
  const srcCapSurface = new Map<string, string>(); // lc key -> first-seen surface form
  const srcNonInitial = new Set<string>(); // lc keys attested mid-sentence in source
  for (const t of srcToks) {
    if (!isCandidateShape(t.word)) continue;
    const lc = foldKey(t.word);
    if (!srcCapSurface.has(lc)) srcCapSurface.set(lc, t.word);
    if (!t.initial) srcNonInitial.add(lc);
  }
  return { srcSet, srcCapSurface, srcNonInitial, srcCaps: [...srcCapSurface.keys()] };
}

// knownMultiWordRun is the adjacency dampener: a candidate inside a same-line contiguous
// capitalized run that contains a source-covered token ("Apple M3 Max" with M3/Max in source)
// is part of a known multi-word name, so it maps to true and is suppressed from the advisory
// invented lane only. The flag is monotonic per key — one covered neighbor anywhere fixes it.
function knownMultiWordRun(outToks: Tok[], covered: (w: string) => boolean): Map<string, boolean> {
  const inKnownRun = new Map<string, boolean>();
  for (let i = 0; i < outToks.length; i++) {
    const t = outToks[i];
    if (!isCandidateShape(t.word)) continue;
    const k = foldKey(t.word);
    let known = inKnownRun.get(k) ?? false;
    for (const dir of [-1, 1]) {
      for (let j = i + dir; j >= 0 && j < outToks.length; j += dir) {
        const u = outToks[j];
        if (u.line !== t.line || !isCapWord(u.word)) break;
        if (covered(u.word) && u.word.replace(/[’']/g, "").length >= 2) {
          known = true;
          break;
        }
      }
    }
    inKnownRun.set(k, known);
  }
  return inKnownRun;
}

// nameLintAgainstSource compares `output` against `source` and flags candidate proper names
// (see isCandidateShape) that appear in output but not in source: as `corrupted` when a
// candidate sits within corruptionCap edit distance of a source name, with `wanted` naming
// that source match, or as `invented` otherwise. Total: never throws, and the result is
// advisory — callers only render it, never block on it.
export function nameLintAgainstSource(output: string, source: string): NameLintResult {
  const { srcSet, srcCapSurface, srcNonInitial, srcCaps } = buildSourceIndex(source);
  const outToks = tokens(output);
  const groups = buildCandidateGroups(outToks);
  const outLower = lowercaseKeys(outToks); // words seen uncapitalized in the output
  const covered = (w: string) => foldSet(w).some((a) => srcSet.has(a));
  const inKnownRun = knownMultiWordRun(outToks, covered);
  const corrupted: NameLintResult["corrupted"] = [];
  const invented: string[] = [];
  for (const [k, g] of groups) {
    // first-occurrence order
    if (covered(g.word)) continue; // present in source (case-insensitive, folded)
    // The corrupted lane applies the initialOnlyRelaxed rule below; the advisory
    // invented lane keeps the strict skip — it has no such evidence.
    const initialOnly = g.nonInitial === 0;
    let best: string | null = null,
      bestD = Infinity;
    for (const s of srcCaps) {
      const d = levenshtein(k, s);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    const cap = best ? corruptionCap(k, best) : 0;
    if (best && bestD >= 1 && bestD <= cap) {
      if (initialOnlyRelaxed(initialOnly, outLower.has(k), srcNonInitial.has(best))) continue;
      corrupted.push({ found: g.word, wanted: srcCapSurface.get(best) ?? best });
    } else if (!initialOnly && !inKnownRun.get(k)) invented.push(g.word);
  }
  return { corrupted, invented };
}

// nameLintSelfConsistency compares `output` against itself: when the same candidate name
// occurs under two different spellings within corruptionCap edit distance of each other, the
// minority-count spelling is flagged as `corrupted` against the majority-count spelling; a tie
// (equal counts) has no clear direction and is skipped. Has no invented lane — there is
// nothing to compare a single document against. Total: never throws.
export function nameLintSelfConsistency(output: string): NameLintResult {
  const toks = tokens(output);
  const lower = lowercaseKeys(toks); // words seen uncapitalized in the doc
  const groups = buildCandidateGroups(toks);
  const names = [...groups.keys()];
  const corrupted: NameLintResult["corrupted"] = [];
  for (const a of names)
    for (const b of names) {
      if (a >= b) continue; // each unordered pair once
      const ga = groups.get(a)!,
        gb = groups.get(b)!;
      if (foldSet(ga.word).some((x) => foldSet(gb.word).includes(x))) continue; // inflection variants
      const d = levenshtein(a, b);
      const cap = corruptionCap(a, b);
      if (d < 1 || d > cap) continue;
      const [minor, major] = ga.count < gb.count ? [ga, gb] : [gb, ga];
      if (minor.count === major.count) continue; // tie: no direction, skip
      // same initialOnlyRelaxed rule as against-source (kills Definition/Destination-style
      // table-header pairs while keeping a fronted corrupted name)
      if (
        initialOnlyRelaxed(
          minor.nonInitial === 0,
          lower.has(foldKey(minor.word)),
          major.nonInitial !== 0,
        )
      )
        continue;
      corrupted.push({ found: minor.word, wanted: major.word }); // minority spelling is the suspect
    }
  return { corrupted, invented: [] }; // self mode has no invented lane
}

// formatNameLint renders a NameLintResult as a trailing footer fragment (" · name-lint: ...")
// for a distill run's summary line, or "" when the result is clean (no corrupted or invented
// names).
export function formatNameLint(r: NameLintResult): string {
  if (r.corrupted.length === 0 && r.invented.length === 0) return "";
  const parts: string[] = [];
  if (r.corrupted.length)
    parts.push(
      `${r.corrupted.length} probable corrupted name${r.corrupted.length > 1 ? "s" : ""} ` +
        `(${r.corrupted.map((p) => `${p.found} ← ${p.wanted}`).join(", ")})`,
    );
  if (r.invented.length) {
    const shown = r.invented.slice(0, 5);
    parts.push(
      `${r.invented.length} invented (${shown.join(", ")}${r.invented.length > 5 ? ", …" : ""})`,
    );
  }
  return ` · name-lint: ${parts.join(", ")}`;
}
