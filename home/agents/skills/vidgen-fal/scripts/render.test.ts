/**
 * Unit test: the render orchestration.
 *
 * Run:
 *   bun test render.test.ts
 *
 * renderVideo takes the fal subscriber, the MP4 fetcher and the ffmpeg runner as
 * injected functions, so every branch below runs against plain inline fakes with
 * no network and no encoder. The filesystem is real: outputs and the JSONL log go
 * to a per-pid tmpdir removed in afterAll.
 */

import { describe, it, expect, afterAll, beforeAll } from "bun:test";
import { rmSync, mkdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { renderVideo, type RenderOptions, type RenderDeps } from "./render.ts";

const TMP_DIR = join(tmpdir(), `vidgenfal-render-test-${process.pid}`);

const INPUT = {
  prompt: "a cat",
  duration: "5",
  aspect_ratio: "16:9",
  negative_prompt: "blur",
  cfg_scale: 0.5,
};

function options(overrides: Partial<RenderOptions> = {}): RenderOptions {
  return {
    endpoint: "fal-ai/kling-video/v1.6/standard/text-to-video",
    input: INPUT,
    outDir: TMP_DIR,
    timestamp: "20260720-140233-4242",
    logFile: join(TMP_DIR, "log.jsonl"),
    webm: false,
    scale: 480,
    webmCrf: 40,
    ...overrides,
  };
}

/** A fal response carrying a usable video URL. */
const okSubscribe = async () => ({ data: { video: { url: "https://fal.media/v.mp4" } } });

/** A successful MP4 download; the body is stand-in bytes, never decoded. */
const okFetch = async () => new Response("MP4BYTES", { status: 200 });

/** Silent sinks, so a passing run prints nothing. */
function deps(overrides: Partial<RenderDeps> = {}): RenderDeps {
  return {
    subscribe: okSubscribe,
    fetchVideo: okFetch,
    runFfmpeg: () => {},
    log: () => {},
    warn: () => {},
    emit: () => {},
    ...overrides,
  };
}

beforeAll(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("failure paths", () => {
  it("throws when the fal response carries no video URL", async () => {
    const promise = renderVideo(options(), deps({ subscribe: async () => ({ data: {} }) }));

    await expect(promise).rejects.toThrow("No video URL in response");
  });

  it("throws when the MP4 download fails", async () => {
    const promise = renderVideo(
      options(),
      deps({
        fetchVideo: async () =>
          new Response("nope", { status: 503, statusText: "Service Unavailable" }),
      }),
    );

    await expect(promise).rejects.toThrow(
      "Failed to download https://fal.media/v.mp4: 503 Service Unavailable",
    );
  });

  it("attempts to unlink the partial MP4 when the write fails", async () => {
    // A directory already occupies the .mp4 name, so Bun.write throws and the
    // best-effort unlink runs (and itself fails on a directory, silently).
    const timestamp = "write-fail";
    const blocked = join(TMP_DIR, `vidgen-${timestamp}.mp4`);
    mkdirSync(blocked, { recursive: true });

    const promise = renderVideo(options({ timestamp }), deps());

    await expect(promise).rejects.toThrow();
    // The swallowed unlink failure leaves the blocker in place rather than
    // surfacing over the original write error.
    expect(existsSync(blocked)).toBe(true);
  });
});

describe("ffmpeg invocation", () => {
  it("builds the WebM arg vector exactly", async () => {
    let args: string[] = [];
    const opts = options({ timestamp: "ffargs", webm: true, scale: 640, webmCrf: 34 });
    await renderVideo(
      opts,
      deps({
        runFfmpeg: (a) => {
          args = a;
        },
      }),
    );

    expect(args).toEqual([
      "-y",
      "-i",
      join(TMP_DIR, "vidgen-ffargs.mp4"),
      "-vf",
      "scale=640:-2",
      "-c:v",
      "libvpx-vp9",
      "-crf",
      "34",
      "-b:v",
      "0",
      "-row-mt",
      "1",
      "-pix_fmt",
      "yuv420p",
      "-g",
      "1",
      "-keyint_min",
      "1",
      "-an",
      join(TMP_DIR, "vidgen-ffargs.webm"),
    ]);
  });
});

describe("log.jsonl", () => {
  it("appends one record describing the run", async () => {
    const logFile = join(TMP_DIR, "record.jsonl");
    const opts = options({ timestamp: "logrec", logFile, webm: true });
    const result = await renderVideo(opts, deps());

    const lines = readFileSync(logFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!);

    expect(record).toEqual({
      ts: record.ts,
      prompt: "a cat",
      endpoint: "fal-ai/kling-video/v1.6/standard/text-to-video",
      duration: "5",
      aspect_ratio: "16:9",
      cfg_scale: 0.5,
      negative_prompt: "blur",
      webm: true,
      outputs: [join(TMP_DIR, "vidgen-logrec.mp4"), join(TMP_DIR, "vidgen-logrec.webm")],
      elapsed_ms: record.elapsed_ms,
    });
    expect(new Date(record.ts).toISOString()).toBe(record.ts);
    expect(record.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(record).toEqual(result.logRecord);
  });

  it("warns rather than throwing when the log file cannot be written", async () => {
    // A directory at the log path makes appendFileSync throw.
    const logFile = join(TMP_DIR, "blocked-log");
    mkdirSync(logFile, { recursive: true });
    const warnings: string[] = [];

    await renderVideo(
      options({ timestamp: "logwarn", logFile }),
      deps({ warn: (m) => warnings.push(m) }),
    );

    expect(warnings).toEqual([`WARNING: could not write to log file: ${logFile}`]);
  });
});

describe("JSONL emission", () => {
  it("emits one video record when only the MP4 is produced", async () => {
    const emitted: string[] = [];
    const opts = options({ timestamp: "emit1", logFile: join(TMP_DIR, "emit1.jsonl") });
    await renderVideo(opts, deps({ emit: (line) => emitted.push(line) }));

    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.endsWith("\n")).toBe(true);
    expect(JSON.parse(emitted[0]!)).toEqual({
      type: "video",
      path: join(TMP_DIR, "vidgen-emit1.mp4"),
      endpoint: "fal-ai/kling-video/v1.6/standard/text-to-video",
      prompt: "a cat",
      duration: "5",
      aspect_ratio: "16:9",
      cfg_scale: 0.5,
    });
  });

  it("discriminates the webm record from the video record", async () => {
    const emitted: string[] = [];
    const opts = options({
      timestamp: "emit2",
      logFile: join(TMP_DIR, "emit2.jsonl"),
      webm: true,
    });
    await renderVideo(opts, deps({ emit: (line) => emitted.push(line) }));

    const records = emitted.map((l) => JSON.parse(l) as { type: string; path: string });
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.type)).toEqual(["video", "webm"]);
    expect(records.map((r) => r.path)).toEqual([
      join(TMP_DIR, "vidgen-emit2.mp4"),
      join(TMP_DIR, "vidgen-emit2.webm"),
    ]);
  });
});
