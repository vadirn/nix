// parse-projection.test.ts — round-trip tests for parseCanonicalNote (the reader inverse of the
// seven-section projector). Focus: the reader recovers what projectMarkdown emits, including a
// multi-line `## Payload` fence whose anchor renders as a BARE `start..end` line after the closing
// fence (renderPayload). Pure; no mdstruct binary. Run: `bun test parse-projection.test.ts`.
import { expect, test } from "bun:test";
import { projectMarkdown, type Projection } from "./project.ts";
import { parseCanonicalNote } from "./parse-projection.ts";

// strip the frontmatter block the projector prepends, leaving the body the reader consumes.
function bodyOf(md: string): string {
  const m = md.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return m ? m[1]! : md;
}

const NOTE: Projection = {
  source: { path: "cfg.md", bytes: 200, sha256: "deadbeef0000" },
  title: "Config example",
  abstract: "A note whose payload is a multi-line fenced code block.",
  units: [
    { id: "timeout", type: "concept", statement: "the per-request deadline in ms", span: [10, 40] },
    {
      id: "must-hold",
      type: "judgment",
      statement: "the deadline must exceed zero",
      modality: "necessarily",
      span: [41, 70],
    },
    // multi-line payload: statement carries a newline, so renderPayload emits a fence + bare anchor
    {
      id: "default config",
      type: "payload",
      statement: "timeout: 5000\nretries: 3",
      span: [71, 120],
    },
    // single-line payload: renderPayload emits `> quote anchor` (anchor inline)
    { id: "one-liner", type: "payload", statement: "log_level: info", span: [121, 140] },
  ],
  edges: [{ from: "timeout", to: "must-hold", rel: "precondition-for", span: [71, 120] }],
};

test("reader recovers a multi-line Payload fence's BARE trailing anchor (regression)", () => {
  const note = parseCanonicalNote(bodyOf(projectMarkdown(NOTE)));
  const multi = note.payload.find((p) => p.headword === "default config")!;
  expect(multi.body).toBe("timeout: 5000\nretries: 3");
  // the bug: stripAnchor could not read the bare `71..120` line, so span came back null.
  expect(multi.span).toEqual([71, 120]);
});

test("reader recovers a single-line Payload's inline anchor", () => {
  const note = parseCanonicalNote(bodyOf(projectMarkdown(NOTE)));
  const one = note.payload.find((p) => p.headword === "one-liner")!;
  expect(one.body).toBe("log_level: info");
  expect(one.span).toEqual([121, 140]);
});

test("reader strips the (modality) tag and recovers concept/judgement spans", () => {
  const note = parseCanonicalNote(bodyOf(projectMarkdown(NOTE)));
  expect(note.concepts[0]).toMatchObject({ headword: "timeout", span: [10, 40] });
  expect(note.judgements[0]).toEqual({
    statement: "the deadline must exceed zero",
    span: [41, 70],
  });
  expect(note.relations[0]).toContain("timeout — precondition-for → must-hold");
});
