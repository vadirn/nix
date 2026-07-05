// polish.test.ts — polish-text's own test surface: arg parsing (help / misuse /
// flag composition), the footer renderer, and the revise→spell composition order
// polish's main() encodes, driven offline through a mocked fw.ts (spell.test.ts /
// degradation.test.ts pattern).
import { afterAll, expect, mock, test } from "bun:test";
import { USAGE, buildPolishFooter, parseArgs } from "./polish.ts";
import { PASS_EN } from "./writing/passes.ts";

function ok(argv: string[]) {
  const r = parseArgs(argv);
  if (r.kind !== "ok") throw new Error(`expected ok, got ${r.kind}: ${JSON.stringify(r)}`);
  return r;
}
function err(argv: string[]) {
  const r = parseArgs(argv);
  if (r.kind !== "error") throw new Error(`expected error, got ${r.kind}`);
  return r.message;
}

// ---- USAGE (frozen text, §4.2) ----
test("USAGE: names the flags and the env requirement", () => {
  expect(USAGE).toContain("--lang <en|ru>");
  expect(USAGE).toContain("--no-revise");
  expect(USAGE).toContain("--no-spell");
  expect(USAGE).toContain("-o, --temp-file");
  expect(USAGE).toContain("-h, --help");
  expect(USAGE).toContain("Env: FIREWORKS_API_KEY");
  expect(USAGE).toContain("does not compress the text, add a glossary, or apply a fidelity gate");
});

test("USAGE: states the output contract — never in place, content→stdout, footer→stderr, exit codes", () => {
  expect(USAGE).toContain("The input file is never modified");
  expect(USAGE).not.toContain("in place");
  expect(USAGE).toContain("diagnostics go to stderr");
  expect(USAGE).toContain("0 polished");
  expect(USAGE).toContain("2 usage error");
  expect(USAGE).toContain("3 passthrough");
});

// ---- parseArgs ----
test("parseArgs: --help and -h short-circuit to the help result, even alongside other args", () => {
  expect(parseArgs(["--help"]).kind).toBe("help");
  expect(parseArgs(["-h"]).kind).toBe("help");
  expect(parseArgs(["input.md", "--help"]).kind).toBe("help");
});

test("parseArgs: bare invocation reads stdin with auto lang and no flags", () => {
  const r = ok([]);
  expect(r.opts).toEqual({
    lang: "auto",
    noRevise: false,
    noSpell: false,
    tempFile: false,
    path: undefined,
  });
});

test("parseArgs: -o / --temp-file select the temp-file output mode", () => {
  expect(ok(["-o", "in.md"]).opts.tempFile).toBe(true);
  expect(ok(["--temp-file"]).opts.tempFile).toBe(true);
});

test("parseArgs: a positional is taken as the input path; flags compose", () => {
  const r = ok(["--no-revise", "--no-spell", "input.md"]);
  expect(r.opts.path).toBe("input.md");
  expect(r.opts.noRevise).toBe(true);
  expect(r.opts.noSpell).toBe(true);
});

test("parseArgs: --lang en/ru are accepted", () => {
  expect(ok(["--lang", "en", "in.md"]).opts.lang).toBe("en");
  expect(ok(["--lang", "ru", "in.md"]).opts.lang).toBe("ru");
});

test("parseArgs: --lang rejects a missing value", () => {
  expect(err(["--lang"])).toBe("--lang expects a value (en or ru)");
});

test("parseArgs: --lang rejects an out-of-set value (no 'auto' token — absence IS auto)", () => {
  const m = err(["--lang", "auto"]);
  expect(m).toContain("--lang expects one of: en, ru");
  expect(m).toContain("'auto'");
  expect(err(["--lang", "fr"])).toContain("'fr'");
});

test("parseArgs: an unknown flag errors and names the offending token", () => {
  expect(err(["--frobnicate", "input.md"])).toBe("unknown flag '--frobnicate'");
});

test("parseArgs: more than one positional errors as an extra argument", () => {
  expect(err(["a.md", "b.md"])).toContain("unexpected extra argument(s): b.md");
});

test("parseArgs: `--` ends option parsing so a dash-prefixed path is a positional", () => {
  expect(ok(["--", "-weird-name.md"]).opts.path).toBe("-weird-name.md");
  expect(ok(["--", "--no-revise"]).opts.path).toBe("--no-revise"); // literal path, not the flag
});

test("parseArgs: a bare '-' stays a positional, not a flag-typo error", () => {
  expect(ok(["-"]).opts.path).toBe("-");
});

test("parseArgs: a value flag with no following token errors instead of silently defaulting", () => {
  expect(err(["--lang"])).toContain("--lang");
});

// ---- buildPolishFooter (frozen format, §4.5) ----
const CLEAN = { corrupted: [], invented: [] };

test("buildPolishFooter: clean run — 4 passes, spell ok, no name-lint fragment", () => {
  const f = buildPolishFooter({
    beforeWords: 100,
    afterWords: 90,
    noRevise: false,
    noSpell: false,
    reverted: 0,
    spellFailed: false,
    nameLint: CLEAN,
  });
  expect(f).toBe("— polished · 100→90 words (-10%) · 4 passes · spell ok");
});

test("buildPolishFooter: --no-revise tags 'revise skipped'", () => {
  const f = buildPolishFooter({
    beforeWords: 50,
    afterWords: 50,
    noRevise: true,
    noSpell: false,
    reverted: 0,
    spellFailed: false,
    nameLint: CLEAN,
  });
  expect(f).toBe("— polished · 50→50 words (±0%) · revise skipped · spell ok");
});

test("buildPolishFooter: --no-spell tags 'spell skipped'", () => {
  const f = buildPolishFooter({
    beforeWords: 40,
    afterWords: 44,
    noRevise: false,
    noSpell: true,
    reverted: 0,
    spellFailed: false,
    nameLint: CLEAN,
  });
  expect(f).toBe("— polished · 40→44 words (+10%) · 4 passes · spell skipped");
});

test("buildPolishFooter: reverted blocks are counted", () => {
  const f = buildPolishFooter({
    beforeWords: 10,
    afterWords: 10,
    noRevise: false,
    noSpell: false,
    reverted: 2,
    spellFailed: false,
    nameLint: CLEAN,
  });
  expect(f).toContain("· spell: 2 block(s) reverted");
});

test("buildPolishFooter: a failed spell pass is tagged distinctly from a revert count", () => {
  const f = buildPolishFooter({
    beforeWords: 10,
    afterWords: 10,
    noRevise: false,
    noSpell: false,
    reverted: 0,
    spellFailed: true,
    nameLint: CLEAN,
  });
  expect(f).toContain("· spell pass failed (kept input)");
});

test("buildPolishFooter: a corrupted-name pair appends the name-lint fragment", () => {
  const f = buildPolishFooter({
    beforeWords: 20,
    afterWords: 20,
    noRevise: false,
    noSpell: false,
    reverted: 0,
    spellFailed: false,
    nameLint: { corrupted: [{ found: "Firecurl", wanted: "Firecrawl" }], invented: [] },
  });
  expect(f).toBe(
    "— polished · 20→20 words (±0%) · 4 passes · spell ok · name-lint: 1 probable corrupted name (Firecurl ← Firecrawl)",
  );
});

// ---- pipeline order: revise() runs before spellPass(), threading its output as the
// spell pass's input — the exact composition main() performs (offline, mocked fw,
// degradation.test.ts / spell.test.ts pattern). ----
const FW = "./fw.ts";
const real = await import(FW);
afterAll(() => mock.module(FW, () => real));

test("pipeline order: revise's output is what spellPass receives, not the original text", async () => {
  const calls: string[] = [];
  mock.module(FW, () => ({
    ...real,
    askJson: mock(async (_model: unknown, prompt: string) => {
      calls.push(prompt);
      if (prompt.includes("You are a copy editor")) {
        // every revise pass rewrites toward this revised-and-still-misspelled sentence
        return { blocks: [{ id: "B1", text: "The teh text is revised now." }] };
      }
      // the spell prompt: assert it is proofreading the REVISED text, not the original
      expect(prompt).toContain("revised now");
      // small, bound-respecting fix (typo only) so verifySpellBlock accepts it
      return { blocks: [{ id: "B1", text: "The the text is revised now." }] };
    }),
  }));
  const { revise: revise2 } = await import("./writing/passes.ts");
  const { spellPass: spellPass2 } = await import("./writing/spell.ts");
  const blocks = [{ id: "B1", text: "Teh original text." }];
  const revised = await revise2(blocks, PASS_EN);
  expect(revised[0].text).toContain("revised now");
  const spelled = await spellPass2(revised, "en");
  expect(spelled.reverted).toEqual([]); // the fix landed, not reverted
  expect(spelled.blocks[0].text).toBe("The the text is revised now."); // spell operated on revise's OUTPUT
  // 4 revise-pass calls + 1 spell call
  expect(calls.length).toBe(5);
  expect(calls.slice(0, 4).every((p) => p.includes("You are a copy editor"))).toBe(true);
  expect(calls[4]).toContain("You are a proofreader");
});

// ---- main() end-to-end over the typography-only path (--no-revise --no-spell:
// no API key, no LLM call): the output contract (content→stdout exact bytes,
// footer→stderr), the temp-file mode, stdin via '-', and the empty-input exit. ----
const { mkdtempSync, readFileSync: read, writeFileSync: write } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const POLISH = join(import.meta.dir, "polish.ts");
const dir = mkdtempSync(join(tmpdir(), "polish-main-"));

test("main: content is stdout's exact bytes (trailing newline preserved); the footer is on stderr", () => {
  const run = (name: string, content: string) => {
    const p = join(dir, name);
    write(p, content);
    const proc = Bun.spawnSync(["bun", POLISH, "--no-revise", "--no-spell", p]);
    expect(proc.exitCode).toBe(0);
    expect(proc.stderr.toString()).toStartWith("— polished ·");
    return proc.stdout.toString();
  };
  expect(run("with-nl.md", "One paragraph of plain text here.\n")).toBe(
    "One paragraph of plain text here.\n",
  );
  expect(run("without-nl.md", "One paragraph of plain text here.")).toBe(
    "One paragraph of plain text here.",
  );
});

test("main: -o writes a temp .md and keeps the two-line stdout (path, footer)", () => {
  const p = join(dir, "temp-mode.md");
  write(p, "One paragraph of plain text here.\n");
  const proc = Bun.spawnSync(["bun", POLISH, "-o", "--no-revise", "--no-spell", p]);
  expect(proc.exitCode).toBe(0);
  const lines = proc.stdout.toString().split("\n");
  expect(lines.length).toBe(3); // path, footer, trailing newline's empty tail
  expect(lines[0]).toEndWith(".md");
  expect(lines[1]).toStartWith("— polished ·");
  expect(lines[2]).toBe("");
  expect(read(lines[0], "utf8")).toBe("One paragraph of plain text here.\n");
});

test("main: '-' reads stdin instead of a file named '-'", () => {
  const proc = Bun.spawnSync(["bun", POLISH, "--no-revise", "--no-spell", "-"], {
    stdin: Buffer.from("Piped through the dash convention.\n"),
  });
  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString()).toBe("Piped through the dash convention.\n");
});

test("main: empty input exits 3 with a stderr note and no stdout", () => {
  const proc = Bun.spawnSync(["bun", POLISH, "--no-revise", "--no-spell"], {
    stdin: Buffer.from("  \n"),
  });
  expect(proc.exitCode).toBe(3);
  expect(proc.stdout.toString()).toBe("");
  expect(proc.stderr.toString()).toContain("polish skipped: empty input");
});
