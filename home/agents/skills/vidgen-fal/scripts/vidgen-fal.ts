#!/usr/bin/env bun
/**
 * vidgen-fal.ts — generate a looped GIF (+ MP4 source) via fal.ai Kling video
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
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from "fs";
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

Generate a seamless looped GIF (and MP4 source) via fal.ai Kling video.
The ffmpeg pipeline runs locally: pingpong reverse-concat → palettegen → paletteuse.

Options:
  --prompt <text>            Required. Text description of the video to generate.
  --out <dir>                Output directory (default: ~/Pictures/vidgen).
  --duration <5|10>          Clip length in seconds (default: 5).
  --aspect-ratio <16:9|9:16|1:1>
                             Aspect ratio (default: 16:9).
  --cfg-scale <0-1>          Prompt adherence, 0–1 float (default: 0.5).
  --negative-prompt <text>   Negative prompt (default: "blur, distort, and low quality").
  --pro                      Use the pro tier endpoint (higher quality, ~$0.49/5s).
  --no-gif                   Skip GIF stage; keep MP4 only.
  --no-pingpong              Single-pass MP4 → GIF; skip reverse-concat step.
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
    "no-gif":         { type: "boolean", default: false },
    "no-pingpong":    { type: "boolean", default: false },
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

const DO_GIF      = !values["no-gif"];
const DO_PINGPONG = !values["no-pingpong"];

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

  if (DO_GIF) {
    // Determine the source for palette/encode steps.
    let gifSource = mp4Path;

    if (DO_PINGPONG) {
      // Step A: reverse-concat into a pingpong MP4.
      const pingpongPath = join(OUT_DIR, `vidgen-${TIMESTAMP}-pingpong.mp4`);
      console.log(`Running ffmpeg pingpong…`);
      ffmpeg([
        "-y", "-i", mp4Path,
        "-filter_complex", "[0]reverse[r];[0][r]concat=n=2:v=1",
        "-an", pingpongPath,
      ]);
      gifSource = pingpongPath;
    }

    // Step B: generate palette from source fps (no fps override — mirror source rate).
    const palettePath = join(OUT_DIR, `vidgen-${TIMESTAMP}-palette.png`);
    console.log(`Generating palette…`);
    ffmpeg([
      "-y", "-i", gifSource,
      "-vf", "palettegen=stats_mode=full",
      palettePath,
    ]);

    // Step C: encode GIF at source fps (no fps override).
    const gifPath = join(OUT_DIR, `vidgen-${TIMESTAMP}.gif`);
    console.log(`Encoding GIF…`);
    ffmpeg([
      "-y", "-i", gifSource, "-i", palettePath,
      "-lavfi", "[0:v][1:v]paletteuse=dither=sierra2_4a",
      gifPath,
    ]);

    // Clean up intermediate files (pingpong MP4, palette PNG).
    try {
      const { unlinkSync } = await import("fs");
      if (existsSync(palettePath)) unlinkSync(palettePath);
      if (DO_PINGPONG) {
        const ppPath = join(OUT_DIR, `vidgen-${TIMESTAMP}-pingpong.mp4`);
        if (existsSync(ppPath)) unlinkSync(ppPath);
      }
    } catch { /* best-effort cleanup */ }

    outputPaths.push(gifPath);
    console.log(`gif: ${gifPath}`);
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
    gif: DO_GIF,
    pingpong: DO_PINGPONG,
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
    const ext = p.endsWith(".gif") ? "gif" : "video";
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
