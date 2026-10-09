// Tests for stop-remind.ts — the Stop hook that asks Jev whether the finished turn needs a
// crux, SDLC or confidence reminder. Each case runs the hook as Claude Code does: JSON on
// stdin, a decision on stdout. A local server stands in for TypeSafe, and a fake `security`
// on PATH stands in for the Keychain, so the suite stays offline.
import { afterAll, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const HOOK = join(import.meta.dir, "stop-remind.ts");
const LAUNCHER = join(import.meta.dir, "../../../../claude/hooks/stop-remind.sh");
const WORK = mkdtempSync(join(tmpdir(), "stop-remind-test-"));
const BIN = join(WORK, "bin");
const MARK = join(WORK, "stop-remind.s");

mkdirSync(BIN);
writeFileSync(
  join(BIN, "security"),
  `#!/bin/bash
touch "$FAKE/security.called"
[ -z "\${FAKE_SECURITY_SLEEP:-}" ] || exec sleep "$FAKE_SECURITY_SLEEP"
exit 44
`,
);
chmodSync(join(BIN, "security"), 0o755);

// The fake TypeSafe: records each call and answers with `reply`, or fails with `status`.
type Call = { body: Record<string, any>; auth: string | null };
const calls: Call[] = [];
let reply: unknown;
let status = 200;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    calls.push({
      body: (await req.json()) as Record<string, any>,
      auth: req.headers.get("authorization"),
    });
    return status === 200 ? Response.json(reply) : new Response("failed", { status });
  },
});

afterAll(() => {
  server.stop(true);
  rmSync(WORK, { recursive: true, force: true });
});

function respond(crux: unknown, sdlc: unknown, confidence: unknown, model = "jev-1.13.0") {
  status = 200;
  reply = {
    model,
    answers: {
      crux: { type: "noul", noul: crux },
      sdlc: { type: "noul", noul: sdlc },
      confidence: { type: "noul", noul: confidence },
    },
  };
}

beforeEach(() => respond(0.95, 0.95, 0.95));

// The parent's own settings never reach the hook; NO_PROXY keeps the fake server off any
// proxy the environment routes through.
const ENV: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter(
    (e): e is [string, string] =>
      e[1] !== undefined && !/^(STOP_REMIND_|TYPESAFE_|LLM_KEYS_)/.test(e[0]),
  ),
);
Object.assign(ENV, {
  PATH: `${BIN}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
  FAKE: WORK,
  TMPDIR: WORK,
  TYPESAFE_API_KEY: "test-key-123",
  STOP_REMIND_URL: `http://127.0.0.1:${server.port}`,
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
});

type Result = { out: string; err: string; code: number; call: Call | undefined };

async function hook(
  input: object,
  env: Record<string, string> = {},
  launcher = false,
): Promise<Result> {
  calls.length = 0;
  rmSync(join(WORK, "security.called"), { force: true });
  const proc = Bun.spawn(launcher ? ["bash", LAUNCHER] : [process.execPath, HOOK], {
    stdin: new Blob([JSON.stringify(input)]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...ENV, ...env },
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out: out.trim(), err, code, call: calls[0] };
}

// run <transcript> <last message> [stop_hook_active]
function run(transcript: string, last: string, active = false, env: Record<string, string> = {}) {
  return hook(
    {
      session_id: "s",
      transcript_path: transcript,
      hook_event_name: "Stop",
      stop_hook_active: active,
      last_assistant_message: last,
    },
    env,
  );
}

const prompt = (t: string) => ({ type: "user", message: { role: "user", content: t } });
const promptParts = (a: string, b: string) => ({
  type: "user",
  message: {
    role: "user",
    content: [
      { type: "text", text: a },
      { type: "text", text: b },
    ],
  },
});
const tool = (name: string, input: object) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", id: "t", name, input }] },
});
const result = (c: string) => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: c }] },
});
const say = (t: string) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text: t }] },
});
const compaction = () => [
  { type: "system", subtype: "compact_boundary" },
  {
    type: "user",
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
    message: {
      role: "user",
      content: "This session is being continued from a previous conversation.",
    },
  },
];

function transcript(name: string, entries: object[]): string {
  const path = join(WORK, `${name}.jsonl`);
  writeFileSync(path, entries.map((e) => `${JSON.stringify(e)}\n`).join(""));
  return path;
}

const keys = (call: Call | undefined) => Object.keys(call?.body.questions ?? {}).sort();

// A previous turn wrote crux and read nothing from the SDLC notes
const T = transcript("basic", [
  promptParts("<system-reminder>CLAUDE.md body</system-reminder>", "first question"),
  tool("mcp__crux__add_note", { goal: "g", body: "b" }),
  result("ok"),
  say("done 1"),
  prompt("fix the parser"),
  { type: "user", isSidechain: true, message: { role: "user", content: "subagent prompt" } },
  tool("Bash", { command: "echo sk-live-SECRET", description: "Run the parser tests" }),
  result("3 passed"),
  tool("Edit", { file_path: "/repo/src/parser.ts", old_string: "a", new_string: "b" }),
  result("ok"),
  say("Fixed."),
]);

test("blocks with every reminder and sends only the turn's summary", async () => {
  const r = await run(T, "The parser is fixed.");
  const out = JSON.parse(r.out);
  const body = JSON.stringify(r.call?.body);
  expect(out.decision).toBe("block");
  expect(out.reason).toContain("Update crux");
  expect(out.reason).toContain("vault-query get ~SDLC");
  expect(out.reason).toContain("Grade your confidence");
  expect(r.call?.body.model).toBe("jev-1.13.0");
  expect(keys(r.call)).toEqual(["confidence", "crux", "sdlc"]);
  expect(r.call?.body.state.request).toBe("fix the parser");
  expect(r.call?.body.state.tools).toEqual([
    { name: "Bash", arg: "Run the parser tests" },
    { name: "Edit", arg: "/repo/src/parser.ts" },
  ]);
  expect(body).not.toContain("sk-live-SECRET");
  expect(body).not.toContain("3 passed");
  expect(r.call?.body.state.answer).toBe("The parser is fixed.");
  expect(body).not.toContain("test-key-123");
  expect(r.call?.auth).toBe("Bearer test-key-123");
});

test("goes through the bash launcher", async () => {
  const r = await hook(
    { session_id: "s", transcript_path: T, stop_hook_active: false, last_assistant_message: "x" },
    {},
    true,
  );
  expect(r.err).toBe("");
  expect(JSON.parse(r.out).decision).toBe("block");
});

test("falls back to the transcript answer", async () => {
  const r = await hook({ transcript_path: T, stop_hook_active: false });
  expect(r.call?.body.state.answer).toBe("Fixed.");
});

test("keeps every complete line before a cut-off tail", async () => {
  const cut = join(WORK, "cut.jsonl");
  writeFileSync(cut, `${readFileSync(T, "utf8")}{"type":"assistant","message":{"role":"assis`);
  const r = await run(cut, "The parser is fixed.");
  expect(JSON.parse(r.out).decision).toBe("block");
  expect(r.call?.body.state.request).toBe("fix the parser");
  expect(r.call?.body.state.answer).toBe("The parser is fixed.");
});

test("a compaction summary mid-turn never becomes the prompt", async () => {
  const comp = transcript("compact", [
    prompt("ship the fix"),
    tool("mcp__crux__add_note", { goal: "g", body: "b" }),
    result("ok"),
    ...compaction(),
    tool("Edit", { file_path: "/repo/a.ts" }),
    result("ok"),
  ]);
  const r = await run(comp, "x");
  expect(r.call?.body.state.request).toBe("ship the fix");
  expect(keys(r.call)).not.toContain("crux");
});

test("a prompt with a pasted image starts the turn", async () => {
  const img = transcript("image", [
    prompt("old question"),
    tool("mcp__crux__add_note", { goal: "g", body: "b" }),
    result("ok"),
    {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", data: "IMAGEDATA" } },
          { type: "text", text: "fix this layout" },
        ],
      },
    },
    tool("Edit", { file_path: "/repo/a.css" }),
    result("ok"),
  ]);
  const r = await run(img, "x");
  expect(r.call?.body.state.request).toBe("fix this layout");
  expect(keys(r.call)).toContain("crux");
  expect(JSON.stringify(r.call?.body)).not.toContain("IMAGEDATA");
});

test("a slash command sends its name, arguments and expanded text", async () => {
  const cmd = transcript("command", [
    prompt(
      "<command-message>code-review is running…</command-message>\n<command-name>/code-review</command-name>\n<command-args>high</command-args>",
    ),
    {
      type: "user",
      isMeta: true,
      message: { role: "user", content: [{ type: "text", text: "Review the current diff." }] },
    },
    tool("Bash", { command: "git diff", description: "Show the diff" }),
    result("diff"),
  ]);
  const r = await run(cmd, "x");
  expect(r.call?.body.state.request).toBe("/code-review high\nReview the current diff.");
});

test("a prompt quoting command tags stays as typed", async () => {
  const text = "Fix the case where Jev gets <command-name>/code-review</command-name> alone.";
  const r = await run(transcript("quoted", [prompt(text)]), "x");
  expect(r.call?.body.state.request).toBe(text);
});

test("strips system-reminder blocks", async () => {
  const t2 = transcript("reminder", [
    promptParts("<system-reminder>CLAUDE.md body</system-reminder>", "second question"),
  ]);
  const r = await run(t2, "An answer.");
  expect(r.call?.body.state.request).toBe("second question");
});

// Gates met in the transcript are never asked
const T3 = transcript("partial", [
  prompt("plan the change"),
  tool("Bash", { command: "vault-query consult x", description: "Consult the vault" }),
  result("## ~SDLC (30 notes/SDLC/~SDLC.md)"),
  tool("mcp__57b9e6ea-d0af-4b63-844c-6a0a98964d71__record_decision", { goal: "g" }),
  result("ok"),
]);

test("asks only the ungated question", async () => {
  expect(keys((await run(T3, "Use a state table.")).call)).toEqual(["confidence"]);
});

test("every gate met emits nothing and makes no call", async () => {
  const r = await run(T3, "Use a state table. Confidence: 8/10.");
  expect(r.out).toBe("");
  expect(r.call).toBeUndefined();
});

test("a bare fraction is not a grade", async () => {
  expect(keys((await run(T3, "Step 3/10 failed, so use a state table.")).call)).toEqual([
    "confidence",
  ]);
});

test("the crux gate takes any crux write, and only crux's", async () => {
  const own = transcript("crux-own", [
    prompt("tick the condition"),
    tool("mcp__crux__set_done_condition", { condition: "c" }),
    result("ok"),
  ]);
  expect(keys((await run(own, "x")).call)).not.toContain("crux");
  const other = transcript("crux-other", [
    prompt("file a ticket"),
    tool("mcp__linear__create_item", { title: "t" }),
    result("ok"),
  ]);
  expect(keys((await run(other, "x")).call)).toContain("crux");
});

test("an SDLC note read before a compaction no longer counts", async () => {
  const sd = transcript("sdlc-compact", [
    prompt("read the process"),
    tool("Read", { file_path: "/vault/30 notes/SDLC/~SDLC.md" }),
    result("process"),
    say("ok"),
    ...compaction(),
    prompt("implement it"),
    tool("Edit", { file_path: "/repo/a.ts" }),
    result("ok"),
  ]);
  expect(keys((await run(sd, "x")).call)).toContain("sdlc");
});

test("thresholds", async () => {
  respond(0.2, 0.5, 0.79);
  expect((await run(T, "x")).out).toBe("");
  respond(0.9, 0.1, 0.1);
  const reason: string = JSON.parse((await run(T, "x")).out).reason;
  expect(reason).toContain("Update crux");
  expect(reason).not.toContain("SDLC");
  expect(reason).not.toContain("Grade");
  respond(0.6, 0.6, 0.6);
  expect((await run(T, "x", false, { STOP_REMIND_THRESHOLD: "0.5" })).out).not.toBe("");
});

test("a turn this hook blocked passes its later stops", async () => {
  await run(T, "x");
  const again = await run(T, "x", true);
  expect(again.out).toBe("");
  expect(again.call).toBeUndefined();
  rmSync(MARK);
  expect((await run(T, "x", true)).out).not.toBe("");
});

test("a huge answer is cut to 8000 characters and keeps its trailing grade", async () => {
  const r = await run(T, `${"a".repeat(2_000_000)} Confidence: 8/10.`);
  expect(r.call?.body.state.answer).toHaveLength(8000);
  expect(keys(r.call)).toEqual(["crux", "sdlc"]);
});

test("STOP_REMIND_TIMING prints the Jev round trip", async () => {
  const r = await run(T, "x", false, { STOP_REMIND_TIMING: "1" });
  expect(r.err).toMatch(/^stop-remind: jev 200 \d+\.\d{3}s$/m);
  expect(r.code).toBe(0);
});

// Fail open, but visibly: exit 1 never blocks, and stderr says why
test("a missing transcript emits nothing", async () => {
  const r = await run(join(WORK, "gone.jsonl"), "x");
  expect(r.out).toBe("");
  expect(r.code).toBe(0);
});

test("an unexpected model fails visibly", async () => {
  respond(0.95, 0.95, 0.95, "jev-latest");
  const r = await run(T, "x");
  expect(r.out).toBe("");
  expect(r.code).toBe(1);
  expect(r.err).toContain("unexpected model jev-latest");
});

test("a malformed or out-of-range answer fails visibly", async () => {
  reply = { model: "jev-1.13.0", answers: { crux: { type: "noul", noul: "high" } } };
  expect((await run(T, "x")).out).toBe("");
  reply = { model: "jev-1.13.0", answers: { crux: { type: "noul", noul: 1.5 } } };
  const r = await run(T, "x");
  expect(r.out).toBe("");
  expect(r.err).toContain("invalid answer for crux");
});

test("an HTTP error fails visibly", async () => {
  status = 500;
  const r = await run(T, "x");
  expect(r.out).toBe("");
  expect(r.code).toBe(1);
  expect(r.err).toContain("the TypeSafe request failed (HTTP 500)");
});

test("an unreachable server fails visibly", async () => {
  const r = await run(T, "x", false, { STOP_REMIND_URL: "http://127.0.0.1:1" });
  expect(r.out).toBe("");
  expect(r.code).toBe(1);
  expect(r.err).toContain("the TypeSafe request failed");
});

test("a missing key tries the Keychain, makes no call and says so", async () => {
  const r = await run(T, "x", false, { TYPESAFE_API_KEY: "" });
  expect(r.out).toBe("");
  expect(r.code).toBe(1);
  expect(existsSync(join(WORK, "security.called"))).toBe(true);
  expect(r.call).toBeUndefined();
  expect(r.err).toContain("no TypeSafe key");
});

test("a stuck Keychain read gives up", async () => {
  const started = performance.now();
  const r = await run(T, "x", false, {
    TYPESAFE_API_KEY: "",
    FAKE_SECURITY_SLEEP: "10",
    STOP_REMIND_KEYCHAIN_TIMEOUT: "1",
  });
  expect(performance.now() - started).toBeLessThan(5000);
  expect(r.out).toBe("");
  expect(r.err).toContain("no TypeSafe key");
});
