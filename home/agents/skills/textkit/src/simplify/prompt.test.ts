// simplify/prompt tests — the restyle prompt is frozen: the language-selected ruleset, the
// keep-verbatim and no-op clauses, the never-translate guard, and the strict seven-key JSON schema
// are all pinned. Pure, offline: no model call.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createMasker } from "textkit/core/writing/mask.ts";
import { sequenceScan } from "textkit/simplify/sequence.ts";
import { wordCapScan } from "textkit/simplify/wordcap.ts";
import {
  BRIEF_KEYS,
  capHint,
  resolveLang,
  shapeHint,
  SIMPLIFY_RULESET_EN,
  SIMPLIFY_RULESET_RU,
  simplifyPrompt,
} from "textkit/simplify/prompt.ts";

// The live-measurement fixture for the SHAPE member test. It is not read by any production code —
// it is the input the three-run measurement is taken over — so this suite pins the property that
// gives it its power. See the shapeHint note in prompt.ts for the runs it produced.
const SHAPE_FIXTURE = resolve(import.meta.dir, "fixtures", "shape-member-test.md");

test("simplifyPrompt: EN embeds the English ruleset, the schema, and the masked text", () => {
  const p = simplifyPrompt("A wordy ⟦0⟧ sentence.", "en");
  expect(p).toContain(SIMPLIFY_RULESET_EN);
  expect(p).not.toContain(SIMPLIFY_RULESET_RU);
  // the seven keys are all named in the JSON schema
  for (const k of BRIEF_KEYS) expect(p).toContain(`"${k}"`);
  // masked text is carried verbatim under a TEXT section
  expect(p).toContain("TEXT:\nA wordy ⟦0⟧ sentence.");
});

test("simplifyPrompt: RU swaps to the Russian ruleset, not a port of the English one", () => {
  const p = simplifyPrompt("Многословное ⟦0⟧ предложение.", "ru");
  expect(p).toContain(SIMPLIFY_RULESET_RU);
  expect(p).not.toContain(SIMPLIFY_RULESET_EN);
  // a Russian-specific mechanic the English rules never mention
  expect(p).toContain("«является»");
});

test("simplifyPrompt: the no-op clause and the never-translate guard are pinned in both languages", () => {
  for (const lang of ["en", "ru"] as const) {
    const p = simplifyPrompt("x ⟦0⟧ y", lang);
    // already-compliant text round-trips unchanged
    expect(p).toContain("If the text already satisfies every rule, change nothing");
    // a proofreader-style guard against translating code-switched clauses (polish's live-observed bug)
    expect(p).toContain("never translate");
    // reference spans are reproduced, not reworded
    expect(p).toContain("Reproduce every ⟦N⟧ placeholder token unchanged");
  }
});

test("simplifyPrompt: KEEP pins list kind, item count, split-within-item, and thematic breaks", () => {
  for (const lang of ["en", "ru"] as const) {
    const p = simplifyPrompt("x ⟦0⟧ y", lang);
    // the KEEP scaffolding is English and shared, so both languages carry the list guardrail
    expect(p).toContain("keep its kind (numbered stays numbered, bulleted stays bulleted)");
    expect(p).toContain("its item count");
    expect(p).toContain("never grow that list's item count");
    expect(p).toContain("never nest a new list under one");
    expect(p).toContain("thematic breaks (a `---` separator line)");
  }
});

test("KEEP scopes its list prohibition, so it no longer cancels SHAPE outright", () => {
  // The clause used to end "Never promote a sentence to a new list item" — meant to bound the
  // existing list in front of it, read as a flat ban among unqualified absolutes. A live pass on a
  // four-verb sentence then returned four sentences tagged `split` with `## Shape` empty: SHAPE
  // built nothing, ever. guard.ts had assumed the opposite the whole time, forgiving a grown item
  // count because "the SHAPE rule inflates a list on purpose".
  const p = simplifyPrompt("x ⟦0⟧ y", "en");
  expect(p).not.toContain("Never promote a sentence to a new list item");
  // the prohibition now names the list it governs, and KEEP hands SHAPE its remaining territory
  expect(p).toContain("SHAPE still governs prose OUTSIDE any list");
});

test("simplifyPrompt: KEEP fixes the heading count and forbids promotion to a heading", () => {
  for (const lang of ["en", "ru"] as const) {
    const p = simplifyPrompt("x ⟦0⟧ y", lang);
    // the heading guardrail is shared English KEEP scaffolding, so both languages carry it
    expect(p).toContain("Keep the heading count exact");
    expect(p).toContain("Never promote a bold lead, a question, or a sentence to a heading");
  }
});

test("simplifyPrompt: SHAPE is scoped to prose so it never over-splits an existing list", () => {
  // the SHAPE rule builds a list only from PROSE; both rulesets scope it to avoid the over-split
  expect(SIMPLIFY_RULESET_EN).toContain("turn a PROSE sequence or set into a vertical list");
  expect(SIMPLIFY_RULESET_EN).toContain("Keep an existing list's kind and item count");
  expect(SIMPLIFY_RULESET_EN).toContain("a list you build comes only from prose");
  expect(SIMPLIFY_RULESET_RU).toContain("В ПРОЗЕ");
  expect(SIMPLIFY_RULESET_RU).toContain("сохрани вид и число пунктов");
});

test("SHAPE names a countable trigger, so it competes with the cap it used to lose to", () => {
  // "a PROSE sequence" is a judgment standing next to "at most 20 words", which is a measurement.
  // The unmeasured rule lost every time. Both rulesets now define the threshold outright.
  expect(SIMPLIFY_RULESET_EN).toContain("three or more parallel actions");
  expect(SIMPLIFY_RULESET_EN).toContain("a pair stays prose");
  expect(SIMPLIFY_RULESET_RU).toContain("тремя и более параллельными действиями");
  expect(SIMPLIFY_RULESET_RU).toContain("пара остаётся прозой");
});

test("SHAPE binds the list's item count to the source's members, in both languages", () => {
  // A stated threshold was not enough: given a pair, the rule reached for a third member instead of
  // leaving prose alone. Across thirteen restyled notes it invented a consequence, split a
  // benefit/cost pair into flat siblings, and followed "fixes two things" with three bullets. So the
  // count is now a contract — one item per source member, and no member may be created or divided.
  expect(SIMPLIFY_RULESET_EN).toContain("exactly that many items, one per member");
  expect(SIMPLIFY_RULESET_EN).toContain("Never invent a member to reach three");
  expect(SIMPLIFY_RULESET_RU).toContain("ровно столько пунктов, по одному на член");
  expect(SIMPLIFY_RULESET_RU).toContain("Не придумывай член ради третьего пункта");
});

test("SHAPE excludes a relation, and holds a counting word to its count", () => {
  // The other half of the same failure: a contrast ("a live problem rather than a solved one") came
  // back as two flat bullets, and splitting a pair left "both facts" and "Both sides" pointing at
  // three and four items. A relation is not a sequence, and a counting word fixes the count.
  expect(SIMPLIFY_RULESET_EN).toContain("is a relation, not a sequence");
  expect(SIMPLIFY_RULESET_EN).toContain("keep that word and match its count");
  expect(SIMPLIFY_RULESET_RU).toContain("это отношение, а не перечисление");
  expect(SIMPLIFY_RULESET_RU).toContain("сохрани это слово и совпади с ним");
});

test("the SHAPE contract names the member test as a gate, everywhere it speaks, in both languages", () => {
  // The rule stated the test and still lost, because the test arrived as a DESCRIPTION while
  // shapeHint's worklist arrived as an imperative carrying a count. Measured on
  // fixtures/shape-member-test.md, where the scan confirms a relation ("Build the DSL outward from
  // the operations that consume it, not top-down as a taxonomy, or it becomes ornament") and a real
  // series at the same 3 members and cannot tell them apart: the relation was flattened into three
  // bullets in 2 of 3 live runs, once under an invented "Build the DSL in three ways:".
  //
  // So both halves must bind — three or more parallel members, ENUMERATING rather than relating —
  // in every place the contract speaks: the ruleset, KEEP, and both shapeHint branches. A half
  // stated in one place and dropped in another is what the model exploited, since a relation passes
  // the count on its own.
  const seq = { sentence: "x, y, and z.", members: 3 };
  const halves = {
    en: ["three or more parallel members", "enumerates rather than relates"],
    ru: ["три и более параллельных члена", "перечисляет, а не связывает"],
  } as const;
  for (const half of halves.en) expect(SIMPLIFY_RULESET_EN).toContain(half);
  for (const half of halves.ru) expect(SIMPLIFY_RULESET_RU).toContain(half);
  // stated as a gate with a build-only-on-pass condition, not as a description standing beside one
  expect(SIMPLIFY_RULESET_EN).toContain("build only where it passes both halves");
  expect(SIMPLIFY_RULESET_RU).toContain("строй список, только если он прошёл обе половины");
  // the reorder diagnostic, which is what makes "enumerates rather than relates" checkable
  expect(SIMPLIFY_RULESET_EN).toContain("Members enumerate when you can reorder them");
  expect(SIMPLIFY_RULESET_RU).toContain("Члены перечисляют, если их можно переставить местами");
  // KEEP restates SHAPE's territory, so it must restate BOTH halves — the count alone is what a
  // relation passes, and KEEP used to hand over the count and stop
  const keep = simplifyPrompt("x ⟦0⟧ y", "en");
  expect(keep).toContain("three or more parallel members that enumerate rather than relate");
  // and the hint, in both branches and both languages: the scan is declared blind to the second
  // half, so a confirmed candidate is a candidate rather than a licence to convert
  for (const hint of [shapeHint([], "en"), shapeHint([seq], "en")]) {
    expect(hint).toContain("passes the member test");
    expect(hint).toContain("enumerating rather than relating");
    expect(hint).toContain("cannot tell a member from a contrast or a consequence");
  }
  for (const hint of [shapeHint([], "ru"), shapeHint([seq], "ru")]) {
    expect(hint).toContain("прошло тест на члены");
    expect(hint).toContain("перечисление, а не связь");
    expect(hint).toContain("не отличит член от противопоставления или следствия");
  }
  // the worklist branch is the place the licence was issued, so it carries the gate too
  expect(shapeHint([seq], "en")).toContain("a confirmed count is no licence");
  expect(shapeHint([seq], "ru")).toContain("подтверждённый счёт права не даёт");
});

test("the SHAPE contract keeps a pair prose, and sends a long pair's split to sentences", () => {
  // The second specimen's defect is an INTERACTION, not a lone misreading: a 40-word sentence naming
  // two deferred strands (fetch adapters, card-collection hygiene) drew a capHint "split this", and
  // the model reached for a list to split into — twice in one note. Two members sit under the floor,
  // so naming where the split LANDS is what neither hint could say alone.
  expect(SIMPLIFY_RULESET_EN).toContain("a pair stays prose however long the sentence runs");
  expect(SIMPLIFY_RULESET_EN).toContain("never into a two-item list");
  expect(SIMPLIFY_RULESET_RU).toContain("пара остаётся прозой, какой бы длинной ни была фраза");
  expect(SIMPLIFY_RULESET_RU).toContain("а не на список из двух пунктов");
  for (const hint of [
    shapeHint([], "en"),
    shapeHint([{ sentence: "x, y, and z.", members: 3 }], "en"),
  ])
    expect(hint).toContain("never into a two-item list");
  for (const hint of [
    shapeHint([], "ru"),
    shapeHint([{ sentence: "х, у и я.", members: 3 }], "ru"),
  ])
    expect(hint).toContain("а не на список из двух пунктов");
  // KEEP carries the floor as well, so its restatement cannot license what SHAPE forbids
  expect(simplifyPrompt("x ⟦0⟧ y", "en")).toContain(
    "Two members is a pair, and a pair stays prose",
  );
  // a counting word the source never had is a manufactured member by another route — one live run
  // led its three bullets with "Build the DSL in three ways:", a phrase no source sentence states
  expect(SIMPLIFY_RULESET_EN).toContain("never add a counting word the source does not have");
  expect(SIMPLIFY_RULESET_RU).toContain("не добавляй счёт, которого в источнике нет");
});

test("the SHAPE fixture holds a relation and a series the scan cannot tell apart", () => {
  // The fixture is a single-differing-factor comparison, and this test is what keeps it one. Both
  // specimens must reach the model on the SAME worklist at the SAME count, so the only thing that
  // can separate them is the member test. A fixture edit that drops either from the worklist, or
  // that splits their counts, turns a passing three-run measurement into a measurement of nothing.
  const { mask } = createMasker();
  const masked = mask(readFileSync(SHAPE_FIXTURE, "utf8"));
  const confirmed = sequenceScan(masked);
  expect(confirmed).toHaveLength(2);
  expect(confirmed.map((f) => f.members)).toEqual([3, 3]);
  const sentences = confirmed.map((f) => f.sentence);
  // the relation: a contrast and its consequence, which must stay prose despite being confirmed
  expect(sentences).toContain(
    "Build the DSL outward from the operations that consume it, not top-down as a taxonomy, or it becomes ornament.",
  );
  // the positive control: three parallel enumerated members, which must still convert. It guards
  // the failure mode of the first revision of this rule, which killed SHAPE outright while looking
  // like a fix for the over-building.
  expect(sentences).toContain(
    "The scan strips fenced code, skips every list item, and measures both delimiters.",
  );
  // the pair specimen is a PAIR, so the scan confirms nothing in it — its pressure comes from the
  // length hint instead, which is the interaction that produced its two-item list
  const pair = wordCapScan(masked);
  expect(pair).toHaveLength(1);
  expect(pair[0]!.sentence).toContain("fetch adapters");
  expect(pair[0]!.sentence).toContain("card-collection hygiene");
  expect(pair[0]!.words).toBeGreaterThan(20);
  // and it reaches the model as prose only: no list markers anywhere in the source, so every list
  // block the guard's SHORT reading sees in a rewrite is one the restyle built
  expect(masked).not.toMatch(/^\s*(?:[-*+]\s|\d+[.)]\s)/m);
});

test("simplifyPrompt: neither the ruleset nor the schema invites adding a heading", () => {
  // KEEP forbids new headings, so no lingering clause may invite one — that contradiction fed the
  // observed heading-inflation drift (a PR body's two headings became six).
  expect(SIMPLIFY_RULESET_EN).not.toContain("Add a heading");
  expect(SIMPLIFY_RULESET_RU).not.toContain("Заголовок для темы");
  const p = simplifyPrompt("x ⟦0⟧ y", "en");
  expect(p).not.toContain("a topic heading added"); // the schema's `shape` hint no longer suggests it
});

test("MEANING pins claim force in both languages — the one drift every swept model showed", () => {
  // Live sweep finding: nearly every restyle model softened "A live run PROVED the gap" to "showed"
  // or "found". Tense/mood/polarity all survived, so the existing MEANING clause never caught it —
  // the weakened verb is a claim-force shift, a fourth axis the rule now names outright.
  expect(SIMPLIFY_RULESET_EN).toContain("Keep each claim's FORCE");
  expect(SIMPLIFY_RULESET_EN).toContain("Never trade a strong verb for a weaker one");
  expect(SIMPLIFY_RULESET_RU).toContain("Сохрани СИЛУ каждого утверждения");
  for (const lang of ["en", "ru"] as const)
    expect(simplifyPrompt("x ⟦0⟧ y", lang)).toContain(lang === "ru" ? "СИЛУ" : "FORCE");
});

test("RELEVANCE bounds the cut to restatement, so a substantive sentence survives", () => {
  // Live sweep finding: qwen-flash and glm-5.2 each DELETED a load-bearing sentence outright, and
  // both briefs still printed "All checks passed" — no deterministic axis sees a dropped claim. The
  // cut licence is now bounded, and the keep is stated positively.
  expect(SIMPLIFY_RULESET_EN).toContain("Cut a sentence ONLY when it restates");
  expect(SIMPLIFY_RULESET_EN).toContain("Keep every sentence that carries its own claim");
  expect(SIMPLIFY_RULESET_RU).toContain("ТОЛЬКО если оно повторяет");
  expect(SIMPLIFY_RULESET_RU).toContain("Сохрани каждое предложение со своим утверждением");
  // the blanket licence that invited the deletion is gone
  expect(SIMPLIFY_RULESET_EN).not.toContain("cut the rest");
});

test("capHint: names each over-cap offender with its count, or nothing when the source is clean", () => {
  // empty in → no hint, so a within-cap source leaves the no-op clause to govern alone
  expect(capHint([], "en")).toBe("");
  const over = [
    { sentence: "A very long first offender that runs well past the cap here.", words: 24 },
    { sentence: "A second offender that also exceeds the twenty-word limit by a bit.", words: 22 },
  ];
  const en = capHint(over, "en");
  expect(en).toContain("LENGTH CHECK");
  expect(en).toContain("20-word cap"); // WORD_CAP surfaced in the instruction
  expect(en).toContain("(24 words) A very long first offender"); // the offender, with its count
  expect(en).toContain("note it in `borderline`"); // framed as candidates, not commands
});

test("capHint: the Russian hint uses Russian framing, not a port of the English one", () => {
  const ru = capHint([{ sentence: "Очень длинное предложение источника здесь.", words: 21 }], "ru");
  expect(ru).toContain("ПРОВЕРКА ДЛИНЫ");
  expect(ru).toContain("«borderline»");
  expect(ru).not.toContain("LENGTH CHECK");
});

test("simplifyPrompt: over-cap findings ride into the prompt; a clean source carries no hint", () => {
  const offender = { sentence: "This one sentence is deliberately over the cap.", words: 21 };
  const withHint = simplifyPrompt("x ⟦0⟧ y", "en", [offender]);
  expect(withHint).toContain("LENGTH CHECK");
  expect(withHint).toContain("This one sentence is deliberately over the cap.");
  // the default (no third arg) omits the block entirely — no dangling "LENGTH CHECK" scaffolding
  expect(simplifyPrompt("x ⟦0⟧ y", "en")).not.toContain("LENGTH CHECK");
});

test("shapeHint: names each confirmed sentence, and states the scan's reach as a floor", () => {
  const seqs = [{ sentence: "It reads, extracts, classifies, and verdicts.", members: 4 }];
  const en = shapeHint(seqs, "en");
  expect(en).toContain("SHAPE CHECK");
  expect(en).toContain("3 or more grammatically parallel members"); // SEQ_MIN surfaced
  expect(en).toContain("(4 members) It reads, extracts, classifies, and verdicts.");
  expect(en).toContain("The scan confirmed these sentences");
  expect(en).toContain("one item per source member");
  // the reported count runs high when the last member is itself a series, so it is a floor to check,
  // never the item count to build to
  expect(en).toContain("recount before you build");
  // a decline needs a REASON, because a sequence is often right left as prose — the enumeration may
  // already appear nearby as a diagram or a table, which the scan cannot see
  expect(en).toContain("`borderline` with the reason");
  // a list that repeats a frozen span is a hard apply-gate block, so it declines instead
  expect(en).toContain("repeat a ⟦N⟧ token");
  // NOT closed. The worklist was "Convert no other sentence" and that banned Russian outright — no
  // Russian comma series is ever confirmed, so the closed form suppressed the rule wholesale there.
  expect(en).toContain("a floor, not a boundary");
  expect(en).not.toContain("Convert no other sentence");
});

test("shapeHint: a source with no confirmed sequence gets the scan's limits, not a ban", () => {
  // shapeHint still departs from capHint by always riding: an absent LENGTH finding means nothing to
  // split, while SHAPE silence would leave the ruleset's rule standing alone as an unbounded
  // principle. What it must NOT do is claim the source has no sequence — the scan reads two forms,
  // and a source may enumerate in a third.
  const en = shapeHint([], "en");
  expect(en).toContain("The scan confirmed no such sentence");
  expect(en).toContain("a floor, not a boundary");
  expect(en).not.toContain("build no new list");
  const ru = shapeHint([], "ru");
  expect(ru).toContain("не подтвердила ни одного такого предложения");
  expect(ru).not.toContain("новых списков не строй");
  expect(ru).not.toContain("SHAPE CHECK");
});

test("shapeHint: the Russian hint uses Russian framing, not a port of the English one", () => {
  const ru = shapeHint([{ sentence: "Он читает, разбирает и решает.", members: 3 }], "ru");
  expect(ru).toContain("ПРОВЕРКА ФОРМЫ");
  expect(ru).toContain("«borderline»");
  expect(ru).toContain("Эти предложения проверка подтвердила");
  expect(ru).not.toContain("SHAPE CHECK");
});

test("shapeHint: both languages carry the same contract, in both branches", () => {
  // The scan reaches Russian less far, because Russian writes «А, Б и В» with no comma before "и" and
  // the series form requires that comma. That is a fact about what the scan CONFIRMS, so it must not
  // leak into what the two contracts PERMIT — a per-language ban would make the tool behave
  // differently by language. Every invariant clause therefore appears in all four hints.
  const seq = { sentence: "x, y, and z.", members: 3 };
  const clauses = {
    en: [
      "a floor, not a boundary",
      "grammatically parallel",
      "is a relation, so keep it prose",
      "Never invent a member",
      "`borderline` with the reason",
    ],
    ru: [
      "нижняя граница, а не предел",
      "грамматически параллельных",
      "это отношение, поэтому оставь его прозой",
      "Не придумывай член",
      "«borderline» с причиной",
    ],
  } as const;
  for (const lang of ["en", "ru"] as const)
    for (const hint of [shapeHint([], lang), shapeHint([seq], lang)])
      for (const clause of clauses[lang]) expect(hint).toContain(clause);
});

test("simplifyPrompt: both pre-hints ride, and only the length one is gated on findings", () => {
  const overCap = { sentence: "This one sentence is deliberately over the cap.", words: 21 };
  const seq = { sentence: "It reads, extracts, and verdicts.", members: 3 };
  const both = simplifyPrompt("x ⟦0⟧ y", "en", [overCap], [seq]);
  expect(both).toContain("LENGTH CHECK");
  expect(both).toContain("The scan confirmed these sentences");
  // LENGTH is gated: a source within the cap gets no length block, and no dangling scaffolding
  const shapeOnly = simplifyPrompt("x ⟦0⟧ y", "en", [], [seq]);
  expect(shapeOnly).not.toContain("LENGTH CHECK");
  // SHAPE always rides. With no sequences it reports what the scan could not confirm, because that
  // report is what bounds the rule — silence would leave it an unbounded principle
  const noSeq = simplifyPrompt("x ⟦0⟧ y", "en", [overCap]);
  expect(noSeq).toContain("LENGTH CHECK");
  expect(noSeq).toContain("The scan confirmed no such sentence");
  expect(noSeq).not.toContain("The scan confirmed these sentences");
});

test("resolveLang: auto-detects by script, and an explicit override wins", () => {
  expect(resolveLang("auto", "plain english prose here")).toBe("en");
  expect(resolveLang("auto", "обычный русский текст здесь")).toBe("ru");
  expect(resolveLang("ru", "english body")).toBe("ru"); // override beats detection
  expect(resolveLang("en", "русское тело")).toBe("en");
});
