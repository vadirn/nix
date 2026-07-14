// TTY session wrapper (Phase 5) — run with `bun test` from here.
//
// `runTtySession` is the gate-aware sugar loop main() hands off to at a real
// terminal (both process.stdin.isTTY and process.stdout.isTTY — the guard itself
// is one line in main() and is proven OFF-by-default at emit.test.ts's "Phase 5"
// pin, colocated there to share its mocked-pipeline lifecycle). A real terminal
// resists subprocess pinning (smoke-tested by hand), so every test here calls
// `runTtySession` directly with a
// scripted `askFn` — that parameter IS the TTY seam this suite fakes: production
// wires the real readline-over-stdin reader, tests wire a canned answer queue.
//
// Every scenario below is deliberately a REJECT-ALL-OR-KEEP triage (the checked
// `recover` item is never exercised): `keep` never calls the LLM and an unchecked
// `recover`/`keep` is a pure removal, so the whole suite runs OFFLINE — no
// mock.module("./fw.ts"), no FIREWORKS_API_KEY, no race with any other file's fw
// mock (the hazard emit.test.ts's own banner names).
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { buildIntermediary } from "./triage.ts";
import { runTtySession } from "./tty.ts";
import type { Residue } from "./residue.ts";

const NOTE = `---
type: distillation
description: "Anchor image discipline in plein-air blocking."
---

# Anchor image discipline

## Abstract

Blocking from the felt sense rather than the scene keeps distances honest.

## Concepts

### Anchor image

The first felt impression, fixed as the reference. 10..40

### Impression distance

The nearness of a value to its anchor. 41..70
`;

const R_RECOVER: Residue = {
  kind: "def",
  reasonClass: "failed",
  label: "Impression distance",
  reason: "inverted: def asserts nearness where source asserts a gap",
  source: "Impression distance is the gap between felt sense and re-inspection.",
};
const R_KEEP: Residue = {
  kind: "def",
  reasonClass: "gate-inconclusive",
  label: "Anchor image",
  reason: "gate-inconclusive: judge returned no verdict after retry",
  source: "The anchor image is the first felt impression, fixed before mixing begins.",
};

// Emit a fresh intermediary (creation case: src=new, no destination on disk) into a
// scratch dir, mirroring how compress-mode's success path calls buildIntermediary.
function emitFixture(): { dir: string; tmpPath: string; destPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "distill-session-"));
  const tmpPath = join(dir, "note.tmp.md");
  const destPath = join(dir, "note.md");
  const tmp = buildIntermediary(NOTE, [R_RECOVER, R_KEEP], { dest: "note.md", src: "new" });
  writeFileSync(tmpPath, tmp);
  return { dir, tmpPath, destPath };
}

// Flip `- [ ] <prefix>` → `- [x] <prefix>` (apply.test.ts's own convention). Throws
// when the prefix is absent so a fixture drift fails loud instead of silently
// checking nothing.
function check(tmpPath: string, prefix: string): void {
  const tmp = readFileSync(tmpPath, "utf8");
  const from = `- [ ] ${prefix}`;
  if (!tmp.includes(from)) throw new Error(`check: item not found: ${JSON.stringify(from)}`);
  writeFileSync(tmpPath, tmp.replace(from, `- [x] ${prefix}`));
}
const checkGate = (tmpPath: string): void => check(tmpPath, "reviewed:");
const checkKeep = (tmpPath: string): void =>
  check(tmpPath, "keep: `Anchor image` — gate-inconclusive: judge returned no verdict after retry");

// A scripted answer queue: each call returns the next entry (a plain string), or
// optionally runs a side effect first (the reviewer editing the file in Obsidian
// between prompts) when the entry is a function.
type Scripted = string | (() => string);
function scriptedAsk(answers: Scripted[]): {
  ask: (p: string) => Promise<string | null>;
  prompts: string[];
} {
  const prompts: string[] = [];
  let i = 0;
  return {
    prompts,
    ask: async (prompt: string) => {
      prompts.push(prompt);
      if (i >= answers.length) throw new Error("scriptedAsk: ran out of scripted answers");
      const a = answers[i++]!;
      return typeof a === "function" ? a() : a;
    },
  };
}

test("gate unchecked, decline: diagnosis prompt fires once, exits 0, nothing written or deleted", async () => {
  const { tmpPath, destPath } = emitFixture();
  const before = readFileSync(tmpPath, "utf8");
  const { ask, prompts } = scriptedAsk(["n"]);
  const code = await runTtySession(tmpPath, destPath, "en", ask);
  expect(code).toBe(0);
  expect(prompts).toEqual([
    "gate 'triage-final' unchecked — check it in Obsidian, then press y to re-check [y/N] ",
  ]);
  expect(existsSync(tmpPath)).toBe(true);
  expect(readFileSync(tmpPath, "utf8")).toBe(before); // byte-untouched
  expect(existsSync(destPath)).toBe(false);
});

test("gate unchecked, EOF (null answer): treated as decline, exits 0", async () => {
  const { tmpPath, destPath } = emitFixture();
  const code = await runTtySession(tmpPath, destPath, "en", async () => null);
  expect(code).toBe(0);
  expect(existsSync(destPath)).toBe(false);
});

test("gate unchecked, 'y' re-checks WITHOUT re-reading the tick itself: the file must change for the loop to advance", async () => {
  const { tmpPath, destPath } = emitFixture();
  // 'y' means "I looked, re-read" — it never substitutes for the tick. The file is
  // still unchecked on the second read, so the SAME diagnosis prompt must repeat.
  const { ask, prompts } = scriptedAsk(["y", "n"]);
  const code = await runTtySession(tmpPath, destPath, "en", ask);
  expect(code).toBe(0);
  expect(prompts.length).toBe(2);
  expect(prompts[0]).toBe(prompts[1]); // identical diagnosis prompt both times
  expect(existsSync(destPath)).toBe(false);
});

test("gate ticked between prompts (Sync-style edit), then declined at the count-confirm: re-reads from disk, no apply runs", async () => {
  const { tmpPath, destPath } = emitFixture();
  const answers: Scripted[] = [
    () => {
      checkGate(tmpPath); // the reviewer checks the gate in Obsidian, mid-session
      return "y"; // then comes back and re-checks
    },
    "n", // declines the count-confirm
  ];
  const { ask, prompts } = scriptedAsk(answers);
  const code = await runTtySession(tmpPath, destPath, "en", ask);
  expect(code).toBe(0);
  expect(prompts[0]).toContain("gate 'triage-final' unchecked");
  expect(prompts[1]).toBe(
    "about to write: 0 recovered · 0 kept · 2 removed → " + destPath + " — confirm [y/N] ",
  );
  expect(existsSync(destPath)).toBe(false); // declined — nothing written
  expect(existsSync(tmpPath)).toBe(true); // intermediary still on disk
});

test("gate checked from the start: count-confirm names real tallies, decline leaves both files untouched", async () => {
  const { tmpPath, destPath } = emitFixture();
  checkKeep(tmpPath);
  checkGate(tmpPath);
  const { ask, prompts } = scriptedAsk(["n"]);
  const code = await runTtySession(tmpPath, destPath, "en", ask);
  expect(code).toBe(0);
  expect(prompts).toEqual([
    `about to write: 0 recovered · 1 kept · 1 removed → ${destPath} — confirm [y/N] `,
  ]);
  expect(existsSync(destPath)).toBe(false);
  expect(existsSync(tmpPath)).toBe(true);
});

test("gate checked, confirmed: applies in-process, dest written, tmp consumed, apply's own stdout lands on STDERR not real stdout", async () => {
  const { tmpPath, destPath } = emitFixture();
  checkKeep(tmpPath); // recover stays unchecked ⇒ removed; keep stays ⇒ kept, no LLM
  checkGate(tmpPath);
  const { ask, prompts } = scriptedAsk(["y"]);

  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const dec = (c: string | Uint8Array) => (typeof c === "string" ? c : new TextDecoder().decode(c));
  process.stdout.write = ((c: string | Uint8Array) => (
    outChunks.push(dec(c)),
    true
  )) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => (
    errChunks.push(dec(c)),
    true
  )) as typeof process.stderr.write;
  let code: number;
  try {
    code = await runTtySession(tmpPath, destPath, "en", ask);
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }

  expect(code).toBe(0);
  expect(outChunks.join("")).toBe(""); // NOTHING reaches real stdout during the session
  // the scripted askFn stands in for the WHOLE prompt round-trip (production's real
  // `ask` is what writes the "about to write:" text to stderr) — its content is
  // asserted on the prompts queue, not the stderr capture
  expect(prompts).toEqual([
    `about to write: 0 recovered · 1 kept · 1 removed → ${destPath} — confirm [y/N] `,
  ]);
  // apply's path line, redirected onto stderr instead of the real stdout it would
  // otherwise have gone to, plus its footer (a direct stderr write)
  const err = errChunks.join("");
  expect(err).toContain(destPath);
  expect(err).toContain("— applied: 0 recovered · 1 kept · 1 removed");

  expect(existsSync(tmpPath)).toBe(false); // consumed
  expect(existsSync(destPath)).toBe(true);
  const dest = readFileSync(destPath, "utf8");
  expect(dest).toContain("Anchor image"); // kept
  expect(dest).not.toContain("Impression distance"); // unchecked recover ⇒ removed
  expect(dest).not.toContain("interact"); // scaffold stripped
});

test("apply refuses (e.g. a stamp mismatch) mid-session: its exit code propagates as the session's own return", async () => {
  const { tmpPath, destPath } = emitFixture();
  checkKeep(tmpPath);
  checkGate(tmpPath);
  // an edit lands on the destination AFTER emit but before the session applies —
  // the stamp (src=new requires dest ABSENT) must refuse, not silently clobber.
  writeFileSync(destPath, "a file that appeared from nowhere\n");
  const { ask } = scriptedAsk(["y"]);
  const code = await runTtySession(tmpPath, destPath, "en", ask);
  expect(code).toBe(2); // apply's own refusal code, not swallowed to 0
  expect(existsSync(tmpPath)).toBe(true); // refused — tmp NOT consumed
  expect(readFileSync(destPath, "utf8")).toBe("a file that appeared from nowhere\n"); // untouched
});

test("tmp already consumed before the session starts (a racing apply): returns 0 without prompting", async () => {
  const { tmpPath, destPath } = emitFixture();
  const before = readFileSync(tmpPath, "utf8");
  writeFileSync(destPath, "already applied by someone else\n");
  const fs = await import("node:fs");
  fs.unlinkSync(tmpPath);
  const { ask, prompts } = scriptedAsk([]); // must NEVER be called
  const code = await runTtySession(tmpPath, destPath, "en", ask);
  expect(code).toBe(0);
  expect(prompts).toEqual([]);
  void before;
});
