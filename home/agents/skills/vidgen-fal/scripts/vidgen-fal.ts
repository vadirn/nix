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
import { join } from "path";
import { homedir } from "os";
import { expandTilde, dryRunExit } from "@skills/media/media-utils.ts";
import { renderVideo, type KlingInput } from "./render.ts";

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------
const ENDPOINT_STANDARD = "fal-ai/kling-video/v1.6/standard/text-to-video";
const ENDPOINT_PRO = "fal-ai/kling-video/v1.6/pro/text-to-video";

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
  --dry-run                  Resolve all options, print the request payload as JSON and
                             exit without calling fal or writing any file.
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
    prompt: { type: "string" },
    out: { type: "string" },
    duration: { type: "string" },
    "aspect-ratio": { type: "string" },
    "cfg-scale": { type: "string" },
    "negative-prompt": { type: "string" },
    pro: { type: "boolean", default: false },
    webm: { type: "boolean", default: false },
    scale: { type: "string" },
    "webm-crf": { type: "string" },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", default: false, short: "h" },
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

const DRY_RUN = values["dry-run"] ?? false;

// ---------------------------------------------------------------------------
// FAL_KEY — fail fast unless we are just printing help or doing a dry-run
// ---------------------------------------------------------------------------
const FAL_KEY = process.env.FAL_KEY;
if (!FAL_KEY && !DRY_RUN) {
  console.error(
    "ERROR: FAL_KEY is not set.\n" +
      "Inject it via: doppler run -p claude-code -c std --no-fallback --",
  );
  process.exit(1);
}

if (FAL_KEY) fal.config({ credentials: FAL_KEY });

// ---------------------------------------------------------------------------
// Resolve options
// ---------------------------------------------------------------------------
const ENDPOINT = values.pro ? ENDPOINT_PRO : ENDPOINT_STANDARD;

// --duration: string enum "5" | "10"
const VALID_DURATIONS = ["5", "10"] as const;
type Duration = (typeof VALID_DURATIONS)[number];
const durationArg = values.duration ?? "5";
if (!(VALID_DURATIONS as readonly string[]).includes(durationArg)) {
  console.error(`ERROR: --duration must be "5" or "10" (got '${durationArg}')`);
  process.exit(1);
}
const DURATION = durationArg as Duration;

// --aspect-ratio: string enum
const VALID_ASPECT_RATIOS = ["16:9", "9:16", "1:1"] as const;
type AspectRatio = (typeof VALID_ASPECT_RATIOS)[number];
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

let SCALE = 640;
let WEBM_CRF = 32;

if (DO_WEBM) {
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
  SCALE = scaleParsed;

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
  WEBM_CRF = webmCrfParsed;
} else {
  // Warn if --scale or --webm-crf were explicitly supplied without --webm
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

const TIMESTAMP =
  new Date()
    .toISOString()
    .replace(/[-:T]/g, "")
    .replace(/\.\d+Z$/, "")
    .replace(/^(\d{8})(\d{6})$/, "$1-$2") + `-${process.pid}`;

const LOG_FILE = join(OUT_DIR, "log.jsonl");

// The exact Kling input, shared by the --dry-run payload and the live call so the
// two cannot drift — printing it is what makes the dry run assertable.
const INPUT: KlingInput = {
  prompt: PROMPT,
  duration: DURATION,
  aspect_ratio: ASPECT_RATIO,
  negative_prompt: NEGATIVE_PROMPT,
  cfg_scale: CFG_SCALE,
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  // ---------------------------------------------------------------------------
  // --dry-run: print the resolved request payload and exit (no API call, no writes)
  // ---------------------------------------------------------------------------
  if (DRY_RUN) {
    dryRunExit({
      endpoint: ENDPOINT,
      input: INPUT,
      out_dir: OUT_DIR,
      webm: DO_WEBM,
      scale: SCALE,
      webm_crf: WEBM_CRF,
    });
  }

  await renderVideo(
    {
      endpoint: ENDPOINT,
      input: INPUT,
      outDir: OUT_DIR,
      timestamp: TIMESTAMP,
      logFile: LOG_FILE,
      webm: DO_WEBM,
      scale: SCALE,
      webmCrf: WEBM_CRF,
    },
    { subscribe: (endpoint, options) => fal.subscribe(endpoint, options) },
  );
}

main().catch((err) => {
  console.error("ERROR:", err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  const body = (err as { body?: unknown })?.body;
  if (body !== undefined) {
    console.error("DETAIL:", typeof body === "string" ? body : JSON.stringify(body, null, 2));
  }
  process.exit(1);
});
