// neighbours — recall: surface the existing vault cards nearest a candidate by
// spawning the vault-query CLI (BM25 today; the seam is recall-agnostic, see
// NeighbourHit in types.ts). Never imports pipeline.ts (D13) — the candidate
// arrives already built from an emitted note; this module only talks to
// vault-query and to the filesystem for each hit's frontmatter description.
//
// Failure is a lane, not a throw: a spawn error, a non-zero exit, or unparseable
// JSON all resolve to `{ hits: [], ok: false }` — the recall-unavailable lane
// (types.ts CandidateFlag). fetchNeighbours never throws. A hit's own card file
// being unreadable, or carrying no `description:`, is NOT that lane — it is a
// per-hit empty description with `ok` still true, mirroring the frontmatter
// contract (parseDescription: "" is "nothing authored to pin", not an error).
//
// I/O is injected (RunFn/ReadFn) so cards/neighbours.test.ts drives every lane
// with fakes; the real Bun.spawn/Bun.file implementations are exported but are
// only the trailing-default wiring, never called directly by the pure logic.
import { join } from "node:path";
import { parseDescription, parseFrontmatter } from "../frontmatter.ts";
import type { Candidate, NeighbourHit } from "./types.ts";

// ---- injected I/O seams ----

export type RunFn = (cmd: string[]) => Promise<{ exitCode: number; stdout: string }>;
export type ReadFn = (absPath: string) => Promise<string | null>;

// Real vault-query spawn. Captures stdout only — stderr is diagnostic noise the
// recall-unavailable lane doesn't need to render, so it is discarded at the OS level
// (stderr: "ignore") rather than piped-and-left-undrained (Finding 4): an undrained
// pipe fills its OS buffer (~64 KB) once vault-query writes enough to it, and the
// child then blocks on that write before its stdout ever reaches EOF — a mutual hang
// between this await and the child, not the recall-unavailable lane it should degrade
// to.
export async function spawnRun(cmd: string[]): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout };
}

// Real card-file read. null on any failure (missing file, permission error) —
// the caller treats that identically to "no description", never as a fatal lane.
export async function readCardFile(absPath: string): Promise<string | null> {
  try {
    const f = Bun.file(absPath);
    if (!(await f.exists())) return null;
    return await f.text();
  } catch {
    return null;
  }
}

// The subset of a vault-query search result this module trusts. Untyped fields
// (tokens, links, body) are read by nobody downstream and left unvalidated.
type RawResult = {
  path?: unknown;
  title?: unknown;
  score?: unknown;
  snippet?: unknown;
  superseded?: unknown;
};

function isRawResult(v: unknown): v is RawResult {
  return typeof v === "object" && v !== null;
}

// Structural validation of the vault-query JSON reply. Anything short of "an
// object with a `results` array" is unparseable — the recall-unavailable lane,
// same as a JSON.parse throw.
function parseResults(stdout: string): RawResult[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const results = (parsed as { results?: unknown }).results;
  if (!Array.isArray(results)) return null;
  return results.filter(isRawResult);
}

// Frontmatter `description:` for one hit's card file, "" on any unreadable/absent
// case (not a lane — see header). vaultRoot + the vault-relative path from
// vault-query is the join; vault-query never reports an absolute path.
async function describeHit(path: string, vaultRoot: string, read: ReadFn): Promise<string> {
  const text = await read(join(vaultRoot, path));
  if (text === null) return "";
  return parseDescription(parseFrontmatter(text).front);
}

// Fetch the nearest existing vault cards for `candidate`. Query text is the
// candidate's own headword and def — no query-construction knobs beyond that, so
// recall stays a pure function of the candidate. `topK` is forwarded verbatim as
// `--limit`. Superseded hits are excluded (retired content, never a live
// neighbour — mirrors frontmatter.ts parseSuperseded's licence to drop wholesale).
export async function fetchNeighbours(
  candidate: Candidate,
  opts: { vaultRoot: string; topK: number },
  run: RunFn = spawnRun,
  read: ReadFn = readCardFile,
): Promise<{ hits: NeighbourHit[]; ok: boolean }> {
  const query = `${candidate.term} ${candidate.def}`;
  const cmd = [
    "vault-query",
    "search",
    query,
    "--types",
    "card",
    "--format",
    "json",
    "--limit",
    String(opts.topK),
  ];

  let reply: { exitCode: number; stdout: string };
  try {
    reply = await run(cmd);
  } catch {
    return { hits: [], ok: false };
  }
  if (reply.exitCode !== 0) return { hits: [], ok: false };

  const results = parseResults(reply.stdout);
  if (results === null) return { hits: [], ok: false };

  const live = results.filter((r) => r.superseded !== true);
  const hits: NeighbourHit[] = await Promise.all(
    live.map(async (r) => {
      const path = typeof r.path === "string" ? r.path : "";
      return {
        path,
        title: typeof r.title === "string" ? r.title : "",
        score: typeof r.score === "number" ? r.score : 0,
        description: await describeHit(path, opts.vaultRoot, read),
        snippet: typeof r.snippet === "string" ? r.snippet : "",
      };
    }),
  );
  return { hits, ok: true };
}
