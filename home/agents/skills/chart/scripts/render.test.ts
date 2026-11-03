import { describe, expect, it } from "bun:test";
import { join } from "path";
import { toHtml, toWidget, VIEW_MAX_HEIGHT, ZOOM_MIN_WIDTH } from "./render.ts";

const SCRIPT = join(import.meta.dir, "render.ts");

// Twelve nodes in a row lay out well past ZOOM_MIN_WIDTH.
const WIDE = `flowchart LR\n  accTitle: Wide\n  ${Array.from({ length: 12 }, (_, i) => `N${i}[Step number ${i}]`).join(" --> ")}`;

const ids = (html: string) => [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);

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

  it("maps every chart series onto the host palette", () => {
    const html = toWidget('pie\n  accTitle: Demo\n  "A" : 1\n  "B" : 2');
    for (let n = 1; n <= 8; n++) {
      expect(html).toMatch(new RegExp(`--pele-series-${n}:var\\(--series-${n},#[0-9a-f]{6}\\)`));
    }
    expect(html).toContain("var(--pele-series-1,");
  });

  it("paints role classes with the host's role tokens", () => {
    const html = toWidget("flowchart LR\n  accTitle: Demo\n  A:::success --> B\n  class B warning");
    expect(html).toMatch(/<g class="pele-node [^"]* success" data-id="A"/);
    expect(html).toMatch(/<g class="pele-node [^"]* warning" data-id="B"/);
    for (const role of ["accent", "success", "warning", "danger"]) {
      expect(html).toContain(`.pele .${role}>:not(text):not([fill=none]){fill:var(--bg-${role})}`);
      expect(html).toContain(`.pele .${role}>text{fill:var(--text-${role})}`);
    }
    expect(toWidget(WIDE)).toContain(".pele .success>text{");
  });

  it("puts a wide diagram in a zoomable viewport", () => {
    const html = toWidget(WIDE);
    expect(html).toStartWith('<div style="');
    expect(html).toContain("--pele-fg:var(--text-primary)");
    expect(html).toContain("<title");
    expect(html).toMatch(
      /<div id="mmd-[0-9a-f]{8}" data-w="\d+" data-h="\d+" tabindex="0" role="group"/,
    );
    for (const label of ["Zoom out", "Zoom in", "Fit to view", "Actual size"]) {
      expect(html).toContain(`<button type="button" data-act=`);
      expect(html).toContain(`aria-label="${label}"`);
    }
    // Inline !important beats the host's pre-styled button border and padding.
    expect(html).toMatch(/<button [^>]*style="[^"]*border:0!important;[^"]*"/);
    expect(html).toMatch(/<button [^>]*style="[^"]*padding:0!important;[^"]*"/);
    // The toolbar sits in the viewport's bottom-right corner, after the SVG.
    expect(html).toMatch(
      /<div id="(mmd-[0-9a-f]{8})"[^>]*>.*<\/svg><div id="\1-tools" style="position:absolute;right:8px;bottom:8px;.*<\/div><\/div><script>/s,
    );
    expect(html).toContain("<script>(function mermaidViewport(");
    expect(html).not.toContain("position:fixed");
    expect(html).not.toContain("overflow:auto");
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toContain("<foreignObject");
  });

  it("gives every render its own ids", () => {
    const [a, b] = [toWidget(WIDE), toWidget(WIDE)];
    const [idsA, idsB] = [ids(a), ids(b)];
    const own = idsA.find((id) => /^mmd-[0-9a-f]{8}$/.test(id)) ?? "";
    // Pele keys shapes by data-id, so every id in the output is the render's own.
    expect(idsA.toSorted()).toEqual([own, `${own}-title`, `${own}-tools`]);
    expect(idsA.filter((id) => idsB.includes(id))).toEqual([]);
    expect(a).toContain(`aria-labelledby="${own}-title"`);
    expect(a).toContain(`})("${own}")</script>`);
  });

  it("inlines a script that parses", () => {
    const code = toWidget(WIDE).match(/<script>(.*)<\/script>/s)?.[1] ?? "";
    expect(code).not.toContain("//");
    expect(() => new Function(code)).not.toThrow();
  });
});

describe("toHtml", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>';

  it("keeps the plain wrapper up to the legibility threshold", () => {
    expect(ZOOM_MIN_WIDTH).toBeCloseTo(865.45, 1);
    expect(toHtml({ svg, width: 865, height: 300 }, "mmd-x")).not.toContain("<script");
    expect(toHtml({ svg, width: 866, height: 300 }, "mmd-x")).toContain("<script");
  });

  it("bounds the viewport height", () => {
    expect(toHtml({ svg, width: 2000, height: 300 }, "mmd-x")).toContain("height:300px");
    expect(toHtml({ svg, width: 2000, height: 1500 }, "mmd-x")).toContain(
      `height:${VIEW_MAX_HEIGHT}px`,
    );
  });

  it("paints the opening view before the script runs: 1:1, left edge, centred vertically", () => {
    const html = toHtml({ svg, width: 2000, height: 1500 }, "mmd-x");
    expect(html).toContain(`#mmd-x>svg{position:absolute;left:0;top:0;max-width:none!important`);
    expect(html).toContain(`transform:translate(0px,${(VIEW_MAX_HEIGHT - 1500) / 2}px)`);
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
