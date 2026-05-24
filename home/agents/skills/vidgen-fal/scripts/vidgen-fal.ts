#!/usr/bin/env bun
/**
 * vidgen-fal.ts — generate a Kling MP4 (+ optional WebM transcode) via fal.ai
 *
 * Usage:
 *   bun <skill-dir>/scripts/vidgen-fal.ts --prompt "<text>" [flags]
 *
 * Invoked through doppler so FAL_KEY is present in env:
 *   doppler run -p claude-code -c std --no-fallback -- \
 *     bun <skill-dir>/scripts/vidgen-fal.ts --prompt "<text>" [flags]
 */

import { fal } from "@fal-ai/client";
import { parseArgs } from "util";
import { appendFileSync } from "fs";
import { mkdirSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { homedir } from "os";

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------
const ENDPOINT_STANDARD = "fal-ai/kling-video/v1.6/standard/text-to-video";
const ENDPOINT_PRO      = "fal-ai/kling-video/v1.6/pro/text-to-video";

// ---------------------------------------------------------------------------
// Tilde expansion — only ~/path or bare ~ (not ~user/path)
// ---------------------------------------------------------------------------
function expandTilde(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return p.replace(/^~/, process.env.HOME ?? homedir());
  }
  if (p.startsWith("~")) {
    console.error(`ERROR: --out: ~user form not supported; use ~/path or an absolute path`);
    process.exit(1);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------
function usage(): void {
  console.log(`\
Usage: vidgen-fal.ts --prompt "<text>" [OPTIONS]

Generate an MP4 via fal.ai Kling video. The MP4 is always kept as the master
output. Pass --webm to also encode a WebM loop alongside it (VP9, default 640px
wide). Both files are emitted on stdout when --webm is set.

Options:
  --prompt <text>            Required. Text description of the video to generate.
  --out <dir>                Output directory (default: ~/Pictures/vidgen).
  --duration <5|10>          Clip length in seconds (default: 5).
  --aspect-ratio <16:9|9:16|1:1>
                             Aspect ratio (default: 16:9).
  --cfg-scale <0-1>          Prompt adherence, 0–1 float (default: 0.5).
  --negative-prompt <text>   Negative prompt (default: "blur, distort, and low quality").
  --pro                      Use the pro tier endpoint (higher quality, ~$0.49/5s).
  --webm                     Also encode a WebM loop (VP9) alongside the MP4.
  --scale <number>           Width in pixels for WebM output (default: 640). Must be a
                             positive even integer. Height is computed automatically.
                             Has no effect unless --webm is set.
  --webm-crf <number>        VP9 quality, 0–63 (default: 32). Lower = larger/better.
                             Has no effect unless --webm is set.
  -h, --help                 Show this help and exit.

Environment:
  FAL_KEY              fal.ai API key (inject via doppler run -p claude-code -c std).

Example:
  doppler run -p claude-code -c std --no-fallback -- \\
    bun <skill-dir>/scripts/vidgen-fal.ts \\
    --prompt "gentle smoke rising from incense, studio background, slow ambient motion"
`);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    prompt:           { type: "string" },
    out:              { type: "string" },
    duration:         { type: "string" },
    "aspect-ratio":   { type: "string" },
    "cfg-scale":      { type: "string" },
    "negative-prompt":{ type: "string" },
    pro:              { type: "boolean", default: false },
    webm:             { type: "boolean", default: false },
    scale:            { type: "string" },
    "webm-crf":       { type: "string" },
    help:             { type: "boolean", default: false, short: "h" },
  },
  allowPositionals: false,
});

if (values.help) {
  usage();
  process.exit(0);
}

const PROMPT = values.prompt ?? "";
if (!PROMPT) {
  console.error("ERROR: --prompt is required");
  usage();
  process.exit(1);
}

// ---------------------------------------------------------------------------
// FAL_KEY — fail fast unless we are just printing help
// ---------------------------------------------------------------------------
const FAL_KEY = process.env.FAL_KEY;
if (!FAL_KEY) {
  console.error(
    "ERROR: FAL_KEY is not set.\n" +
    "Inject it via: doppler run -p claude-code -c std --no-fallback --"
  );
  process.exit(1);
}

fal.config({ credentials: FAL_KEY });

// ---------------------------------------------------------------------------
// Resolve options
// ---------------------------------------------------------------------------
const ENDPOINT = values.pro ? ENDPOINT_PRO : ENDPOINT_STANDARD;

// --duration: string enum "5" | "10"
const VALID_DURATIONS = ["5", "10"] as const;
type Duration = typeof VALID_DURATIONS[number];
const durationArg = values.duration ?? "5";
if (!(VALID_DURATIONS as readonly string[]).includes(durationArg)) {
  console.error(`ERROR: --duration must be "5" or "10" (got '${durationArg}')`);
  process.exit(1);
}
const DURATION = durationArg as Duration;

// --aspect-ratio: string enum
const VALID_ASPECT_RATIOS = ["16:9", "9:16", "1:1"] as const;
type AspectRatio = typeof VALID_ASPECT_RATIOS[number];
const aspectRatioArg = values["aspect-ratio"] ?? "16:9";
if (!(VALID_ASPECT_RATIOS as readonly string[]).includes(aspectRatioArg)) {
  console.error(`ERROR: --aspect-ratio must be one of 16:9, 9:16, 1:1 (got '${aspectRatioArg}')`);
  process.exit(1);
}
const ASPECT_RATIO = aspectRatioArg as AspectRatio;

// --cfg-scale: strict float 0–1 (no trailing garbage accepted)
const cfgScaleArg = values["cfg-scale"] ?? "0.5";
if (!/^\d+(\.\d+)?$/.test(cfgScaleArg)) {
  console.error(`ERROR: --cfg-scale must be a number between 0 and 1 (got '${cfgScaleArg}')`);
  process.exit(1);
}
const cfgScaleParsed = parseFloat(cfgScaleArg);
if (cfgScaleParsed < 0 || cfgScaleParsed > 1) {
  console.error(`ERROR: --cfg-scale must be a number between 0 and 1 (got '${cfgScaleArg}')`);
  process.exit(1);
}
const CFG_SCALE = cfgScaleParsed;

// --negative-prompt: pass through verbatim; use Kling's documented default if not supplied
const NEGATIVE_PROMPT = values["negative-prompt"] ?? "blur, distort, and low quality";

const DO_WEBM = values.webm ?? false;

// --scale: positive even integer width in pixels for WebM output
const scaleArg = values.scale ?? "640";
if (!/^\d+$/.test(scaleArg)) {
  console.error(`ERROR: --scale must be a positive even integer (got '${scaleArg}')`);
  process.exit(1);
}
const scaleParsed = parseInt(scaleArg, 10);
if (scaleParsed <= 0 || scaleParsed % 2 !== 0) {
  console.error(`ERROR: --scale must be a positive even integer (got '${scaleArg}')`);
  process.exit(1);
}
const SCALE = scaleParsed;

// --webm-crf: strict integer 0–63
const webmCrfArg = values["webm-crf"] ?? "32";
if (!/^\d+$/.test(webmCrfArg)) {
  console.error(`ERROR: --webm-crf must be an integer between 0 and 63 (got '${webmCrfArg}')`);
  process.exit(1);
}
const webmCrfParsed = parseInt(webmCrfArg, 10);
if (webmCrfParsed < 0 || webmCrfParsed > 63) {
  console.error(`ERROR: --webm-crf must be an integer between 0 and 63 (got '${webmCrfArg}')`);
  process.exit(1);
}
const WEBM_CRF = webmCrfParsed;

// Warn if --scale or --webm-crf were explicitly supplied without --webm
if (!DO_WEBM) {
  if (values.scale !== undefined) {
    console.warn(`WARNING: --scale has no effect unless --webm is set`);
  }
  if (values["webm-crf"] !== undefined) {
    console.warn(`WARNING: --webm-crf has no effect unless --webm is set`);
  }
}

// Output directory (default: ~/Pictures/vidgen).
const OUT_DIR = values.out
  ? expandTilde(values.out)
  : `${process.env.HOME ?? homedir()}/Pictures/vidgen`;

const TIMESTAMP = new Date()
  .toISOString()
  .replace(/[-:T]/g, "")
  .replace(/\.\d+Z$/, "") + `-${process.pid}`;

const LOG_FILE = join(OUT_DIR, "log.jsonl");

// ---------------------------------------------------------------------------
// ffmpeg helper — run synchronously, throw on non-zero exit
// ---------------------------------------------------------------------------
function ffmpeg(args: string[]): void {
  const result = spawnSync("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) {
    throw new Error(
      `ffmpeg could not be spawned: ${result.error.message} (is ffmpeg installed and on PATH?)`
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  const startMs = Date.now();

  // Call fal Kling endpoint.
  // Kling v1.6 params: prompt, duration (str enum), aspect_ratio (str enum),
  // negative_prompt, cfg_scale (float 0–1).
  console.log(`Generating video via ${ENDPOINT}…`);
  const result = await fal.subscribe(ENDPOINT, {
    input: {
      prompt: PROMPT,
      duration: DURATION,
      aspect_ratio: ASPECT_RATIO,
      negative_prompt: NEGATIVE_PROMPT,
      cfg_scale: CFG_SCALE,
    },
    logs: false,
  }) as { data?: { video?: { url?: string } } };

  const videoUrl = result.data?.video?.url;
  if (!videoUrl) {
    throw new Error(
      `No video URL in response: ${JSON.stringify(result).slice(0, 500)}`
    );
  }

  // Download MP4 — always kept as the master output.
  const mp4Path = join(OUT_DIR, `vidgen-${TIMESTAMP}.mp4`);
  console.log(`Downloading MP4…`);
  const resp = await fetch(videoUrl, { signal: AbortSignal.timeout(120_000) });
  if (!resp.ok) throw new Error(`Failed to download ${videoUrl}: ${resp.status} ${resp.statusText}`);
  await Bun.write(mp4Path, resp);
  console.log(`video: ${mp4Path}`);

  const outputPaths: string[] = [mp4Path];
  let webmPath: string | undefined;

  if (DO_WEBM) {
    // Encode WebM (VP9) at target width, preserving aspect ratio.
    // -b:v 0 puts libvpx-vp9 into true CRF mode.
    // -row-mt 1 enables multi-threaded row encoding.
    // -an strips audio (Kling MP4 has none, but explicit insurance).
    // -pix_fmt yuv420p ensures browser (Safari) compatibility.
    // -g 1 -keyint_min 1: every frame is a keyframe so the loop boundary is clean.
    webmPath = join(OUT_DIR, `vidgen-${TIMESTAMP}.webm`);
    console.log(`Encoding WebM…`);
    ffmpeg([
      "-y", "-i", mp4Path,
      "-vf", `scale=${SCALE}:-2`,
      "-c:v", "libvpx-vp9",
      "-crf", String(WEBM_CRF),
      "-b:v", "0",
      "-row-mt", "1",
      "-pix_fmt", "yuv420p",
      "-g", "1", "-keyint_min", "1",
      "-an",
      webmPath,
    ]);

    outputPaths.push(webmPath);
    console.log(`webm: ${webmPath}`);
  }

  const elapsedMs = Date.now() - startMs;

  // Append to log file.
  const logRecord = {
    ts: new Date().toISOString(),
    prompt: PROMPT,
    endpoint: ENDPOINT,
    duration: DURATION,
    aspect_ratio: ASPECT_RATIO,
    cfg_scale: CFG_SCALE,
    negative_prompt: NEGATIVE_PROMPT,
    webm: DO_WEBM,
    outputs: outputPaths,
    elapsed_ms: elapsedMs,
  };
  const logLine = JSON.stringify(logRecord) + "\n";
  try {
    appendFileSync(LOG_FILE, logLine);
  } catch {
    console.warn(`WARNING: could not write to log file: ${LOG_FILE}`);
  }

  console.log(`log: ${LOG_FILE}`);
  console.log(`elapsed: ${elapsedMs}ms`);

  // Emit one JSON-lines record per output file.
  for (const p of outputPaths) {
    const ext = p.endsWith(".webm") ? "webm" : "video";
    process.stdout.write(
      JSON.stringify({
        type: ext,
        path: p,
        endpoint: ENDPOINT,
        prompt: PROMPT,
        duration: DURATION,
        aspect_ratio: ASPECT_RATIO,
        cfg_scale: CFG_SCALE,
      }) + "\n"
    );
  }
}

main().catch((err) => {
  console.error("ERROR:", err instanceof Error ? err.message : String(err));
  const body = (err as { body?: unknown })?.body;
  if (body !== undefined) {
    console.error("DETAIL:", typeof body === "string" ? body : JSON.stringify(body, null, 2));
  }
  process.exit(1);
});
