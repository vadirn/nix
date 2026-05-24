#!/usr/bin/env bun
/**
 * vidgen-fal.ts — generate a looped GIF (+ MP4 source) via fal.ai video models
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

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------
function usage(): void {
  console.log(`\
Usage: vidgen-fal.ts --prompt "<text>" [OPTIONS]

Generate a seamless looped GIF (and MP4 source) via fal.ai AnimateDiff.
The ffmpeg pipeline runs locally: pingpong reverse-concat → palettegen → paletteuse.

Options:
  --prompt <text>      Required. Text description of the video to generate.
  --out <dir>          Output directory (default: cwd).
  --frames <n>         Number of frames to generate (default: 16, max 32).
  --fps <n>            Frames per second (default: 8, max 16).
  --endpoint <id>      fal endpoint ID (default: fal-ai/fast-animatediff/text-to-video).
  --no-gif             Skip GIF stage; keep MP4 only.
  --no-pingpong        Single-pass MP4 → GIF; skip reverse-concat step.
  -h, --help           Show this help and exit.

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
    prompt:        { type: "string" },
    out:           { type: "string" },
    frames:        { type: "string" },
    fps:           { type: "string" },
    endpoint:      { type: "string" },
    "no-gif":      { type: "boolean", default: false },
    "no-pingpong": { type: "boolean", default: false },
    help:          { type: "boolean", default: false, short: "h" },
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
const ENDPOINT = values.endpoint ?? "fal-ai/fast-animatediff/text-to-video";

const framesArg = values.frames ?? "16";
if (!/^[0-9]+$/.test(framesArg)) {
  console.error(`ERROR: --frames must be a positive integer (got '${framesArg}')`);
  process.exit(1);
}
const NUM_FRAMES = Math.min(parseInt(framesArg, 10) || 16, 32);

const fpsArg = values.fps ?? "8";
if (!/^[0-9]+$/.test(fpsArg)) {
  console.error(`ERROR: --fps must be a positive integer (got '${fpsArg}')`);
  process.exit(1);
}
const FPS = Math.min(parseInt(fpsArg, 10) || 8, 16);

const DO_GIF      = !values["no-gif"];
const DO_PINGPONG = !values["no-pingpong"];

// Output directory (default: cwd).
const OUT_DIR = values.out
  ? values.out.replace(/^~/, process.env.HOME ?? "~")
  : process.cwd();

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

  // Call fal endpoint.
  // AnimateDiff real param names (from schema): prompt, num_frames, fps, video_size,
  // negative_prompt, num_inference_steps, guidance_scale, seed.
  console.log(`Generating video via ${ENDPOINT}…`);
  const result = await fal.subscribe(ENDPOINT, {
    input: {
      prompt: PROMPT,
      num_frames: NUM_FRAMES,
      fps: FPS,
    },
    logs: false,
  }) as { data?: { video?: { url?: string } }; video?: { url?: string } };

  // AnimateDiff wraps output in result.data.video.url when using fal.subscribe.
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

    // Step B: generate palette.
    const palettePath = join(OUT_DIR, `vidgen-${TIMESTAMP}-palette.png`);
    console.log(`Generating palette…`);
    ffmpeg([
      "-y", "-i", gifSource,
      "-vf", `fps=${FPS},palettegen=stats_mode=full`,
      palettePath,
    ]);

    // Step C: encode GIF.
    const gifPath = join(OUT_DIR, `vidgen-${TIMESTAMP}.gif`);
    console.log(`Encoding GIF…`);
    ffmpeg([
      "-y", "-i", gifSource, "-i", palettePath,
      "-lavfi", `fps=${FPS}[v];[v][1:v]paletteuse=dither=sierra2_4a`,
      gifPath,
    ]);

    // Clean up intermediate files (pingpong MP4, palette PNG).
    if (DO_PINGPONG && existsSync(join(OUT_DIR, `vidgen-${TIMESTAMP}-pingpong.mp4`))) {
      try { Bun.file(join(OUT_DIR, `vidgen-${TIMESTAMP}-pingpong.mp4`)); } catch { /* ignore */ }
    }
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
    num_frames: NUM_FRAMES,
    fps: FPS,
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
        num_frames: NUM_FRAMES,
        fps: FPS,
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
