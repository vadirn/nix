/**
 * Smoke test: CLI argument validation.
 *
 * Run:
 *   bun test vidgen-fal.test.ts
 *
 * vidgen-fal.ts parses argv and runs main() at import, so nothing in it can be
 * imported directly; each case spawns the worker instead. Every case here exits
 * during the top-level validation block, which runs before main(), so no API call
 * is made. FAL_KEY is stubbed because the key check precedes option validation.
 *
 * Not covered: the render path (main() itself) needs a live fal call — see the
 * project track's backlog.
 */

import { describe, it, expect } from "bun:test";

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
