import { describe, expect, it } from "bun:test";
import { join } from "path";
import { toWidget } from "./render.ts";

const SCRIPT = join(import.meta.dir, "render.ts");

describe("toWidget", () => {
  it("wraps a themeable SVG in the host-variable mapping", () => {
    const html = toWidget("flowchart LR\n  accTitle: Demo\n  A --> B");
    expect(html).toStartWith('<div style="');
    expect(html).toContain("--pele-fg:var(--text-primary)");
    expect(html).toContain('<svg xmlns="http://www.w3.org/2000/svg" class="pele');
    expect(html).toContain("var(--pele-fg,");
    expect(html).toContain("<title");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<foreignObject");
  });
});

describe("cli", () => {
  it("exits 1 with the error on stderr for invalid Mermaid", () => {
    const run = Bun.spawnSync(["bun", SCRIPT], { stdin: Buffer.from("flowchart LR\n  A -->") });
    expect(run.exitCode).toBe(1);
    expect(run.stdout.toString()).toBe("");
    expect(run.stderr.toString().length).toBeGreaterThan(0);
  });
});
