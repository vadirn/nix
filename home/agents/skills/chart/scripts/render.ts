#!/usr/bin/env bun
/**
 * Render a Mermaid diagram or chart from stdin into a `show_widget` fragment.
 *
 * Run:
 *   bun render.ts < diagram.mmd
 *
 * Rendering happens here, with the pele version pinned in bun.lock, because the
 * widget's CSP admits scripts only from public CDNs. The fragment is pele's SVG
 * inside a div that maps its --pele-* variables onto the widget host's theme
 * variables, so the diagram follows light and dark mode. A diagram too wide to
 * stay legible at the widget's width goes into a zoomable viewport instead.
 */

import { join } from "path";
import { PeleError, render } from "pele";

// --pele-bg masks edges behind edge labels, so it has to be the solid page colour.
const THEME = [
  "--pele-bg:var(--surface-0)",
  "--pele-fg:var(--text-primary)",
  "--pele-muted:var(--text-secondary)",
  "--pele-line:var(--text-secondary)",
  "--pele-surface:var(--surface-1)",
  "--pele-surface-alt:var(--surface-0)",
  "--pele-border:var(--border-strong)",
  "--pele-accent:var(--text-accent)",
  "--pele-font:var(--font-sans)",
  "--pele-font-mono:var(--font-mono)",
].join(";");

// 680 is the widget width; it also keeps LR flowcharts above pele's 640px
// autoDirection breakpoint. 14px matches the widget's diagram label size.
const WIDGET_WIDTH = 680;
const FONT_SIZE = 14;

// Fit-to-width shrinks the text by WIDGET_WIDTH / width. Past the point where
// 14px text would fall below the widget's 11px floor, the diagram gets a viewport.
export const ZOOM_MIN_WIDTH = (WIDGET_WIDTH * FONT_SIZE) / 11;
export const VIEW_MAX_HEIGHT = 480;

// pele ships enableZoom, which bundles inline too. It is not used: its fit
// reads the width only, its reset is fit, it exposes no pan for choosing the
// opening view, and its controls draw their own SVG icons where the widget
// wants Tabler.
const VIEWPORT_JS = new Bun.Transpiler({ loader: "js", minifyWhitespace: true })
  .transformSync(await Bun.file(join(import.meta.dir, "viewport.js")).text())
  .trim();

// The host pre-styles every button with a border and padding, and its rules
// outrank a scoped stylesheet. Inline !important declarations outrank any
// stylesheet, so the reset lives here; background stays in the stylesheet so
// hover can change it.
const BUTTON_STYLE = [
  "width:28px",
  "height:28px",
  "min-width:0",
  "min-height:0",
  "margin:0",
  "padding:0",
  "display:inline-flex",
  "align-items:center",
  "justify-content:center",
  "gap:0",
  "border:0",
  "border-radius:6px",
  "box-shadow:none",
  "color:var(--text-primary)",
  "font-size:16px",
  "line-height:1",
]
  .map((rule) => `${rule}!important`)
  .join(";");

const button = (act: string, label: string, icon: string) =>
  `<button type="button" data-act="${act}" aria-label="${label}" title="${label}" style="${BUTTON_STYLE}"><i class="ti ${icon}" aria-hidden="true"></i></button>`;

// A compact toolbar in the viewport's bottom-right corner: zoom out, the scale
// readout, zoom in, then fit and actual size. Its Tabler icons need no loading:
// show_widget preloads the webfont.
const TOOLBAR = [
  button("out", "Zoom out", "ti-minus"),
  `<output aria-label="Zoom" style="min-width:40px;text-align:center;font-size:12px;color:var(--text-secondary);font-variant-numeric:tabular-nums">100%</output>`,
  button("in", "Zoom in", "ti-plus"),
  `<span aria-hidden="true" style="width:0.5px;height:16px;margin:0 2px;background:var(--border)"></span>`,
  button("fit", "Fit to view", "ti-arrows-minimize"),
  button("actual", "Actual size", "ti-zoom-reset"),
].join("");

export interface Rendered {
  svg: string;
  width: number;
  height: number;
}

/** Wrap pele's SVG: plain when it stays legible at the widget width, else in a viewport. */
export function toHtml({ svg, width, height }: Rendered, id: string): string {
  if (width <= ZOOM_MIN_WIDTH) {
    return `<div style="display:flex;justify-content:center;padding:1rem 0;${THEME}">${svg}</div>`;
  }
  const viewHeight = Math.min(Math.ceil(height), VIEW_MAX_HEIGHT);
  // Until the script runs, the SVG sits at 1:1 against the left edge, centred
  // vertically: the same view the script opens with.
  const top = (viewHeight - height) / 2;
  const style = [
    `#${id}>svg{position:absolute;left:0;top:0;max-width:none!important;transform-origin:0 0;transform:translate(0px,${top}px)}`,
    `#${id}-tools button{background:transparent!important;cursor:pointer}`,
    `#${id}-tools button:hover{background:var(--surface-1)!important}`,
  ].join("");
  return [
    `<div style="padding:1rem 0;${THEME}">`,
    `<style>${style}</style>`,
    `<div id="${id}" data-w="${width}" data-h="${height}" tabindex="0" role="group" aria-label="Zoomable diagram: drag or arrow keys to pan, ctrl or cmd and scroll, or plus and minus, to zoom"`,
    ` style="position:relative;overflow:hidden;height:${viewHeight}px;border:0.5px solid var(--border);border-radius:var(--radius);cursor:grab;touch-action:none;user-select:none">${svg}`,
    `<div id="${id}-tools" style="position:absolute;right:8px;bottom:8px;display:flex;align-items:center;gap:2px;padding:2px;background:var(--surface-0);border:0.5px solid var(--border);border-radius:var(--radius);cursor:default">${TOOLBAR}</div>`,
    `</div>`,
    `<script>(${VIEWPORT_JS})(${JSON.stringify(id)})</script>`,
    `</div>`,
  ].join("");
}

// Ids must not collide when several widgets share a page. Pele keys shapes by
// data-id, so its only ids are the title and desc, which idPrefix covers.
export function toWidget(source: string): string {
  const id = `mmd-${crypto.randomUUID().slice(0, 8)}`;
  const result = render(source, { maxWidth: WIDGET_WIDTH, fontSize: FONT_SIZE, idPrefix: id });
  return toHtml(result, id);
}

if (import.meta.main) {
  try {
    console.log(toWidget(await Bun.stdin.text()));
  } catch (error) {
    if (!(error instanceof PeleError)) throw error;
    console.error(error.snippet ? `${error.message}\n${error.snippet}` : error.message);
    process.exit(1);
  }
}
