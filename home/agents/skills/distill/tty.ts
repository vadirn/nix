// tty — the interactive terminal half of the pipeline: the span-typing review (blueprint
// §11.4) and the emit->apply TTY session (plan §4). Both are sugar over the pure retype.ts /
// triage.ts / apply-mode.ts machinery, driven only at a real terminal; a non-TTY caller never
// reaches here. `ask` is the readline round-trip; `askFn` is the injection seam tests script to
// answer without a terminal.
import { createInterface } from "node:readline";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { type Projection } from "./project.ts";
import { applyTyping, buildTypingReview } from "./retype.ts";
import { type Block, parseInteract, renderBlock } from "./interact.ts";
import { runApply } from "./apply-mode.ts";

// The confirm-all gate-satisfied predicate (plan §4 / blueprint §11.4): a document's gate is
// satisfied only when a confirm-all block exists AND has at least one item AND every item is
// checked (an empty confirm-all block never auto-satisfies). Both TTY loops below re-read the
// file on every iteration and re-derive this off the fresh parse, so it stays a pure function
// of the current blocks rather than cached state.
function isGateChecked(blocks: Block[]): boolean {
  const gate = blocks.find((b) => b.kind === "confirm-all");
  return (
    gate !== undefined && gate.items.length > 0 && gate.items.every((it) => it.state === "checked")
  );
}

// ---- TTY session (Phase 5, plan §4): sugar over emit+apply, never a third code path ----

/// One `prompt [y/N]` round-trip against the real terminal: the prompt lands on
/// stderr (stdout stays the frozen one-line path even at a TTY), the answer
/// comes from stdin. A fresh readline.Interface per call — this is a handful of
/// round-trips per session, not a hot loop. EOF (Ctrl-D) or a stream error
/// resolves null, which the caller treats as decline; readline's own Ctrl-C
/// handling is not engaged (`terminal` defaults off without a matching `output`),
/// so Ctrl-C falls through to the SIGINT handler main() installs around the session.
function ask(prompt: string): Promise<string | null> {
  return new Promise((resolvePrompt) => {
    process.stderr.write(prompt);
    const rl = createInterface({ input: process.stdin });
    let answered = false;
    rl.once("line", (line) => {
      answered = true;
      rl.close();
      resolvePrompt(line);
    });
    rl.once("close", () => {
      if (!answered) resolvePrompt(null);
    });
  });
}

const isYes = (answer: string | null): boolean =>
  answer !== null && answer.trim().toLowerCase() === "y";

/// The span-typing review's TTY orchestration (blueprint §11.4): the interactive half of the pure
/// retype.ts helpers, driven only at a real terminal (the caller in distill() TTY-gates it, so a
/// non-TTY run never reaches here — the review is skipped and the graph keeps its extract-assigned
/// types). Writes the per-unit `pick-one` review (buildTypingReview → renderBlock) to a scratch file,
/// then runs the SAME gate-aware sugar loop as runTtySession: re-read on each iteration, prompt until
/// the confirm-all gate is checked (the reviewer toggles types + the gate in their editor), then
/// applyTyping the result — mutating result.units IN PLACE before the caller projects. A non-"y"
/// answer or EOF declines: the graph is left with its extract-assigned types. `askFn` is the same
/// injection seam runTtySession uses; production wires the real `ask`. The scratch file is always
/// removed. Returns true when the reviewer confirmed (types applied), false when they declined.
export async function runTypingReview(
  result: Projection,
  body: string,
  askFn: (prompt: string) => Promise<string | null> = ask,
): Promise<boolean> {
  const blocks = buildTypingReview(result, body);
  if (blocks.length === 0) return false; // no units → nothing to type
  const scratch = join(tmpdir(), `distill-typing-${process.pid}-${Date.now()}.md`);
  writeFileSync(scratch, blocks.map(renderBlock).join(""));
  try {
    for (;;) {
      const text = readFileSync(scratch, "utf8");
      const { blocks: parsed } = parseInteract(text);
      if (!isGateChecked(parsed)) {
        const answer = await askFn(
          `typing review '${scratch}' — set each unit's type, check the gate, then press y [y/N] `,
        );
        if (!isYes(answer)) return false;
        continue; // re-read before applying — the tick is the file's, not the terminal's
      }
      applyTyping(result, text);
      return true;
    }
  } finally {
    try {
      unlinkSync(scratch);
    } catch {}
  }
}

/// The gate-aware sugar loop (plan §4 transcript): re-reads `tmpPath` from disk on
/// every iteration (Sync may have landed a cross-device edit between prompts), so
/// it never asks a question the file itself already answers. The confirm-all gate
/// (triage.ts always names it "triage-final") unchecked → a diagnosis prompt whose
/// "y" only asks for a re-read, never substitutes for the tick; gate fully checked →
/// one count-confirm naming what apply is about to do, then `runApply` runs
/// in-process with its stdout REDIRECTED to stderr for the duration of the call —
/// the stdout path line belongs to emit alone, even in-session. Any
/// non-"y" answer or EOF returns 0 with the intermediary untouched; the file
/// predates the prompt, so nothing is lost. `askFn` is the injection seam unit
/// tests use to script answers without a real terminal; production always uses the
/// real `ask` above.
export async function runTtySession(
  tmpPath: string,
  dest: string,
  lang: "en" | "ru",
  askFn: (prompt: string) => Promise<string | null> = ask,
): Promise<number> {
  for (;;) {
    if (!existsSync(tmpPath)) return 0; // consumed already — a racing apply, or a hand delete
    const { blocks } = parseInteract(readFileSync(tmpPath, "utf8"));
    if (!isGateChecked(blocks)) {
      const gateId = blocks.find((b) => b.kind === "confirm-all")?.id ?? "triage-final";
      const answer = await askFn(
        `gate '${gateId}' unchecked — check it in Obsidian, then press y to re-check [y/N] `,
      );
      if (!isYes(answer)) return 0;
      continue; // re-read before asking again — the tick is the file's, not the terminal's
    }
    const items = blocks.filter((b) => b.kind !== "confirm-all").flatMap((b) => b.items);
    const recovered = items.filter((it) => it.state === "checked" && it.verb === "recover").length;
    const kept = items.filter((it) => it.state === "checked" && it.verb === "keep").length;
    const removed = items.filter((it) => it.state === "unchecked").length;
    const answer = await askFn(
      `about to write: ${recovered} recovered · ${kept} kept · ${removed} removed → ${dest} — confirm [y/N] `,
    );
    if (!isYes(answer)) return 0;
    const realStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) =>
      process.stderr.write(chunk)) as typeof process.stdout.write;
    try {
      return await runApply(tmpPath, { lang });
    } finally {
      process.stdout.write = realStdoutWrite;
    }
  }
}
