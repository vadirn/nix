#!/usr/bin/env bun
/**
 * imagen-fal.ts — generate images via fal.ai-hosted models (default: Kling Image O1)
 *
 * Usage:
 *   bun <skill-dir>/scripts/imagen-fal.ts "<prompt>" [flags]
 *
 * Invoked through doppler so FAL_KEY is present in env:
 *   doppler run -p claude-code -c std --no-fallback -- \
 *     bun <skill-dir>/scripts/imagen-fal.ts "<prompt>" [flags]
 */

import { fal } from "@fal-ai/client";
import { parseArgs } from "util";
import { existsSync, mkdirSync, writeFileSync, renameSync, appendFileSync } from "fs";
import { join, basename } from "path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
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

function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return join(os.homedir(), p.slice(2));
  if (p.startsWith("~")) {
    console.error(`ERROR: ~user/ form not supported (got '${p}'); use absolute paths`);
    process.exit(1);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------
function usage(): void {
  console.log(`\
Usage: imagen-fal.ts "<prompt>" [OPTIONS]

Generate images via fal.ai-hosted models.
Auto-selects fal-ai/kling-image/v3/text-to-image (t2i) when --source is absent,
fal-ai/kling-image/o1 (i2i) when --source is supplied. --model overrides both.

Positional:
  <prompt>               Required image description (quoted string).

Options:
  --source <paths>       Comma-separated reference image paths for multi-ref (up to 10).
  --drafts <N>           Number of variant images (default: 1).
  --model <id>           Model ID override (auto-selected if omitted; see above).
  --aspect <ratio>       Aspect ratio, e.g. 1:1, 16:9, 4:3.
  --resolution <1k|2k|4k>
                         Output resolution (default: 2k). fal Kling supports 1k and 2k;
                         4k is not available on fal and will be capped to 2k with a warning.
  --name <slug>          Output filename prefix (default: slugified prompt).
  --out <dir>            Output directory (default: ~/Pictures/imagen).
  --transparent          Run BiRefNet v2 after generation to remove background.
                         Saves the alpha result as a sibling <base>-alpha.png; the
                         original Kling PNG is kept. Controlled by --cutout.
  --cutout <birefnet|none>
                         Controls the cutout step when --transparent is set.
                         birefnet (default): run BiRefNet v2 and write <base>-alpha.png.
                         none: skip BiRefNet; only the raw Kling PNG is saved.
  -h, --help             Show this help and exit.

Environment:
  FAL_KEY                fal.ai API key (inject via doppler run -p claude-code -c std).

Example:
  doppler run -p claude-code -c std --no-fallback -- \\
    bun <skill-dir>/scripts/imagen-fal.ts \\
    "A cinematic samurai in rain, Kling style" --aspect 16:9 --drafts 3
`);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    source:      { type: "string" },
    drafts:      { type: "string" },
    model:       { type: "string" },
    aspect:      { type: "string" },
    resolution:  { type: "string" },
    name:        { type: "string" },
    out:         { type: "string" },
    transparent: { type: "boolean", default: false },
    cutout:      { type: "string" },
    help:        { type: "boolean", default: false, short: "h" },
  },
  allowPositionals: true,
});

if (values.help) {
  usage();
  process.exit(0);
}

const prompt = positionals[0] ?? "";
if (!prompt) {
  console.error("ERROR: a prompt is required");
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
// Kling on fal splits text-to-image from image-to-image into separate endpoints.
// Auto-pick: refs supplied → kling-image/o1 (i2i, requires image_urls);
// no refs → kling-image/v3/text-to-image (t2i). User --model overrides both.
const HAS_SOURCES = Boolean(values.source && values.source.trim());
const MODEL       = values.model
  ?? (HAS_SOURCES ? "fal-ai/kling-image/o1" : "fal-ai/kling-image/v3/text-to-image");

// Validate explicit --model override against --source presence.
// kling-image/o1 is image-to-image (requires --source).
// kling-image/v3/text-to-image is text-to-image (rejects image_urls).
if (values.model) {
  const isI2I = MODEL.includes("kling-image/o1");
  const isT2I = MODEL.includes("text-to-image");
  if (isI2I && !HAS_SOURCES) {
    console.error(`ERROR: --model ${MODEL} is image-to-image and requires --source`);
    process.exit(1);
  }
  if (isT2I && HAS_SOURCES) {
    console.error(`ERROR: --model ${MODEL} is text-to-image; remove --source or pick an i2i model`);
    process.exit(1);
  }
}
const draftsArg = values.drafts ?? "1";
if (!/^[0-9]+$/.test(draftsArg) || parseInt(draftsArg, 10) < 1) {
  console.error(`ERROR: --drafts must be a positive integer (got '${draftsArg}')`);
  process.exit(1);
}
const DRAFTS = parseInt(draftsArg, 10);
if (DRAFTS > 9) {
  console.error("ERROR: --drafts must be 9 or fewer (Kling API limit)");
  process.exit(1);
}
const VALID_ASPECTS_FAL = new Set(["16:9","9:16","1:1","4:3","3:4","3:2","2:3","21:9","auto"]);
if (values.aspect && !VALID_ASPECTS_FAL.has(values.aspect)) {
  console.error(`ERROR: --aspect must be one of: ${[...VALID_ASPECTS_FAL].join(", ")} (got '${values.aspect}')`);
  process.exit(1);
}
const ASPECT      = values.aspect ?? (HAS_SOURCES ? "auto" : "1:1");
const TRANSPARENT = values.transparent ?? false;

// --cutout: controls whether BiRefNet runs when --transparent is set.
// Accepted values: "birefnet" (default) or "none".
const cutoutRaw = (values.cutout ?? (TRANSPARENT ? "birefnet" : "none")).toLowerCase();
if (!["birefnet", "none"].includes(cutoutRaw)) {
  console.error(`ERROR: --cutout must be one of: birefnet, none (got '${values.cutout}')`);
  process.exit(1);
}
const CUTOUT = cutoutRaw as "birefnet" | "none";

// Resolution: map user-facing 1k/2k/4k to fal Kling image_size presets.
// fal Kling supports square_hd (1k) and square (512), but for rectangular
// we derive the image_size object from aspect + resolution.
// If user passes 4k, warn and cap to 2k.
let RESOLUTION = (values.resolution ?? "2k").toLowerCase();
if (RESOLUTION === "4k") {
  console.warn("WARNING: 4k resolution is not supported on fal Kling; capping to 2k.");
  RESOLUTION = "2k";
}
if (!["1k", "2k"].includes(RESOLUTION)) {
  console.error(`ERROR: --resolution must be one of: 1k, 2k, 4k`);
  process.exit(1);
}

// Output directory.
const OUT_DIR = values.out
  ? expandTilde(values.out)
  : join(os.homedir(), "Pictures", "imagen");

mkdirSync(OUT_DIR, { recursive: true });

// Name slug.
let NAME_SLUG = values.name ?? "";
if (!NAME_SLUG) {
  NAME_SLUG = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .replace(/-$/, "") || "image";
}

const TIMESTAMP = new Date()
  .toISOString()
  .replace(/[-:T]/g, "")
  .replace(/\.\d+Z$/, "") + `-${process.pid}`;

const LOG_FILE = join(OUT_DIR, "log.jsonl");

// ---------------------------------------------------------------------------
// Source images: upload to fal storage
// ---------------------------------------------------------------------------
async function uploadSources(sourceArg: string): Promise<string[]> {
  const paths = sourceArg.split(",").map((p) => p.trim()).filter(Boolean);
  if (paths.length === 0) return [];
  if (paths.length > 10) {
    console.error(`ERROR: at most 10 --source images are supported (got ${paths.length})`);
    process.exit(1);
  }

  const urls: string[] = [];
  for (const p of paths) {
    const resolved = p.startsWith("~") ? expandTilde(p) : p;
    if (!existsSync(resolved)) {
      console.error(`ERROR: source file not found: ${resolved}`);
      process.exit(1);
    }
    const meta = await Bun.file(resolved).image().metadata();
    console.log(`Uploading ${basename(resolved)} to fal storage…`);
    let blob: Blob;
    if (meta.width <= 2048 && meta.height <= 2048) {
      const file = Bun.file(resolved);
      blob = new Blob([await file.arrayBuffer()], { type: file.type || "image/png" });
    } else {
      const bytes = await Bun.file(resolved).image().resize(2048, 2048, { fit: "inside" }).webp({ quality: 85 }).bytes();
      console.log(`  (shrunk ${meta.width}x${meta.height} -> 2048-box webp)`);
      blob = new Blob([bytes], { type: "image/webp" });
    }
    const url = await fal.storage.upload(blob);
    urls.push(url);
  }
  return urls;
}

// ---------------------------------------------------------------------------
// Download a URL to disk; sniff extension from content-type.
// ---------------------------------------------------------------------------
async function downloadImage(url: string, destBase: string): Promise<string> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to download ${url}: ${resp.status} ${resp.statusText}`);
  const contentType = resp.headers.get("content-type") ?? "image/png";
  const ext = contentType.includes("webp") ? "webp"
            : contentType.includes("jpeg") || contentType.includes("jpg") ? "jpg"
            : "png";
  const dest = `${destBase}.${ext}`;
  const buf = await resp.arrayBuffer();
  writeFileSync(dest, Buffer.from(buf));
  return dest;
}

// ---------------------------------------------------------------------------
// BiRefNet v2 post-processing
// ---------------------------------------------------------------------------
async function applyBiRefNet(imagePath: string): Promise<string> {
  // Upload the local file to fal storage so BiRefNet can fetch it.
  const file = Bun.file(imagePath);
  const blob = new Blob([await file.arrayBuffer()], { type: file.type || "image/png" });
  console.log(`  [BiRefNet] uploading ${basename(imagePath)}…`);
  const imageUrl = await fal.storage.upload(blob);

  console.log(`  [BiRefNet] running background removal…`);
  const result = await withTimeout(fal.subscribe("fal-ai/birefnet/v2", {
    input: {
      image_url: imageUrl,
      model: "General Use (Heavy)",
      refine_foreground: true,
      operating_resolution: "2048x2048",
    },
    logs: false,
  }), 120_000, "fal.subscribe(BiRefNet)");
  const alphaUrl = (result as { data?: { image?: { url?: string } } })?.data?.image?.url;
  if (!alphaUrl) {
    throw new Error(
      `BiRefNet returned unexpected response shape: ${JSON.stringify(result).slice(0, 500)}`
    );
  }
  // Download alpha image to a sibling <base>-alpha.<ext>; keep the original.
  const alphaBase = imagePath.replace(/\.[^.]+$/, "");
  const tmpPath = await downloadImage(alphaUrl, `${alphaBase}-birefnet-tmp`);
  const ext = tmpPath.slice(tmpPath.lastIndexOf("."));  // e.g. ".png", ".webp"
  const alphaPath = `${alphaBase}-alpha${ext}`;
  renameSync(tmpPath, alphaPath);
  console.log(`  [BiRefNet] saved alpha image: ${alphaPath}`);
  return alphaPath;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  // Upload reference images if provided.
  const referenceUrls: string[] = values.source
    ? await uploadSources(values.source)
    : [];

  const savedPaths: string[] = [];
  const startMs = Date.now();

  // Build fal input. Kling Image O1 schema:
  //   prompt (required), image_urls (required for i2i — flat string array),
  //   resolution ("1K"|"2K"|"4K"), aspect_ratio (enum string), num_images (1-9).
  // image_size is a Flux/SDXL convention; Kling rejects it.
  const input: Record<string, unknown> = {
    prompt,
    num_images: DRAFTS,
    resolution: RESOLUTION.toUpperCase(),
  };
  if (ASPECT) input.aspect_ratio = ASPECT;
  if (referenceUrls.length > 0) {
    // Kling multi-ref: flat array of URL strings (NOT objects).
    input.image_urls = referenceUrls;
  }

  console.log(`Generating ${DRAFTS} image(s) via ${MODEL}…`);
  const result = await withTimeout(fal.subscribe(MODEL, {
    input,
    logs: false,
  }), 180_000, "fal.subscribe(Kling)") as { data: { images: Array<{ url: string; content_type?: string }> } };

  const images = result.data?.images ?? [];
  if (images.length === 0) {
    console.error("ERROR: fal returned no images");
    process.exit(1);
  }

  for (let i = 0; i < images.length; i++) {
    const img = images[i]!;
    const suffix = DRAFTS > 1 ? `-${i + 1}` : "";
    const destBase = join(OUT_DIR, `${NAME_SLUG}-${TIMESTAMP}${suffix}`);
    const rawPath = await downloadImage(img.url, destBase);

    savedPaths.push(rawPath);
    console.log(`image: ${rawPath}`);

    if (TRANSPARENT && CUTOUT === "birefnet") {
      try {
        const alphaPath = await applyBiRefNet(rawPath);
        savedPaths.push(alphaPath);
        console.log(`alpha: ${alphaPath}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`WARNING draft ${i + 1}: BiRefNet failed (${msg}); keeping opaque image only`);
      }
    }
  }

  const elapsedMs = Date.now() - startMs;

  // Emit JSON-lines log record (one per run, not per file — matches imagen.sh shape).
  const logRecord = {
    ts: new Date().toISOString(),
    prompt,
    model: MODEL,
    aspect: ASPECT,
    resolution: RESOLUTION,
    drafts: DRAFTS,
    transparent: TRANSPARENT,
    sources: values.source ? values.source.split(",").map((p) => p.trim()) : [],
    outputs: savedPaths,
    elapsed_ms: elapsedMs,
    // Cost estimate: Kling O1 ~$0.028/image + BiRefNet ~$0.003/image when cutout ran.
    cost_estimate_usd: parseFloat(
      (images.length * (0.028 + (TRANSPARENT && CUTOUT === "birefnet" ? 0.003 : 0))).toFixed(4)
    ),
  };

  // Append to log file (one JSON line).
  const logLine = JSON.stringify(logRecord) + "\n";
  try {
    appendFileSync(LOG_FILE, logLine);
  } catch {
    console.warn(`WARNING: could not write to log file: ${LOG_FILE}`);
  }

  console.log(`log: ${LOG_FILE}`);
  console.log(
    `cost_estimate: $${logRecord.cost_estimate_usd.toFixed(4)} ` +
    `(${images.length} image(s), elapsed ${elapsedMs}ms)`
  );

  // Emit one JSON-lines record per saved file (task acceptance criterion).
  const birefnetRan = TRANSPARENT && CUTOUT === "birefnet";
  for (const p of savedPaths) {
    const isAlpha = /-alpha\.[^.]+$/.test(p);
    process.stdout.write(
      JSON.stringify({
        path: p,
        kind: isAlpha ? "alpha" : "raw",
        model: MODEL,
        transparent: TRANSPARENT,
        cutout: CUTOUT,
        prompt,
        cost_estimate_usd: parseFloat(
          (isAlpha ? (birefnetRan ? 0.003 : 0) : 0.028).toFixed(4)
        ),
      }) + "\n"
    );
  }
}

main().catch((err) => {
  console.error("ERROR:", err instanceof Error ? err.message : String(err));
  // fal SDK ValidationError carries the offending fields in .body — surface them.
  const body = (err as { body?: unknown })?.body;
  if (body !== undefined) {
    console.error("DETAIL:", typeof body === "string" ? body : JSON.stringify(body, null, 2));
  }
  process.exit(1);
});
