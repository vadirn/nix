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
  const re = /[\p{L}\p{N}][\p{L}\p{N}'’]*/gu; // Unicode-aware; Cyrillic included
  const lines = stripZones(text).split("\n");
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

// membership folds: lowercase, strip possessive 's / trailing apostrophe, plural s/es
const foldSet = (w: string): string[] => {
  const l = w
    .toLowerCase()
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
  !/^[\p{Lu}\p{N}'’]+$/u.test(w) &&
  !/^[\p{Lu}\p{N}]+[’']?s$/u.test(w) &&
  /^[\p{L}'’]+$/u.test(w) &&
  w.replace(/[’']/g, "").length >= 4;
const isCapWord = (w: string): boolean => /^\p{Lu}/u.test(w);

export function nameLintAgainstSource(output: string, source: string): NameLintResult {
  const srcToks = tokens(source);
  const srcSet = new Set(srcToks.flatMap((t) => foldSet(t.word))); // ALL source words, folded
  const srcCapSurface = new Map<string, string>(); // lc key -> first-seen surface form
  for (const t of srcToks) {
    if (isCandidateShape(t.word) && !srcCapSurface.has(t.word.toLowerCase()))
      srcCapSurface.set(t.word.toLowerCase(), t.word);
  }
  const srcCaps = [...srcCapSurface.keys()];
  const outToks = tokens(output);
  const groups = new Map<string, { word: string; nonInitial: number }>();
  const covered = (w: string) => foldSet(w).some((a) => srcSet.has(a));
  const inKnownRun = new Map<string, boolean>(); // adjacency dampener
  for (let i = 0; i < outToks.length; i++) {
    const t = outToks[i];
    if (!isCandidateShape(t.word)) continue;
    const k = t.word.toLowerCase();
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
    if (g.nonInitial === 0) continue; // sentence-initial-only: skip (ordinary capitalization)
    if (covered(g.word)) continue; // present in source (case-insensitive, folded)
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
    if (best && bestD >= 1 && bestD <= cap)
      corrupted.push({ found: g.word, wanted: srcCapSurface.get(best) ?? best });
    else if (!inKnownRun.get(k)) invented.push(g.word);
  }
  return { corrupted, invented };
}

export function nameLintSelfConsistency(output: string): NameLintResult {
  const toks = tokens(output);
  const groups = new Map<string, { word: string; count: number; nonInitial: number }>();
  for (const t of toks) {
    if (!isCandidateShape(t.word)) continue;
    const k = t.word.toLowerCase();
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
      if (minor.nonInitial === 0) continue;
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
