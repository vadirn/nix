#!/usr/bin/env bun
// Re-runs the measurement behind the Oxford-comma decision in src/simplify/sequence.ts.
//
// That decision refuses recall on purpose: `sequenceScan` will not read a bare "A, B and C" as a
// series. A deliberate under-reach needs its evidence attached, and the figures this script
// replaced named a file count with no selector, so nobody could re-run them and their arithmetic
// drifted unnoticed. Hence a script rather than a remembered number.
//
// Three arms over one corpus, each file read the way runSimplify reads it — frontmatter stripped,
// body masked:
//
//   A  shipped contract       — Oxford required, coordinator located anywhere in the sentence
//   B  bare form accepted     — a later segment that merely CONTAINS a coordinator closes the series
//   C  coordinator must CLOSE the sentence — the contract before trailing material was counted out
//
// Arm A is replicated here rather than imported, because the variants need sequence.ts's private
// helpers. The replica is checked against the real `sequenceScan` on every file, and a mismatch
// prints DRIFT and lands in the report — so a copy that falls behind the module fails loud instead
// of quietly measuring something else.
//
// Corpus: `git ls-files '*.md'` at the repo root, or a newline-separated file list on stdin.
// Run: bun run measure:oxford

import { parseFrontmatter } from "textkit/core/frontmatter.ts";
import { createMasker } from "textkit/core/writing/mask.ts";
import { proseParagraphs } from "textkit/simplify/prose.ts";
import { SEQ_MIN, sequenceScan } from "textkit/simplify/sequence.ts";

// Verbatim from src/simplify/sequence.ts. The DRIFT check below is what keeps them in step. The
// three arms differ only in how they count a comma series, so all three read the module's own prose
// source — mdstruct's paragraphs, minus every blockquote and list.
const SHAPED_BLOCKS = new Set(["blockQuote", "list"]);

const SENTENCE_SPLIT_RE = /(?<=[.!?…][*_`)\]"'»”’]*)\s+(?=\S)/;
const ASIDE_RE = /,\s+(?:which|who|whom|whose|that|where|when)\b[^,]*,/g;
const COORD_OPENS_RE = /^\s*(?:and|or)\s/;
// Arm B only: the coordinator sits INSIDE the segment, so no comma precedes it.
const COORD_INSIDE_RE = /\s(?:and|or)\s/;

const segmentsOn = (s: string, delim: string): number => (s.trim() ? s.split(delim).length : 0);

type Arm = "A" | "B" | "C";

function commaMembers(sentence: string, arm: Arm): number {
  if (!sentence.trim()) return 0;
  const segments = sentence.replace(ASIDE_RE, "").split(",");
  if (arm === "C") {
    // The coordinator must be the LAST segment, so nothing may follow the final member.
    const last = segments.length - 1;
    if (last < 1) return 0;
    return COORD_OPENS_RE.test(segments[last]!) ? segments.length : 0;
  }
  const opens = segments.findIndex((s, i) => i > 0 && COORD_OPENS_RE.test(s));
  if (arm === "A") return opens < 0 ? 0 : opens + 1;
  // Arm B takes whichever comes first: a segment opening with the coordinator (Oxford, so that
  // segment IS the last member), or one merely containing it (bare form, so the segment holds two
  // members — "A, B and C" splits to ["A", " B and C"] and scores 3).
  const inside = segments.findIndex((s, i) => i > 0 && COORD_INSIDE_RE.test(s));
  if (opens < 0 && inside < 0) return 0;
  if (opens >= 0 && (inside < 0 || opens <= inside)) return opens + 1;
  return inside + 2;
}

type Finding = { sentence: string; members: number };

function scan(masked: string, arm: Arm, min = SEQ_MIN): Finding[] {
  const findings: Finding[] = [];
  for (const paragraph of proseParagraphs(masked, SHAPED_BLOCKS)) {
    for (const sentence of paragraph.split(SENTENCE_SPLIT_RE)) {
      const semis = segmentsOn(sentence, ";");
      const commas = commaMembers(sentence, arm);
      if (semis >= min || commas >= min)
        findings.push({ sentence: sentence.trim(), members: Math.max(semis, commas) });
    }
  }
  return findings;
}

function defaultCorpus(): string[] {
  const root = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"]).stdout.toString().trim();
  const listed = Bun.spawnSync(["git", "ls-files", "*.md"], { cwd: root }).stdout.toString();
  return listed
    .split("\n")
    .filter(Boolean)
    .map((rel) => `${root}/${rel}`);
}

const piped = process.stdin.isTTY ? "" : await Bun.stdin.text();
const files = piped.trim()
  ? piped
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
  : defaultCorpus();

let a = 0,
  b = 0,
  c = 0,
  scanned = 0,
  drift = 0;
const addedByB: string[] = [];
const droppedByC: string[] = [];

for (const file of files) {
  let text: string;
  try {
    text = await Bun.file(file).text();
  } catch {
    continue;
  }
  scanned++;
  const { body } = parseFrontmatter(text);
  const masked = createMasker().mask(body);

  const fa = scan(masked, "A");
  const fb = scan(masked, "B");
  const fc = scan(masked, "C");

  const real = sequenceScan(masked)
    .map((f) => f.sentence)
    .sort();
  if (JSON.stringify(real) !== JSON.stringify(fa.map((f) => f.sentence).sort())) {
    drift++;
    console.error(`DRIFT ${file}: sequenceScan ${real.length} vs arm A ${fa.length}`);
  }

  a += fa.length;
  b += fb.length;
  c += fc.length;

  const aSet = new Set(fa.map((f) => f.sentence));
  const cSet = new Set(fc.map((f) => f.sentence));
  for (const f of fb) if (!aSet.has(f.sentence)) addedByB.push(`${file}\t${f.sentence}`);
  for (const f of fa) if (!cSet.has(f.sentence)) droppedByC.push(`${file}\t${f.sentence}`);
}

console.log(
  JSON.stringify(
    {
      corpusFiles: scanned,
      replicaDrift: drift,
      armA_shipped: a,
      armB_bareFormAccepted: b,
      armC_coordinatorMustClose: c,
      addedByBareForm: addedByB.length,
      droppedByDemandingClose: droppedByC.length,
    },
    null,
    2,
  ),
);

// The deltas are what the comment characterizes, so make them readable rather than counted only.
if (process.env.OUT_ADDED) await Bun.write(process.env.OUT_ADDED, addedByB.join("\n"));
if (process.env.OUT_DROPPED) await Bun.write(process.env.OUT_DROPPED, droppedByC.join("\n"));
