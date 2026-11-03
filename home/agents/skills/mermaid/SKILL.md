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

The widget is 680 px wide and shrinks a wider SVG to fit. From 866 px on, Pele's 14 px text would render below the widget's 11 px floor. So a diagram that wide goes into a zoomable viewport; a narrower one keeps the plain centred output.

- The viewport is at most 480 px tall. It opens at 1:1, against the left edge and centred vertically, where a left-to-right flow starts.
- Controls: a compact toolbar in the viewport's bottom-right corner, with zoom out, the scale readout, zoom in, fit to view and actual size (1:1). Its 28 px buttons use Tabler icons, which `show_widget` preloads.
- Pointer: drag to pan, with half a viewport of slack, so any corner of the diagram can reach the centre; ctrl/cmd+scroll or pinch to zoom around the pointer. A plain scroll passes through to the chat. On touch, one finger pans the diagram and two fingers pinch.
- Keyboard: focus the viewport, then arrows pan, `+` and `-` zoom, `0` returns to 1:1, `f` fits.

The zoom script is `scripts/viewport.js`. `render.ts` inlines it, whitespace-minified, so nothing loads at view time. It moves Pele's SVG with a CSS transform and leaves the markup as Pele wrote it. Each render, plain or zoomable, takes a random `mmd-…` id and passes it to Pele as `idPrefix`. Pele keys shapes by `data-id`, so every `id` in the output carries that prefix, and widgets sharing a page never collide.

Pele ships `enableZoom`, and it bundles inline. The skill does not use it: its fit scale reads the width only, its reset is fit, it exposes no pan for choosing the opening view, and its controls draw their own SVG icons where the widget wants Tabler.

## Rules

- Load nothing from a CDN for diagrams. This skill exists so the rendering code comes from the lockfile, not from jsDelivr, esm.sh or unpkg at view time. It also replaces the `show_widget` guide's advice to load mermaid.js from esm.sh for ER and class diagrams.
- Leave the output as it is. The wrapper `div` maps Pele's `--pele-*` variables onto the widget's theme variables, so the diagram follows light and dark mode. Hex colours added by hand break dark mode.
- Pele lays out once, at render time. Live relayout to the container width needs Pele's browser `mount()`, which this skill gives up along with the CDN. Zoom covers the width a fixed layout cannot.

## Upgrading Pele

The version lives in `scripts/package.json`, and `bun.lock` pins its sha512. To bump it, run `bun add pele@<version>` in `scripts/`. `~/.bunfig.toml` refuses releases younger than 7 days. Then run `bun test` there.
