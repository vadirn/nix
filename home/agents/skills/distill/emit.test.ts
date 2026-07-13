// emit-path red corpus (Phase 3, build plan §6) — run with `bun test` from this directory.
//
// Freezes the pipeline emit swap: every successful distill writes the interactive
// intermediary to `<dest>.tmp.md` (sibling of the destination — the input path by
// default, `--out` override) instead of the `<result>`/`<residue>` XML envelope;
// stdout carries exactly the data — one line, the .tmp.md path — while the footer
// (which gains the `· review: …` suffix) goes to stderr; a pending intermediary refuses with exit 4 BEFORE the
// API-key gate; stdin requires `--out` once the run actually reaches the emit
// (exit 2) — while the empty/no-body/passthrough exit-3 paths keep today's mktemp
// behavior byte-identical (the stages.test.ts:656 recipe test is the executable
// proof and stays UNMODIFIED).
//
// LLM-bearing success paths run main() in-process with fw.ts mocked per the
// degradation.test.ts convention (mock.module repoints the live askJson binding);
// key-gate/preflight/usage paths spawn the real binary offline.
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, mock, test } from "bun:test";
import { parseInteract, stripInteract } from "./interact.ts";

const DISTILL = join(import.meta.dir, "distill.ts");
const DUMMY_KEY = { ...process.env, FIREWORKS_API_KEY: "test-dummy" };
const NO_KEY = { PATH: process.env.PATH ?? "" };

const NOTE = `---
type: note
description: "Anchor image discipline in plein-air blocking."
---

# Anchor image discipline

Blocking from the impression rather than the scene keeps the painting honest, because the first felt impression is the only reference that does not drift while the light moves. Painters who re-check against the scene chase a moving target instead, and their values wander with the light across the whole session without anyone noticing the drift.

The anchor image is the first felt impression of the scene, fixed as the reference all later value judgments measure against. The impression distance is the nearness of a value to its anchor on re-inspection, and it grows silently unless the painter re-checks against the anchor rather than against the scene itself.

Fix the anchor image before opening paints, and re-check values against the anchor rather than the scene whenever a mixture is judged.
`;

// ---- offline spawned paths: preflight (exit 4), stdin usage (exit 2), exit-3 hygiene ----

test("emit preflight: a pending sibling intermediary refuses with exit 4 BEFORE the key gate, nothing on stdout", () => {
  const dir = mkdtempSync(join(tmpdir(), "distill-emit-"));
  const notePath = join(dir, "note.md");
  const tmpPath = join(dir, "note.tmp.md");
  writeFileSync(notePath, NOTE);
  writeFileSync(tmpPath, "pending intermediary bytes\n");
  // NO_KEY env: exit 4 (not 1) proves the preflight beats the API-key gate
  const proc = Bun.spawnSync(["bun", DISTILL, notePath], { env: NO_KEY });
  expect(proc.exitCode).toBe(4);
  expect(proc.stdout.toString()).toBe("");
  const err = proc.stderr.toString();
  expect(err).toContain("pending intermediary exists");
  expect(err).toContain(tmpPath);
});

test("emit preflight: --out redirects the destination, so the pending check watches <out>.tmp.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "distill-emit-"));
  const notePath = join(dir, "note.md");
  const outPath = join(dir, "elsewhere.md");
  const outTmp = join(dir, "elsewhere.tmp.md");
  writeFileSync(notePath, NOTE);
  writeFileSync(outTmp, "pending intermediary bytes\n");
  const proc = Bun.spawnSync(["bun", DISTILL, "--out", outPath, notePath], { env: NO_KEY });
  expect(proc.exitCode).toBe(4);
  expect(proc.stdout.toString()).toBe("");
  expect(proc.stderr.toString()).toContain(outTmp);
  // the input's own sibling is NOT the watched path under --out
  expect(proc.stderr.toString()).not.toContain(join(dir, "note.tmp.md"));
});

test("emit preflight: stdin with --out derives the pending path from --out, pre-key", () => {
  const dir = mkdtempSync(join(tmpdir(), "distill-emit-"));
  const outTmp = join(dir, "dest.tmp.md");
  writeFileSync(outTmp, "pending intermediary bytes\n");
  const proc = Bun.spawnSync(["bun", DISTILL, "--out", join(dir, "dest.md"), "-"], {
    env: NO_KEY,
    stdin: Buffer.from(NOTE),
  });
  expect(proc.exitCode).toBe(4);
  expect(proc.stdout.toString()).toBe("");
  expect(proc.stderr.toString()).toContain(outTmp);
});

test("emit: stdin without --out is a usage refusal (exit 2) once the run reaches the emit", () => {
  // a REAL body: the empty-input and no-body stdin paths keep exit 3 (the c4e0339
  // recipe at stages.test.ts:656 pins that and stays unmodified), so the refusal
  // fires exactly where a destination becomes necessary
  const proc = Bun.spawnSync(["bun", DISTILL, "-"], {
    env: DUMMY_KEY,
    stdin: Buffer.from(NOTE),
  });
  expect(proc.exitCode).toBe(2);
  expect(proc.stdout.toString()).toBe("");
  expect(proc.stderr.toString()).toContain("--out");
});

test("emit hygiene: the no-body exit-3 path writes NO sibling intermediary (mktemp only)", () => {
  const dir = mkdtempSync(join(tmpdir(), "distill-emit-"));
  const notePath = join(dir, "note.md");
  writeFileSync(notePath, "---\ntype: note\n---\n");
  const proc = Bun.spawnSync(["bun", DISTILL, notePath], { env: DUMMY_KEY });
  expect(proc.exitCode).toBe(3);
  const lines = proc.stdout.toString().split("\n");
  expect(proc.stderr.toString()).toContain("— no body to distill");
  expect(lines.length).toBe(2); // path + trailing newline's empty tail
  // the stdout path line still points at a disposable mktemp artifact…
  expect(lines[0]).toEndWith(".md");
  expect(lines[0]).not.toBe(join(dir, "note.tmp.md"));
  expect(readFileSync(lines[0]!, "utf8")).toBe("---\ntype: note\n---\n");
  // …and no in-vault intermediary exists for a run apply could never act on
  expect(existsSync(join(dir, "note.tmp.md"))).toBe(false);
});

// ---- mocked-fw success paths: main() in-process (degradation.test.ts convention) ----

const FW = "./fw.ts";
const real = await import(FW);
// Snapshot the FUNCTION, not the namespace: mock.module rebinds the namespace's
// live exports, so restoring `() => real` after mocking would restore the mock
// itself. This file can run before degradation.test.ts (file order is not
// alphabetical), which needs the genuine transport back.
const realAskJson = real.askJson;
afterAll(() => mock.module(FW, () => ({ ...real, askJson: realAskJson })));

// One dispatching transport for the whole five-stage run. Markers are verbatim
// substrings of the stage prompts in prompts.ts; an unmocked prompt throws so a
// new stage can never silently ride a wrong answer.
function mockPipeline() {
  mock.module(FW, () => ({
    ...real,
    askJson: mock(async (_model: unknown, prompt: string) => {
      if (prompt.includes("concept cartographer")) {
        // The canonical default path parses this via parseExtractGraph (prompts.ts), so the mock
        // returns the RawGraph shape (concepts/judgements/inferences/procedures), NOT the legacy
        // Combo (glossary/workflow). title/abstract render as the `# title` and the one unanchored
        // `## Abstract`; each unit's verbatim `quote` is located in NOTE by locateGraph — a HARD
        // ABORT on a miss — so every quote is a real slice of NOTE, not just a source block id.
        return {
          title: "Anchor image discipline",
          abstract:
            "Blocking from the first felt impression, not the moving scene, keeps values from drifting.",
          thesis: "Blocking from the impression rather than the scene keeps the painting honest.",
          concepts: [
            {
              headword: "Anchor image",
              statement: "The first felt impression, fixed as the reference.",
              relations: [],
              source: ["B3"],
              quote:
                "The anchor image is the first felt impression of the scene, fixed as the reference",
            },
            {
              headword: "Impression distance",
              statement: "The nearness of a value to its anchor.",
              relations: [],
              source: ["B3"],
              quote:
                "The impression distance is the nearness of a value to its anchor on re-inspection",
            },
          ],
          judgements: [],
          inferences: [],
          procedures: [
            {
              headword: "Anchor discipline",
              steps: [
                {
                  statement: "Fix the anchor image before opening paints.",
                  source: ["B4"],
                  quote: "Fix the anchor image before opening paints",
                },
              ],
            },
          ],
        };
      }
      if (prompt.includes("grading each block")) {
        return {
          grades: [
            { id: "B1", grade: "drop" },
            { id: "B2", grade: "distill" },
            { id: "B3", grade: "distill" },
            { id: "B4", grade: "distill" },
          ],
        };
      }
      if (prompt.includes("writing glossary definitions")) {
        return {
          entries: [
            {
              term: "Anchor image",
              def: "The first felt impression of the scene, fixed as the reference.",
            },
            {
              term: "Impression distance",
              def: "The nearness of a value to its anchor on re-inspection.",
            },
          ],
        };
      }
      if (prompt.includes("tightening the procedure")) {
        return { steps: [{ id: "S0", step: "Fix the anchor image before opening paints" }] };
      }
      if (prompt.includes("state the note's thesis")) {
        return {
          prose: "The anchor image fixes the reference; impression distance names drift from it.",
        };
      }
      if (prompt.includes("readable body of a note")) {
        return {
          prose:
            "**Anchor image** fixes the reference before mixing starts, and **Impression distance** names the drift from it on re-inspection.",
        };
      }
      // workflow gate first: its prompt also contains "independent fidelity judge"
      if (prompt.includes("for a procedure checklist")) {
        return {
          groups: [
            // the verdict is keyed by the procedure's `### headword` (its unit id), so the
            // residue target is the headword-scoped `procedure:<headword>` form
            {
              id: "Anchor discipline",
              grade: "inconclusive",
              missing: "judge returned no verdict",
            },
          ],
        };
      }
      if (prompt.includes("independent fidelity judge")) {
        return {
          thesisRecoverable: false,
          concepts: [
            {
              term: "Impression distance",
              grade: "residue",
              direction: "inverted",
              missing: "def asserts nearness where source asserts a gap",
            },
            {
              term: "Anchor image",
              grade: "inconclusive",
              direction: "",
              missing: "judge returned no verdict after retry",
            },
          ],
        };
      }
      if (prompt.includes("independent prose editor")) {
        return { pass: true, issues: [] };
      }
      throw new Error(`unmocked prompt: ${prompt.slice(0, 100)}`);
    }),
  }));
}

// Run main() in-process with argv patched and stdout captured. The success path
// never calls process.exit; process.exit is stubbed to THROW so any exit-path
// regression (or red-phase behavior) fails the test instead of killing the runner.
async function runMain(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const argv = process.argv;
  const hadKey = process.env.FIREWORKS_API_KEY;
  const realWrite = process.stdout.write.bind(process.stdout);
  const realErrWrite = process.stderr.write.bind(process.stderr);
  const realExit = process.exit;
  const chunks: string[] = [];
  const errChunks: string[] = [];
  process.argv = ["bun", "distill.ts", ...args];
  process.env.FIREWORKS_API_KEY = "test-dummy";
  process.stdout.write = ((c: string | Uint8Array) => {
    chunks.push(typeof c === "string" ? c : new TextDecoder().decode(c));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => {
    errChunks.push(typeof c === "string" ? c : new TextDecoder().decode(c));
    return true;
  }) as typeof process.stderr.write;
  process.exit = ((code?: number) => {
    throw new Error(`main() called process.exit(${code}) on a success path`);
  }) as typeof process.exit;
  try {
    const { main } = await import("./pipeline.ts");
    await main();
  } finally {
    process.stdout.write = realWrite;
    process.stderr.write = realErrWrite;
    process.argv = argv;
    process.exit = realExit;
    if (hadKey === undefined) delete process.env.FIREWORKS_API_KEY;
    else process.env.FIREWORKS_API_KEY = hadKey;
  }
  return { stdout: chunks.join(""), stderr: errChunks.join("") };
}

test("emit success: sibling .tmp.md intermediary, path-only stdout, no XML, dest=/src= stamp, residue triaged", async () => {
  mockPipeline();
  const dir = mkdtempSync(join(tmpdir(), "distill-emit-"));
  const notePath = join(dir, "note.md");
  const tmpPath = join(dir, "note.tmp.md");
  writeFileSync(notePath, NOTE);
  const { stdout, stderr } = await runMain(["--no-revise", notePath]);

  // stdout: exactly the data — the intermediary path; the footer with the review suffix on stderr
  expect(stdout).toBe(`${tmpPath}\n`);
  expect(stderr).toContain("— distilled");
  expect(stderr).toContain("· review: 4 items + gate");

  // the intermediary: an Obsidian-first document, not an XML envelope
  expect(existsSync(tmpPath)).toBe(true);
  const tmp = readFileSync(tmpPath, "utf8");
  expect(tmp).not.toContain("<result>");
  expect(tmp).not.toContain("<residue>");
  expect(tmp).toContain("epistemic_status: in-review");

  // C1 regression: EXACTLY ONE frontmatter block. The canonical projection (now the default
  // compress body) carries its own `type: distillation` / `source:` / `schema:` YAML, so main()
  // must NOT also prepend the source note's front — doing so emitted two YAML blocks (the collision
  // that was latent while canonical was opt-in). The single block holds the spec fields plus the
  // forced review status; the source note's own `type: note` front is dropped, not prepended.
  expect(tmp.match(/^type: distillation$/gm)).toHaveLength(1);
  expect(tmp).not.toContain("type: note");
  expect(tmp).toContain("schema: 1.0");
  expect(tmp).toContain("source: { path:");
  expect(tmp.split("\n").filter((l) => l.trim() === "---")).toHaveLength(2); // one open + one close

  // the four residue entries, verbs picked by reason class, targets by kind
  expect(tmp).toContain("- [ ] recover: thesis — thesis not recoverable from output");
  expect(tmp).toContain(
    "- [ ] recover: `Impression distance` — inverted: def asserts nearness where source asserts a gap",
  );
  expect(tmp).toContain(
    "- [ ] keep: `Anchor image` — gate-inconclusive: judge returned no verdict after retry",
  );
  expect(tmp).toContain(
    "- [ ] keep: procedure:Anchor discipline — gate-inconclusive: judge returned no verdict",
  );

  // the stamp rides the gate anchor: dest= is the destination basename, src= hashes
  // the existing destination (the input file) — 12 hex digits
  const { blocks, errors } = parseInteract(tmp);
  expect(errors).toEqual([]);
  expect(blocks.map((b) => b.id)).toEqual(["residue", "triage-final"]);
  const gate = blocks[1]!;
  expect(gate.kind).toBe("confirm-all");
  expect(gate.dest).toBe("note.md");
  expect(gate.src).toMatch(/^sha256:[0-9a-f]{12}$/);

  // strip is the write-back projection: no scaffold survives it, and the body is the seven-section
  // canonical projection (the default compress output): a `# title`, the unanchored `## Abstract`,
  // then the populated type-as-section blocks (Concepts + Procedures here; empty sections omitted).
  const stripped = stripInteract(tmp);
  expect(stripped).not.toContain("interact");
  expect(stripped).toContain("# Anchor image discipline");
  expect(stripped).toContain("## Abstract");
  expect(stripped).toContain("## Concepts");
  expect(stripped).toContain("### Anchor image");
  expect(stripped).toContain("### Impression distance");
  expect(stripped).toContain("## Procedures");
  // legacy assembleBody section headers never appear on the canonical default path
  expect(stripped).not.toContain("## Glossary");
  expect(stripped).not.toContain("## Workflow");
});

test("emit success (clean run): gate-only intermediary, footer says '· review: gate'", async () => {
  mockPipeline();
  const dir = mkdtempSync(join(tmpdir(), "distill-emit-"));
  const notePath = join(dir, "clean.md");
  writeFileSync(notePath, NOTE);
  const { stdout, stderr } = await runMain(["--no-revise", "--no-gate", notePath]);

  expect(stdout).toBe(`${join(dir, "clean.tmp.md")}\n`);
  expect(stderr).toContain("· review: gate");
  expect(stderr).not.toContain("items + gate");

  const tmp = readFileSync(join(dir, "clean.tmp.md"), "utf8");
  expect(tmp).not.toContain("pick-any");
  const { blocks, errors } = parseInteract(tmp);
  expect(errors).toEqual([]);
  expect(blocks.map((b) => b.id)).toEqual(["triage-final"]);
  expect(blocks[0]!.dest).toBe("clean.md");
  expect(blocks[0]!.src).toMatch(/^sha256:[0-9a-f]{12}$/);
});

// Like runMain, but for paths that end in process.exit: the stub throws a sentinel
// carrying the code (main's own catch rethrows it — a sentinel is not transient),
// and the wrapper returns it alongside captured stdout.
async function runMainExpectExit(
  args: string[],
): Promise<{ stdout: string; exit: number | undefined }> {
  const argv = process.argv;
  const hadKey = process.env.FIREWORKS_API_KEY;
  const realWrite = process.stdout.write.bind(process.stdout);
  const realExit = process.exit;
  const chunks: string[] = [];
  let exit: number | undefined;
  process.argv = ["bun", "distill.ts", ...args];
  process.env.FIREWORKS_API_KEY = "test-dummy";
  process.stdout.write = ((c: string | Uint8Array) => {
    chunks.push(typeof c === "string" ? c : new TextDecoder().decode(c));
    return true;
  }) as typeof process.stdout.write;
  process.exit = ((code?: number) => {
    throw Object.assign(new Error(`process.exit(${code})`), { sentinelExit: code ?? 0 });
  }) as typeof process.exit;
  try {
    const { main } = await import("./pipeline.ts");
    await main();
  } catch (e) {
    const s = (e as { sentinelExit?: number }).sentinelExit;
    if (s === undefined) throw e;
    exit = s;
  } finally {
    process.stdout.write = realWrite;
    process.argv = argv;
    process.exit = realExit;
    if (hadKey === undefined) delete process.env.FIREWORKS_API_KEY;
    else process.env.FIREWORKS_API_KEY = hadKey;
  }
  return { stdout: chunks.join(""), exit };
}

test("emit success (--out to a new destination): intermediary sibling of --out, src=new", async () => {
  mockPipeline();
  const dir = mkdtempSync(join(tmpdir(), "distill-emit-"));
  const notePath = join(dir, "note.md");
  const outPath = join(dir, "fresh", "dest.md");
  writeFileSync(notePath, NOTE);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "fresh"));
  const { stdout } = await runMain(["--no-revise", "--no-gate", "--out", outPath, notePath]);

  const lines = stdout.split("\n");
  expect(lines[0]).toBe(join(dir, "fresh", "dest.tmp.md"));
  const tmp = readFileSync(join(dir, "fresh", "dest.tmp.md"), "utf8");
  const { blocks, errors } = parseInteract(tmp);
  expect(errors).toEqual([]);
  const gate = blocks[blocks.length - 1]!;
  expect(gate.dest).toBe("dest.md");
  expect(gate.src).toBe("new"); // destination absent ⇒ creation case
  // the input's own sibling stays untouched
  expect(existsSync(join(dir, "note.tmp.md"))).toBe(false);
});

// ---- Phase 5 pin: the TTY session guard is OFF for this whole file ----
//
// `bun test` gives main() a non-TTY stdin AND stdout (there is no real terminal
// behind either descriptor here), which is exactly the guard's off condition —
// so a real, successful, residue-bearing distill run is the sharpest proof that
// the session never fires unless BOTH ends are a TTY: colocated with the Phase 3
// mock (not a new file) so it shares runMain's process.exit-throws-on-success
// sentinel and mockPipeline's lifecycle, sidestepping the cross-file fw mock race
// emit.test.ts's own banner names (a second file's mock.module("./fw.ts") could
// otherwise unmock mid-flight under a slow run here). If the guard's condition
// were ever inverted, runMain's stubbed process.exit would throw and fail this
// test loudly; stderr is captured too, so a bug that printed prompt text WITHOUT
// exiting (guard fires, loop never reaches the exit call) is caught as well.
test("Phase 5: a non-TTY success run never enters the session — stdout stays the path line, stderr carries no prompt text", async () => {
  mockPipeline();
  const dir = mkdtempSync(join(tmpdir(), "distill-emit-"));
  const notePath = join(dir, "note.md");
  const tmpPath = join(dir, "note.tmp.md");
  writeFileSync(notePath, NOTE);
  const { stdout, stderr } = await runMain(["--no-revise", notePath]);
  expect(stdout).toBe(`${tmpPath}\n`); // exactly the path line
  const stderrAll = stderr;
  for (const forbidden of [
    "[y/N]",
    `review: ${tmpPath}`, // the session's stderr hint, not the footer's "· review: …" suffix
    "apply later with",
    "gate '",
    "about to write",
    "applied:",
  ]) {
    expect(stderrAll).not.toContain(forbidden);
  }
  expect(existsSync(tmpPath)).toBe(true); // still pending — nothing applied itself
});

// ---- adversarial pins (Phase-3 review): non-.md destinations, absolute stdout,
// --out directory validation, the atomic no-clobber write, and mktemp hygiene ----

// Supersedes the Phase-3 non-.md handling: emit appended `.tmp.md` to `note.txt` and
// stamped dest=note.txt, but apply derives note.txt.md, so the intermediary could never
// be applied (advisor finding 2). The honest contract rejects a non-.md compress input at
// parse time — before any LLM work — so nothing is written and the input is never touched.
test("emit: a non-.md compress input without --out is rejected at parse time (exit 2), input untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "distill-emit-"));
  const notePath = join(dir, "note.txt");
  writeFileSync(notePath, NOTE);
  const proc = Bun.spawnSync(["bun", DISTILL, notePath], { env: NO_KEY });
  expect(proc.exitCode).toBe(2);
  expect(proc.stdout.toString()).toBe("");
  expect(proc.stderr.toString()).toContain(".md");
  expect(readFileSync(notePath, "utf8")).toBe(NOTE); // never touched
  expect(existsSync(`${notePath}.tmp.md`)).toBe(false); // no orphan intermediary
});

test("emit success: a non-.md input WITH --out emits an appliable intermediary named for the --out .md", async () => {
  mockPipeline();
  const dir = mkdtempSync(join(tmpdir(), "distill-emit-"));
  const notePath = join(dir, "note.txt");
  const destPath = join(dir, "dest.md");
  writeFileSync(notePath, NOTE);
  const { stdout } = await runMain(["--no-revise", "--no-gate", notePath, "--out", destPath]);
  const lines = stdout.split("\n");
  expect(lines[0]).toBe(`${dir}/dest.tmp.md`); // sibling of --out, not the input
  expect(readFileSync(notePath, "utf8")).toBe(NOTE); // input byte-untouched
  const { blocks, errors } = parseInteract(readFileSync(`${dir}/dest.tmp.md`, "utf8"));
  expect(errors).toEqual([]);
  // dest= matches what apply's destinationFor derives, so the round-trip closes
  expect(blocks[blocks.length - 1]!.dest).toBe("dest.md");
});

test("emit: --out into a missing directory is a usage refusal (exit 2) BEFORE the key gate", () => {
  const dir = mkdtempSync(join(tmpdir(), "distill-emit-"));
  const notePath = join(dir, "note.md");
  writeFileSync(notePath, NOTE);
  // NO_KEY: exit 2 (not 1) proves the check beats the key gate — otherwise the run
  // would burn the whole LLM budget and die on the final write
  const proc = Bun.spawnSync(["bun", DISTILL, "--out", join(dir, "missing", "x.md"), notePath], {
    env: NO_KEY,
  });
  expect(proc.exitCode).toBe(2);
  expect(proc.stdout.toString()).toBe("");
  expect(proc.stderr.toString()).toContain("directory does not exist");
});

test("emit preflight: a cwd-relative input names the pending intermediary by ABSOLUTE path", () => {
  // agent callers re-open the named path after a cwd reset; the plan-§4 transcript
  // shows an absolute line 1 for a relative invocation, and the mktemp contract was
  // always absolute — relative paths must not leak out of a relative invocation
  const dir = mkdtempSync(join(tmpdir(), "distill-emit-"));
  writeFileSync(join(dir, "note.md"), NOTE);
  writeFileSync(join(dir, "note.tmp.md"), "pending intermediary bytes\n");
  const proc = Bun.spawnSync(["bun", DISTILL, "note.md"], { env: NO_KEY, cwd: dir });
  expect(proc.exitCode).toBe(4);
  const err = proc.stderr.toString();
  expect(err).toMatch(/pending intermediary exists: \//);
  expect(err).toContain("note.tmp.md");
  // the refusal appends the mtime staleness hint (plan §4, tmpfile F5)
  expect(err).toMatch(/\(\d+[mhd] old\)/);
});

test("emit success: a cwd-relative input still puts an ABSOLUTE intermediary path on stdout line 1", async () => {
  mockPipeline();
  const dir = mkdtempSync(join(tmpdir(), "distill-emit-"));
  writeFileSync(join(dir, "relnote.md"), NOTE);
  const cwd = process.cwd();
  let stdout: string;
  try {
    process.chdir(dir);
    ({ stdout } = await runMain(["--no-revise", "--no-gate", "relnote.md"]));
  } finally {
    process.chdir(cwd);
  }
  const lines = stdout.split("\n");
  expect(lines[0]!.startsWith("/")).toBe(true);
  expect(lines[0]!).toEndWith("/relnote.tmp.md");
  expect(existsSync(lines[0]!)).toBe(true); // openable from any later cwd
});

test("emit write is no-clobber: an intermediary that appears mid-run (racing emit) loses LOUD with exit 4, raced bytes intact", async () => {
  // both racers pass the preflight before their minutes-long LLM runs; the final
  // write must be linkSync-no-clobber (plan §4, atomicity F7), never a silent
  // last-writer-wins overwrite
  mockPipeline();
  const mocked = await import(FW);
  const inner = mocked.askJson; // snapshot: the dispatcher mock, not the live binding
  const dir = mkdtempSync(join(tmpdir(), "distill-emit-"));
  const notePath = join(dir, "race.md");
  const tmpPath = join(dir, "race.tmp.md");
  writeFileSync(notePath, NOTE);
  mock.module(FW, () => ({
    ...real,
    askJson: async (...args: unknown[]) => {
      // the "other emit" lands its intermediary while this run is mid-LLM
      if (!existsSync(tmpPath)) writeFileSync(tmpPath, "raced bytes\n");
      return (inner as (...a: unknown[]) => unknown)(...args);
    },
  }));
  const { stdout, exit } = await runMainExpectExit(["--no-revise", "--no-gate", notePath]);
  expect(exit).toBe(4);
  expect(stdout).toBe(""); // refusal keeps stdout empty
  expect(readFileSync(tmpPath, "utf8")).toBe("raced bytes\n"); // winner not clobbered
  expect(readdirSync(dir).filter((f) => f.endsWith(".partial"))).toEqual([]); // no residue
});

test("emit success: no orphan mktemp file is created (the temp sink is lazy)", async () => {
  mockPipeline();
  const dir = mkdtempSync(join(tmpdir(), "distill-emit-"));
  const scratch = mkdtempSync(join(tmpdir(), "distill-tmpdir-"));
  const notePath = join(dir, "note.md");
  writeFileSync(notePath, NOTE);
  const hadTmpdir = process.env.TMPDIR;
  try {
    process.env.TMPDIR = scratch; // mktemp children inherit this
    await runMain(["--no-revise", "--no-gate", notePath]);
  } finally {
    if (hadTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = hadTmpdir;
  }
  expect(readdirSync(scratch)).toEqual([]); // the success path never mints a temp file
});
