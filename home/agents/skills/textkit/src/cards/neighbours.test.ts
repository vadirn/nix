// neighbours tests — run scoped: `bun test cards/neighbours.test.ts` from the
// distill dir (bare `bun test` picks up sibling in-progress files — see brief).
//
// Drives fetchNeighbours entirely through injected RunFn/ReadFn fakes: no real
// vault-query spawn, no real filesystem read. Covers the lanes the header comment
// promises — happy-path mapping, spawn failure, malformed JSON, an unreadable card
// file (empty description, ok still true), a superseded hit excluded, and topK
// forwarded into the spawned command.
import { expect, test } from "bun:test";
import { fetchNeighbours, type ReadFn, type RunFn } from "textkit/cards/neighbours.ts";
import type { Candidate } from "textkit/cards/types.ts";

const CANDIDATE: Candidate = {
  arm: "concept",
  term: "legacy code",
  def: "code without tests",
  relations: [],
  sourceNote: "/abs/emitted-note.md",
};

// A realistic vault-query JSON fixture built from the shape verified this
// session: an object with query/count/results, each result carrying path,
// title, type, score, snippet, body, tokens, links, superseded.
function fixtureJson(): string {
  return JSON.stringify({
    query: "legacy code code without tests",
    count: 2,
    results: [
      {
        path: "20 cards/Legacy code/Code without tests.md",
        title: "Code without tests",
        type: "card",
        score: 15.828003,
        snippet: "Legacy code is simply code without tests.",
        body: "Legacy code is simply code without tests.\n",
        tokens: 30,
        links: ["Legacy code"],
        superseded: false,
      },
      {
        path: "20 cards/Legacy code/Retired take.md",
        title: "Retired take",
        type: "card",
        score: 9.1,
        snippet: "An old framing, since superseded.",
        body: "An old framing, since superseded.\n",
        tokens: 12,
        links: [],
        superseded: true,
      },
    ],
  });
}

const okRun =
  (stdout: string): RunFn =>
  async () => ({ exitCode: 0, stdout });

const cardFrontmatter = "---\ntype: card\ndescription: A card about legacy code.\n---\nBody.\n";
const readWithDescription: ReadFn = async () => cardFrontmatter;
const readUnreadable: ReadFn = async () => null;

test("fetchNeighbours: happy path maps results, joins frontmatter description, drops superseded", async () => {
  const result = await fetchNeighbours(
    CANDIDATE,
    { vaultRoot: "/vault", topK: 5 },
    okRun(fixtureJson()),
    readWithDescription,
  );
  expect(result.ok).toBe(true);
  expect(result.hits).toHaveLength(1); // the superseded hit is excluded
  expect(result.hits[0]).toEqual({
    path: "20 cards/Legacy code/Code without tests.md",
    title: "Code without tests",
    score: 15.828003,
    description: "A card about legacy code.",
    snippet: "Legacy code is simply code without tests.",
  });
});

test("fetchNeighbours: spawn failure (run throws) is the recall-unavailable lane", async () => {
  const throwingRun: RunFn = async () => {
    throw new Error("ENOENT: vault-query not found");
  };
  const result = await fetchNeighbours(
    CANDIDATE,
    { vaultRoot: "/vault", topK: 5 },
    throwingRun,
    readUnreadable,
  );
  expect(result.ok).toBe(false);
  expect(result.hits).toEqual([]);
});

test("fetchNeighbours: non-zero exit is the recall-unavailable lane", async () => {
  const failingRun: RunFn = async () => ({ exitCode: 1, stdout: "" });
  const result = await fetchNeighbours(
    CANDIDATE,
    { vaultRoot: "/vault", topK: 5 },
    failingRun,
    readUnreadable,
  );
  expect(result.ok).toBe(false);
  expect(result.hits).toEqual([]);
});

test("fetchNeighbours: malformed JSON is the recall-unavailable lane", async () => {
  const result = await fetchNeighbours(
    CANDIDATE,
    { vaultRoot: "/vault", topK: 5 },
    okRun("{ not valid json"),
    readUnreadable,
  );
  expect(result.ok).toBe(false);
  expect(result.hits).toEqual([]);
});

test("fetchNeighbours: JSON without a results array is the recall-unavailable lane", async () => {
  const result = await fetchNeighbours(
    CANDIDATE,
    { vaultRoot: "/vault", topK: 5 },
    okRun(JSON.stringify({ query: "x", count: 0 })),
    readUnreadable,
  );
  expect(result.ok).toBe(false);
  expect(result.hits).toEqual([]);
});

test("fetchNeighbours: unreadable card file yields empty description, ok stays true", async () => {
  const oneHit = JSON.stringify({
    query: "x",
    count: 1,
    results: [
      {
        path: "20 cards/Missing/File.md",
        title: "File",
        type: "card",
        score: 1,
        snippet: "s",
        body: "b",
        tokens: 1,
        links: [],
        superseded: false,
      },
    ],
  });
  const result = await fetchNeighbours(
    CANDIDATE,
    { vaultRoot: "/vault", topK: 5 },
    okRun(oneHit),
    readUnreadable,
  );
  expect(result.ok).toBe(true);
  expect(result.hits).toHaveLength(1);
  expect(result.hits[0].description).toBe("");
});

test("fetchNeighbours: topK is forwarded into the spawned command args", async () => {
  let seenCmd: string[] = [];
  const capturingRun: RunFn = async (cmd) => {
    seenCmd = cmd;
    return { exitCode: 0, stdout: JSON.stringify({ query: "x", count: 0, results: [] }) };
  };
  await fetchNeighbours(CANDIDATE, { vaultRoot: "/vault", topK: 7 }, capturingRun, readUnreadable);
  expect(seenCmd).toEqual([
    "vault-query",
    "search",
    "legacy code code without tests",
    "--types",
    "card",
    "--format",
    "json",
    "--limit",
    "7",
  ]);
});
