/**
 * Source-image upload preparation, split out of imagen-fal.ts so it is reachable
 * from a test: imagen-fal.ts parses argv and runs main() at import, so nothing
 * defined there can be imported without running the CLI.
 *
 * prepareUploadBlob is network-free — it is the half that touches Bun.file().image(),
 * which is the half that broke. uploadSources takes its uploader as a parameter so
 * the loop can run against a fake.
 */
import { basename } from "path";

// fal storage rejects oversized inputs; Kling gains nothing above a 2048 box.
const MAX_EDGE = 2048;
const WEBP_QUALITY = 85;

export interface PreparedBlob {
  blob: Blob;
  /** Set when the source was downscaled, for the caller to log. */
  shrunkFrom?: { width: number; height: number };
}

/**
 * Read an image and return the blob to upload, downscaling into a MAX_EDGE box
 * (preserving aspect) only when it exceeds one. Images within the box upload as-is
 * so no re-encode is spent on them.
 */
export async function prepareUploadBlob(path: string, mime: string): Promise<PreparedBlob> {
  const meta = await Bun.file(path).image().metadata();

  if (meta.width <= MAX_EDGE && meta.height <= MAX_EDGE) {
    const bytes = await Bun.file(path).arrayBuffer();
    return { blob: new Blob([bytes], { type: mime }) };
  }

  const bytes = await Bun.file(path)
    .image()
    .resize(MAX_EDGE, MAX_EDGE, { fit: "inside" })
    .webp({ quality: WEBP_QUALITY })
    .bytes();

  return {
    blob: new Blob([bytes], { type: "image/webp" }),
    shrunkFrom: { width: meta.width, height: meta.height },
  };
}

/** Upload each source in order, returning the fal storage URLs. */
export async function uploadSources(
  resolvedPaths: string[],
  mimes: string[],
  upload: (blob: Blob) => Promise<string>,
  log: (msg: string) => void = console.log,
): Promise<string[]> {
  const urls: string[] = [];

  for (const [i, path] of resolvedPaths.entries()) {
    const { blob, shrunkFrom } = await prepareUploadBlob(path, mimes[i]!);
    log(`Uploading ${basename(path)} to fal storage…`);
    if (shrunkFrom) {
      log(`  (shrunk ${shrunkFrom.width}x${shrunkFrom.height} -> ${MAX_EDGE}-box webp)`);
    }
    urls.push(await upload(blob));
  }

  return urls;
}
