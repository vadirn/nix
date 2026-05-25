#!/usr/bin/env bun
/**
 * imagen-nanobanana.ts — generate images via Google Gemini image models
 *
 * Usage:
 *   bun <skill-dir>/scripts/imagen-nanobanana.ts "<prompt>" [flags]
 *
 * Invoked through doppler so GEMINI_API_KEY is present in env:
 *   doppler run -p claude-code -c std --no-fallback -- \
 *     bun <skill-dir>/scripts/imagen-nanobanana.ts "<prompt>" [flags]
 */

import { parseArgs } from "util";
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "fs";
import { join, dirname } from "path";
import os from "os";

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------
function usage(): void {
  console.log(`\
Usage: imagen-nanobanana.ts "<prompt>" [OPTIONS]

Generate images via Google Gemini image models (default: gemini-3.1-flash-image-preview).

Positional:
  <prompt>               Required image description (quoted string).

Options:
  --source <path>        Image file to edit/compose/reference. Repeatable, up to 10.
  --drafts <N>           Number of images to generate, 1-8 (default: 1).
  --model <M>            Model name (default: gemini-3.1-flash-image-preview).
  --aspect <ratio>       Aspect ratio: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4,
                         9:16, 16:9, 21:9 (default: 1:1).
  --resolution <R>       Output resolution: 512, 1K, 2K, 4K (default: 2K).
                         Not supported by gemini-2.5-flash-image.
  --name <slug>          Output filename slug (default: slugified first ~5 prompt words).
  --out <path>           Explicit output path. Valid only with --drafts 1.
  --transparent          Signals chroma-key mode. Default --cutout when set: colorkey.
                         The script generates the image and runs ffmpeg colorkey in-process.
  --cutout <colorkey|none>
                         Controls the post-process step when --transparent is set.
                         colorkey (default): run ffmpeg colorkey+despill and write
                         <base>-alpha.png sibling. none: skip; keep raw image only.
  --chroma-key-fallback  Deprecated alias for --transparent --cutout colorkey.
  -h, --help             Show this help and exit.

Environment:
  GEMINI_API_KEY         Google API key (inject via doppler run -p claude-code -c std).
  IMAGEN_DIR             Output directory (default: ~/Pictures/imagen).

Example:
  doppler run -p claude-code -c std --no-fallback -- \\
    bun <skill-dir>/scripts/imagen-nanobanana.ts \\
    "A sunlit forest path in watercolour style" --aspect 16:9 --drafts 3
`);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    source:               { type: "string", multiple: true },
    drafts:               { type: "string" },
    model:                { type: "string" },
    aspect:               { type: "string" },
    resolution:           { type: "string" },
    name:                 { type: "string" },
    out:                  { type: "string" },
    transparent:          { type: "boolean", default: false },
    cutout:               { type: "string" },
    "chroma-key-fallback": { type: "boolean", default: false },
    help:                 { type: "boolean", default: false, short: "h" },
  },
  allowPositionals: true,
});

if (values.help) {
  usage();
  process.exit(0);
}

// Handle deprecated --chroma-key-fallback
let chromaKeyFallback = values["chroma-key-fallback"] ?? false;
let transparent = values.transparent ?? false;
let cutoutOverride = values.cutout;

if (chromaKeyFallback) {
  console.error("WARNING: --chroma-key-fallback is deprecated; use --transparent --cutout colorkey instead");
  transparent = true;
  cutoutOverride = cutoutOverride ?? "colorkey";
}

const prompt = positionals[0] ?? "";
if (!prompt) {
  console.error("ERROR: a prompt is required");
  usage();
  process.exit(1);
}

// ---------------------------------------------------------------------------
// GEMINI_API_KEY — fail fast
// ---------------------------------------------------------------------------
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error(
    "ERROR: GEMINI_API_KEY is not set.\n" +
    "Inject it via: doppler run -p claude-code -c std --no-fallback --"
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Resolve options
// ---------------------------------------------------------------------------
const MODEL = values.model ?? "gemini-3.1-flash-image-preview";
const SUPPORTS_IMAGE_SIZE = MODEL !== "gemini-2.5-flash-image";

const draftsArg = values.drafts ?? "1";
if (!/^\d+$/.test(draftsArg) || parseInt(draftsArg, 10) < 1) {
  console.error(`ERROR: --drafts must be a positive integer (got '${draftsArg}')`);
  process.exit(1);
}
const DRAFTS = parseInt(draftsArg, 10);
if (DRAFTS > 8) {
  console.error("ERROR: --drafts must be 8 or fewer");
  process.exit(1);
}

// --out only valid with --drafts 1
if (values.out && DRAFTS !== 1) {
  console.error("ERROR: --out is only valid with --drafts 1");
  process.exit(1);
}

// Warn if --model was explicit and resolution was explicit for gemini-2.5-flash-image
if (!SUPPORTS_IMAGE_SIZE && values.resolution) {
  console.error(`WARNING: --resolution is ignored for model ${MODEL} (fixed size)`);
}

// Validate and normalize --resolution
const VALID_RESOLUTIONS = ["512", "1k", "2k", "4k"];
let RESOLUTION = (values.resolution ?? "2K").toLowerCase();
if (!VALID_RESOLUTIONS.includes(RESOLUTION)) {
  console.error(`ERROR: --resolution must be one of: 512, 1K, 2K, 4K`);
  process.exit(1);
}
// Keep the casing the API expects (shell script uses uppercase)
const RESOLUTION_API = RESOLUTION.toUpperCase();

// Validate --aspect
const VALID_ASPECTS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const ASPECT = (values.aspect ?? "1:1");
if (!VALID_ASPECTS.includes(ASPECT)) {
  console.error(`ERROR: --aspect must be one of: ${VALID_ASPECTS.join(", ")}`);
  process.exit(1);
}

// Validate --cutout
const TRANSPARENT = transparent;
const cutoutDefault = TRANSPARENT ? "colorkey" : "none";
const cutoutRaw = (cutoutOverride ?? cutoutDefault).toLowerCase();
if (!["colorkey", "none"].includes(cutoutRaw)) {
  console.error(`ERROR: --cutout must be one of: colorkey, none (got '${values.cutout}')`);
  process.exit(1);
}
const CUTOUT = cutoutRaw as "colorkey" | "none";

// Warn if --cutout was explicitly supplied without --transparent
if (!TRANSPARENT && values.cutout !== undefined) {
  console.warn(`WARNING: --cutout has no effect unless --transparent is set`);
}

// Validate source files
const SOURCES: string[] = (values.source ?? []).map((p) => {
  if (p.startsWith("~/") || p === "~") return p.replace(/^~/, os.homedir());
  if (p.startsWith("~")) {
    console.error(`ERROR: ~user/ form not supported (got '${p}'); use absolute paths`);
    process.exit(1);
  }
  return p;
});
if (SOURCES.length > 10) {
  console.error(`ERROR: at most 10 --source images are supported (got ${SOURCES.length})`);
  process.exit(1);
}
const VALID_MIMES = ["image/png", "image/jpeg", "image/webp"];
const SOURCE_MIMES: string[] = [];
for (const src of SOURCES) {
  if (!existsSync(src)) {
    console.error(`ERROR: source file not found: ${src}`);
    process.exit(1);
  }
  // Fix N3: magic-byte sniff (primary), fall back to extension/Bun type
  const headBuf = await Bun.file(src).arrayBuffer();
  const head = new Uint8Array(headBuf.byteLength > 12 ? headBuf.slice(0, 12) : headBuf);
  let magicMime: string | null = null;
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
    magicMime = "image/png";
  } else if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    magicMime = "image/jpeg";
  } else if (
    head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
    head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50
  ) {
    magicMime = "image/webp";
  } else if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38) {
    magicMime = "image/gif";
  }
  // Extension/Bun fallback
  const bunFile = Bun.file(src);
  const bunMime = bunFile.type || "application/octet-stream";
  const extLower = src.toLowerCase();
  let extMime: string | null = null;
  if (extLower.endsWith(".png")) extMime = "image/png";
  else if (extLower.endsWith(".jpg") || extLower.endsWith(".jpeg")) extMime = "image/jpeg";
  else if (extLower.endsWith(".webp")) extMime = "image/webp";
  else if (VALID_MIMES.includes(bunMime)) extMime = bunMime;
  const detectedMime = magicMime ?? extMime;
  if (!detectedMime) {
    console.error(`ERROR: unsupported file type for source: ${src} (detected: ${bunMime})`);
    process.exit(1);
  }
  if (magicMime && extMime && magicMime !== extMime) {
    console.error(`WARNING: magic-byte MIME (${magicMime}) disagrees with extension MIME (${extMime}) for: ${src}`);
  }
  SOURCE_MIMES.push(detectedMime);
}

// Output directory
function expandTilde(p: string): string {
  if (p.startsWith("~/") || p === "~") return p.replace(/^~/, os.homedir());
  if (p.startsWith("~")) {
    console.error(`ERROR: ~user/ form not supported (got '${p}'); use absolute paths`);
    process.exit(1);
  }
  return p;
}

const IMAGEN_DIR = process.env.IMAGEN_DIR
  ? expandTilde(process.env.IMAGEN_DIR)
  : join(os.homedir(), "Pictures", "imagen");

mkdirSync(IMAGEN_DIR, { recursive: true });

// For explicit --out, create parent dir
let OUT_PATH = values.out ? expandTilde(values.out) : "";
if (OUT_PATH) {
  mkdirSync(dirname(OUT_PATH), { recursive: true });
}

// Name slug
let NAME_SLUG = values.name ?? "";
if (!NAME_SLUG) {
  NAME_SLUG =
    prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40)
      .replace(/-$/, "") || "image";
}

const TIMESTAMP =
  new Date()
    .toISOString()
    .replace(/[-:T]/g, "")
    .replace(/\.\d+Z$/, "") +
  `-${process.pid}`;

const LOG_FILE = join(IMAGEN_DIR, "log.jsonl");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function mimeToExt(mime: string): string {
  switch (mime) {
    case "image/png":  return "png";
    case "image/jpeg": return "jpg";
    case "image/webp": return "webp";
    default:
      console.error(`WARNING: unknown MIME type '${mime}'; defaulting to png`);
      return "png";
  }
}

// ---------------------------------------------------------------------------
// Single-draft API call
// ---------------------------------------------------------------------------
type DraftResult =
  | { ok: true; data: Buffer; mime: string; usageMetadata: Record<string, unknown> }
  | { ok: false; error: string };

async function runDraft(): Promise<DraftResult> {
  // Build inline_data parts for source images (ARG_MAX fix: encode in-process)
  const imageParts: Array<{ inline_data: { mime_type: string; data: string } }> = [];
  for (let i = 0; i < SOURCES.length; i++) {
    const buf = await Bun.file(SOURCES[i]!).arrayBuffer();
    const b64 = Buffer.from(buf).toString("base64");
    imageParts.push({ inline_data: { mime_type: SOURCE_MIMES[i]!, data: b64 } });
  }

  const parts: Array<{ text: string } | { inline_data: { mime_type: string; data: string } }> = [
    { text: prompt },
    ...imageParts,
  ];

  const imageConfig: Record<string, string> = { aspectRatio: ASPECT };
  if (SUPPORTS_IMAGE_SIZE) {
    imageConfig.imageSize = RESOLUTION_API;
  }

  const body = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig,
    },
  };

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

  let resp: Response;
  try {
    resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY!,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const responseText = await resp.text();

  if (!resp.ok) {
    return { ok: false, error: `HTTP ${resp.status}: ${responseText}` };
  }

  let json: unknown;
  try {
    json = JSON.parse(responseText);
  } catch {
    return { ok: false, error: `Failed to parse response JSON: ${responseText.slice(0, 200)}` };
  }

  // Walk candidates[0].content.parts for inlineData
  const parts0 = (
    (json as { candidates?: Array<{ content?: { parts?: unknown[] } }> })
      ?.candidates?.[0]?.content?.parts ?? []
  ) as Array<Record<string, unknown>>;

  const inlineParts = parts0.filter((p) => p.inlineData != null);
  if (inlineParts.length === 0) {
    // Safety refusal or text-only
    const textParts = parts0
      .filter((p) => typeof p.text === "string")
      .map((p) => p.text as string)
      .join(" ");
    const finishReason =
      (json as { candidates?: Array<{ finishReason?: string }> })
        ?.candidates?.[0]?.finishReason ?? "";
    return {
      ok: false,
      error: `No image in response. finishReason: ${finishReason}. text: ${textParts}`,
    };
  }

  const first = inlineParts[0]!;
  const inlineData = first.inlineData as { mimeType?: string; data?: string };
  const mime = inlineData.mimeType ?? "image/png";
  const data = inlineData.data ?? "";

  // Fix N1: reject empty payloads
  if (data === "" || Buffer.from(data, "base64").length === 0) {
    return { ok: false, error: "empty image data from API" };
  }

  // Fix N5: capture usageMetadata
  const usageMetadata =
    ((json as { usageMetadata?: Record<string, unknown> })?.usageMetadata) ?? {};

  return { ok: true, data: Buffer.from(data, "base64"), mime, usageMetadata };
}

// ---------------------------------------------------------------------------
// Colorkey post-process (ffmpeg colorkey + despill)
// ---------------------------------------------------------------------------
async function applyColorkey(imagePath: string): Promise<string> {
  const alphaBase = imagePath.replace(/\.[^.]+$/, "-alpha");
  const alphaPath = `${alphaBase}.png`;

  const proc = Bun.spawn([
    "ffmpeg",
    "-nostats", "-loglevel", "error", "-hide_banner",
    "-y",
    "-i", imagePath,
    "-vf", "colorkey=0x00ff00:0.30:0.20,despill=type=green:mix=0.5:expand=0,format=rgba",
    alphaPath,
  ], {
    stdout: "ignore",
    stderr: "pipe",
  });

  const stderrText = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`ffmpeg exited with code ${exitCode}: ${stderrText.trim()}`);
  }

  // Fix N2: verify ffmpeg actually wrote the output file
  if (!existsSync(alphaPath)) {
    throw new Error(`ffmpeg exited 0 but produced no file at ${alphaPath}`);
  }

  console.log(`  [colorkey] saved alpha PNG: ${alphaPath}`);
  return alphaPath;
}

// ---------------------------------------------------------------------------
// Bounded-concurrency runner (max 2 in flight)
// ---------------------------------------------------------------------------
async function runWithConcurrency<T>(
  count: number,
  concurrency: number,
  fn: (i: number) => Promise<T>
): Promise<T[]> {
  const results: T[] = new Array(count);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < count) {
      const i = next++;
      results[i] = await fn(i);
    }
  }

  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(concurrency, count); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const savedPaths: string[] = [];
  const startMs = Date.now();

  console.log(`Generating ${DRAFTS} image(s) via ${MODEL}…`);

  // Build output path for each draft (extension placeholder .png; corrected after response)
  function draftOutBase(i: number): string {
    if (OUT_PATH) return OUT_PATH.replace(/\.[^.]+$/, ""); // strip extension for base
    const suffix = DRAFTS > 1 ? `-${i + 1}` : "";
    return join(IMAGEN_DIR, `${NAME_SLUG}-${TIMESTAMP}${suffix}`);
  }

  const draftResults = await runWithConcurrency(DRAFTS, 2, async (i) => {
    const result = await runDraft();
    return { i, result };
  });

  // Fix N5: keep the first non-empty usageMetadata (matches shell FIRST_USAGE behaviour)
  let firstUsage: Record<string, unknown> = {};

  let successCount = 0;
  for (const { i, result } of draftResults) {
    if (!result.ok) {
      console.error(`ERROR draft ${i + 1}: ${result.error}`);
      continue;
    }

    const ext = mimeToExt(result.mime);
    let finalPath: string;

    if (OUT_PATH) {
      finalPath = OUT_PATH;
      // Warn if extension disagrees
      const outExt = OUT_PATH.split(".").pop()?.toLowerCase().replace("jpeg", "jpg") ?? "";
      if (outExt && outExt !== ext) {
        console.error(
          `WARNING draft ${i + 1}: --out extension does not match returned format (${result.mime}); file kept at ${finalPath}`
        );
      }
    } else {
      finalPath = `${draftOutBase(i)}.${ext}`;
    }

    writeFileSync(finalPath, result.data);
    savedPaths.push(finalPath);
    console.log(`image: ${finalPath}`);
    successCount++;

    // Fix N5: record first non-empty usageMetadata
    if (Object.keys(firstUsage).length === 0 && Object.keys(result.usageMetadata).length > 0) {
      firstUsage = result.usageMetadata;
    }

    if (TRANSPARENT && CUTOUT === "colorkey") {
      try {
        const alphaPath = await applyColorkey(finalPath);
        savedPaths.push(alphaPath);
        console.log(`alpha: ${alphaPath}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`WARNING draft ${i + 1}: colorkey failed (${msg}); keeping opaque image only`);
      }
    }
  }

  if (successCount === 0) {
    console.error("ERROR: no images were generated");
    process.exit(1);
  }

  console.log(`${successCount}/${DRAFTS} drafts generated`);

  const elapsedMs = Date.now() - startMs;

  // Log record
  const logRecord = {
    ts: new Date().toISOString(),
    prompt,
    model: MODEL,
    aspect: ASPECT,
    resolution: RESOLUTION_API,
    drafts_requested: DRAFTS,
    drafts_completed: successCount,
    chroma_key_fallback: chromaKeyFallback,
    transparent: TRANSPARENT,
    cutout: CUTOUT,
    sources: SOURCES,
    outputs: savedPaths,
    elapsed_ms: elapsedMs,
    usage: firstUsage,
  };

  const logLine = JSON.stringify(logRecord) + "\n";
  try {
    appendFileSync(LOG_FILE, logLine);
  } catch {
    console.warn(`WARNING: could not write to log file: ${LOG_FILE}`);
  }

  console.log(`log: ${LOG_FILE}`);

  // JSON-lines per saved file
  for (const p of savedPaths) {
    const isAlpha = p.endsWith("-alpha.png");
    process.stdout.write(
      JSON.stringify({
        path: p,
        kind: isAlpha ? "alpha" : "raw",
        model: MODEL,
        transparent: TRANSPARENT,
        cutout: CUTOUT,
        prompt,
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
