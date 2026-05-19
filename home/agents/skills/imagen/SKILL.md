---
name: imagen
description: >
  Generate images with Google's Nano Banana (Gemini) models. Triggers: /imagen,
  "generate an image", "create a picture", "make an image", «нарисуй», «сгенерируй картинку».
  Edit or restyle existing images by passing them as --source. Skip for non-image tasks.
---

# imagen

Generate or edit images via Google Gemini image models.

```
// Gather
intent = do("understand what the user wants to create or edit")

// Expand prompt
prompt = do("""
  Rewrite the user's request as a full descriptive paragraph — not a keyword list.
  Cover: subject, composition, lighting, colour palette, style (photography / illustration /
  painting / 3-D render / etc.), camera angle or lens, mood, and the image's purpose.
  If the image must contain readable text, name the exact words verbatim.
  The paragraph is the value passed to the script as the first positional argument.
""")

// Choose flags
source_flags = do("--source <path> for each image the user referenced or a prior output to iterate on")
drafts_flag  = do("--drafts 3 or 4 when the user wants options; omit (default 1) otherwise")
aspect_flag  = do("--aspect <ratio> when the user specifies dimensions or orientation")
res_flag     = do("--resolution 512 for cheap drafts; bump to 1K or 2K once the user picks a keeper")
model_flag   = do("--model only when the user explicitly overrides the default")

// Invoke (replace <skill-dir> with this skill's base directory at invocation time)
Bash(doppler run -p claude-code -c std --no-fallback -- bash <skill-dir>/scripts/imagen.sh "<prompt>" [source_flags] [drafts_flag] [aspect_flag] [res_flag] [model_flag])

// Relay output
do("print each 'image: ...' path the script emitted so the user can see or copy them")
do("note the log path the script printed")

// Iterate
if user wants to refine or upscale:
  do("call the script again with a chosen output path as --source and adjusted flags")

// Refusals
if script reports no image:
  do("relay the returned safety or model text honestly; do not retry automatically")
```

## Notes

- Output images land in `~/Pictures/imagen/` (or `$IMAGEN_DIR` if set). The file extension (`.png`, `.jpg`, `.webp`) reflects the format the model actually returned; most models currently return JPEG.
- Only `~/Pictures/imagen` is on the sandbox write allowlist. Pointing `$IMAGEN_DIR` or `--out` outside it requires adding a matching entry to `home/claude/settings.json`, otherwise writes fail under the sandbox.
- `--out` honors the path verbatim; it does not adjust the extension to match the returned format. The script warns to stderr on a mismatch.
- The API key (`GEMINI_API_KEY`) is injected by `doppler run` and never appears on a command line.
- The curl call lives inside the script, so the `no-network-abuse` hook (which blocks visible
  `curl --data`) does not fire.
- `gemini-2.5-flash-image` does not accept `--resolution`; the script warns and ignores it.
- Default model: `gemini-3.1-flash-image-preview`.
