// cards/stage.test.ts — pins the W5 staging writer (renderStagingFile) and the
// card-stage CLI's flow function (stageNote) against injected fakes. Run scoped:
// `bun test cards/stage.test.ts` from the distill dir (bare `bun test` picks up
// sibling in-progress files — see brief). No real vault-query spawn, no real
// Fireworks call, no real filesystem write anywhere in this file.
import { expect, test } from "bun:test";
import { EXTRACT, FIDELITY, TransientError, TruncationError } from "../fw.ts";
import { relText, slugSegment } from "../text.ts";
import {
  formatDryRunReport,
  formatSummary,
  stageNote,
  unwrapResult,
  type AskFn,
  type FetchNeighboursFn,
  type WriteFn,
} from "./card-stage.ts";
import { renderStagingFile } from "./stage.ts";
import type { BandVerdict, Candidate, NeighbourHit, StagingRecord } from "./types.ts";

// ---- renderStagingFile ----

const candidate: Candidate = {
  arm: "concept",
  term: "Legacy code",
  def: "Code without tests.",
  relations: [
    { rel: "subsumes", to: "old-code", predicate: "a broader framing" },
    { rel: "made-up-rel", to: "risk", predicate: null },
  ],
  sourceNote: "/abs/vault/00 inbox/note.md",
};

const hits: NeighbourHit[] = [
  {
    path: "20 cards/Legacy code.md",
    title: "Legacy code",
    score: 12,
    description: "Code with no tests.",
    snippet: "snippet text",
  },
];

const verdict: BandVerdict = { band: "mint", rationale: "close but not identical", nearest: hits };

function record(overrides: Partial<StagingRecord> = {}): StagingRecord {
  return {
    candidate,
    verdict,
    edges: [
      { rel: "subsumes", to: "old-code", predicate: "a broader framing", offRegistry: false },
      { rel: "made-up-rel", to: "risk", predicate: null, offRegistry: true },
    ],
    flags: [],
    lang: "en",
    draft: "Code lacking tests.\n\nBody prose.",
    ...overrides,
  };
}

test("renderStagingFile: every header field is present", () => {
  const { filename, content } = renderStagingFile(record(), "My Note");
  expect(filename).toBe(`${slugSegment("My Note")}--${slugSegment("Legacy code")}.md`);
  expect(content).toContain("# Legacy code");
  expect(content).toContain("## Review");
  expect(content).toContain("- **Arm:** concept");
  expect(content).toContain("- **Band:** mint — close but not identical");
  expect(content).toContain("Legacy code — Code with no tests. — `20 cards/Legacy code.md`");
  expect(content).toContain(
    relText({ rel: "subsumes", to: "old-code", predicate: "a broader framing" }),
  );
  expect(content).toContain("- **Flags:** (none)");
  expect(content).toContain(`[${candidate.sourceNote}](<${candidate.sourceNote}>)`);
  expect(content).toContain("## On commit");
  expect(content).toContain("- [ ] Rewrite the draft in your own words");
  expect(content).toContain("- [ ] Add the `reference:` backlink");
  expect(content).toContain("- [ ] Move to `20 cards/`");
  expect(content).toContain("- [ ] If the draft names a split, split first");
  expect(content).toContain("---");
  expect(content).toContain("Code lacking tests.\n\nBody prose.");
});

test("renderStagingFile: verdict-null renders the judge-inconclusive notice, no neighbours block", () => {
  const { content } = renderStagingFile(
    record({ verdict: null, flags: ["judge-inconclusive"] }),
    "My Note",
  );
  expect(content).toContain(
    "- **Band:** judge-inconclusive (flagged — the judge returned no usable verdict)",
  );
  expect(content).not.toContain("Neighbours (as the judge saw them)");
  expect(content).toContain("- **Flags:** judge-inconclusive");
});

test("renderStagingFile: off-registry marker attaches only to the flagged edge", () => {
  const { content } = renderStagingFile(record(), "My Note");
  const lines = content.split("\n");
  const madeUpLine = lines.find((l) => l.includes("made-up-rel"));
  const subsumesLine = lines.find((l) => l.includes("subsumes ::"));
  expect(madeUpLine).toContain("[off-registry]");
  expect(subsumesLine).not.toContain("[off-registry]");
});

test("renderStagingFile: the blanket uncertified notice appears whenever there are edges", () => {
  const { content } = renderStagingFile(record(), "My Note");
  expect(content).toContain(
    "All relations above are UNCERTIFIED leads (parsed off the source note, never re-verified) — check each against the source before trusting it.",
  );
});

test("renderStagingFile: no edges renders '(none)' without the uncertified notice", () => {
  const { content } = renderStagingFile(record({ edges: [] }), "My Note");
  expect(content).toContain("- **Relations (UNCERTIFIED leads):** (none)");
  expect(content).not.toContain("check each against the source before trusting it");
});

test("renderStagingFile: Cyrillic note name and term slug into the filename", () => {
  const cyr: Candidate = { ...candidate, term: "Пример" };
  const { filename } = renderStagingFile(record({ candidate: cyr }), "Заметка");
  expect(filename).toBe("заметка--пример.md");
});

test("renderStagingFile: empty draft renders the draft-failed notice", () => {
  const { content } = renderStagingFile(record({ draft: "", flags: ["draft-failed"] }), "My Note");
  expect(content).toContain(
    "_Draft failed — the writer call did not return usable content. Draft this card manually from the candidate above._",
  );
});

// Pins Finding 1: two candidates whose (noteName, term) pairs slug to the SAME base
// filename — a thesis candidate's term equals the note's H1 title, exactly the
// collision the finding names — must still land on two distinct filenames when threaded
// through one shared `used` Set, the way card-stage.ts's stageNote loop threads it.
test("renderStagingFile: a thesis term colliding with a same-note concept term dedupes via a shared `used` set", () => {
  const used = new Set<string>();
  const concept: Candidate = { ...candidate, arm: "concept", term: "Legacy code" };
  const thesis: Candidate = { ...candidate, arm: "thesis", term: "Legacy code" };
  const first = renderStagingFile(record({ candidate: concept }), "Legacy code", used);
  const second = renderStagingFile(record({ candidate: thesis }), "Legacy code", used);
  expect(first.filename).toBe("legacy-code--legacy-code.md");
  expect(second.filename).toBe("legacy-code--legacy-code-2.md");
  expect(first.filename).not.toBe(second.filename);
});

// Case/punctuation variants ("Alpha" vs "alpha") slug identically and must dedupe too.
test("renderStagingFile: case-variant terms that slug identically also dedupe", () => {
  const used = new Set<string>();
  const upper: Candidate = { ...candidate, term: "Alpha" };
  const lower: Candidate = { ...candidate, term: "alpha" };
  const first = renderStagingFile(record({ candidate: upper }), "My Note", used);
  const second = renderStagingFile(record({ candidate: lower }), "My Note", used);
  expect(first.filename).not.toBe(second.filename);
});

// ---- stageNote flow ----

// alpha (concept, relates to beta by subsumes) + beta (concept, no relations) +
// "My Note" (thesis, from the frontmatter description) — 3 candidates total.
const NOTE_MD = [
  "---",
  "description: The unifying thesis of the note.",
  "---",
  "# My Note",
  "",
  "## Glossary",
  "",
  "| Term | Definition |",
  "| ---- | ---------- |",
  "| alpha | def a |",
  "| beta | def b |",
  "",
  "## Relations",
  "",
  "- alpha subsumes:: beta",
  "",
].join("\n");

const okNoHits: FetchNeighboursFn = async () => ({ hits: [], ok: true });

function recordingWriteFile(): { writeFile: WriteFn; calls: { path: string; content: string }[] } {
  const calls: { path: string; content: string }[] = [];
  const writeFile: WriteFn = async (path, content) => {
    calls.push({ path, content });
  };
  return { writeFile, calls };
}

const STAGE_OPTS = {
  vaultRoot: "/vault",
  stagingDir: "/vault/00 inbox/card-staging",
  topK: 5,
  dryRun: false,
};

test("stageNote: a transient band-judge failure degrades to judge-inconclusive; drafting still runs", async () => {
  const { writeFile, calls } = recordingWriteFile();
  const ask: AskFn = (async (model: string) => {
    if (model === FIDELITY) throw new TransientError("flaky judge");
    return { draft: "A draft." };
  }) as AskFn;
  const result = await stageNote(NOTE_MD, "/abs/note.md", STAGE_OPTS, {
    ask,
    fetchNeighbours: okNoHits,
    writeFile,
  });
  expect(result.mode).toBe("staged");
  if (result.mode !== "staged") throw new Error("unreachable");
  expect(result.total).toBe(3);
  expect(result.staged).toBe(3);
  expect(result.flagCounts["judge-inconclusive"]).toBe(3);
  expect(result.flagCounts["draft-failed"]).toBeUndefined();
  expect(calls).toHaveLength(3);
  for (const c of calls) expect(c.content).toContain("judge-inconclusive");
});

test("stageNote: a truncation on the draft call degrades to draft-failed; the band verdict still lands", async () => {
  const { writeFile, calls } = recordingWriteFile();
  const ask: AskFn = (async (model: string) => {
    if (model === FIDELITY) return { band: "mint", rationale: "close" };
    if (model === EXTRACT) throw new TruncationError("cap hit");
    throw new Error(`unexpected model ${model}`);
  }) as AskFn;
  const result = await stageNote(NOTE_MD, "/abs/note.md", STAGE_OPTS, {
    ask,
    fetchNeighbours: okNoHits,
    writeFile,
  });
  expect(result.mode).toBe("staged");
  if (result.mode !== "staged") throw new Error("unreachable");
  expect(result.staged).toBe(3);
  expect(result.flagCounts["draft-failed"]).toBe(3);
  expect(result.flagCounts["judge-inconclusive"]).toBeUndefined();
  for (const c of calls) expect(c.content).toContain("draft-failed");
});

test("stageNote: a non-transient error from the band judge propagates instead of degrading", async () => {
  const ask: AskFn = (async (model: string) => {
    if (model === FIDELITY) throw new Error("bad request: 400 content policy");
    return { draft: "d" };
  }) as AskFn;
  const { writeFile } = recordingWriteFile();
  await expect(
    stageNote(NOTE_MD, "/abs/note.md", STAGE_OPTS, { ask, fetchNeighbours: okNoHits, writeFile }),
  ).rejects.toThrow("bad request");
});

test("stageNote: every enumerated candidate produces exactly one staged file even when every LLM call fails", async () => {
  const { writeFile, calls } = recordingWriteFile();
  const ask: AskFn = (async () => {
    throw new TransientError("down");
  }) as AskFn;
  const result = await stageNote(NOTE_MD, "/abs/note.md", STAGE_OPTS, {
    ask,
    fetchNeighbours: okNoHits,
    writeFile,
  });
  expect(result.mode).toBe("staged");
  if (result.mode !== "staged") throw new Error("unreachable");
  expect(result.total).toBe(3);
  expect(result.staged).toBe(3);
  expect(result.flagCounts["judge-inconclusive"]).toBe(3);
  expect(result.flagCounts["draft-failed"]).toBe(3);
  expect(calls).toHaveLength(3);
  expect(new Set(calls.map((c) => c.path)).size).toBe(3);
});

// Pins Finding 1 end-to-end through stageNote (not just renderStagingFile in isolation):
// the note's H1 title is "Legacy code" and its glossary also carries a term "Legacy code"
// — the exact collision named in the finding, since the thesis candidate's term IS the
// title. Before the fix, both candidates' filenames were identical and the second
// `writeFile` call clobbered the first while `staged` still counted both.
test("stageNote: a thesis term colliding with a glossary term still produces one staged file per candidate", async () => {
  const collidingNote = [
    "---",
    "description: The unifying thesis of the note.",
    "---",
    "# Legacy code",
    "",
    "## Glossary",
    "",
    "| Term | Definition |",
    "| ---- | ---------- |",
    "| Legacy code | code without tests |",
    "",
  ].join("\n");
  const { writeFile, calls } = recordingWriteFile();
  const ask: AskFn = (async () => {
    throw new TransientError("down");
  }) as AskFn;
  const result = await stageNote(collidingNote, "/abs/legacy-code.md", STAGE_OPTS, {
    ask,
    fetchNeighbours: okNoHits,
    writeFile,
  });
  expect(result.mode).toBe("staged");
  if (result.mode !== "staged") throw new Error("unreachable");
  expect(result.total).toBe(2);
  expect(result.staged).toBe(2);
  expect(calls).toHaveLength(2);
  expect(new Set(calls.map((c) => c.path)).size).toBe(2);
});

test("stageNote: --dry-run enumerates and fetches neighbours only, writes nothing, calls no ask fake", async () => {
  let askCalls = 0;
  const ask: AskFn = (async () => {
    askCalls++;
    throw new Error("ask must not be called in --dry-run");
  }) as AskFn;
  let writeCalls = 0;
  const writeFile: WriteFn = async () => {
    writeCalls++;
  };
  let fetchCalls = 0;
  const fetchNeighbours: FetchNeighboursFn = async () => {
    fetchCalls++;
    return {
      hits: [{ path: "20 cards/X.md", title: "X", score: 1, description: "d", snippet: "s" }],
      ok: true,
    };
  };
  const result = await stageNote(
    NOTE_MD,
    "/abs/note.md",
    { ...STAGE_OPTS, dryRun: true },
    { ask, fetchNeighbours, writeFile },
  );
  expect(result.mode).toBe("dry-run");
  if (result.mode !== "dry-run") throw new Error("unreachable");
  expect(result.total).toBe(3);
  expect(result.entries).toHaveLength(3);
  expect(result.entries.every((e) => e.neighbourCount === 1 && e.neighboursOk)).toBe(true);
  const alpha = result.entries.find((e) => e.term === "alpha");
  expect(alpha?.edgeCount).toBe(1);
  expect(alpha?.offRegistryCount).toBe(0);
  expect(askCalls).toBe(0);
  expect(writeCalls).toBe(0);
  expect(fetchCalls).toBe(3);
});

// ---- pure stdout formatting ----

test("formatDryRunReport: one line per candidate, term/arm/neighbours/edges all present", () => {
  const report = formatDryRunReport([
    {
      term: "alpha",
      arm: "concept",
      neighbourCount: 2,
      neighboursOk: true,
      edgeCount: 1,
      offRegistryCount: 0,
    },
  ]);
  expect(report).toContain("alpha [concept]");
  expect(report).toContain("neighbours: 2 (ok=true)");
  expect(report).toContain("edges: 1 (0 off-registry)");
});

test("formatSummary: staged/total plus per-flag counts", () => {
  expect(formatSummary(3, 3, { "judge-inconclusive": 1, "draft-failed": 2 })).toBe(
    "staged 3/3 · judge-inconclusive: 1, draft-failed: 2",
  );
  expect(formatSummary(2, 2, {})).toBe("staged 2/2");
});

test("unwrapResult: a distill <result> envelope unwraps to its payload; a bare note passes through", () => {
  const note = "---\ndescription: the tie\n---\n\n# T\n\nbody";
  expect(unwrapResult(`<result>\n${note}</result>\n<residue><entry/></residue>`)).toBe(`${note}`);
  expect(unwrapResult(note)).toBe(note);
});

test("stageNote: a wrapped note still yields the thesis candidate from the enveloped frontmatter", async () => {
  const note = "---\ndescription: the tie\n---\n\n# T\n\n## Glossary\n\n| Term | Definition |\n| ---- | ---------- |\n| alpha | first |";
  const res = await stageNote(`<result>\n${note}</result>`, "/x/T.md", { vaultRoot: "/v", stagingDir: "/s", topK: 5, dryRun: true }, {
    ask: async () => { throw new Error("dry-run must not ask"); },
    fetchNeighbours: async () => ({ hits: [], ok: true }),
    writeFile: async () => { throw new Error("dry-run must not write"); },
  });
  if (res.mode !== "dry-run") throw new Error("expected dry-run");
  expect(res.entries.map((e) => e.arm).sort()).toEqual(["concept", "thesis"]);
});
