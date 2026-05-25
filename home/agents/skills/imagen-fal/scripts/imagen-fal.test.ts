/**
 * Smoke test: magic-byte MIME-mismatch warning path.
 *
 * Run:
 *   bun test imagen-fal.test.ts
 *
 * Covers: a JPEG file renamed to .png triggers the WARNING: magic-byte MIME … disagrees
 * message and the resolved request payload carries "image/jpeg" (not "image/png").
 *
 * No API calls are made — the worker exits via --dry-run before touching the network.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { writeFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Minimal valid JPEG: SOI (FFD8FF) + APP0 marker + EOI (FFD9).
// Eight bytes is enough for the magic-byte sniff (it reads the first 12 bytes).
const MINIMAL_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, // SOI + APP0 marker
  0x00, 0x10,             // APP0 length (16 bytes)
  0x4a, 0x46, 0x49, 0x46, // "JFIF"
  0x00, 0x01,             // version 1.1
  // truncating here is fine — the sniff only needs the first 3 bytes
  0xff, 0xd9,             // EOI
]);

const TMP_DIR = join(tmpdir(), `imagenfal-test-${process.pid}`);
mkdirSync(TMP_DIR, { recursive: true });

const JPEG_RENAMED_PNG = join(TMP_DIR, "photo.png"); // JPEG content, .png extension

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

const WORKER = new URL("./imagen-fal.ts", import.meta.url).pathname;

describe("magic-byte MIME mismatch", () => {
  it("emits WARNING when JPEG bytes are given a .png extension", async () => {
    writeFileSync(JPEG_RENAMED_PNG, MINIMAL_JPEG);

    const proc = Bun.spawn(
      ["bun", WORKER, "test prompt", "--source", JPEG_RENAMED_PNG, "--dry-run"],
      { stdout: "pipe", stderr: "pipe" },
    );

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    // Worker must exit cleanly via the --dry-run path.
    expect(exitCode).toBe(0);

    // The warning is written to stderr via console.error.
    expect(stderr).toContain("WARNING: magic-byte MIME (image/jpeg) disagrees with extension MIME (image/png)");

    // The resolved payload must carry the correct (magic-byte) MIME.
    const payload = JSON.parse(stdout) as { source_mimes: string[] };
    expect(payload.source_mimes).toEqual(["image/jpeg"]);
  });

  it("does not warn when a genuine PNG is passed", async () => {
    // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
    const MINIMAL_PNG = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
      0x00, 0x00, 0x00, 0x0d,                           // IHDR chunk length
      0x49, 0x48, 0x44, 0x52,                           // "IHDR"
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,  // 1×1 px
      0x08, 0x02, 0x00, 0x00, 0x00,                     // bit depth 8, RGB
      0x90, 0x77, 0x53, 0xde,                           // CRC
      0x00, 0x00, 0x00, 0x0c,                           // IDAT chunk length
      0x49, 0x44, 0x41, 0x54,                           // "IDAT"
      0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00,  // compressed data
      0x00, 0x02, 0x00, 0x01,                           // CRC
      0xe2, 0x21, 0xbc, 0x33,
      0x00, 0x00, 0x00, 0x00,                           // IEND chunk length
      0x49, 0x45, 0x4e, 0x44,                           // "IEND"
      0xae, 0x42, 0x60, 0x82,                           // CRC
    ]);
    const GENUINE_PNG = join(TMP_DIR, "genuine.png");
    writeFileSync(GENUINE_PNG, MINIMAL_PNG);

    const proc = Bun.spawn(
      ["bun", WORKER, "test prompt", "--source", GENUINE_PNG, "--dry-run"],
      { stdout: "pipe", stderr: "pipe" },
    );

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).not.toContain("WARNING: magic-byte MIME");

    const payload = JSON.parse(stdout) as { source_mimes: string[] };
    expect(payload.source_mimes).toEqual(["image/png"]);
  });
});
