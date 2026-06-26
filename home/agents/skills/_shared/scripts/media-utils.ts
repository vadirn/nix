/**
 * media-utils.ts — shared helpers for imagen-* and vidgen-* workers.
 *
 * Deliberately minimal: only logic that is verbatim-identical across two or
 * more workers lives here. Don't add worker-specific concerns.
 */

import { existsSync } from "fs";
import os from "os";

// ---------------------------------------------------------------------------
// expandTilde
// ---------------------------------------------------------------------------
export function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return p.replace(/^~/, os.homedir());
  if (p.startsWith("~")) {
    console.error(`ERROR: ~user/ form not supported (got '${p}'); use absolute paths`);
    process.exit(1);
  }
  return p;
}

// ---------------------------------------------------------------------------
// sniffSourceMimes
//
// Accepts an array of file paths (already expanded / un-comma-split).
// Each worker is responsible for splitting/joining its own --source format
// before calling this function.
//
// Returns { resolved: string[], mimes: string[] } where:
//   resolved — absolute paths (tilde-expanded)
//   mimes    — detected MIME type per path (magic-byte primary, extension fallback)
//
// Exits the process on any validation error so callers don't need to check
// error returns.
// ---------------------------------------------------------------------------
const VALID_MIMES = ["image/png", "image/jpeg", "image/webp"];

export async function sniffSourceMimes(
  paths: string[],
): Promise<{ resolved: string[]; mimes: string[] }> {
  if (paths.length === 0) return { resolved: [], mimes: [] };
  if (paths.length > 10) {
    console.error(`ERROR: at most 10 --source images are supported (got ${paths.length})`);
    process.exit(1);
  }

  const resolved: string[] = [];
  const mimes: string[] = [];

  for (const p of paths) {
    const r = p.startsWith("~") ? expandTilde(p) : p;
    if (!existsSync(r)) {
      console.error(`ERROR: source file not found: ${r}`);
      process.exit(1);
    }

    // Magic-byte sniff (primary), fall back to extension/Bun type.
    const headBuf = await Bun.file(r).arrayBuffer();
    const head = new Uint8Array(headBuf.byteLength > 12 ? headBuf.slice(0, 12) : headBuf);
    let magicMime: string | null = null;
    if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
      magicMime = "image/png";
    } else if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
      magicMime = "image/jpeg";
    } else if (
      head[0] === 0x52 &&
      head[1] === 0x49 &&
      head[2] === 0x46 &&
      head[3] === 0x46 &&
      head[8] === 0x57 &&
      head[9] === 0x45 &&
      head[10] === 0x42 &&
      head[11] === 0x50
    ) {
      magicMime = "image/webp";
    } else if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38) {
      magicMime = "image/gif";
    }

    // Extension/Bun fallback.
    const bunFile = Bun.file(r);
    const bunMime = bunFile.type || "application/octet-stream";
    const extLower = r.toLowerCase();
    let extMime: string | null = null;
    if (extLower.endsWith(".png")) extMime = "image/png";
    else if (extLower.endsWith(".jpg") || extLower.endsWith(".jpeg")) extMime = "image/jpeg";
    else if (extLower.endsWith(".webp")) extMime = "image/webp";
    else if (VALID_MIMES.includes(bunMime)) extMime = bunMime;

    const detectedMime = magicMime ?? extMime;
    if (!detectedMime) {
      console.error(`ERROR: unsupported file type for source: ${r} (detected: ${bunMime})`);
      process.exit(1);
    }
    if (magicMime && extMime && magicMime !== extMime) {
      console.error(
        `WARNING: magic-byte MIME (${magicMime}) disagrees with extension MIME (${extMime}) for: ${r}`,
      );
    }

    resolved.push(r);
    mimes.push(detectedMime);
  }

  return { resolved, mimes };
}

// ---------------------------------------------------------------------------
// dryRunExit
//
// Print the resolved request payload as formatted JSON and exit without making
// any API call. Declared as `never` so TypeScript knows control does not return.
// ---------------------------------------------------------------------------
export function dryRunExit(payload: unknown): never {
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  process.exit(0);
}
