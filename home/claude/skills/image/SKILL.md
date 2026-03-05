---
name: image
description: >
  Generate and edit images via Gemini API. Use when the user asks to generate, create,
  draw, edit, modify, or transform an image. Triggers on any visual content creation request,
  even if the user doesn't say "image" explicitly (e.g., "make me a logo", "draw a cat").
---

# Image — Gemini Generation & Editing

## Generate

1. Expand the user's prompt: add style, lighting, composition, colors, mood. Keep under 200 words. Preserve intent.
2. Run:
   ```sh
   doppler run -p claude-code -c std -- uv run ~/.claude/skills/image/scripts/generate.py '<expanded_prompt>' --aspect-ratio <ratio> --size <size>
   ```
3. Parse `IMAGE_PATH=<path>` from stdout.
4. Read the output image to show it.

## Edit

1. Resolve image path from previous generation, user-provided path, or conversation context.
2. Run:
   ```sh
   doppler run -p claude-code -c std -- uv run ~/.claude/skills/image/scripts/generate.py '<edit_prompt>' --image '<path>'
   ```
3. Parse `IMAGE_PATH=<path>` from stdout.
4. Read the output image to show it.

## Options

| Flag | Default | Values |
|------|---------|--------|
| `--aspect-ratio` | `1:1` | `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `9:16`, `16:9`, `2:1`, `1:2`, `4:5`, `5:4`, `3:1`, `1:3`, `9:21` |
| `--size` | `1K` | `512px`, `1K`, `2K`, `4K` |
| `--model` | `gemini-3.1-flash-image-preview` | Any Gemini model with image output |
| `--image` | None | Input image path (triggers edit mode) |
| `--output` | `/tmp/image-<ts>.png` | Custom output path |

## Prompt expansion

- Add visual specifics: "a cat" → "a fluffy orange tabby cat sitting on a sandy beach at golden hour, soft warm lighting, shallow depth of field"
- Specify style if the user didn't: photorealistic, illustration, watercolor, 3D render, etc.
- Include composition hints: foreground/background, camera angle, framing
- Preserve the user's core intent. Enrich, don't change.
- For edits: be precise about what to change and what to preserve.
