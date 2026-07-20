/**
 * The render path, split out of vidgen-fal.ts so it is reachable from a test:
 * vidgen-fal.ts parses argv and runs main() at import, so nothing defined there
 * can be imported without running the CLI.
 *
 * renderVideo takes its three external boundaries — the fal subscriber, the MP4
 * fetcher, and the ffmpeg runner — as injected functions, so the orchestration
 * around them (the missing-URL throw, the download-failure paths, the ffmpeg arg
 * vector, the log record, the JSONL emission) runs against fakes with no network
 * and no encoder. Everything it needs from vidgen-fal.ts's module scope arrives
 * as a parameter; this module reads no module-scope state of its own.
 */
import { appendFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

const SUBSCRIBE_TIMEOUT_MS = 300_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** The Kling v1.6 text-to-video input, as sent and as logged. */
export interface KlingInput {
  prompt: string;
  duration: string;
  aspect_ratio: string;
  negative_prompt: string;
  cfg_scale: number;
}

/** Everything the render path needs from the CLI's resolved options. */
export interface RenderOptions {
  endpoint: string;
  input: KlingInput;
  outDir: string;
  /** Filename stem shared by the MP4 and the WebM, e.g. "20260720-140233-4242". */
  timestamp: string;
  logFile: string;
  webm: boolean;
  scale: number;
  webmCrf: number;
}

export type SubscribeVideo = (
  endpoint: string,
  options: { input: KlingInput; logs: boolean },
) => Promise<unknown>;

export type FetchVideo = (url: string) => Promise<Response>;

export type RunFfmpeg = (args: string[]) => void;

/** The three external boundaries, plus the three output sinks. */
export interface RenderDeps {
  subscribe: SubscribeVideo;
  fetchVideo?: FetchVideo;
  runFfmpeg?: RunFfmpeg;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
  emit?: (line: string) => void;
}

export interface LogRecord {
  ts: string;
  prompt: string;
  endpoint: string;
  duration: string;
  aspect_ratio: string;
  cfg_scale: number;
  negative_prompt: string;
  webm: boolean;
  outputs: string[];
  elapsed_ms: number;
}

export interface RenderResult {
  mp4Path: string;
  webmPath?: string;
  outputPaths: string[];
  logRecord: LogRecord;
}

/** Run ffmpeg synchronously, throwing on a spawn failure, a signal, or a non-zero exit. */
export function ffmpeg(args: string[]): void {
  const result = spawnSync("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) {
    throw new Error(
      `ffmpeg could not be spawned: ${result.error.message} (is ffmpeg installed and on PATH?)`,
    );
  }
  if (result.signal) {
    const stderr = result.stderr?.toString() ?? "";
    throw new Error(`ffmpeg killed by signal ${result.signal}:\n${stderr}`);
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.toString() ?? "";
    throw new Error(`ffmpeg failed (exit ${result.status}):\n${stderr}`);
  }
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Generate the video, download the MP4 master, optionally transcode a WebM loop,
 * append the run to the JSONL log, and emit one JSON-lines record per output file.
 */
export async function renderVideo(
  opts: RenderOptions,
  {
    subscribe,
    fetchVideo = (url) => fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) }),
    runFfmpeg = ffmpeg,
    log = console.log,
    warn = console.warn,
    emit = (line) => {
      process.stdout.write(line);
    },
  }: RenderDeps,
): Promise<RenderResult> {
  mkdirSync(opts.outDir, { recursive: true });

  const startMs = Date.now();

  // Call fal Kling endpoint.
  // Kling v1.6 params: prompt, duration (str enum), aspect_ratio (str enum),
  // negative_prompt, cfg_scale (float 0–1).
  log(`Generating video via ${opts.endpoint}…`);
  const result = (await withTimeout(
    subscribe(opts.endpoint, { input: opts.input, logs: false }),
    SUBSCRIBE_TIMEOUT_MS,
    "fal.subscribe(Kling video)",
  )) as { data?: { video?: { url?: string } } };

  const videoUrl = result.data?.video?.url;
  if (!videoUrl) {
    throw new Error(`No video URL in response: ${JSON.stringify(result).slice(0, 500)}`);
  }

  // Download MP4 — always kept as the master output.
  const mp4Path = join(opts.outDir, `vidgen-${opts.timestamp}.mp4`);
  log(`Downloading MP4…`);
  const resp = await fetchVideo(videoUrl);
  if (!resp.ok)
    throw new Error(`Failed to download ${videoUrl}: ${resp.status} ${resp.statusText}`);
  try {
    await Bun.write(mp4Path, resp);
  } catch (err) {
    try {
      unlinkSync(mp4Path);
    } catch {} // best-effort cleanup; ignore if file never existed
    throw err;
  }
  log(`video: ${mp4Path}`);

  const outputPaths: string[] = [mp4Path];
  let webmPath: string | undefined;

  if (opts.webm) {
    // Encode WebM (VP9) at target width, preserving aspect ratio.
    // -b:v 0 puts libvpx-vp9 into true CRF mode.
    // -row-mt 1 enables multi-threaded row encoding.
    // -an strips audio (Kling MP4 has none, but explicit insurance).
    // -pix_fmt yuv420p ensures browser (Safari) compatibility.
    // -g 1 -keyint_min 1: every frame is a keyframe so the loop boundary is clean.
    webmPath = join(opts.outDir, `vidgen-${opts.timestamp}.webm`);
    log(`Encoding WebM…`);
    runFfmpeg([
      "-y",
      "-i",
      mp4Path,
      "-vf",
      `scale=${opts.scale}:-2`,
      "-c:v",
      "libvpx-vp9",
      "-crf",
      String(opts.webmCrf),
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
      webmPath,
    ]);

    outputPaths.push(webmPath);
    log(`webm: ${webmPath}`);
  }

  const elapsedMs = Date.now() - startMs;

  // Append to log file.
  const logRecord: LogRecord = {
    ts: new Date().toISOString(),
    prompt: opts.input.prompt,
    endpoint: opts.endpoint,
    duration: opts.input.duration,
    aspect_ratio: opts.input.aspect_ratio,
    cfg_scale: opts.input.cfg_scale,
    negative_prompt: opts.input.negative_prompt,
    webm: opts.webm,
    outputs: outputPaths,
    elapsed_ms: elapsedMs,
  };
  const logLine = JSON.stringify(logRecord) + "\n";
  try {
    appendFileSync(opts.logFile, logLine);
  } catch {
    warn(`WARNING: could not write to log file: ${opts.logFile}`);
  }

  log(`log: ${opts.logFile}`);
  log(`elapsed: ${elapsedMs}ms`);

  // Emit one JSON-lines record per output file.
  for (const p of outputPaths) {
    const ext = p.endsWith(".webm") ? "webm" : "video";
    emit(
      JSON.stringify({
        type: ext,
        path: p,
        endpoint: opts.endpoint,
        prompt: opts.input.prompt,
        duration: opts.input.duration,
        aspect_ratio: opts.input.aspect_ratio,
        cfg_scale: opts.input.cfg_scale,
      }) + "\n",
    );
  }

  return { mp4Path, webmPath, outputPaths, logRecord };
}
