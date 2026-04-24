---
name: image
description: >
  Generate and edit images via Gemini API. Use when the user asks to generate, create,
  draw, edit, modify, or transform an image. Triggers on any visual content creation request,
  even if the user doesn't say "image" explicitly (e.g., "make me a logo", "draw a cat").
---

# Image — Gemini Generation & Editing

```
dir = directory containing this file
script = dir + "/scripts/generate.py"
run = "doppler run -p claude-code -c std -- uv run " + script

if editing existing image:
    path = resolve image from previous generation, user path, or conversation context
    output = Bash(<run> '<edit_prompt>' --image '<path>')
else:
    expanded = do("expand prompt: add style, lighting, composition, colors, mood. Under 200 words. Preserve intent.")
    output = Bash(<run> '<expanded>' --aspect-ratio <ratio> --size <size>)

image_path = parse IMAGE_PATH=<path> from output
Read(image_path)  // show the result
```

## Reference

### Script options

| Flag             | Default                          | Values                                                                                                            |
| ---------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `--aspect-ratio` | `1:1`                            | `1:1`, `1:2`, `1:3`, `1:4`, `1:8`, `2:3`, `3:2`, `3:4`, `4:1`, `4:3`, `4:5`, `5:4`, `8:1`, `9:16`, `16:9`, `21:9` |
| `--size`         | `1K`                             | `512`, `1K`, `2K`, `4K`                                                                                           |
| `--model`        | `gemini-3.1-flash-image-preview` | Any Gemini model with image output                                                                                |
| `--image`        | None                             | Input image path (triggers edit mode)                                                                             |
| `--output`       | `$TMPDIR/image-<ts>.png`         | Custom output path                                                                                                |

### Prompt expansion

- Add visual specifics: "a cat" → "a fluffy orange tabby cat sitting on a sandy beach at golden hour, soft warm lighting, shallow depth of field"
- Specify style if the user didn't: photorealistic, illustration, watercolor, 3D render, etc.
- Include composition hints: foreground/background, camera angle, framing
- Keep the user's core intent intact. Enrich only.
- For edits: be precise about what to change and what to preserve.
