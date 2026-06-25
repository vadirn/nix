#!/usr/bin/env bun
// harness — settle distill's synthesis fidelity dial (render vs regenerate).
//
// Runs distill N× per fixture per dial and measures, by construction:
//   1. STABILITY — mean pairwise Jaccard over the set of glossary terms across the
//      N runs (model-free, normalized-string match). NOT word-count clustering.
//   2. COLLAPSE  — each fixture injects 2 concepts, each stated 3× in scattered
//      paraphrases (see *.truth.json). A correct distill collapses each set to
//      exactly ONE glossary entry. We count output terms matching the concept's
//      coined name: 1 = collapsed, 0 = dropped (hard fail), >=2 = split.
//   3. REDUCTION — (baseWords - outputWords)/baseWords, mean per dial.
//
// Live Fireworks (~20-40 s/run). Run under doppler so children inherit the key:
//   doppler run --project claude-code --config std -- bun harness.ts [--n 5] [--gate]
// Children run with --no-gate by default (isolates stage 3 for the stability read);
// pass --gate to measure how often each dial trips the fidelity gate instead.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname } from "node:path";

const pexec = promisify(execFile);
const HERE = dirname(Bun.fileURLToPath(import.meta.url));
const DISTILL = join(HERE, "..", "distill.ts");
const FIXDIR = join(HERE, "fixtures");

type Truth = {
  baseWords: number;
  concepts: { term: string; match: string[]; restatements: number; expected_entries: number }[];
};
type RunResult = { terms: string[]; words: number; footer: string } | null;

function bodyOf(text: string): string {
  // mirror distill's splitFrontmatter: drop a leading --- … --- block
  if (!text.startsWith("---\n")) return text;
  const lines = text.split("\n");
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---" || lines[i] === "...")
      return lines
        .slice(i + 1)
        .join("\n")
        .replace(/^\n/, "");
  }
  return text;
}

function wordCount(s: string): number {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}

const normTerm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[.,;:]+$/, "")
    .replace(/\s+/g, " ")
    .trim();

// pull the Term column out of the `## Glossary` markdown table in a result body
function parseGlossaryTerms(body: string): string[] {
  const lines = body.split("\n");
  const out: string[] = [];
  let inTable = false;
  for (const line of lines) {
    if (/^##\s+Glossary/i.test(line)) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (!line.trim().startsWith("|")) {
      if (out.length) break; // table ended
      continue;
    }
    const cells = line.split("|").map((c) => c.trim());
    const term = cells[1] ?? "";
    if (!term || /^-+$/.test(term) || /^term$/i.test(term)) continue; // header / separator
    out.push(normTerm(term));
  }
  return out;
}

function resultBody(file: string): string {
  const raw = readFileSync(file, "utf8");
  const m = raw.match(/<result>\n([\s\S]*?)\n<\/result>/);
  return bodyOf(m ? m[1] : raw);
}

async function oneRun(fixture: string, dial: string, gate: boolean): Promise<RunResult> {
  const args = [DISTILL, "--synth", dial, fixture];
  if (!gate) args.push("--no-gate");
  try {
    const { stdout } = await pexec("bun", args, { maxBuffer: 1 << 24, timeout: 240_000 });
    const [path, footer = ""] = stdout.trim().split("\n");
    if (footer.includes("skipped") || footer.includes("no concepts")) return null;
    const body = resultBody(path);
    return { terms: parseGlossaryTerms(body), words: wordCount(body), footer };
  } catch {
    return null;
  }
}

// mean pairwise Jaccard over N term-sets
function meanJaccard(sets: Set<string>[]): number {
  if (sets.length < 2) return 1;
  let sum = 0,
    pairs = 0;
  for (let i = 0; i < sets.length; i++)
    for (let j = i + 1; j < sets.length; j++) {
      const a = sets[i],
        b = sets[j];
      const inter = [...a].filter((x) => b.has(x)).length;
      const uni = new Set([...a, ...b]).size;
      sum += uni ? inter / uni : 1;
      pairs++;
    }
  return pairs ? sum / pairs : 1;
}

// bounded-concurrency map (5-way) — never fire all runs at once (429s)
async function pMap<T, R>(
  items: T[],
  limit: number,
  fn: (t: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function main() {
  if (!process.env.FIREWORKS_API_KEY) {
    console.error("FIREWORKS_API_KEY not set — run under doppler.");
    process.exit(1);
  }
  const argv = process.argv.slice(2);
  const N = (() => {
    const i = argv.indexOf("--n");
    return i >= 0 ? parseInt(argv[i + 1], 10) : 5;
  })();
  const gate = argv.includes("--gate");
  const dials = ["render", "regenerate"];
  const fixtures = readdirSync(FIXDIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));

  // build the full task list, then run it 5-way concurrent
  type Task = { fixture: string; dial: string; run: number };
  const tasks: Task[] = [];
  for (const fixture of fixtures)
    for (const dial of dials) for (let r = 0; r < N; r++) tasks.push({ fixture, dial, run: r });

  console.error(
    `# distill synth-dial experiment\nfixtures=${fixtures.length} dials=${dials.length} N=${N} gate=${gate} → ${tasks.length} runs, 5-way concurrent\n`,
  );
  let done = 0;
  const results = await pMap(tasks, 5, async (t) => {
    const r = await oneRun(join(FIXDIR, `${t.fixture}.md`), t.dial, gate);
    console.error(
      `  [${++done}/${tasks.length}] ${t.fixture} ${t.dial} #${t.run} ${r ? "ok" : "FAIL"}`,
    );
    return { ...t, r };
  });

  // aggregate
  const rows: string[] = [];
  rows.push(`# distill synth-dial experiment — N=${N} per fixture per dial, gate=${gate}`);
  rows.push("");
  rows.push(
    "| Fixture | Dial | Jaccard | mean reduction | concept → entries (per run) | dropped |",
  );
  rows.push(
    "| ------- | ---- | ------- | -------------- | --------------------------- | ------- |",
  );

  const summary: Record<string, { jac: number[]; red: number[]; drops: number }> = {
    render: { jac: [], red: [], drops: 0 },
    regenerate: { jac: [], red: [], drops: 0 },
  };

  for (const fixture of fixtures) {
    const truth = JSON.parse(readFileSync(join(FIXDIR, `${fixture}.truth.json`), "utf8")) as Truth;
    const baseWords = wordCount(bodyOf(readFileSync(join(FIXDIR, `${fixture}.md`), "utf8")));
    for (const dial of dials) {
      const runs = results
        .filter((x) => x.fixture === fixture && x.dial === dial && x.r)
        .map((x) => x.r!);
      if (runs.length === 0) {
        rows.push(`| ${fixture} | ${dial} | — | — | (all runs failed) | — |`);
        continue;
      }
      const sets = runs.map((r) => new Set(r.terms));
      const jac = meanJaccard(sets);
      const red = runs.map((r) => (baseWords - r.words) / baseWords);
      const meanRed = red.reduce((a, b) => a + b, 0) / red.length;
      // collapse: per concept, count matching output terms per run
      const collapseCells: string[] = [];
      let dropped = 0;
      for (const c of truth.concepts) {
        const counts = runs.map(
          (r) => r.terms.filter((t) => c.match.some((m) => t.includes(m.toLowerCase()))).length,
        );
        if (counts.some((n) => n === 0)) dropped++;
        collapseCells.push(`${c.term}: [${counts.join(",")}]`);
      }
      summary[dial].jac.push(jac);
      summary[dial].red.push(meanRed);
      summary[dial].drops += dropped;
      rows.push(
        `| ${fixture} | ${dial} | ${jac.toFixed(2)} | ${(meanRed * 100).toFixed(0)}% | ${collapseCells.join("; ")} | ${dropped} |`,
      );
    }
  }

  rows.push("");
  rows.push("| Dial | mean Jaccard | mean reduction | concept-drops |");
  rows.push("| ---- | ------------ | -------------- | ------------- |");
  for (const dial of dials) {
    const s = summary[dial];
    const mj = s.jac.length ? s.jac.reduce((a, b) => a + b, 0) / s.jac.length : 0;
    const mr = s.red.length ? s.red.reduce((a, b) => a + b, 0) / s.red.length : 0;
    rows.push(`| ${dial} | ${mj.toFixed(2)} | ${(mr * 100).toFixed(0)}% | ${s.drops} |`);
  }

  const table = rows.join("\n");
  console.log("\n" + table + "\n");
  const outPath = join(HERE, `results-${gate ? "gate" : "nogate"}.md`);
  writeFileSync(outPath, table + "\n");
  console.error(`\nwrote ${outPath}`);
}

main();
