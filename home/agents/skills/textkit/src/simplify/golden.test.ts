// simplify/golden — the map's closing checklist, on two realistic fixtures. One English note and
// one Russian note run end-to-end through runSimplify with an injected `ask` fake (no network), so
// the map's three test done-conditions are asserted together, in one named place, instead of
// scattered across the per-module suites:
//   1. the CLI restyles a fixture note end-to-end into a valid brief — the seven `##` sections plus
//      `## guard`,
//   2. every masked reference span survives the rewrite unchanged — wikilink, embed, inline code,
//   3. the guard flags an introduced name typo on the fixture — in EN and in RU.
// The fake echoes the masked body back (a faithful no-op restyle), so mask survival and the guard
// run on genuine ⟦N⟧ tokens; a sabotage variant perturbs one span to drive done-condition 3.
// Offline.
import { expect, test } from "bun:test";
import { askJson } from "@skills/llm/llm.ts";
import { runSimplify } from "textkit/simplify/simplify.ts";

// The masked body the prompt carries (everything after the TEXT: marker). The fakes derive the
// rewrite from THIS, so ⟦N⟧ survival and the guard are exercised on real masking, not a literal.
const maskedOf = (prompt: string): string => prompt.split("TEXT:\n")[1]!;

// An ask fake returning a seven-key brief whose `rewrite` derives from the masked prompt body;
// `seen` captures the prompt so a test can assert which ruleset the language router picked.
const fakeAsk = (
  rewrite: (masked: string) => string,
  seen?: (prompt: string) => void,
): typeof askJson =>
  (async (_model: unknown, prompt: string) => {
    seen?.(prompt);
    return {
      verdict: "ok",
      cut: [],
      change: [],
      shape: [],
      keep: [],
      borderline: [],
      rewrite: rewrite(maskedOf(prompt)),
    };
  }) as unknown as typeof askJson;

const echo = (m: string): string => m; // a faithful no-op restyle

// A representative English vault note: frontmatter, a heading, a wikilink, an inline-code span, an
// embed, and a fenced code block — every span kind the masker and the guard axes read. One proper
// name (Levenshtein) sits in body prose, the only place the name axis inspects. Every sentence
// stays under the 20-word cap, so a faithful echo passes every axis clean.
const EN = `---
title: Edit distance
tags: [algorithms]
---

# Edit distance

We compute the Levenshtein distance between two strings. See the [[edit-distance]] note.

The core step uses the \`wagner-fischer\` recurrence. The grid is in ![[dp-grid.png]].

The recurrence has three moves:

1. Delete a character.
2. Insert a character.
3. Substitute a character.

\`\`\`ts
const cost = a === b ? 0 : 1;
\`\`\``;

// A representative Russian vault note: it must auto-route to the RU ruleset (Cyrillic prose), and
// carries the same span kinds plus a Cyrillic proper name (Левенштейна) in body prose for the name
// axis. Sentences stay under the cap.
const RU = `---
title: Расстояние
---

# Расстояние

Мы считаем расстояние Левенштейна между строками. Смотри заметку [[глоссарий]].

Ядро использует флаг \`--tau\` здесь. Схема в ![[сетка.png]].

\`\`\`ts
const cost = 1;
\`\`\``;

const SECTIONS = [
  "## verdict",
  "## cut",
  "## change",
  "## shape",
  "## keep",
  "## borderline",
  "## rewrite",
  "## guard",
];

test("golden EN: a faithful restyle yields a valid brief with every masked span restored", async () => {
  const out = await runSimplify(EN, { lang: "auto" }, { ask: fakeAsk(echo) });
  // done-condition 1: a valid brief end-to-end — the seven sections plus the guard.
  for (const h of SECTIONS) expect(out).toContain(h);
  // done-condition 2: every masked reference span survives the rewrite unchanged.
  expect(out).toContain("[[edit-distance]]");
  expect(out).toContain("![[dp-grid.png]]");
  expect(out).toContain("`wagner-fischer`");
  // the fenced code block round-trips and the guard passes every axis.
  expect(out).toContain("const cost = a === b ? 0 : 1;");
  expect(out).toContain("## guard\n\nAll checks passed.");
  // the original frontmatter is prepended to the rewrite verbatim.
  expect(out).toContain("---\ntitle: Edit distance\ntags: [algorithms]\n---");
  // the numbered list keeps its kind and its three items — the list axis stays clean.
  expect(out).toContain("1. Delete a character.");
  expect(out).toContain("3. Substitute a character.");
});

test("golden EN: over-splitting the numbered list into bullets flips the guard's list axis", async () => {
  // done-condition: the model turns the 3-item numbered list into bullets; the list axis flags it
  // (advisory — the brief is still produced, the human decides).
  const flipToBullets = (m: string): string =>
    m
      .replace(/^\d+\. /gm, "- ")
      .replace("Substitute a character.", "Substitute a character.\n- And more.");
  const out = await runSimplify(EN, { lang: "auto" }, { ask: fakeAsk(flipToBullets) });
  expect(out).toContain("- lists: FLIP");
  expect(out).toContain("## rewrite"); // advisory — the brief is still produced
});

test("golden EN: an introduced name typo is flagged by the guard against the source", async () => {
  // done-condition 3: the model drops the 'h' from Levenshtein; the guard's name axis catches it.
  const out = await runSimplify(
    EN,
    { lang: "auto" },
    { ask: fakeAsk((m) => m.replace("Levenshtein", "Levenstein")) },
  );
  expect(out).toContain("- names:");
  expect(out).toContain("Levenstein ← Levenshtein");
  expect(out).toContain("## rewrite"); // advisory — the brief is still produced
});

test("golden EN: a statement recast as a command is flagged by the advisory meaning axis", async () => {
  // done-condition: the restyle recasts a narrative statement as a command; the meaning axis runs
  // one model call over the `change` pair and flags it, advisory — the brief is still produced.
  // One `ask` fake serves both prompts: the restyle prompt yields the seven-key brief with a recast
  // change pair; the meaning prompt (carrying "PAIRS:") yields the judge's verdict.
  const ask: typeof askJson = (async (_model: unknown, prompt: string) => {
    if (prompt.includes("PAIRS:"))
      return { findings: [{ index: 0, issue: "statement recast as a command" }] };
    return {
      verdict: "recast a statement as a command",
      cut: [],
      change: [
        {
          before: "We compute the Levenshtein distance.",
          after: "Compute the Levenshtein distance.",
          transform: "active",
          why: "imperative",
        },
      ],
      shape: [],
      keep: [],
      borderline: [],
      rewrite: maskedOf(prompt), // faithful masked echo, so only the meaning axis fires
    };
  }) as unknown as typeof askJson;
  const out = await runSimplify(EN, { lang: "auto" }, { ask });
  expect(out).toContain("- meaning: 1 pair(s) shifted the speech act");
  expect(out).toContain("statement recast as a command");
  expect(out).not.toContain("All checks passed."); // a meaning finding drops the pass line
  expect(out).toContain("## rewrite"); // advisory — the brief is still produced
});

test("golden RU: a Russian note routes to the RU ruleset and preserves Cyrillic spans", async () => {
  let prompt = "";
  const out = await runSimplify(
    RU,
    { lang: "auto" },
    {
      ask: fakeAsk(echo, (p) => {
        prompt = p;
      }),
    },
  );
  expect(prompt).toContain("«является»"); // detectLang → ru selected the Russian ruleset
  // done-condition 2, Cyrillic: every masked reference span survives.
  expect(out).toContain("[[глоссарий]]");
  expect(out).toContain("![[сетка.png]]");
  expect(out).toContain("`--tau`");
  expect(out).toContain("## guard\n\nAll checks passed.");
});

test("golden RU: an introduced Cyrillic name typo is flagged by the guard", async () => {
  // done-condition 3, Cyrillic: swap one letter of Левенштейна; name-lint is Unicode-aware.
  const out = await runSimplify(
    RU,
    { lang: "auto" },
    { ask: fakeAsk((m) => m.replace("Левенштейна", "Левенштайна")) },
  );
  expect(out).toContain("- names:");
  expect(out).toContain("Левенштайна ← Левенштейна");
});
