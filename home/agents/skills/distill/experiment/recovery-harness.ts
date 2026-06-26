#!/usr/bin/env bun
// recovery-harness — settle distill's workflow-gate recovery ladder for
// contrastive-directive inversions. Compares three DISTILL_WF_RECOVERY modes:
//   retighten       — re-run the same render compression that inverted the step (prior)
//   repair          — judge-guided rewrite from the gate's finding, no floor
//   repair-verbatim — repair, then the source's verbatim imperative as a floor
//
// The scorer is by construction. A fixture with a `contrastive` truth block names
// the correct target tokens and the counterexample token of one trap directive.
// A shipped Workflow step is INVERTED iff it names the counterexample as the target
// (contains an `inverted` token) while naming no `correct` token — i.e. it prescribes
// Y after the source said "X, not Y". Gate ON throughout (the gate is what recovery
// reacts to). Run under doppler so children inherit the key and the mode env:
//   doppler run --project claude-code --config std -- bun recovery-harness.ts [--n 5]
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname } from "node:path";

const pexec = promisify(execFile);
const HERE = dirname(Bun.fileURLToPath(import.meta.url));
const DISTILL = join(HERE, "..", "distill.ts");
const FIXDIR = join(HERE, "fixtures");
const MODES = ["retighten", "repair", "repair-verbatim"];

type Contrastive = { desc: string; correct: string[]; inverted: string[] };
type Truth = { baseWords: number; contrastive?: Contrastive; directives_expected?: number };
type RunResult = {
  steps: string[];
  inverted: boolean;
  correctPresent: boolean;
  directiveCount: number;
  stepWords: number;
  residue: number;
  keptVerbatim: number;
  retries: number;
  footer: string;
} | null;

function bodyOf(text: string): string {
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

function resultBody(file: string): string {
  const raw = readFileSync(file, "utf8");
  const m = raw.match(/<result>\n([\s\S]*?)\n<\/result>/);
  return bodyOf(m ? m[1] : raw);
}

// pull the numbered items out of the `## Workflow` section
function parseWorkflowSteps(body: string): string[] {
  const lines = body.split("\n");
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (/^##\s+Workflow\b/i.test(line.trim())) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (/^##\s/.test(line.trim())) break; // next section ends it
    const m = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (m) out.push(m[1].trim());
  }
  return out;
}

const tagNum = (footer: string, label: string): number => {
  const m = new RegExp(`·\\s*(\\d+)\\s+${label}`).exec(footer);
  return m ? parseInt(m[1], 10) : 0;
};

function scoreSteps(steps: string[], c: Contrastive) {
  const correct = c.correct.map((t) => t.toLowerCase());
  const inverted = c.inverted.map((t) => t.toLowerCase());
  const hasCorrect = (s: string) => correct.some((t) => s.includes(t));
  const hasInverted = (s: string) => inverted.some((t) => s.includes(t));
  const lc = steps.map((s) => s.toLowerCase());
  return {
    inverted: lc.some((s) => hasInverted(s) && !hasCorrect(s)),
    correctPresent: lc.some(hasCorrect),
  };
}

async function oneRun(fixture: string, mode: string, c: Contrastive): Promise<RunResult> {
  try {
    const { stdout } = await pexec("bun", [DISTILL, fixture], {
      maxBuffer: 1 << 24,
      timeout: 300_000,
      env: { ...process.env, DISTILL_WF_RECOVERY: mode },
    });
    const [path, footer = ""] = stdout.trim().split("\n");
    if (footer.includes("skipped") || footer.includes("no concepts")) return null;
    const body = resultBody(path);
    const steps = parseWorkflowSteps(body);
    const { inverted, correctPresent } = scoreSteps(steps, c);
    return {
      steps,
      inverted,
      correctPresent,
      directiveCount: steps.length,
      stepWords: steps.reduce((a, s) => a + wordCount(s), 0),
      residue: tagNum(footer, "residue"),
      keptVerbatim: tagNum(footer, "kept-verbatim"),
      retries: tagNum(footer, "retries"),
      footer,
    };
  } catch {
    return null;
  }
}

async function pMap<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>) {
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

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

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
  const fixtures = readdirSync(FIXDIR)
    .filter((f) => f.endsWith(".truth.json"))
    .map((f) => f.replace(/\.truth\.json$/, ""))
    .filter((name) => {
      const t = JSON.parse(readFileSync(join(FIXDIR, `${name}.truth.json`), "utf8")) as Truth;
      return !!t.contrastive;
    });
  if (fixtures.length === 0) {
    console.error("no fixtures with a `contrastive` truth block found.");
    process.exit(1);
  }

  type Task = { fixture: string; mode: string; run: number };
  const tasks: Task[] = [];
  for (const fixture of fixtures)
    for (const mode of MODES) for (let r = 0; r < N; r++) tasks.push({ fixture, mode, run: r });

  console.error(
    `# distill recovery-ladder experiment\nfixtures=${fixtures.length} modes=${MODES.length} N=${N} → ${tasks.length} runs (gate ON), 5-way concurrent\n`,
  );
  const truths = new Map(
    fixtures.map((f) => [
      f,
      JSON.parse(readFileSync(join(FIXDIR, `${f}.truth.json`), "utf8")) as Truth,
    ]),
  );
  let done = 0;
  const results = await pMap(tasks, 5, async (t) => {
    const c = truths.get(t.fixture)!.contrastive!;
    const r = await oneRun(join(FIXDIR, `${t.fixture}.md`), t.mode, c);
    console.error(
      `  [${++done}/${tasks.length}] ${t.fixture} ${t.mode} #${t.run} ${
        r ? (r.inverted ? "INVERTED" : "ok") : "FAIL"
      }`,
    );
    return { ...t, r };
  });

  const rows: string[] = [];
  rows.push(`# distill recovery-ladder experiment — N=${N} per fixture per mode, gate ON`);
  rows.push("");
  rows.push(
    "| Fixture | Mode | runs | inverted | directive-dropped | mean residue | mean kept-verbatim | mean step-words | mean retries |",
  );
  rows.push(
    "| ------- | ---- | ---- | -------- | ----------------- | ------------ | ------------------ | --------------- | ------------ |",
  );

  for (const fixture of fixtures) {
    for (const mode of MODES) {
      const runs = results
        .filter((x) => x.fixture === fixture && x.mode === mode && x.r)
        .map((x) => x.r!);
      if (runs.length === 0) {
        rows.push(`| ${fixture} | ${mode} | 0 | — | — | — | — | — | — |`);
        continue;
      }
      const inv = runs.filter((r) => r.inverted).length;
      const dropped = runs.filter((r) => !r.correctPresent).length;
      rows.push(
        `| ${fixture} | ${mode} | ${runs.length} | ${inv}/${runs.length} | ${dropped}/${runs.length} | ${mean(
          runs.map((r) => r.residue),
        ).toFixed(2)} | ${mean(runs.map((r) => r.keptVerbatim)).toFixed(2)} | ${mean(
          runs.map((r) => r.stepWords),
        ).toFixed(0)} | ${mean(runs.map((r) => r.retries)).toFixed(2)} |`,
      );
    }
  }

  const table = rows.join("\n");
  console.log("\n" + table + "\n");
  const outPath = join(HERE, "results-recovery.md");
  writeFileSync(outPath, table + "\n");
  console.error(`\nwrote ${outPath}`);
}

main();
