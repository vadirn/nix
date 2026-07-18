// apply red corpus (Phase 4) — run with `bun test` from here.
//
// Freezes the apply contract AHEAD of the implementation: apply-mode.ts's bodies
// are unimplemented (each throws), so every behavioral assertion below is RED until
// the green pass turns them on without touching a signature. The suite loads clean
// and the pre-existing files stay green.
//
// The check order under test (FROZEN): path exists → suffix → parse+resolve
// (vocab recover/keep/reviewed) → mandatory confirm-all gate present+checked → stamp
// (dest= basename vs the tmp-derived destination; src=sha256 vs the destination's
// current bytes; src=new ⇒ destination absent) → key gate iff a checked recover DEF
// needs the LLM → fire verbs in document order in memory → re-project iff ≥1 def
// re-rendered → re-hash the tmp (refuse on mid-run mutation) → strip + set
// epistemic_status: distilled → atomic dest write → unlink tmp (ENOENT tolerated).
//
// Fixtures are built through the REAL emit serialization (triage.buildIntermediary)
// so emit↔apply never drift; checkbox state is flipped by string surgery, the way a
// reviewer's Obsidian edit would land. The note bodies are the canonical seven-section
// projection (`## Concepts` `### headword` blocks, numbered `## Procedures` steps) that
// projectMarkdown emits, with trailing `start..end` byte anchors on the anchored lines.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { type Item, parseInteract, stripInteract } from "@/distill/review/interact.ts";
import { buildIntermediary, safeHandle } from "@/distill/review/triage.ts";
import { verbatimDef, verbatimDirectives } from "@/distill/prompt/prompts.ts";
import { askJson } from "@skills/llm/llm.ts";
import type { Residue } from "@/distill/review/residue.ts";
import {
  type ProcedureOp,
  classifyItems,
  editProcedure,
  insertThesis,
  resolveDefTerm,
  resolveStepTarget,
  runApply,
  spliceDef,
} from "@/distill/app/apply-mode.ts";
import { destinationFor, unlinkIfPresent } from "@/distill/review/execute.ts";
import { parseArgs } from "@/distill/app/cli.ts";

// ---------------------------------------------------------------------------
// CLI wiring (parseArgs) — GREEN: the `apply` subcommand surface is implemented,
// only runApply's body is deferred. Pins that apply is a recognized mode, takes a
// mandatory path, accepts --lang, and rejects --dry-run (exit 2 via the error path).
// ---------------------------------------------------------------------------
test("parseArgs: `apply <path>` selects apply mode with the intermediary path", () => {
  const r = parseArgs(["apply", "note.tmp.md"]);
  expect(r.kind).toBe("ok");
  if (r.kind !== "ok") throw new Error("expected ok");
  expect(r.mode).toBe("apply");
  expect(r.opts.path).toBe("note.tmp.md");
});

test("parseArgs: apply accepts --lang and rejects a missing path or --dry-run", () => {
  const withLang = parseArgs(["apply", "--lang", "ru", "note.tmp.md"]);
  expect(withLang.kind === "ok" && withLang.opts.lang).toBe("ru");
  const noPath = parseArgs(["apply"]);
  expect(noPath.kind).toBe("error");
  const dry = parseArgs(["apply", "--dry-run", "note.tmp.md"]);
  expect(dry.kind === "error" && dry.message).toContain("dry-run");
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

// A distilled note: frontmatter + `## Abstract` + three `## Concepts` (`### headword`
// blocks; "Scene" carries no residue, so it survives every triage as the control the
// removals are measured against) + a numbered `## Procedures` under one `### headword`.
const NOTE = `---
type: distillation
description: "Impression distance in plein-air blocking."
epistemic_status: distilled
---

# Impression distance

## Abstract

Blocking from the felt sense rather than the scene keeps the painting's distances honest.

## Concepts

### Anchor image

The first felt impression, fixed as the reference. 10..40

### Impression distance

The nearness of a value to its anchor on re-inspection. 41..70

### Scene

The shifting subject in front of the painter. 71..90

## Procedures

### Block from the impression

1. Fix the anchor image before opening paints 100..140
2. Re-check values against the anchor, not the scene
`;

// A distilled note whose concept headword is BACKTICKED — the Phase-3 emit seam: its
// residue target degrades to safeHandle("`tau` threshold") = "tau threshold", so apply
// must match it back to the `### headword` via safeHandle, not the degraded target string.
const NOTE_TAU = `---
type: distillation
epistemic_status: distilled
---

# Tau

## Abstract

Orientation about the tau split.

## Concepts

### \`tau\` threshold

The split ratio bound. 10..30

### Scene

The subject in front of the painter. 31..50
`;

const DEF_SRC =
  "Impression distance is the gap between the felt sense of a scene and what the eye verifies on re-inspection.";
const WF_SRC =
  "Before glazing, **let the underlayer dry fully**; a damp underlayer lifts the glaze.";
const THESIS_SRC = "Impression distance measures drift from the anchor, not the scene.";
const TAU_SRC = "The tau threshold bounds the route split at 0.5.";

const R_DEF: Residue = {
  kind: "def",
  reasonClass: "failed",
  label: "Impression distance",
  reason: "inverted: def asserts nearness where source asserts a gap",
  source: DEF_SRC,
};
const R_WF: Residue = {
  kind: "steps",
  reasonClass: "failed",
  label: "Block from the impression",
  stepIdxs: [1],
  reason: "procedure: drying precondition missing from steps",
  source: WF_SRC,
};
const R_KEEP: Residue = {
  kind: "def",
  reasonClass: "gate-inconclusive",
  label: "Anchor image",
  reason: "gate-inconclusive: judge returned no verdict after retry",
  source: "The anchor image is the first felt impression, fixed before mixing begins.",
};
const R_THESIS: Residue = {
  kind: "thesis",
  reasonClass: "failed",
  label: "(thesis)",
  reason: "thesis not recoverable from output",
  source: THESIS_SRC,
};
const R_TAU: Residue = {
  kind: "def",
  reasonClass: "failed",
  label: "`tau` threshold",
  reason: "r: m",
  source: TAU_SRC,
};

// The pre-distillation source note.md the emit hashed for src=; independent of the
// distilled NOTE the intermediary carries. Stable so its hash matches the stamp.
const SOURCE = "# Impression distance\n\nThe original long-form source note.\n";

function sha12(bytes: string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}`;
}

// Emit an intermediary the way compress-mode does. `srcMode:"sha256"` writes the
// destination (SOURCE) and stamps its hash; `"new"` leaves the destination absent
// (creation case). Returns the paths and the tmp text (unwritten — the caller flips
// checkboxes, then writes with `writeTmp`).
function emit(
  dir: string,
  destName: string,
  note: string,
  residue: Residue[],
  srcMode: "sha256" | "new" = "sha256",
): { destPath: string; tmpPath: string; tmp: string } {
  const destPath = join(dir, destName);
  let src: string;
  if (srcMode === "new") {
    src = "new";
  } else {
    writeFileSync(destPath, SOURCE);
    src = sha12(SOURCE);
  }
  const tmp = buildIntermediary(note, residue, { dest: destName, src });
  const tmpPath = join(dir, destName.replace(/\.md$/, ".tmp.md"));
  return { destPath, tmpPath, tmp };
}

function writeTmp(tmpPath: string, tmp: string): void {
  writeFileSync(tmpPath, tmp);
}

// Flip `- [ ] <prefix>` → `- [x] <prefix>` (the reviewer's tick). Throws when the
// prefix is absent so a fixture drift fails loud instead of silently checking nothing.
function check(tmp: string, prefix: string): string {
  const from = `- [ ] ${prefix}`;
  if (!tmp.includes(from)) throw new Error(`check: item not found: ${JSON.stringify(from)}`);
  return tmp.replace(from, `- [x] ${prefix}`);
}
const checkGate = (tmp: string): string => check(tmp, "reviewed:");

function tmpdirFor(tag: string): string {
  return mkdtempSync(join(tmpdir(), `distill-apply-${tag}-`));
}

// ---------------------------------------------------------------------------
// runApply capture: it returns the exit code and writes its own stdout/stderr.
// The helper catches the Phase-4 "not implemented" throw so the SPEC assertions
// (side effects, message shapes) stay visible in the red state and turn green when
// the body lands — an unimplemented runApply simply leaves `code` undefined.
// ---------------------------------------------------------------------------
type Captured = { code: number | undefined; threw: unknown; stdout: string; stderr: string };

async function apply(
  tmpPath: string,
  lang: "en" | "ru" | "auto" = "auto",
  ask?: typeof askJson,
): Promise<Captured> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  const dec = (c: string | Uint8Array) => (typeof c === "string" ? c : new TextDecoder().decode(c));
  process.stdout.write = ((c: string | Uint8Array) => (
    outChunks.push(dec(c)),
    true
  )) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => (
    errChunks.push(dec(c)),
    true
  )) as typeof process.stderr.write;
  let code: number | undefined;
  let threw: unknown;
  try {
    code = await runApply(tmpPath, { lang, ask });
  } catch (e) {
    threw = e;
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
  return { code, threw, stdout: outChunks.join(""), stderr: errChunks.join("") };
}

// ---------------------------------------------------------------------------
// LLM stubbing by DEPENDENCY INJECTION — runApply takes an `ask` seam (ApplyOpts.ask,
// defaulting to fw's askJson), so a test hands it a fake transport directly. No
// globalThis.fetch swap and no mock.module("./llm.ts"): nothing process-global is
// mutated, so a file running concurrently over the shared module registry can never
// see this file's stub (the race that a fetch/module mock invites). Every apply LLM
// call (renderEntryPrompt re-render, fidelityGate re-grade) routes through the injected
// `ask`, dispatched on prompt markers below.
// ---------------------------------------------------------------------------
const RENDER_PROSE_MARKER = "reconstructing a readable prose note";
const RENDER_ENTRY_MARKER = 'Write the glossary definition for "';

// A recover-def transport, dispatched on prompt markers: re-render → `def`, re-grade
// → `grade`, re-projection → `prose`. Unknown prompts return an empty object (the
// caller asserts on call presence/count, never on a specific unmatched answer).
function defRecover(
  grade: "translated" | "residue" | "inconclusive",
  def = "MOCKDEF",
  prose = "REPROJECTED HEAD PROSE.",
) {
  return (prompt: string): unknown => {
    if (prompt.includes(RENDER_ENTRY_MARKER)) return { def };
    if (prompt.includes("for a procedure checklist")) return { groups: [] };
    if (prompt.includes("independent fidelity judge"))
      return {
        thesisRecoverable: true,
        concepts: [{ term: "x", grade, direction: "both", missing: "m" }],
      };
    if (prompt.includes(RENDER_PROSE_MARKER)) return { prose };
    return {};
  };
}
// Any LLM path is a bug on this route — a handler that fails loud if fetch is reached.
const NO_LLM = (): never => {
  throw new Error("this apply path must not call the LLM");
};

type MockedCapture = Captured & { prompts: string[] };

// Run apply with an injected `ask` that answers each fw request from `handler`
// (dispatched on the user prompt). Records every prompt so "fires once" / "no LLM"
// assertions read off `prompts`. The seam is local to this call — nothing global is
// touched, so a concurrent file's transport is untouched.
async function applyWith(
  tmpPath: string,
  handler: (prompt: string) => unknown,
  lang: "en" | "ru" | "auto" = "auto",
): Promise<MockedCapture> {
  const prompts: string[] = [];
  const ask = (async (_model: unknown, prompt: string) => {
    prompts.push(prompt);
    return handler(prompt);
  }) as typeof askJson;
  const cap = await apply(tmpPath, lang, ask);
  return { ...cap, prompts };
}

// Hermetic keys: apply's LLM gate is DISTILL_EXTRACT (OpenAI). Run env-only (no Keychain/
// Doppler shell-out) with a dummy set fresh each test, so has-key tests pass deterministically
// and the missing-key test forces the exit-1 path by deleting the dummy.
const HAD_KEYS = {
  fw: process.env.FIREWORKS_API_KEY,
  oai: process.env.OPENAI_API_KEY,
  ds: process.env.DASHSCOPE_API_KEY,
  envOnly: process.env.LLM_KEYS_ENV_ONLY,
};
beforeEach(() => {
  process.env.LLM_KEYS_ENV_ONLY = "1";
  process.env.OPENAI_API_KEY = "test-dummy";
  process.env.DASHSCOPE_API_KEY = "test-dummy";
});
afterEach(() => {
  const restore = (k: string, v: string | undefined) =>
    v === undefined ? delete process.env[k] : (process.env[k] = v);
  restore("FIREWORKS_API_KEY", HAD_KEYS.fw);
  restore("OPENAI_API_KEY", HAD_KEYS.oai);
  restore("DASHSCOPE_API_KEY", HAD_KEYS.ds);
  restore("LLM_KEYS_ENV_ONLY", HAD_KEYS.envOnly);
});

// ===========================================================================
// 1. Preflight: path, suffix, mandatory gate, unchecked gate
// ===========================================================================

test("apply: ENOENT at the path exits 2 with the already-applied message, nothing written", async () => {
  const dir = tmpdirFor("enoent");
  const gone = join(dir, "gone.tmp.md");
  const r = await apply(gone);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("already applied");
  expect(r.stderr).toContain(gone);
  expect(r.stdout).toBe("");
  expect(existsSync(gone.replace(/\.tmp\.md$/, ".md"))).toBe(false);
});

test("apply: a non-.tmp.md path is refused (exit 2), never deriving a destination onto it", async () => {
  const dir = tmpdirFor("suffix");
  const notePath = join(dir, "note.md");
  writeFileSync(notePath, NOTE);
  const r = await apply(notePath);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain(".tmp.md");
  // the note it was told to read is untouched
  expect(readFileSync(notePath, "utf8")).toBe(NOTE);
});

test("apply: an intermediary with residue blocks but NO confirm-all gate is malformed (exit 2)", async () => {
  const dir = tmpdirFor("nogate");
  const tmpPath = join(dir, "x.tmp.md");
  // a lone pick-any block, no gate — the mandatory gate is triage policy, so this is malformed
  writeTmp(
    tmpPath,
    "---\ntype: note\nepistemic_status: in-review\n---\n\n# X\n\nBody.\n\n" +
      "<!-- interact: pick-any id=residue -->\n\n- [ ] recover: `X` — r\n\n<!-- /interact -->\n",
  );
  const before = readFileSync(tmpPath, "utf8");
  const r = await apply(tmpPath);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("no confirm-all gate");
  expect(existsSync(join(dir, "x.md"))).toBe(false);
  expect(readFileSync(tmpPath, "utf8")).toBe(before); // intermediary intact
});

test("apply: a blockless intermediary hits the SAME missing-gate refusal (exit 2)", async () => {
  const dir = tmpdirFor("blockless");
  const tmpPath = join(dir, "b.tmp.md");
  writeTmp(tmpPath, "---\ntype: note\n---\n\n# B\n\nJust prose, no decision blocks.\n");
  const r = await apply(tmpPath);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("no confirm-all gate");
  expect(existsSync(join(dir, "b.md"))).toBe(false);
});

test("apply: an unchecked gate refuses (exit 2); the destination stays byte-identical (constraint 7)", async () => {
  const dir = tmpdirFor("gate");
  const { destPath, tmpPath, tmp } = emit(dir, "note.md", NOTE, [R_DEF]);
  writeTmp(tmpPath, tmp); // gate left UNCHECKED (emit default)
  const destBefore = sha12(readFileSync(destPath, "utf8"));
  const tmpBefore = readFileSync(tmpPath, "utf8");
  const r = await apply(tmpPath);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("triage-final");
  // the source note was never touched, and the intermediary survives for a later apply
  expect(sha12(readFileSync(destPath, "utf8"))).toBe(destBefore);
  expect(readFileSync(tmpPath, "utf8")).toBe(tmpBefore);
});

// ===========================================================================
// 2. Stamp: dest= basename, src=sha256 content, src=new no-clobber
// ===========================================================================

test("apply: an edited destination fails the src=sha256 stamp (exit 2), nothing written", async () => {
  const dir = tmpdirFor("stamp-sha");
  const { destPath, tmpPath, tmp } = emit(dir, "note.md", NOTE, [R_DEF]);
  writeTmp(tmpPath, checkGate(tmp));
  writeFileSync(destPath, SOURCE + "\nan edit after emit\n"); // hash no longer matches src=
  const r = await apply(tmpPath);
  expect(r.code).toBe(2);
  expect(r.stderr.toLowerCase()).toContain("changed");
  expect(readFileSync(destPath, "utf8")).toBe(SOURCE + "\nan edit after emit\n"); // untouched
});

test("apply: a renamed tmp fails the dest= stamp — sha256 case (exit 2)", async () => {
  const dir = tmpdirFor("rename-sha");
  const { tmp } = emit(dir, "note.md", NOTE, [R_DEF]); // stamp dest=note.md
  const renamed = join(dir, "other.tmp.md"); // → destinationFor = other.md ≠ note.md
  writeTmp(renamed, checkGate(tmp));
  const r = await apply(renamed);
  expect(r.code).toBe(2);
  expect(r.stderr.toLowerCase()).toMatch(/dest|renamed/);
  expect(existsSync(join(dir, "other.md"))).toBe(false);
  expect(existsSync(join(dir, "note.md"))).toBe(true); // the real dest was never derived
});

test("apply: a renamed tmp fails the dest= stamp — src=new case (exit 2)", async () => {
  const dir = tmpdirFor("rename-new");
  const { tmp } = emit(dir, "fresh.md", NOTE, [R_DEF], "new"); // stamp dest=fresh.md, src=new
  const renamed = join(dir, "other.tmp.md");
  writeTmp(renamed, checkGate(tmp));
  const r = await apply(renamed);
  expect(r.code).toBe(2);
  expect(r.stderr.toLowerCase()).toMatch(/dest|renamed/);
  expect(existsSync(join(dir, "fresh.md"))).toBe(false);
  expect(existsSync(join(dir, "other.md"))).toBe(false);
});

test("apply: src=new refuses to clobber an existing destination (exit 2)", async () => {
  const dir = tmpdirFor("new-clobber");
  const { destPath, tmpPath, tmp } = emit(dir, "fresh.md", NOTE, [R_DEF], "new");
  writeFileSync(destPath, "a destination that appeared after emit\n"); // src=new but dest now exists
  writeTmp(tmpPath, checkGate(tmp));
  const r = await apply(tmpPath);
  expect(r.code).toBe(2);
  expect(r.stderr.toLowerCase()).toContain("exists");
  expect(readFileSync(destPath, "utf8")).toBe("a destination that appeared after emit\n");
});

// ===========================================================================
// 3. Vocabulary: an out-of-vocab verb is rejected, never executed
// ===========================================================================

test("apply: an out-of-vocabulary verb is rejected (exit 2) and NOTHING is executed", async () => {
  const dir = tmpdirFor("vocab");
  const { destPath, tmpPath, tmp } = emit(dir, "note.md", NOTE, [R_DEF]);
  // hand-mangle the verb to one outside {recover, keep, reviewed}
  const mangled = checkGate(tmp).replace(
    "recover: `Impression distance`",
    "delete: `Impression distance`",
  );
  writeTmp(tmpPath, mangled);
  const r = await apply(tmpPath);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("delete");
  // rejected before any verb fires: the source note is untouched, the tmp survives
  expect(readFileSync(destPath, "utf8")).toBe(SOURCE);
  expect(existsSync(tmpPath)).toBe(true);
});

// ===========================================================================
// 4. Offline removal + creation (no key in env)
// ===========================================================================

test("apply: remove-all (every item unchecked, gate checked) applies OFFLINE with no key", async () => {
  delete process.env.FIREWORKS_API_KEY;
  const dir = tmpdirFor("remove-all");
  const { destPath, tmpPath, tmp } = emit(dir, "note.md", NOTE, [R_DEF, R_WF, R_KEEP]);
  writeTmp(tmpPath, checkGate(tmp)); // only the gate checked; all three items left unchecked
  const r = await apply(tmpPath);
  expect(r.code).toBe(0);
  const out = readFileSync(destPath, "utf8");
  // unchecked recover def + unchecked keep def → both concept subsections deleted; "Scene" survives
  expect(out).not.toContain("### Impression distance");
  expect(out).not.toContain("### Anchor image");
  expect(out).toContain("### Scene");
  // unchecked recover procedure:…:2 → step 2 deleted, step 1 kept and renumbered
  expect(out).not.toContain("Re-check values against the anchor");
  expect(out).toContain("Fix the anchor image before opening paints");
  // promotion + scaffold gone
  expect(out).toContain("epistemic_status: distilled");
  expect(out).not.toContain("interact");
  // consumed
  expect(existsSync(tmpPath)).toBe(false);
  // path on stdout, footer on stderr; removal-only, nothing verbatim
  expect(r.stdout).toBe(`${destPath}\n`);
  expect(r.stderr.trim()).toBe("— applied: 0 recovered · 0 kept · 3 removed (0 verbatim)");
});

test("apply: a clean (residue-free) intermediary with src=new CREATES the destination, exit 0", async () => {
  delete process.env.FIREWORKS_API_KEY;
  const dir = tmpdirFor("new-create");
  const { destPath, tmpPath, tmp } = emit(dir, "fresh.md", NOTE, [], "new");
  expect(existsSync(destPath)).toBe(false);
  writeTmp(tmpPath, checkGate(tmp));
  const r = await apply(tmpPath);
  expect(r.code).toBe(0);
  const out = readFileSync(destPath, "utf8");
  expect(out).toContain("### Impression distance"); // no residue ⇒ concepts intact
  expect(out).toContain("epistemic_status: distilled");
  expect(out).not.toContain("interact");
  expect(existsSync(tmpPath)).toBe(false);
  expect(r.stderr.trim()).toBe("— applied: 0 recovered · 0 kept · 0 removed (0 verbatim)");
});

// ===========================================================================
// 5. The inherited Phase-3 seam: a degraded (backticked-term) def target
// ===========================================================================

test("apply: a degraded backticked-term def, all-unchecked → its glossary row is removed (offline)", async () => {
  delete process.env.FIREWORKS_API_KEY;
  const dir = tmpdirFor("degraded-remove");
  const { destPath, tmpPath, tmp } = emit(dir, "tau.md", NOTE_TAU, [R_TAU]);
  // the emitted target is the safe handle, not the backticked term
  expect(tmp).toContain("recover: `tau threshold`");
  expect(tmp).not.toContain("recover: `` `tau` threshold ``");
  writeTmp(tmpPath, checkGate(tmp)); // recover left unchecked ⇒ remove
  const r = await apply(tmpPath);
  expect(r.code).toBe(0);
  const out = readFileSync(destPath, "utf8");
  // matched back to its real `### headword` via safeHandle, then removed
  expect(out).not.toContain("### `tau` threshold");
  expect(out).toContain("### Scene");
});

// ===========================================================================
// 6. Key gate: only a checked recover DEF needs the LLM
// ===========================================================================

test("apply: a checked recover DEF with no key exits 1 (nothing written); the source is untouched", async () => {
  delete process.env.OPENAI_API_KEY; // the distill extract key the recover-def render needs
  const dir = tmpdirFor("key-missing");
  const { destPath, tmpPath, tmp } = emit(dir, "note.md", NOTE, [R_DEF]);
  writeTmp(tmpPath, checkGate(check(tmp, "recover: `Impression distance`")));
  const r = await applyWith(tmpPath, NO_LLM);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("no API key");
  expect(r.prompts.length).toBe(0); // exited before any LLM call
  expect(readFileSync(destPath, "utf8")).toBe(SOURCE); // nothing written
  expect(existsSync(tmpPath)).toBe(true);
});

test("apply: a checked recover PROCEDURE step needs no key — it applies verbatim, exit 0 (no LLM)", async () => {
  delete process.env.FIREWORKS_API_KEY;
  const dir = tmpdirFor("wf-keyless");
  const { destPath, tmpPath, tmp } = emit(dir, "note.md", NOTE, [R_WF]);
  writeTmp(tmpPath, checkGate(check(tmp, "recover: procedure:Block from the impression:2 —")));
  const r = await applyWith(tmpPath, NO_LLM);
  expect(r.code).toBe(0);
  expect(r.prompts.length).toBe(0);
  const out = readFileSync(destPath, "utf8");
  const [verbatim] = verbatimDirectives(WF_SRC); // "let the underlayer dry fully"
  expect(out).toContain(verbatim);
  expect(out).not.toContain("Re-check values against the anchor"); // step 2 replaced
  expect(out).toContain("Fix the anchor image before opening paints"); // step 1 kept
});

// ===========================================================================
// 7. Verb actions via the fw mock
// ===========================================================================

test("apply: checked recover DEF → one re-render + one grade, concept def line updated (anchor preserved)", async () => {
  process.env.FIREWORKS_API_KEY = "test-dummy";
  const dir = tmpdirFor("recover-def");
  const { destPath, tmpPath, tmp } = emit(dir, "note.md", NOTE, [R_DEF]);
  writeTmp(tmpPath, checkGate(check(tmp, "recover: `Impression distance`")));
  const r = await applyWith(tmpPath, defRecover("translated", "A re-grounded gap definition."));
  expect(r.code).toBe(0);
  // the re-render saw the fenced payload as its source
  expect(r.prompts.some((p) => p.includes(RENDER_ENTRY_MARKER) && p.includes(DEF_SRC))).toBe(true);
  const out = readFileSync(destPath, "utf8");
  // the def line of the `### Impression distance` subsection is rewritten, its anchor kept
  expect(out).toContain("### Impression distance");
  expect(out).toContain("A re-grounded gap definition. 41..70");
  // no re-projection on a canonical note: the ## Abstract is left as-authored
  expect(r.prompts.filter((p) => p.includes(RENDER_PROSE_MARKER)).length).toBe(0);
  expect(out).toContain("## Abstract");
  expect(out).toContain("Blocking from the felt sense rather than the scene");
  expect(existsSync(tmpPath)).toBe(false);
  expect(r.stderr.trim()).toBe("— applied: 1 recovered · 0 kept · 0 removed (0 verbatim)");
});

test("apply: checked recover DEF whose second grade fails is spliced VERBATIM (verbatimDef)", async () => {
  process.env.FIREWORKS_API_KEY = "test-dummy";
  const dir = tmpdirFor("recover-verbatim");
  const { destPath, tmpPath, tmp } = emit(dir, "note.md", NOTE, [R_DEF]);
  writeTmp(tmpPath, checkGate(check(tmp, "recover: `Impression distance`")));
  const r = await applyWith(tmpPath, defRecover("residue", "AN INVERTED RE-RENDER"));
  expect(r.code).toBe(0);
  const out = readFileSync(destPath, "utf8");
  // the failed re-render is discarded; the source's own defining clause is spliced
  expect(out).toContain(`${verbatimDef("Impression distance", DEF_SRC)} 41..70`);
  expect(out).not.toContain("AN INVERTED RE-RENDER");
  // no re-projection on a canonical note
  expect(r.prompts.filter((p) => p.includes(RENDER_PROSE_MARKER)).length).toBe(0);
  expect(r.stderr.trim()).toBe("— applied: 1 recovered · 0 kept · 0 removed (1 verbatim)");
});

test("apply: a non-transient error in the recover-def LLM window propagates (regression) — not floored to verbatim", async () => {
  process.env.FIREWORKS_API_KEY = "test-dummy";
  const dir = tmpdirFor("recover-def-bug");
  const { destPath, tmpPath, tmp } = emit(dir, "note.md", NOTE, [R_DEF]);
  writeTmp(tmpPath, checkGate(check(tmp, "recover: `Impression distance`")));
  // A 4xx status is llm.ts's own classification of a real code bug (bad request / auth /
  // content-policy) — NOT TransientError, NOT TruncationError — so fw() throws a plain
  // Error that askJson never catches. Before the fix, the recover-def loop's bare
  // `catch {}` floored ANY throw (including this one) to verbatimDef and returned exit 0;
  // after the fix, rethrowIfBug(e, "apply-recover-def") sees a non-transient error and
  // rethrows, so runApply itself throws and nothing is written.
  // The injected transport throws exactly what fw() raises for a 4xx: a plain Error
  // (`FW 400: …`), NOT TransientError/TruncationError. llm.ts's own status→error
  // classification is exercised in degradation.test.ts; here the point is that a
  // non-transient throw survives the recover-def catch (rethrowIfBug rethrows it).
  const r = await applyWith(tmpPath, (prompt) => {
    if (prompt.includes(RENDER_ENTRY_MARKER)) throw new Error('FW 400: {"error":"bad request"}');
    return {};
  });
  expect(r.threw).toBeDefined();
  expect(String((r.threw as Error).message)).toContain("FW 400");
  // nothing written on the propagation path: the pre-existing destination (from emit's
  // srcMode:"sha256" write) is untouched, and the tmp is never consumed.
  expect(readFileSync(destPath, "utf8")).toBe(SOURCE);
  expect(existsSync(tmpPath)).toBe(true);
});

test("apply: checked recover THESIS sets the ## Abstract body verbatim (no LLM)", async () => {
  process.env.FIREWORKS_API_KEY = "test-dummy";
  const dir = tmpdirFor("recover-thesis");
  const { destPath, tmpPath, tmp } = emit(dir, "note.md", NOTE, [R_THESIS]);
  writeTmp(tmpPath, checkGate(check(tmp, "recover: thesis —")));
  const r = await applyWith(tmpPath, NO_LLM);
  expect(r.code).toBe(0);
  expect(r.prompts.length).toBe(0);
  const out = readFileSync(destPath, "utf8");
  expect(out).toContain(THESIS_SRC);
  // the abstract body is replaced by the recovered thesis (the canonical orientation home)
  expect(out.indexOf("## Abstract")).toBeLessThan(out.indexOf(THESIS_SRC));
  expect(out).not.toContain("Blocking from the felt sense rather than the scene");
  expect(r.stderr.trim()).toBe("— applied: 1 recovered · 0 kept · 0 removed (1 verbatim)");
});

test("apply: a recovered THESIS and a recovered DEF are independent — abstract set, concept def re-rendered", async () => {
  process.env.FIREWORKS_API_KEY = "test-dummy";
  const dir = tmpdirFor("thesis-plus-def");
  // both the thesis and a def fail — a common co-occurrence for a badly-distilled note. The
  // thesis sets the ## Abstract body; a recovered def re-renders its concept subsection. On a
  // canonical note there is no re-projection, so the two edits are wholly independent.
  const { destPath, tmpPath, tmp } = emit(dir, "note.md", NOTE, [R_THESIS, R_DEF]);
  let t = check(tmp, "recover: thesis —");
  t = check(t, "recover: `Impression distance`");
  writeTmp(tmpPath, checkGate(t));
  const r = await applyWith(tmpPath, defRecover("translated", "A re-grounded gap def."));
  expect(r.code).toBe(0);
  const out = readFileSync(destPath, "utf8");
  // the verbatim thesis is the abstract body, and the def was re-rendered into its concept
  expect(out).toContain(THESIS_SRC);
  expect(out.indexOf("## Abstract")).toBeLessThan(out.indexOf(THESIS_SRC));
  expect(out).toContain("A re-grounded gap def. 41..70");
  // no re-projection on a canonical note
  expect(r.prompts.filter((p) => p.includes(RENDER_PROSE_MARKER)).length).toBe(0);
  expect(r.stderr.trim()).toBe("— applied: 2 recovered · 0 kept · 0 removed (1 verbatim)");
});

test("apply: checked keep holds the entry as shipped — no LLM, no removal", async () => {
  process.env.FIREWORKS_API_KEY = "test-dummy";
  const dir = tmpdirFor("keep");
  const { destPath, tmpPath, tmp } = emit(dir, "note.md", NOTE, [R_KEEP]);
  writeTmp(tmpPath, checkGate(check(tmp, "keep: `Anchor image`")));
  const r = await applyWith(tmpPath, NO_LLM);
  expect(r.code).toBe(0);
  expect(r.prompts.length).toBe(0);
  const out = readFileSync(destPath, "utf8");
  expect(out).toContain("### Anchor image");
  expect(out).toContain("The first felt impression, fixed as the reference. 10..40");
  expect(r.stderr.trim()).toBe("— applied: 0 recovered · 1 kept · 0 removed (0 verbatim)");
});

test("apply: a degraded backticked-headword def, checked recover → re-rendered into its real subsection", async () => {
  process.env.FIREWORKS_API_KEY = "test-dummy";
  const dir = tmpdirFor("degraded-recover");
  const { destPath, tmpPath, tmp } = emit(dir, "tau.md", NOTE_TAU, [R_TAU]);
  writeTmp(tmpPath, checkGate(check(tmp, "recover: `tau threshold`")));
  const r = await applyWith(tmpPath, defRecover("translated", "TAU-REDEF", "TAU HEAD."));
  expect(r.code).toBe(0);
  const out = readFileSync(destPath, "utf8");
  // the subsection is still keyed by the real backticked headword, its def re-rendered
  expect(out).toContain("### `tau` threshold");
  expect(out).toContain("TAU-REDEF 10..30");
});

// ===========================================================================
// 8. Mid-apply mutation: the tmp is re-hashed before the write+unlink
// ===========================================================================

test("apply: a tmp mutated during the LLM window is caught by the re-hash (exit 2), nothing written", async () => {
  process.env.FIREWORKS_API_KEY = "test-dummy";
  const dir = tmpdirFor("mid-mutation");
  const { destPath, tmpPath, tmp } = emit(dir, "note.md", NOTE, [R_DEF]);
  writeTmp(tmpPath, checkGate(check(tmp, "recover: `Impression distance`")));
  // the recover's re-render is the async window a cross-device Sync edit lands in:
  // rewrite the tmp on disk mid-call, so the pre-write re-hash no longer matches
  const answer = defRecover("translated");
  const r = await applyWith(tmpPath, (prompt) => {
    if (prompt.includes(RENDER_ENTRY_MARKER)) {
      writeFileSync(tmpPath, "the reviewer's device re-synced different bytes\n");
    }
    return answer(prompt);
  });
  expect(r.code).toBe(2);
  expect(r.stderr.toLowerCase()).toContain("changed");
  expect(readFileSync(destPath, "utf8")).toBe(SOURCE); // the destination was never written
});

test("apply: a DESTINATION edited during the LLM window is not clobbered (exit 2), the edit survives", async () => {
  process.env.FIREWORKS_API_KEY = "test-dummy";
  const dir = tmpdirFor("dest-mid-mutation");
  const { destPath, tmpPath, tmp } = emit(dir, "note.md", NOTE, [R_DEF]);
  writeTmp(tmpPath, checkGate(check(tmp, "recover: `Impression distance`")));
  // step 5 hashes the dest BEFORE the re-render; a cross-device Sync push (or a hand edit)
  // lands on the dest DURING that window. The atomic overwrite must refuse rather than
  // clobber the concurrent edit — the start-of-run stamp alone leaves this window open.
  const PRECIOUS = `${SOURCE}\nan edit that landed while apply was mid-flight\n`;
  const answer = defRecover("translated");
  const r = await applyWith(tmpPath, (prompt) => {
    if (prompt.includes(RENDER_ENTRY_MARKER)) writeFileSync(destPath, PRECIOUS);
    return answer(prompt);
  });
  expect(r.code).toBe(2);
  expect(r.stderr.toLowerCase()).toContain("changed");
  expect(readFileSync(destPath, "utf8")).toBe(PRECIOUS); // the concurrent edit survives intact
  expect(existsSync(tmpPath)).toBe(true); // the intermediary is kept for a re-run
});

// ===========================================================================
// 9. Pure seams (offline unit tests)
// ===========================================================================

test("destinationFor: .tmp.md → the absolute sibling .md; any other suffix → null", () => {
  expect(destinationFor("/a/b/note.tmp.md")).toBe("/a/b/note.md");
  expect(destinationFor("/a/b/note.md")).toBeNull();
  expect(destinationFor("/a/b/note.txt")).toBeNull();
  expect(destinationFor("note.tmp.md")).toBe(resolve("note.md")); // resolved absolute
});

test("spliceDef: replaces the def line (anchor preserved), deletes the subsection on null, no-ops an absent headword", () => {
  const body = NOTE;
  const replaced = spliceDef(body, "Impression distance", "a newly dense def");
  expect(replaced).toContain("a newly dense def 41..70"); // def line rewritten, anchor kept
  expect(replaced).toContain("### Anchor image"); // siblings untouched
  const removed = spliceDef(body, "Impression distance", null);
  expect(removed).not.toContain("### Impression distance");
  expect(removed).toContain("### Anchor image");
  expect(removed).toContain("### Scene");
  expect(spliceDef(body, "Nonexistent", null)).toBe(body); // absent headword ⇒ unchanged
});

test("editProcedure: deletes / replaces a headword's steps by 0-based index, batched against original indices, renumbered", () => {
  const HW = "Block from the impression";
  const del = editProcedure(NOTE, [{ headword: HW, idx: 1, replace: null }]);
  expect(del).toContain("1. Fix the anchor image before opening paints");
  expect(del).not.toContain("Re-check values against the anchor");
  const rep: ProcedureOp[] = [
    { headword: HW, idx: 1, replace: ["dry the underlayer", "then glaze"] },
  ];
  const out = editProcedure(NOTE, rep);
  expect(out).toContain("1. Fix the anchor image before opening paints");
  expect(out).toContain("2. dry the underlayer");
  expect(out).toContain("3. then glaze");
  // a delete + a replace resolve against ORIGINAL indices, then renumber
  const combo = editProcedure(NOTE, [
    { headword: HW, idx: 0, replace: null },
    { headword: HW, idx: 1, replace: ["only this"] },
  ]);
  expect(combo).toContain("1. only this");
  expect(combo).not.toContain("Fix the anchor image before opening paints");
});

test("resolveDefTerm: exact match, degraded safeHandle match, and no-match null", () => {
  expect(resolveDefTerm(NOTE, "Impression distance")).toBe("Impression distance");
  // the degraded target keys off safeHandle(headword), not the raw backticked headword
  expect(safeHandle("`tau` threshold")).toBe("tau threshold");
  expect(resolveDefTerm(NOTE_TAU, "tau threshold")).toBe("`tau` threshold");
  expect(resolveDefTerm(NOTE, "nonexistent")).toBeNull();
});

// ---------------------------------------------------------------------------
// classifyItems + resolveStepTarget: the PURE core of the apply pass,
// unit-tested offline directly (no fs, no LLM), the way the module's helpers-test
// contract asks. Items are built as plain records — the same shape parseInteract
// yields — so the whole branch matrix (checked/unchecked × def/steps/thesis/keep,
// with target-resolution hits and misses) is drivable without an intermediary.
// ---------------------------------------------------------------------------

// The NOTE procedure "Block from the impression" carries 2 steps (idx 0,1). A steps
// target is `procedure:<headword>:<1-based idxs>`; procedureTarget re-bases to 0.
function mkItem(over: Partial<Item> & Pick<Item, "state" | "verb" | "target">): Item {
  return { targetRaw: over.target, line: 1, ...over };
}

test("resolveStepTarget: resolves headword + in-range idxs, drops out-of-range, nulls a missing headword", () => {
  // 1-based 1,2 → 0-based 0,1; both in range (2 steps)
  expect(resolveStepTarget(NOTE, "procedure:Block from the impression:1,2")).toEqual({
    hw: "Block from the impression",
    idxs: [0, 1],
  });
  // 1-based 2,99 → 0-based 1,98; 98 is beyond the 2-step list and is dropped
  expect(resolveStepTarget(NOTE, "procedure:Block from the impression:2,99")).toEqual({
    hw: "Block from the impression",
    idxs: [1],
  });
  // a whole-procedure target (no `:<idxs>`) resolves the headword but yields no slots
  expect(resolveStepTarget(NOTE, "procedure:Block from the impression")).toEqual({
    hw: "Block from the impression",
    idxs: [],
  });
  // an absent headword → null headword, empty idxs (never a phantom slot)
  expect(resolveStepTarget(NOTE, "procedure:No such procedure:1")).toEqual({
    hw: null,
    idxs: [],
  });
});

test("classifyItems: checked keep is counted, never executed; checked recover def that resolves queues a re-render", () => {
  const r = classifyItems(
    [
      mkItem({ state: "checked", verb: "keep", target: "Anchor image" }),
      mkItem({
        state: "checked",
        verb: "recover",
        target: "Impression distance",
        payload: DEF_SRC,
      }),
    ],
    NOTE,
  );
  expect(r.kept).toBe(1);
  expect(r.recovered).toBe(1);
  expect(r.defRecovers).toEqual([{ term: "Impression distance", src: DEF_SRC }]);
  expect(r.defRemovals).toEqual([]);
  expect(r.unrecoverable).toEqual([]);
  expect(r.verbatim).toBe(0); // def recovers do NOT bump verbatim in the pure pass
});

test("classifyItems: checked recover steps splices verbatim; the first slot carries the clauses, the rest delete", () => {
  const r = classifyItems(
    [
      mkItem({
        state: "checked",
        verb: "recover",
        target: "procedure:Block from the impression:1,2",
        payload: WF_SRC,
      }),
    ],
    NOTE,
  );
  const clauses = verbatimDirectives(WF_SRC);
  expect(r.recovered).toBe(1);
  expect(r.verbatim).toBe(1);
  expect(r.procedureOps).toEqual([
    { headword: "Block from the impression", idx: 0, replace: clauses },
    { headword: "Block from the impression", idx: 1, replace: null },
  ]);
});

test("classifyItems: checked recover thesis sets the paragraph verbatim", () => {
  const r = classifyItems(
    [mkItem({ state: "checked", verb: "recover", target: "thesis", payload: THESIS_SRC })],
    NOTE,
  );
  expect(r.thesisPara).toBe(THESIS_SRC);
  expect(r.recovered).toBe(1);
  expect(r.verbatim).toBe(1);
});

test("classifyItems: a CHECKED recover that cannot execute lands in unrecoverable, never a silent no-op", () => {
  const r = classifyItems(
    [
      // def with no glossary row (edge/payload class degrades here)
      mkItem({ state: "checked", verb: "recover", target: "nonexistent", payload: "x" }),
      // steps target out of range → no in-range slot
      mkItem({
        state: "checked",
        verb: "recover",
        target: "procedure:Block from the impression:99",
        payload: WF_SRC,
      }),
      // steps recover with an EMPTY payload would DELETE the slot — refuse instead
      mkItem({
        state: "checked",
        verb: "recover",
        target: "procedure:Block from the impression:1",
        payload: "",
      }),
      // thesis with an empty payload is nothing to recover
      mkItem({ state: "checked", verb: "recover", target: "thesis", payload: "   " }),
    ],
    NOTE,
  );
  expect(r.unrecoverable).toEqual([
    "nonexistent",
    "procedure:Block from the impression:99",
    "procedure:Block from the impression:1",
    "thesis",
  ]);
  expect(r.recovered).toBe(0);
  expect(r.procedureOps).toEqual([]);
  expect(r.thesisPara).toBeNull();
});

test("classifyItems: unchecked entries remove by EFFECT — a resolving def/steps counts, a non-recoverable one does not", () => {
  const r = classifyItems(
    [
      mkItem({
        state: "unchecked",
        verb: "recover",
        target: "Impression distance",
        payload: DEF_SRC,
      }),
      mkItem({
        state: "unchecked",
        verb: "recover",
        target: "procedure:Block from the impression:2",
        payload: WF_SRC,
      }),
      // unchecked non-recoverable: never in the output, so no phantom "removed"
      mkItem({ state: "unchecked", verb: "recover", target: "nonexistent" }),
      // unchecked steps out-of-range: nothing to remove
      mkItem({
        state: "unchecked",
        verb: "recover",
        target: "procedure:Block from the impression:99",
      }),
    ],
    NOTE,
  );
  expect(r.removed).toBe(2);
  expect(r.defRemovals).toEqual(["Impression distance"]);
  expect(r.procedureOps).toEqual([
    { headword: "Block from the impression", idx: 1, replace: null },
  ]);
});

test("insertThesis: replaces the ## Abstract body with the paragraph", () => {
  const out = insertThesis(NOTE, "THE THESIS.");
  expect(out).toContain("## Abstract");
  expect(out.indexOf("## Abstract")).toBeLessThan(out.indexOf("THE THESIS."));
  // the old abstract body is replaced; the H1 and the concept sections stay in place
  expect(out).not.toContain("Blocking from the felt sense rather than the scene");
  expect(out).toContain("# Impression distance");
  expect(out).toContain("### Impression distance");
});

test("unlinkIfPresent: tolerates a missing path and removes an existing one", () => {
  const dir = tmpdirFor("unlink");
  const gone = join(dir, "never-existed");
  expect(() => unlinkIfPresent(gone)).not.toThrow(); // ENOENT tolerated
  const there = join(dir, "here");
  writeFileSync(there, "x");
  unlinkIfPresent(there);
  expect(existsSync(there)).toBe(false);
});

// A guard against the fixtures themselves drifting from the frozen grammar: every
// built intermediary must parse clean and carry the mandatory gate, so a red apply
// assertion is never masked by a malformed fixture. GREEN by design — it exercises
// only the already-shipped emit + grammar core.
const RESIDUE_SETS: Residue[][] = [
  [R_DEF],
  [R_WF],
  [R_KEEP],
  [R_THESIS],
  [R_TAU],
  [R_DEF, R_WF, R_KEEP],
  [],
];
test("fixture sanity: every emitted intermediary parses clean with a triage-final gate and strips clean", () => {
  for (const residue of RESIDUE_SETS) {
    const tmp = buildIntermediary(NOTE, residue, { dest: "note.md", src: "new" });
    const { blocks, errors } = parseInteract(tmp);
    expect(errors).toEqual([]);
    expect(blocks.some((b) => b.kind === "confirm-all" && b.id === "triage-final")).toBe(true);
    expect(stripInteract(tmp)).not.toContain("interact"); // the scaffold strips clean
  }
});

// ===========================================================================
// 9. Non-recoverable residue (edge/payload/prose): the advisor's finding 1.
// These classes emit as `recover` with a safeHandle target that targetKind buckets
// as "def", but resolveDefTerm finds no glossary row for them. A CHECKED recover
// must refuse LOUD, never silently no-op + report "recovered" + consume the tmp —
// a lost reviewer decision is the format's disaster class.
// ===========================================================================

const R_EDGE: Residue = {
  kind: "edge",
  reasonClass: "dropped",
  label: "Dropped wikilink",
  reason: "wikilink dropped: collided with an existing term",
  source: "[[Dropped wikilink]] carried the original aside.",
};

test("apply: a checked recover on non-recoverable residue refuses (exit 2), preserving the decision and the source", async () => {
  delete process.env.FIREWORKS_API_KEY; // the refusal must precede the key gate
  const dir = tmpdirFor("no-action-recover");
  const { destPath, tmpPath, tmp } = emit(dir, "note.md", NOTE, [R_EDGE]);
  const before = readFileSync(destPath, "utf8");
  writeTmp(tmpPath, checkGate(check(tmp, `recover: ${safeHandle("Dropped wikilink")} —`)));
  const r = await apply(tmpPath);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("no applicable action");
  expect(r.stdout).toBe(""); // no false "1 recovered" report
  expect(existsSync(tmpPath)).toBe(true); // decision preserved, tmp not consumed
  expect(readFileSync(destPath, "utf8")).toBe(before); // source untouched (constraint 7)
});

test("apply: an unchecked non-recoverable item stays dropped and does not inflate the removed count (effects, not decisions)", async () => {
  delete process.env.FIREWORKS_API_KEY;
  const dir = tmpdirFor("count-effects");
  const { tmpPath, tmp } = emit(dir, "note.md", NOTE, [R_EDGE]);
  writeTmp(tmpPath, checkGate(tmp)); // gate checked, the edge item left unchecked
  const r = await apply(tmpPath);
  expect(r.code).toBe(0);
  expect(r.stderr).toContain("0 recovered · 0 kept · 0 removed");
});

// The advisor's re-review: the steps and thesis lanes had the same silent-swallow /
// content-delete root as finding 1 — a checked recover that cannot execute must refuse,
// never no-op (an out-of-range idx) or, worse, DELETE the step (an empty payload →
// verbatimDirectives("") → [] → replace:null → editProcedure drops the slot).

test("apply: a checked recover on an out-of-range procedure step target refuses (exit 2), the list untouched", async () => {
  delete process.env.FIREWORKS_API_KEY;
  const dir = tmpdirFor("wf-oor");
  const R: Residue = {
    kind: "steps",
    reasonClass: "failed",
    label: "Block from the impression",
    stepIdxs: [98],
    reason: "procedure: a step group beyond the emitted list",
    source: "Some directive that has nowhere to land.",
  };
  const { destPath, tmpPath, tmp } = emit(dir, "note.md", NOTE, [R]);
  const before = readFileSync(destPath, "utf8");
  writeTmp(tmpPath, checkGate(check(tmp, "recover: procedure:Block from the impression:99 —")));
  const r = await apply(tmpPath);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("no applicable action");
  expect(existsSync(tmpPath)).toBe(true);
  expect(readFileSync(destPath, "utf8")).toBe(before);
});

test("apply: a checked recover on a procedure step with NO source payload refuses — never DELETES the step it was asked to recover", async () => {
  delete process.env.FIREWORKS_API_KEY;
  const dir = tmpdirFor("wf-nosrc");
  const R: Residue = {
    kind: "steps",
    reasonClass: "failed",
    label: "Block from the impression",
    stepIdxs: [1],
    reason: "procedure: the step-group source lookup returned empty",
    source: "", // emit omits the payload → the delete-instead-of-recover hazard
  };
  const { destPath, tmpPath, tmp } = emit(dir, "note.md", NOTE, [R]);
  const before = readFileSync(destPath, "utf8");
  writeTmp(tmpPath, checkGate(check(tmp, "recover: procedure:Block from the impression:2 —")));
  const r = await apply(tmpPath);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("no applicable action");
  expect(readFileSync(destPath, "utf8")).toBe(before); // step 2 survives
});

test("apply: a checked recover thesis with no payload refuses, never inserts an empty paragraph", async () => {
  delete process.env.FIREWORKS_API_KEY;
  const dir = tmpdirFor("thesis-nosrc");
  const R: Residue = {
    kind: "thesis",
    reasonClass: "failed",
    label: "(thesis)",
    reason: "thesis not recoverable from output",
    source: "",
  };
  const { destPath, tmpPath, tmp } = emit(dir, "note.md", NOTE, [R]);
  const before = readFileSync(destPath, "utf8");
  writeTmp(tmpPath, checkGate(check(tmp, "recover: thesis —")));
  const r = await apply(tmpPath);
  expect(r.code).toBe(2);
  expect(readFileSync(destPath, "utf8")).toBe(before);
});

test("apply: an unchecked out-of-range procedure step item does not inflate the removed count", async () => {
  delete process.env.FIREWORKS_API_KEY;
  const dir = tmpdirFor("wf-oor-unchecked");
  const R: Residue = {
    kind: "steps",
    reasonClass: "failed",
    label: "Block from the impression",
    stepIdxs: [98],
    reason: "procedure: beyond the list",
    source: "x",
  };
  const { tmpPath, tmp } = emit(dir, "note.md", NOTE, [R]);
  writeTmp(tmpPath, checkGate(tmp)); // gate checked, the steps item left unchecked
  const r = await apply(tmpPath);
  expect(r.code).toBe(0);
  expect(r.stderr).toContain("0 recovered · 0 kept · 0 removed");
});
