// apply red corpus (Phase 4, build plan §4/§6) — run with `bun test` from here.
//
// Freezes the apply contract AHEAD of the implementation: apply-mode.ts's bodies
// are unimplemented (each throws), so every behavioral assertion below is RED until
// the green pass turns them on without touching a signature. The suite loads clean
// and the pre-existing files stay green.
//
// The check order under test (plan §4, FROZEN): path exists → suffix → parse+resolve
// (vocab recover/keep/reviewed) → mandatory confirm-all gate present+checked → stamp
// (dest= basename vs the tmp-derived destination; src=sha256 vs the destination's
// current bytes; src=new ⇒ destination absent) → key gate iff a checked recover DEF
// needs the LLM → fire verbs in document order in memory → re-project iff ≥1 def
// re-rendered → re-hash the tmp (refuse on mid-run mutation) → strip + set
// epistemic_status: distilled → atomic dest write → unlink tmp (ENOENT tolerated).
//
// Fixtures are built through the REAL emit serialization (triage.buildIntermediary)
// so emit↔apply never drift; checkbox state is flipped by string surgery, the way a
// reviewer's Obsidian edit would land. The `## Workflow` list is the numbered `1.`
// form assembleBody actually emits (the plan-§5 golden's `- [ ]` is an illustration).
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, test } from "bun:test";
import { parseInteract, stripInteract } from "./interact.ts";
import { buildIntermediary, safeHandle } from "./triage.ts";
import { verbatimDef, verbatimDirectives } from "./prompts.ts";
import type { Residue } from "./pipeline.ts";
import {
  type WorkflowOp,
  destinationFor,
  editWorkflow,
  insertThesis,
  replaceHeadProse,
  resolveDefTerm,
  runApply,
  spliceDef,
  unlinkIfPresent,
} from "./apply-mode.ts";
import { parseArgs } from "./pipeline.ts";

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

// A distilled note: frontmatter + head prose + numbered `## Workflow` + `## Glossary`
// (three terms; "Scene" carries no residue, so it survives every triage as the
// control the removals are measured against).
const NOTE = `---
type: note
description: "Impression distance in plein-air blocking."
epistemic_status: distilled
---

# Impression distance

Blocking from the impression rather than the scene keeps the painting's distances honest.

## Workflow

1. Fix the anchor image before opening paints
2. Re-check values against the anchor, not the scene

## Glossary

| Term | Definition |
| ---- | ---------- |
| Anchor image | The first felt impression, fixed as the reference. |
| Impression distance | The nearness of a value to its anchor on re-inspection. |
| Scene | The shifting subject in front of the painter. |
`;

// A distilled note whose glossary carries a BACKTICKED term — the Phase-3 emit seam:
// its residue target degrades to safeHandle("`tau` threshold") = "tau threshold", so
// apply must match it back to the row via safeHandle, not the degraded target string.
const NOTE_TAU = `---
type: note
epistemic_status: distilled
---

# Tau

Head prose about the tau split.

## Glossary

| Term | Definition |
| ---- | ---------- |
| \`tau\` threshold | The split ratio bound. |
| Scene | The subject in front of the painter. |
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
  label: "workflow:2",
  stepIdxs: [1],
  reason: "workflow: drying precondition missing from steps",
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

async function apply(tmpPath: string, lang: "en" | "ru" | "auto" = "auto"): Promise<Captured> {
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
    code = await runApply(tmpPath, { lang });
  } catch (e) {
    threw = e;
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
  return { code, threw, stdout: outChunks.join(""), stderr: errChunks.join("") };
}

// ---------------------------------------------------------------------------
// LLM stubbing at the FETCH boundary — deliberately NOT mock.module("./fw.ts").
// bun runs test files concurrently over one shared module registry, and a
// module-level fw mock (installed/restored per test) races emit.test.ts's slow
// mocked-pipeline run — un-mocking fw mid-flight there (a real 401). Stubbing
// globalThis.fetch instead is orthogonal: a file whose askJson is mock.module'd
// never reaches fetch, so this touches nothing emit relies on. Every apply LLM call
// (renderEntryPrompt re-render, fidelityGate re-grade, renderProse re-projection)
// still routes through fw→fetch, so the real askJson parse/retry path is exercised.
// The fetch stub is installed inside applyWith and torn down in its finally.
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

// Run apply with globalThis.fetch stubbed to answer each fw request from `handler`
// (dispatched on the user prompt). Records every prompt so "fires once" / "no LLM"
// assertions read off `prompts`. fetch is restored in finally — the stub never
// outlives the call, so a concurrent file's real fetch is untouched.
async function applyWith(
  tmpPath: string,
  handler: (prompt: string) => unknown,
  lang: "en" | "ru" | "auto" = "auto",
): Promise<MockedCapture> {
  const prompts: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse((init?.body as string) ?? "{}");
    const prompt: string = body?.messages?.[0]?.content ?? "";
    prompts.push(prompt);
    const content = JSON.stringify(handler(prompt));
    return new Response(
      JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
  try {
    const cap = await apply(tmpPath, lang);
    return { ...cap, prompts };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const HAD_KEY = process.env.FIREWORKS_API_KEY;
afterEach(() => {
  if (HAD_KEY === undefined) delete process.env.FIREWORKS_API_KEY;
  else process.env.FIREWORKS_API_KEY = HAD_KEY;
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
  // unchecked recover def + unchecked keep def → both glossary rows deleted; "Scene" survives
  expect(out).not.toContain("| Impression distance |");
  expect(out).not.toContain("| Anchor image |");
  expect(out).toContain("| Scene |");
  // unchecked recover workflow:2 → step 2 deleted, step 1 kept and renumbered
  expect(out).not.toContain("Re-check values against the anchor");
  expect(out).toContain("Fix the anchor image before opening paints");
  // promotion + scaffold gone
  expect(out).toContain("epistemic_status: distilled");
  expect(out).not.toContain("interact");
  // consumed
  expect(existsSync(tmpPath)).toBe(false);
  // two-line stdout, removal-only ⇒ re-projection skipped, nothing verbatim
  const lines = r.stdout.split("\n");
  expect(lines[0]).toBe(destPath);
  expect(lines[1]).toBe(
    "— applied: 0 recovered · 0 kept · 3 removed (0 verbatim) · re-projection skipped",
  );
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
  expect(out).toContain("| Impression distance |"); // no residue ⇒ glossary intact
  expect(out).toContain("epistemic_status: distilled");
  expect(out).not.toContain("interact");
  expect(existsSync(tmpPath)).toBe(false);
  expect(r.stdout.split("\n")[1]).toBe(
    "— applied: 0 recovered · 0 kept · 0 removed (0 verbatim) · re-projection skipped",
  );
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
  // matched back to its real row via safeHandle, then removed
  expect(out).not.toContain("`tau` threshold |");
  expect(out).toContain("| Scene |");
});

// ===========================================================================
// 6. Key gate: only a checked recover DEF needs the LLM
// ===========================================================================

test("apply: a checked recover DEF with no key exits 1 (nothing written); the source is untouched", async () => {
  delete process.env.FIREWORKS_API_KEY;
  const dir = tmpdirFor("key-missing");
  const { destPath, tmpPath, tmp } = emit(dir, "note.md", NOTE, [R_DEF]);
  writeTmp(tmpPath, checkGate(check(tmp, "recover: `Impression distance`")));
  const r = await applyWith(tmpPath, NO_LLM);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("FIREWORKS_API_KEY");
  expect(r.prompts.length).toBe(0); // exited before any LLM call
  expect(readFileSync(destPath, "utf8")).toBe(SOURCE); // nothing written
  expect(existsSync(tmpPath)).toBe(true);
});

test("apply: a checked recover WORKFLOW needs no key — it applies verbatim, exit 0 (no LLM)", async () => {
  delete process.env.FIREWORKS_API_KEY;
  const dir = tmpdirFor("wf-keyless");
  const { destPath, tmpPath, tmp } = emit(dir, "note.md", NOTE, [R_WF]);
  writeTmp(tmpPath, checkGate(check(tmp, "recover: workflow:2 —")));
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

test("apply: checked recover DEF → one re-render + one grade, glossary row updated, re-projected once", async () => {
  process.env.FIREWORKS_API_KEY = "test-dummy";
  const dir = tmpdirFor("recover-def");
  const { destPath, tmpPath, tmp } = emit(dir, "note.md", NOTE, [R_DEF]);
  writeTmp(tmpPath, checkGate(check(tmp, "recover: `Impression distance`")));
  const r = await applyWith(tmpPath, defRecover("translated", "A re-grounded gap definition."));
  expect(r.code).toBe(0);
  // the re-render saw the fenced payload as its source
  expect(r.prompts.some((p) => p.includes(RENDER_ENTRY_MARKER) && p.includes(DEF_SRC))).toBe(true);
  const out = readFileSync(destPath, "utf8");
  expect(out).toContain("| Impression distance | A re-grounded gap definition. |");
  // re-projection fires exactly once (whole-glossary), replacing the head prose
  expect(r.prompts.filter((p) => p.includes(RENDER_PROSE_MARKER)).length).toBe(1);
  expect(out).toContain("REPROJECTED HEAD PROSE.");
  expect(out).not.toContain("Blocking from the impression rather than the scene");
  expect(existsSync(tmpPath)).toBe(false);
  expect(r.stdout.split("\n")[1]).toBe(
    "— applied: 1 recovered · 0 kept · 0 removed (0 verbatim) · re-projected",
  );
});

test("apply: checked recover DEF whose second grade fails is spliced VERBATIM (verbatimDef), still re-projected", async () => {
  process.env.FIREWORKS_API_KEY = "test-dummy";
  const dir = tmpdirFor("recover-verbatim");
  const { destPath, tmpPath, tmp } = emit(dir, "note.md", NOTE, [R_DEF]);
  writeTmp(tmpPath, checkGate(check(tmp, "recover: `Impression distance`")));
  const r = await applyWith(tmpPath, defRecover("residue", "AN INVERTED RE-RENDER"));
  expect(r.code).toBe(0);
  const out = readFileSync(destPath, "utf8");
  // the failed re-render is discarded; the source's own defining clause is spliced
  expect(out).toContain(`| Impression distance | ${verbatimDef("Impression distance", DEF_SRC)} |`);
  expect(out).not.toContain("AN INVERTED RE-RENDER");
  // a glossary change still triggers exactly one re-projection
  expect(r.prompts.filter((p) => p.includes(RENDER_PROSE_MARKER)).length).toBe(1);
  expect(r.stdout.split("\n")[1]).toBe(
    "— applied: 1 recovered · 0 kept · 0 removed (1 verbatim) · re-projected",
  );
});

test("apply: checked recover THESIS splices the payload verbatim after the H1 (no LLM)", async () => {
  process.env.FIREWORKS_API_KEY = "test-dummy";
  const dir = tmpdirFor("recover-thesis");
  const { destPath, tmpPath, tmp } = emit(dir, "note.md", NOTE, [R_THESIS]);
  writeTmp(tmpPath, checkGate(check(tmp, "recover: thesis —")));
  const r = await applyWith(tmpPath, NO_LLM);
  expect(r.code).toBe(0);
  expect(r.prompts.length).toBe(0);
  const out = readFileSync(destPath, "utf8");
  expect(out).toContain(THESIS_SRC);
  // inserted as the opening paragraph, before the original head prose
  expect(out.indexOf(THESIS_SRC)).toBeLessThan(out.indexOf("Blocking from the impression"));
  expect(r.stdout.split("\n")[1]).toBe(
    "— applied: 1 recovered · 0 kept · 0 removed (1 verbatim) · re-projection skipped",
  );
});

test("apply: a recovered THESIS survives when a def is ALSO recovered (re-projection must not clobber it)", async () => {
  process.env.FIREWORKS_API_KEY = "test-dummy";
  const dir = tmpdirFor("thesis-plus-def");
  // both the thesis and a def fail — a common co-occurrence for a badly-distilled note.
  // The thesis is spliced verbatim after the H1; a recovered def forces a re-projection of
  // the head-prose region, which is exactly where the thesis sits. The verbatim thesis
  // (contract: "no LLM") must not be swept away by the re-projection.
  const { destPath, tmpPath, tmp } = emit(dir, "note.md", NOTE, [R_THESIS, R_DEF]);
  let t = check(tmp, "recover: thesis —");
  t = check(t, "recover: `Impression distance`");
  writeTmp(tmpPath, checkGate(t));
  const r = await applyWith(tmpPath, defRecover("translated", "A re-grounded gap def."));
  expect(r.code).toBe(0);
  const out = readFileSync(destPath, "utf8");
  // the verbatim thesis is present, and leads the re-projected connective prose
  expect(out).toContain(THESIS_SRC);
  expect(out).toContain("REPROJECTED HEAD PROSE.");
  expect(out.indexOf(THESIS_SRC)).toBeLessThan(out.indexOf("REPROJECTED HEAD PROSE."));
  // the def was re-rendered into its row and the head prose re-projected exactly once
  expect(out).toContain("| Impression distance | A re-grounded gap def. |");
  expect(r.prompts.filter((p) => p.includes(RENDER_PROSE_MARKER)).length).toBe(1);
  expect(r.stdout.split("\n")[1]).toBe(
    "— applied: 2 recovered · 0 kept · 0 removed (1 verbatim) · re-projected",
  );
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
  expect(out).toContain("| Anchor image | The first felt impression, fixed as the reference. |");
  expect(r.stdout.split("\n")[1]).toBe(
    "— applied: 0 recovered · 1 kept · 0 removed (0 verbatim) · re-projection skipped",
  );
});

test("apply: re-projection fires EXACTLY ONCE across two recovered defs (whole-glossary, not per-entry)", async () => {
  process.env.FIREWORKS_API_KEY = "test-dummy";
  const dir = tmpdirFor("reproj-once");
  const R_DEF2: Residue = { ...R_KEEP, reasonClass: "failed" }; // Anchor image, now a recover
  const { tmpPath, tmp } = emit(dir, "note.md", NOTE, [R_DEF, R_DEF2]);
  let t = check(tmp, "recover: `Impression distance`");
  t = check(t, "recover: `Anchor image`");
  writeTmp(tmpPath, checkGate(t));
  const r = await applyWith(tmpPath, defRecover("translated", "def-x"));
  expect(r.code).toBe(0);
  expect(r.prompts.filter((p) => p.includes(RENDER_PROSE_MARKER)).length).toBe(1);
});

test("apply: a workflow-only recover NEVER re-projects (no def re-rendered)", async () => {
  delete process.env.FIREWORKS_API_KEY;
  const dir = tmpdirFor("no-reproj");
  const { tmpPath, tmp } = emit(dir, "note.md", NOTE, [R_WF]);
  writeTmp(tmpPath, checkGate(check(tmp, "recover: workflow:2 —")));
  const r = await applyWith(tmpPath, NO_LLM);
  expect(r.code).toBe(0);
  expect(r.prompts.filter((p) => p.includes(RENDER_PROSE_MARKER)).length).toBe(0);
});

test("apply: a degraded backticked-term def, checked recover → re-rendered into its real row", async () => {
  process.env.FIREWORKS_API_KEY = "test-dummy";
  const dir = tmpdirFor("degraded-recover");
  const { destPath, tmpPath, tmp } = emit(dir, "tau.md", NOTE_TAU, [R_TAU]);
  writeTmp(tmpPath, checkGate(check(tmp, "recover: `tau threshold`")));
  const r = await applyWith(tmpPath, defRecover("translated", "TAU-REDEF", "TAU HEAD."));
  expect(r.code).toBe(0);
  const out = readFileSync(destPath, "utf8");
  // the row is still keyed by the real backticked term, its def re-rendered
  expect(out).toContain("| `tau` threshold | TAU-REDEF |");
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

test("spliceDef: replaces a def cell, escapes pipes, deletes on null, no-ops an absent term", () => {
  const body = NOTE;
  const replaced = spliceDef(body, "Impression distance", "a new | dense def");
  expect(replaced).toContain("| Impression distance | a new \\| dense def |"); // pipe escaped
  expect(replaced).toContain("| Anchor image |"); // siblings untouched
  const removed = spliceDef(body, "Impression distance", null);
  expect(removed).not.toContain("| Impression distance |");
  expect(removed).toContain("| Anchor image |");
  expect(removed).toContain("| Scene |");
  expect(spliceDef(body, "Nonexistent", null)).toBe(body); // absent term ⇒ unchanged
});

test("editWorkflow: deletes / replaces by 0-based index, batched against original indices, renumbered", () => {
  const del = editWorkflow(NOTE, [{ idx: 1, replace: null }]);
  expect(del).toContain("1. Fix the anchor image before opening paints");
  expect(del).not.toContain("Re-check values against the anchor");
  const rep: WorkflowOp[] = [{ idx: 1, replace: ["dry the underlayer", "then glaze"] }];
  const out = editWorkflow(NOTE, rep);
  expect(out).toContain("1. Fix the anchor image before opening paints");
  expect(out).toContain("2. dry the underlayer");
  expect(out).toContain("3. then glaze");
  // a delete + a replace resolve against ORIGINAL indices, then renumber
  const combo = editWorkflow(NOTE, [
    { idx: 0, replace: null },
    { idx: 1, replace: ["only this"] },
  ]);
  expect(combo).toContain("1. only this");
  expect(combo).not.toContain("Fix the anchor image before opening paints");
});

test("resolveDefTerm: exact match, degraded safeHandle match, and no-match null", () => {
  expect(resolveDefTerm(NOTE, "Impression distance")).toBe("Impression distance");
  // the degraded target keys off safeHandle(rowTerm), not the raw backticked term
  expect(safeHandle("`tau` threshold")).toBe("tau threshold");
  expect(resolveDefTerm(NOTE_TAU, "tau threshold")).toBe("`tau` threshold");
  expect(resolveDefTerm(NOTE, "nonexistent")).toBeNull();
});

test("insertThesis: the paragraph lands right after the H1, before the existing head prose", () => {
  const out = insertThesis(NOTE, "THE THESIS.");
  expect(out).toContain("# Impression distance");
  expect(out.indexOf("# Impression distance")).toBeLessThan(out.indexOf("THE THESIS."));
  expect(out.indexOf("THE THESIS.")).toBeLessThan(out.indexOf("Blocking from the impression"));
});

test("replaceHeadProse: swaps the head region (H1→first `## `), leaving the sections in place", () => {
  const out = replaceHeadProse(NOTE, "NEW HEAD PROSE.");
  expect(out).toContain("# Impression distance");
  expect(out).toContain("NEW HEAD PROSE.");
  expect(out).not.toContain("Blocking from the impression");
  expect(out).toContain("## Workflow");
  expect(out).toContain("## Glossary");
  expect(out).toContain("| Impression distance |"); // the glossary is not re-projected
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
  expect(r.stdout).toContain("0 recovered · 0 kept · 0 removed");
});
