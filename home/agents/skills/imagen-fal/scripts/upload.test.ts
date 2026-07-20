/**
 * Unit test: source-image upload preparation.
 *
 * Run:
 *   bun test upload.test.ts
 *
 * Covers the half of the upload path that broke unnoticed — Bun.file().image() —
 * plus the pass-through/downscale branch choice and the uploadSources loop.
 * No API calls: uploadSources takes its uploader as a parameter.
 */

import { describe, it, expect, afterAll, beforeAll } from "bun:test";
import { rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { prepareUploadBlob, uploadSources } from "./upload.ts";

// A genuine 1x1 PNG; every fixture below is resized from it, so the decoder sees
// real image data rather than a hand-assembled header.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const TMP_DIR = join(tmpdir(), `imagenfal-upload-test-${process.pid}`);

const SMALL_PNG = join(TMP_DIR, "small.png"); // 800x600 — within the 2048 box
const LARGE_PNG = join(TMP_DIR, "large.png"); // 3000x2000 — exceeds it

beforeAll(async () => {
  mkdirSync(TMP_DIR, { recursive: true });
  await Bun.write(join(TMP_DIR, "seed.png"), PNG_1X1);
  const seed = join(TMP_DIR, "seed.png");
  await Bun.write(SMALL_PNG, await Bun.file(seed).image().resize(800, 600).png().bytes());
  await Bun.write(LARGE_PNG, await Bun.file(seed).image().resize(3000, 2000).png().bytes());
});

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("prepareUploadBlob", () => {
  it("passes an image within the 2048 box through unchanged", async () => {
    const { blob, shrunkFrom } = await prepareUploadBlob(SMALL_PNG, "image/png");

    expect(shrunkFrom).toBeUndefined();
    expect(blob.type).toBe("image/png");
    // Byte-identical to the file: no re-encode is spent on in-box images.
    expect(blob.size).toBe(Bun.file(SMALL_PNG).size);
  });

  it("carries the caller's mime rather than re-sniffing it", async () => {
    // sniffSourceMimes upstream may correct a mislabelled extension; the blob must
    // report what it was told, not what the extension says.
    const { blob } = await prepareUploadBlob(SMALL_PNG, "image/jpeg");

    expect(blob.type).toBe("image/jpeg");
  });

  it("downscales an oversized image into the box as webp, preserving aspect", async () => {
    const { blob, shrunkFrom } = await prepareUploadBlob(LARGE_PNG, "image/png");

    expect(shrunkFrom).toEqual({ width: 3000, height: 2000 });
    expect(blob.type).toBe("image/webp");

    // The decoder reads from disk (there is no Bun.image over raw bytes).
    const decoded = join(TMP_DIR, "out.webp");
    await Bun.write(decoded, await blob.arrayBuffer());
    const out = await Bun.file(decoded).image().metadata();

    expect(out.format).toBe("webp");
    expect(Math.max(out.width, out.height)).toBe(2048);
    // 3:2 source stays 3:2 (fit: "inside" never crops).
    expect(out.width / out.height).toBeCloseTo(3 / 2, 2);
  });
});

describe("uploadSources", () => {
  it("uploads each source in order and returns its urls", async () => {
    const seen: number[] = [];
    const urls = await uploadSources(
      [SMALL_PNG, LARGE_PNG],
      ["image/png", "image/png"],
      async (blob) => {
        seen.push(blob.size);
        return `https://fal.storage/${seen.length}`;
      },
      () => {},
    );

    expect(urls).toEqual(["https://fal.storage/1", "https://fal.storage/2"]);
    expect(seen).toHaveLength(2);
  });

  it("logs the shrink only for the source that was downscaled", async () => {
    const lines: string[] = [];
    await uploadSources(
      [SMALL_PNG, LARGE_PNG],
      ["image/png", "image/png"],
      async () => "https://fal.storage/x",
      (msg) => lines.push(msg),
    );

    expect(lines.filter((l) => l.includes("shrunk"))).toHaveLength(1);
    expect(lines.find((l) => l.includes("shrunk"))).toContain("3000x2000");
  });

  it("returns an empty list for no sources without calling the uploader", async () => {
    let called = false;
    const urls = await uploadSources([], [], async () => {
      called = true;
      return "";
    });

    expect(urls).toEqual([]);
    expect(called).toBe(false);
  });
});
