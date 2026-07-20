/**
 * Smoke test: CLI argument validation.
 *
 * Run:
 *   bun test vidgen-fal.test.ts
 *
 * vidgen-fal.ts parses argv and runs main() at import, so nothing in it can be
 * imported directly; each case spawns the worker instead. Validation cases exit
 * during the top-level block that runs before main(); --dry-run cases enter main()
 * and exit at its first statement. Neither reaches the network. FAL_KEY is stubbed
 * for the validation cases because the key check precedes option validation.
 *
 * Not covered: the render path past the --dry-run exit (fal.subscribe, the MP4
 * download, the ffmpeg WebM encode) still needs a live fal call.
 */

import { describe, it, expect } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const WORKER = new URL("./vidgen-fal.ts", import.meta.url).pathname;

const STUB_ENV = { ...process.env, FAL_KEY: "test-key-not-used" };

async function run(
  args: string[],
  env: Record<string, string | undefined> = STUB_ENV,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", WORKER, ...args], { stdout: "pipe", stderr: "pipe", env });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

describe("--help", () => {
  it("prints usage and exits 0 without needing a key", async () => {
    const { stdout, exitCode } = await run(["--help"], { ...process.env, FAL_KEY: undefined });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("--prompt");
  });
});

describe("required options", () => {
  it("rejects a missing --prompt", async () => {
    const { stderr, exitCode } = await run([]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("ERROR: --prompt is required");
  });

  it("rejects a missing FAL_KEY", async () => {
    const { stderr, exitCode } = await run(["--prompt", "a cat"], {
      ...process.env,
      FAL_KEY: undefined,
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("ERROR: FAL_KEY is not set.");
  });
});

describe("option validation", () => {
  it("rejects a duration outside the Kling enum", async () => {
    const { stderr, exitCode } = await run(["--prompt", "a cat", "--duration", "7"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain(`--duration must be "5" or "10" (got '7')`);
  });

  it("rejects an aspect ratio outside the Kling enum", async () => {
    const { stderr, exitCode } = await run(["--prompt", "a cat", "--aspect-ratio", "4:3"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("--aspect-ratio must be one of 16:9, 9:16, 1:1 (got '4:3')");
  });

  it("rejects a cfg-scale with trailing garbage", async () => {
    // parseFloat("0.5abc") would silently yield 0.5; the regex is what stops it.
    const { stderr, exitCode } = await run(["--prompt", "a cat", "--cfg-scale", "0.5abc"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("--cfg-scale must be a number between 0 and 1 (got '0.5abc')");
  });

  it("rejects a cfg-scale above 1", async () => {
    const { stderr, exitCode } = await run(["--prompt", "a cat", "--cfg-scale", "1.5"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("--cfg-scale must be a number between 0 and 1 (got '1.5')");
  });
});

describe("--dry-run", () => {
  async function payload(args: string[], env: Record<string, string | undefined> = STUB_ENV) {
    const { stdout, exitCode } = await run(["--prompt", "a cat", "--dry-run", ...args], env);

    expect(exitCode).toBe(0);
    return JSON.parse(stdout);
  }

  it("resolves the Kling defaults without calling fal", async () => {
    const p = await payload([]);

    expect(p.endpoint).toBe("fal-ai/kling-video/v1.6/standard/text-to-video");
    expect(p.input).toEqual({
      prompt: "a cat",
      duration: "5",
      aspect_ratio: "16:9",
      negative_prompt: "blur, distort, and low quality",
      cfg_scale: 0.5,
    });
    expect(p.webm).toBe(false);
  });

  it("runs without a key, since it never reaches the API", async () => {
    const p = await payload([], { ...process.env, FAL_KEY: undefined });

    expect(p.input.prompt).toBe("a cat");
  });

  it("switches endpoint on --pro", async () => {
    const p = await payload(["--pro"]);

    expect(p.endpoint).toBe("fal-ai/kling-video/v1.6/pro/text-to-video");
  });

  it("carries the resolved Kling options through", async () => {
    const p = await payload([
      "--duration",
      "10",
      "--aspect-ratio",
      "9:16",
      "--cfg-scale",
      "0.8",
      "--negative-prompt",
      "text, watermark",
    ]);

    expect(p.input).toEqual({
      prompt: "a cat",
      duration: "10",
      aspect_ratio: "9:16",
      negative_prompt: "text, watermark",
      cfg_scale: 0.8,
    });
  });

  it("resolves the WebM encode settings when --webm is set", async () => {
    const p = await payload(["--webm", "--scale", "480", "--webm-crf", "40"]);

    expect(p.webm).toBe(true);
    expect(p.scale).toBe(480);
    expect(p.webm_crf).toBe(40);
  });

  it("expands a tilde in --out", async () => {
    const p = await payload(["--out", "~/videos"]);

    expect(p.out_dir).toBe(`${process.env.HOME}/videos`);
    expect(p.out_dir.startsWith("~")).toBe(false);
  });

  it("writes nothing to disk", async () => {
    const dir = join(tmpdir(), `vidgen-dry-run-${process.pid}`);
    await payload(["--out", dir]);

    expect(existsSync(dir)).toBe(false);
  });
});
