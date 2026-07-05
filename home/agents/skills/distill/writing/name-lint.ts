// writing/name-lint — deterministic, zero-LLM check for names the writing/revise
// passes may have corrupted (a proper noun mangled toward a near neighbor) or
// invented (a capitalized token with no source counterpart). Both modes are
// total (never throw) and never block: callers only render the result into a
// footer or Flags line. Leaf module: imports nothing, so the core can depend
// on it without a cycle back to text.ts.

export type NameFinding = { found: string; wanted: string };
export type NameLintResult = { corrupted: NameFinding[]; invented: string[] };

export function levenshtein(a: string, b: string): number {
  const m = a.length,
    n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

// Bounded variant: exact distance when <= bound, else bound+1. Trims the common
// prefix/suffix, short-circuits on the length delta (a Levenshtein lower bound),
// and abandons the DP once a whole row exceeds the bound — so spell verify's hot
// case (a huge block returned nearly unchanged) costs O(len), and a wholesale
// rewrite exits after ~bound rows instead of filling the full len² table.
// Residual: a large block with edits scattered at both ends still pays the DP on
// the untrimmed middle.
export function levenshteinBounded(a: string, b: string, bound: number): number {
  if (a === b) return 0;
  let s = 0,
    ae = a.length,
    be = b.length;
  while (s < ae && s < be && a[s] === b[s]) s++;
  while (ae > s && be > s && a[ae - 1] === b[be - 1]) {
    ae--;
    be--;
  }
  const x = a.slice(s, ae),
    y = b.slice(s, be);
  if (Math.abs(x.length - y.length) > bound) return bound + 1;
  const m = x.length,
    n = y.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > bound) return bound + 1;
    prev = cur;
  }
  return Math.min(prev[n], bound + 1);
}

function stripZones(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ") // fenced code
    .replace(/`[^`\n]+`/g, " ") // inline code
    .replace(/⟦\d+⟧/g, " ") // mask tokens
    .replace(/!?\[\[[^\]]+\]\]/g, " ") // wikilinks / embeds
    .replace(/\]\(([^)\s]+)(\s+"[^"]*")?\)/g, "] ") // markdown link targets (link TEXT survives)
    .replace(/https?:\/\/\S+/g, " "); // bare URLs
}

type Tok = { word: string; initial: boolean; idx: number; line: number };

function tokens(text: string): Tok[] {
  const out: Tok[] = [];
  // Unicode-aware; Cyrillic included. \p{M} keeps combining marks (Cyrillic
  // stress, decomposed accents) inside the token instead of splitting it; NFC
  // canonicalizes the surface form so `found`/`wanted` render composed.
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
      const initial = // sentence-initial detection (frozen)
        first ||
        /[.!?:;|—]\s*$|["«(\[]\s*$/.test(before) ||
        /^\s*[-*>#\d.]+\s*$/.test(line.slice(0, m.index));
      out.push({ word: m[0], initial, idx: idx++, line: li });
      prevEnd = m.index + m[0].length;
      first = false;
    }
  }
  return out;
}

// mark-insensitive lowercase key: NFC/NFD spellings of one name compare equal,
// and accent/stress variants fold into one group (an accent is never the
// letter-mangling corruption this lint chases)
const foldKey = (w: string): string =>
  w
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();

// membership folds: mark-insensitive lowercase, strip possessive 's / trailing
// apostrophe, plural s/es
const foldSet = (w: string): string[] => {
  const l = foldKey(w)
    .replace(/[’']s$/, "")
    .replace(/[’']$/, "");
  const alts = [l];
  if (l.endsWith("es")) alts.push(l.slice(0, -2));
  if (l.endsWith("s")) alts.push(l.slice(0, -1));
  return alts;
};

// candidate shape: starts uppercase; not ALL-CAPS/acronym (HEY, SEO, N3's);
// not acronym-plural/possessive (URLs, APIs, PR's); letters+apostrophes only
// (digit-bearing tokens excluded); >=4 letters ignoring apostrophes
const isCandidateShape = (w: string): boolean =>
  /^\p{Lu}/u.test(w) &&
  !/^[\p{Lu}\p{N}\p{M}'’]+$/u.test(w) &&
  !/^[\p{Lu}\p{N}\p{M}]+[’']?s$/u.test(w) &&
  /^[\p{L}\p{M}'’]+$/u.test(w) &&
  w.replace(/[’']|\p{M}/gu, "").length >= 4;
const isCapWord = (w: string): boolean => /^\p{Lu}/u.test(w);

export function nameLintAgainstSource(output: string, source: string): NameLintResult {
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
  const srcCaps = [...srcCapSurface.keys()];
  const outToks = tokens(output);
  const groups = new Map<string, { word: string; nonInitial: number }>();
  const outLower = new Set<string>(); // words seen uncapitalized in the output
  for (const t of outToks) if (!isCapWord(t.word)) outLower.add(foldKey(t.word));
  const covered = (w: string) => foldSet(w).some((a) => srcSet.has(a));
  const inKnownRun = new Map<string, boolean>(); // adjacency dampener
  for (let i = 0; i < outToks.length; i++) {
    const t = outToks[i];
    if (!isCandidateShape(t.word)) continue;
    const k = foldKey(t.word);
    const g = groups.get(k) ?? { word: t.word, nonInitial: 0 };
    if (!t.initial) g.nonInitial++;
    groups.set(k, g);
    // a candidate inside a same-line contiguous capitalized run that contains a
    // source-covered token ("Apple M3 Max" with M3/Max in source) is part of a
    // known multi-word name -> suppressed from the ADVISORY list only
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
  const corrupted: NameLintResult["corrupted"] = [];
  const invented: string[] = [];
  for (const [k, g] of groups) {
    // first-occurrence order
    if (covered(g.word)) continue; // present in source (case-insensitive, folded)
    // Sentence-initial-only groups are usually ordinary capitalization ("So",
    // "Note", table headers), but a revise pass can front a corrupted name too.
    // The corrupted lane flags an initial-only group when the word never occurs
    // uncapitalized AND its near-neighbor is attested mid-sentence (a real
    // proper noun, not another structurally capitalized ordinary word); the
    // advisory invented lane keeps the strict skip — it has no such evidence.
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
    const cap = best ? Math.min(3, Math.floor(Math.max(k.length, best.length) / 3)) : 0;
    if (best && bestD >= 1 && bestD <= cap) {
      if (initialOnly && (outLower.has(k) || !srcNonInitial.has(best))) continue;
      corrupted.push({ found: g.word, wanted: srcCapSurface.get(best) ?? best });
    } else if (!initialOnly && !inKnownRun.get(k)) invented.push(g.word);
  }
  return { corrupted, invented };
}

export function nameLintSelfConsistency(output: string): NameLintResult {
  const toks = tokens(output);
  const lower = new Set<string>(); // words seen uncapitalized in the doc
  for (const t of toks) if (!isCapWord(t.word)) lower.add(foldKey(t.word));
  const groups = new Map<string, { word: string; count: number; nonInitial: number }>();
  for (const t of toks) {
    if (!isCandidateShape(t.word)) continue;
    const k = foldKey(t.word);
    const g = groups.get(k) ?? { word: t.word, count: 0, nonInitial: 0 };
    g.count++;
    if (!t.initial) g.nonInitial++;
    groups.set(k, g);
  }
  const names = [...groups.keys()];
  const corrupted: NameLintResult["corrupted"] = [];
  for (const a of names)
    for (const b of names) {
      if (a >= b) continue; // each unordered pair once
      const ga = groups.get(a)!,
        gb = groups.get(b)!;
      if (foldSet(ga.word).some((x) => foldSet(gb.word).includes(x))) continue; // inflection variants
      const d = levenshtein(a, b);
      const cap = Math.min(3, Math.floor(Math.max(a.length, b.length) / 3));
      if (d < 1 || d > cap) continue;
      const [minor, major] = ga.count < gb.count ? [ga, gb] : [gb, ga];
      if (minor.count === major.count) continue; // tie: no direction, skip
      // same relaxation as against-source: an initial-only minority is flagged
      // only when it never occurs uncapitalized and the majority spelling is
      // attested mid-sentence (kills Definition/Destination-style table-header
      // pairs while keeping a fronted corrupted name)
      if (minor.nonInitial === 0 && (lower.has(foldKey(minor.word)) || major.nonInitial === 0))
        continue;
      corrupted.push({ found: minor.word, wanted: major.word }); // minority spelling is the suspect
    }
  return { corrupted, invented: [] }; // self mode has no invented lane
}

// footer fragment; "" when clean
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
