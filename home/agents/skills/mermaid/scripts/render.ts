#!/usr/bin/env bun
/**
 * Render Mermaid from stdin into a `show_widget` fragment.
 *
 * Run:
 *   bun render.ts < diagram.mmd
 *
 * Rendering happens here, with the pele version pinned in bun.lock, because the
 * widget's CSP admits scripts only from public CDNs. The fragment is pele's SVG
 * inside a div that maps its --pele-* variables onto the widget host's theme
 * variables, so the diagram follows light and dark mode.
 */

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
export function toWidget(source: string): string {
  const { svg } = render(source, { maxWidth: 680, fontSize: 14 });
  return `<div style="display:flex;justify-content:center;padding:1rem 0;${THEME}">${svg}</div>`;
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
