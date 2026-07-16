// tty — the interactive terminal half of the pipeline: the emit->apply TTY session. Sugar over
// the pure triage.ts / apply-mode.ts machinery, driven only at a real terminal; a non-TTY caller
// never reaches here. `ask` is the readline round-trip; `askFn` is the injection seam tests
// script to answer without a terminal.
import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { type Block, parseInteract } from "@/distill/review/interact.ts";
import { runApply } from "@/distill/app/apply-mode.ts";

// The confirm-all gate-satisfied predicate: a document's gate is satisfied only when a
// confirm-all block exists AND has at least one item AND every item is checked (an empty
// confirm-all block never auto-satisfies). Both TTY loops below re-read the file on every
// iteration and re-derive this off the fresh parse, so it stays a pure function of the
// current blocks rather than cached state.
function isGateChecked(blocks: Block[]): boolean {
  const gate = blocks.find((b) => b.kind === "confirm-all");
  return (
    gate !== undefined && gate.items.length > 0 && gate.items.every((it) => it.state === "checked")
  );
}

// ---- TTY session (Phase 5): sugar over emit+apply, never a third code path ----

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

/// The gate-aware sugar loop: re-reads `tmpPath` from disk on every iteration (Sync may have
/// landed a cross-device edit between prompts), so it never asks a question the file itself
/// already answers. The confirm-all gate (triage.ts always names it "triage-final") unchecked
/// → a diagnosis prompt whose "y" only asks for a re-read, never substitutes for the tick; gate
/// fully checked → one count-confirm naming what apply is about to do, then `runApply` runs
/// in-process with its stdout REDIRECTED to stderr for the duration of the call — the stdout
/// path line belongs to emit alone, even in-session. Any non-"y" answer or EOF returns 0 with
/// the intermediary untouched; the file predates the prompt, so nothing is lost. `askFn` is the
/// injection seam unit tests use to script answers without a real terminal; production always
/// uses the real `ask` above.
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
