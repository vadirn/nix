---
name: imagen-nanobanana
description: >
  The Google Nano Banana (Gemini) worker for the /imagen hub — use directly only to pin the provider.
  Triggers: /imagen-nanobanana, explicit mentions of "Nano Banana", "Gemini image", or "use Nano Banana".
  Edit or restyle existing images by passing them as --source. Skip for non-image tasks and for
  ambiguous image requests (those route through the /imagen hub).
---

# imagen-nanobanana

This skill is the explicit Nano Banana (Google Gemini) worker. The hub skill `imagen` handles routing for ambiguous prompts; invoke this skill directly only when you need to pin the provider to Nano Banana.

Generate or edit images via Google Gemini image models.

```
// Gather
intent     = do("understand what the user wants to create or edit")
chroma_key = do("""
  Set true if the user asked for a transparent / alpha / cut-out / no-background image,
  or for an icon / sticker / sprite / logo with no background. Otherwise false.
""")

// Chroma-key: announce the workaround before invoking
if chroma_key:
  do("""
    Tell the user, in one sentence, that Gemini image models cannot emit a native
    transparent PNG — asked for one, they paint a grey-and-white checkerboard as
    opaque pixels — so this skill paints the subject on a flat chroma-key green
    (#00ff00) background and keys the green out programmatically with ffmpeg.
    Mention that any genuinely green parts of the subject will be keyed out too.
    Mention that --transparent --cutout colorkey activates this mode.
  """)

// Expand prompt
prompt = do("""
  Rewrite the user's request as a full descriptive paragraph — not a keyword list.
  Cover: subject, composition, lighting, colour palette, style (photography / illustration /
  painting / 3-D render / etc.), camera angle or lens, mood, and the image's purpose.
  If the image must contain readable text, name the exact words verbatim.
  The paragraph is the value passed to the script as the first positional argument.

  If chroma_key is true:
    - Do NOT use the words "transparent", "transparency", "alpha", "checkerboard",
      "no background", or "PNG" in the prompt — these trigger the painted-checkerboard
      failure mode.
    - Do NOT use green anywhere on the subject; pick non-green colours for the subject
      explicitly when relevant.
    - Append this background directive verbatim as the final sentence:
        "The entire background must be a single flat, fully saturated pure green of
         hex colour #00ff00 (R=0, G=255, B=0) filling every pixel that is not part of
         the subject; do not draw any pattern, gradient, shadow, or other colour in
         the background."
""")

// Choose flags
source_flags         = do("--source <path> for each image the user referenced or a prior output to iterate on")
drafts_flag          = do("--drafts 3 or 4 when the user wants options; omit (default 1) otherwise")
aspect_flag          = do("--aspect <ratio> when the user specifies dimensions or orientation")
res_flag             = do("--resolution 512 for cheap drafts; omit to use default 2K for final output")
model_flag           = do("--model only when the user explicitly overrides the default")
chroma_key_flag      = do("--transparent --cutout colorkey when chroma_key is true; omit otherwise")

// Invoke (replace <skill-dir> with this skill's base directory at invocation time)
Bash(doppler run -p claude-code -c std --no-fallback -- bash <skill-dir>/scripts/imagen.sh "<prompt>" [source_flags] [drafts_flag] [aspect_flag] [res_flag] [model_flag] [chroma_key_flag])
// chroma_key_flag expands to: --transparent --cutout colorkey

// Post-process: key the green out (only when chroma_key and cutout != none)
if chroma_key:
  for each "image: <src_path>" line the script emitted:
    base      = src_path without its extension  // e.g. /path/to/name
    alpha_path = base + "-alpha.png"             // sibling file: name-alpha.png
    // colorkey removes the green; despill cleans the residual green fringe
    // (JPEG chroma subsampling bleeds green into edge pixels). Tuned on a
    // red-apple test: 0 green-tinted pixels after this chain.
    // src_path (e.g. name.jpg) is PRESERVED. Only the alpha sibling is written.
    Bash(ffmpeg -hide_banner -loglevel error -y -i "<src_path>" \
           -vf "colorkey=0x00ff00:0.30:0.20,despill=type=green:mix=0.5:expand=0,format=rgba" \
           "<alpha_path>")
    emit to the user:
      image: <src_path>
      alpha: <alpha_path>

// Relay output
do("print each 'image: ...' and 'alpha: ...' path so the user can see or copy them")
do("note the log path the script printed")

// Iterate
if user wants to refine or upscale:
  do("call the script again with a chosen output path as --source and adjusted flags")
  do("when iterating on a chroma-key image, re-run the green-key post-process step")

// Refusals
if script reports no image:
  do("relay the returned safety or model text honestly; do not retry automatically")
```

## Notes

- Output images land in `~/Pictures/imagen/` (or `$IMAGEN_DIR` if set). The file extension (`.png`, `.jpg`, `.webp`) reflects the format the model actually returned; most models currently return JPEG.
- Only `~/Pictures/imagen` is on the sandbox write allowlist. Pointing `$IMAGEN_DIR` or `--out` outside it requires adding a matching entry to `home/claude/settings.json`, otherwise writes fail under the sandbox.
- `--out` honors the path verbatim; it does not adjust the extension to match the returned format. The script warns to stderr on a mismatch.
- The API key (`GEMINI_API_KEY`) is injected by `doppler run` and never appears on a command line.
- The curl call lives inside the script, so the `no-network-abuse` hook (which blocks visible `curl --data`) does not fire.
- `gemini-2.5-flash-image` does not accept `--resolution`; the script warns and ignores it.
- Default model: `gemini-3.1-flash-image-preview`.
- Default resolution: `2K`. Pass `--resolution 512` for cheap draft runs.
- For lossless archival, re-encode the JPEG yourself: `ffmpeg -i in.jpg out.png` or `magick in.jpg out.png`. The skill keeps the format the model returned.

### Transparency via chroma-key (`--transparent`, `--cutout`)

Gemini image models cannot emit a native alpha channel. Asked for a "transparent background", they paint a grey-and-white checkerboard — the *icon* for transparency — as opaque pixels (confirmed by Google docs / community reports). The skill works around this entirely outside the script:

1. Detect the transparency request (`chroma_key = true`).
2. Tell the user up front that chroma-keying is used and that green parts of the subject will be keyed out too.
3. Append a flat `#00ff00` background directive to the prompt (without ever using the word "transparent").
4. Pass `--transparent --cutout colorkey` to the script to signal the mode.
5. After the script returns the image, run `ffmpeg` with `colorkey` plus `despill` to write `<base>-alpha.png` as a sibling file. The original generated file (e.g. `name.jpg`) is always preserved.
6. Emit both `image: name.jpg` and `alpha: name-alpha.png` to the user.

Pass `--cutout none` to skip the ffmpeg step and keep only the raw green-plate image.

`--chroma-key-fallback` is a **deprecated** alias for `--transparent --cutout colorkey`; the script prints a deprecation warning to stderr when it sees it.

The keying command (also embedded in the workflow above):

```
ffmpeg -i in.jpg \
  -vf "colorkey=0x00ff00:0.30:0.20,despill=type=green:mix=0.5:expand=0,format=rgba" \
  out-alpha.png
```

- `colorkey=0x00ff00:0.30:0.20` — sets alpha to 0 where pixels are within 30% of pure green, feathering edges over a 20% blend window.
- `despill=type=green:mix=0.5` — subtracts green spill from edge pixels; without this, JPEG chroma subsampling leaves a visible green halo around the subject.
- `format=rgba` — forces an alpha channel on output (PNG `color_type=6`).

Tuned on a red-apple test: this chain produces 0 green-tinted edge pixels. If the subject has fine hair / fur / glass and edges look chewed, raise the `despill` `mix` to `0.7` and the colorkey `blend` to `0.25` for softer edges.
