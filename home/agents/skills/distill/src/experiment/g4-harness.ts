#!/usr/bin/env bun
// g4-harness — calibrate the G4 atomicity judge (cards/prompts.ts::atomicityJudgePrompt)
// against real vault card files, before its verdict is trusted anywhere upstream.
//
// Calibration protocol (verdicts stay ADVISORY — informing the prompt text, never
// gating a merge — until this passes):
//   1. The exemplar cards named in the lexicographer note (cards/prompts.ts's
//      CONCEPT_EXEMPLAR / THESIS_EXEMPLAR: "Объем понятия" and "Parse, don't
//      type-check") must each judge atomic.
//   2. The corpus's own counter-example named in atomicityJudgePrompt's header
//      comment, "Measuring time" (one named timing technique over a body that
//      also covers timer precision and page lifecycle states), must judge
//      non-atomic.
//   3. A roughly 15-card sample of the corpus judges sanely (spot-checked by eye
//      against each printed reason).
//
// Per card: read the file, split frontmatter description (parseDescription) from
// body (parseFrontmatter), build atomicityJudgePrompt, askJson on FIDELITY, print
// one line: path, verdict, reason, and PASS/FAIL when --expect is set. A card with
// no frontmatter description cannot be judged (the judge needs both channels) and
// is skipped with a note, not silently counted. A judge call that fails after fw's
// own retries prints "inconclusive" for that card and the run continues — one flaky
// call must not abort a 15-card batch.
//
// IMPORTANT: no paid call runs without FIREWORKS_API_KEY. --dry-run prints each
// built prompt and exits before touching the network, for offline calibration
// against experiment/fixtures/g4-fixture.md.
//
// Usage:
//   bun experiment/g4-harness.ts --dry-run experiment/fixtures/g4-fixture.md
//   doppler run --project claude-code --config std -- \
//     bun experiment/g4-harness.ts --expect atomic "20 cards/Parse, don't type-check.md" ...
import { readFileSync } from "node:fs";
import { parseFrontmatter, parseDescription } from "@/kernel/frontmatter.ts";
import { detectLang } from "@/kernel/text.ts";
import { atomicityJudgePrompt } from "@/cards/prompts.ts";
import type { AtomicityReply } from "@/cards/types.ts";
import { askJson, FIDELITY, FIDELITY_TOKENS, rethrowIfBug } from "@/kernel/fw.ts";

export const USAGE = `g4-harness — calibrate the G4 atomicity judge over vault card files

Usage:
  g4-harness [options] <card.md>...

Options:
  --expect <atomic|non-atomic>   apply this expected verdict to every given card;
                                  turns the run into a pass/fail calibration
  --dry-run                      print each built prompt; call nothing
  -h, --help                     show this help and exit

Env: FIREWORKS_API_KEY (e.g. doppler run --project claude-code --config std --),
     not required for --dry-run.
`;

type Expect = "atomic" | "non-atomic";

export type ParseResult =
  | { kind: "help" }
  | { kind: "error"; message: string }
  | { kind: "ok"; paths: string[]; expect: Expect | null; dryRun: boolean };

export function parseArgs(argv: string[]): ParseResult {
  let expect: Expect | null = null;
  let dryRun = false;
  const paths: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") return { kind: "help" };
    if (a === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (a === "--expect") {
      const v = argv[++i];
      if (v !== "atomic" && v !== "non-atomic")
        return {
          kind: "error",
          message: `--expect expects one of: atomic, non-atomic (got '${v ?? "(missing)"}')`,
        };
      expect = v;
      continue;
    }
    if (a.startsWith("-") && a !== "-") return { kind: "error", message: `unknown flag '${a}'` };
    paths.push(a);
  }
  if (paths.length === 0) return { kind: "error", message: "expected one or more card .md paths" };
  return { kind: "ok", paths, expect, dryRun };
}

// Validate a raw judge reply into the typed AtomicityReply the card prompts contract
// promises — a thinking model's json_object mode is a strong hint, not a guarantee
// (see fw.ts's extractJson comment), so a malformed reply must fail loud (null) here
// rather than let `undefined.atomic` crash the run or a truthy-but-wrong shape pass.
function validateAtomicityReply(reply: unknown): AtomicityReply | null {
  if (typeof reply !== "object" || reply === null) return null;
  const r = reply as Record<string, unknown>;
  if (typeof r.atomic !== "boolean") return null;
  if (typeof r.reason !== "string" || r.reason.trim() === "") return null;
  return { atomic: r.atomic, reason: r.reason.trim() };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.kind === "help") {
    process.stdout.write(USAGE);
    return;
  }
  if (parsed.kind === "error") {
    console.error(`g4-harness: ${parsed.message}\nTry 'g4-harness --help' for usage.`);
    process.exit(2);
    return;
  }
  const { paths, expect, dryRun } = parsed;
  if (!dryRun && !process.env.FIREWORKS_API_KEY) {
    console.error("g4-harness: FIREWORKS_API_KEY not set — run under doppler, or pass --dry-run.");
    process.exit(1);
    return;
  }

  let judged = 0,
    atomicCount = 0,
    nonAtomicCount = 0,
    inconclusive = 0,
    skipped = 0,
    pass = 0,
    fail = 0;

  for (const p of paths) {
    let raw: string;
    try {
      raw = readFileSync(p, "utf8");
    } catch (e) {
      console.log(`${p}\tERROR\t${e instanceof Error ? e.message : String(e)}`);
      skipped++;
      continue;
    }
    const { front, body } = parseFrontmatter(raw);
    const description = parseDescription(front);
    if (!description) {
      console.log(`${p}\tskipped\tno frontmatter description`);
      skipped++;
      continue;
    }
    const lang = detectLang(`${description}\n${body}`);
    const prompt = atomicityJudgePrompt(description, body.trim(), lang);

    if (dryRun) {
      console.log(`# ${p}\n${prompt}\n`);
      continue;
    }

    try {
      const rawReply = await askJson<AtomicityReply>(FIDELITY, prompt, FIDELITY_TOKENS);
      const reply = validateAtomicityReply(rawReply);
      if (!reply) {
        console.log(`${p}\tinconclusive\tjudge returned an unparseable reply`);
        inconclusive++;
        continue;
      }
      judged++;
      const verdict: Expect = reply.atomic ? "atomic" : "non-atomic";
      if (verdict === "atomic") atomicCount++;
      else nonAtomicCount++;
      let line = `${p}\t${verdict}\t${reply.reason}`;
      if (expect) {
        const ok = verdict === expect;
        if (ok) pass++;
        else fail++;
        line += `\t${ok ? "PASS" : "FAIL"}`;
      }
      console.log(line);
    } catch (e) {
      // a non-transient throw (a real bug, not a judge flake) propagates and aborts
      // the batch — see fw.ts's rethrowIfBug; only a transient flake degrades to an
      // inconclusive line here so the batch can continue.
      rethrowIfBug(e, `g4-harness ${p}`);
      console.log(`${p}\tinconclusive\t${e instanceof Error ? e.message : String(e)}`);
      inconclusive++;
    }
  }

  if (dryRun) return;

  const summaryParts = [
    `${paths.length} cards`,
    `${atomicCount} atomic`,
    `${nonAtomicCount} non-atomic`,
    `${inconclusive} inconclusive`,
    `${skipped} skipped`,
  ];
  if (expect) summaryParts.push(`${pass} PASS, ${fail} FAIL (of ${judged} judged)`);
  console.log(`\n# ${summaryParts.join(", ")}`);
}

// Guarded (Finding 5, mirrors card-stage.ts:345): USAGE/parseArgs are exported for
// testing, which makes this file importable — without the guard, importing it runs
// main() with the test runner's own argv, which can process.exit() mid-suite or,
// worse, make a real paid Fireworks call if FIREWORKS_API_KEY is set and an argv
// token looks like a .md path.
if (import.meta.main) main();
