#!/usr/bin/env bun
/**
 * vidgen-fal.ts — generate a WebM loop (+ MP4 source) via fal.ai Kling video
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
import { mkdirSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { homedir } from "os";

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------
const ENDPOINT_STANDARD = "fal-ai/kling-video/v1.6/standard/text-to-video";
const ENDPOINT_PRO      = "fal-ai/kling-video/v1.6/pro/text-to-video";

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------
function usage(): void {
  console.log(`\
Usage: vidgen-fal.ts --prompt "<text>" [OPTIONS]

Generate a WebM loop (and MP4 source) via fal.ai Kling video.
The ffmpeg pipeline runs locally: scale + VP9 encode → WebM. The WebM loops
natively in HTML5 video with <video loop autoplay muted playsinline>.

Options:
  --prompt <text>            Required. Text description of the video to generate.
  --out <dir>                Output directory (default: ~/Pictures/vidgen).
  --duration <5|10>          Clip length in seconds (default: 5).
  --aspect-ratio <16:9|9:16|1:1>
                             Aspect ratio (default: 16:9).
  --cfg-scale <0-1>          Prompt adherence, 0–1 float (default: 0.5).
  --negative-prompt <text>   Negative prompt (default: "blur, distort, and low quality").
  --pro                      Use the pro tier endpoint (higher quality, ~$0.49/5s).
  --no-webm                  Skip WebM stage; keep MP4 only.
  --scale <number>           Width in pixels for WebM output (default: 640). Height is
                             computed automatically to preserve aspect ratio.
  --webm-crf <number>        VP9 quality, 0–63 (default: 32). Lower = larger/better.
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
    "no-webm":        { type: "boolean", default: false },
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

// --cfg-scale: float 0–1
const cfgScaleArg = values["cfg-scale"] ?? "0.5";
const cfgScaleParsed = parseFloat(cfgScaleArg);
if (isNaN(cfgScaleParsed) || cfgScaleParsed < 0 || cfgScaleParsed > 1) {
  console.error(`ERROR: --cfg-scale must be a number between 0 and 1 (got '${cfgScaleArg}')`);
  process.exit(1);
}
const CFG_SCALE = cfgScaleParsed;

// --negative-prompt: pass through verbatim; use Kling's documented default if not supplied
const NEGATIVE_PROMPT = values["negative-prompt"] ?? "blur, distort, and low quality";

const DO_WEBM = !values["no-webm"];

// --scale: integer width in pixels for WebM output
const scaleArg = values.scale ?? "640";
const scaleParsed = parseInt(scaleArg, 10);
if (isNaN(scaleParsed) || scaleParsed <= 0) {
  console.error(`ERROR: --scale must be a positive integer (got '${scaleArg}')`);
  process.exit(1);
}
const SCALE = scaleParsed;

// --webm-crf: integer 0–63
const webmCrfArg = values["webm-crf"] ?? "32";
const webmCrfParsed = parseInt(webmCrfArg, 10);
if (isNaN(webmCrfParsed) || webmCrfParsed < 0 || webmCrfParsed > 63) {
  console.error(`ERROR: --webm-crf must be an integer between 0 and 63 (got '${webmCrfArg}')`);
  process.exit(1);
}
const WEBM_CRF = webmCrfParsed;

// Output directory (default: ~/Pictures/vidgen).
const OUT_DIR = values.out
  ? values.out.replace(/^~/, process.env.HOME ?? homedir())
  : `${process.env.HOME ?? homedir()}/Pictures/vidgen`;

mkdirSync(OUT_DIR, { recursive: true });

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
  if (result.status !== 0) {
    const stderr = result.stderr?.toString() ?? "";
    throw new Error(`ffmpeg failed (exit ${result.status}):\n${stderr}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
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
  }) as { data?: { video?: { url?: string } }; video?: { url?: string } };

  // fal.subscribe wraps the response in result.data; keep result.video.url as fallback.
  const videoUrl = result.data?.video?.url ?? (result as { video?: { url?: string } }).video?.url;
  if (!videoUrl) {
    throw new Error(
      `No video URL in response: ${JSON.stringify(result).slice(0, 500)}`
    );
  }

  // Download MP4.
  const mp4Path = join(OUT_DIR, `vidgen-${TIMESTAMP}.mp4`);
  console.log(`Downloading MP4…`);
  const resp = await fetch(videoUrl);
  if (!resp.ok) throw new Error(`Failed to download ${videoUrl}: ${resp.status} ${resp.statusText}`);
  const buf = await resp.arrayBuffer();
  writeFileSync(mp4Path, Buffer.from(buf));
  console.log(`video: ${mp4Path}`);

  const outputPaths: string[] = [mp4Path];
  let webmPath: string | undefined;

  if (DO_WEBM) {
    // Encode WebM (VP9) at target width, preserving aspect ratio.
    // -b:v 0 puts libvpx-vp9 into true CRF mode.
    // -row-mt 1 enables multi-threaded row encoding.
    // -an strips audio (Kling MP4 has none, but explicit insurance).
    webmPath = join(OUT_DIR, `vidgen-${TIMESTAMP}.webm`);
    console.log(`Encoding WebM…`);
    ffmpeg([
      "-y", "-i", mp4Path,
      "-vf", `scale=${SCALE}:-2`,
      "-c:v", "libvpx-vp9",
      "-crf", String(WEBM_CRF),
      "-b:v", "0",
      "-row-mt", "1",
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
