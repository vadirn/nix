---
name: mermaid
description: >
  Render a Mermaid diagram inline in the Claude desktop app: Pele turns the Mermaid
  source into themed SVG locally, from a version pinned in bun.lock, and the SVG goes
  out through `show_widget`. Use whenever a reply would carry a Mermaid diagram —
  flowchart, sequence, class, state, ER, Gantt, mindmap and the other Mermaid types —
  and the `show_widget` tool is available. Triggers: /mermaid, "draw a flowchart",
  "sequence diagram", "ERD", "mermaid diagram", "diagram this flow". Skip for
  illustrative or interactive diagrams that hand-drawn SVG serves better, and in a
  terminal session without `show_widget` (leave a ```mermaid fence there).
---

# mermaid

Renders Mermaid through the pinned `pele` package and embeds the SVG in a `show_widget` call.

## Procedure

1. Write the Mermaid source. Put `accTitle:` (and `accDescr:` when the title is not enough) on the line after the diagram keyword. Pele turns them into the SVG's `<title>` and `<desc>`, which stand in for the widget's screen-reader heading.
2. Render it:

   ```bash
   bun ~/.claude/skills/mermaid/scripts/render.ts <<'EOF'
   flowchart LR
     accTitle: Request lifecycle
     A[Client] --> B[API] --> C[(Database)]
   EOF
   ```

3. On exit 1, stderr names the error and, where known, the line and column. Fix the source and rerun.
4. Pass stdout verbatim as `widget_code` to `show_widget`. Write the explanation in the reply, outside the tool call.

## Wide diagrams

A diagram too wide to stay legible at the widget's width goes into a zoomable viewport instead of shrinking; a narrower one keeps the plain centred output. The viewport opens at 1:1 against the left edge, where a left-to-right flow starts.

- Toolbar, bottom-right: zoom out, the scale readout, zoom in, fit to view, actual size.
- Pointer: drag to pan; ctrl/cmd+scroll or pinch to zoom. A plain scroll passes through to the chat.
- Keyboard: focus the viewport, then arrows pan, `+` and `-` zoom, `0` returns to 1:1, `f` fits.

`render.ts` inlines the zoom script, so nothing loads at view time. Each render takes its own random `mmd-…` id prefix, so several diagrams can share one reply.

## Rules

- Load nothing from a CDN for diagrams. This skill exists so the rendering code comes from the lockfile, not from jsDelivr, esm.sh or unpkg at view time. It also replaces the `show_widget` guide's advice to load mermaid.js from esm.sh for ER and class diagrams.
- Leave the output as it is. The wrapper `div` maps Pele's `--pele-*` variables onto the widget's theme variables, so the diagram follows light and dark mode. Hex colours added by hand break dark mode.
- Pele lays out once, at render time. Live relayout to the container width needs Pele's browser `mount()`, which this skill gives up along with the CDN. Zoom covers the width a fixed layout cannot.

## Upgrading Pele

The version lives in `scripts/package.json`, and `bun.lock` pins its sha512. To bump it, run `bun add pele@<version>` in `scripts/`. `~/.bunfig.toml` refuses releases younger than 7 days. Then run `bun test` there.
