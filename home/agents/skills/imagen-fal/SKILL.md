---
name: imagen-fal
description: >
  The fal.ai worker for the /imagen hub; use directly only to pin the provider.
  Triggers: /imagen-fal, explicit mentions of "Kling", "BiRefNet", "fal.ai image",
  or "use fal". Skip for non-image tasks, text-in-image prompts (route to
  imagen-nanobanana), and ambiguous image requests (those route through the /imagen
  hub). Trigger only on explicit fal/Kling/BiRefNet mentions or direct invocation.
---

# imagen-fal

This skill is the fal.ai worker for the `/imagen` hub — invoke it directly only when you need to pin the provider to fal.ai (Kling O1 or another fal-hosted model).

## Models

| Model ID | Notes |
|---|---|
| `fal-ai/kling-image/v3/text-to-image` | **Default for text-only prompts.** Kling V3 Standard, pure text-to-image. 1K/2K, $0.028/image. Auto-selected when `--source` is not provided. |
| `fal-ai/kling-image/o1` | **Default for multi-reference prompts.** Kling O1 image-to-image / multi-ref remix (1–10 reference images required). Auto-selected when `--source` is provided. 1K/2K, $0.028/image. |
| `fal-ai/nano-banana-2` | Gemini 3.1 Flash Image via fal. Explicit override only — costs 3–10x more than the direct Google path used by `imagen-nanobanana`. |
| `fal-ai/nano-banana-pro` | Gemini 3 Pro Image via fal. Same cost caveat. |

The script auto-selects between `v3/text-to-image` and `o1` based on whether `--source` is supplied. Override with `--model` when needed.

**Not on fal:** `kling-v3-omni` is not hosted on fal. Calls requiring v3-omni or 4K resolution fall outside what the hub routes today — inform the user and defer.

**Transparency:** `--transparent` invokes BiRefNet v2 (`fal-ai/birefnet/v2`) as a post-processing step after generation. The original Kling PNG is kept; BiRefNet writes a sibling `<base>-alpha.png`. Both files are emitted (`image:` and `alpha:` lines). Cost add: ~$0.001–0.005/image; latency add: ~1–3s. Superior to chroma-key for subjects with hair, fur, and soft edges. Pass `--cutout none` to skip BiRefNet and keep only the raw Kling PNG.

## Invocation

```
doppler run -p claude-code -c std --no-fallback -- \
  bun <skill-dir>/scripts/imagen-fal.ts "<prompt>" [flags]
```

Replace `<skill-dir>` with this skill's base directory at invocation time. Pass the file path directly — `bun run` is not used because it would interpret the path as a package.json script name.

## Flag reference

| Flag | Description |
|---|---|
| `--source <path>` | One or more reference image paths, comma-separated for multi-ref (e.g. `a.png,b.png`). Up to 10. Presence of `--source` auto-switches the default model to `fal-ai/kling-image/o1` (i2i). Each file is uploaded to fal storage and passed as `image_urls`. |
| `--drafts <N>` | Number of variant images to generate (1–9, default: 1). |
| `--model <id>` | Model identifier. Default auto-picks `fal-ai/kling-image/v3/text-to-image` for t2i or `fal-ai/kling-image/o1` for i2i. |
| `--aspect <ratio>` | Aspect ratio enum, one of `16:9`, `9:16`, `1:1`, `4:3`, `3:4`, `3:2`, `2:3`, `21:9`. The `o1` (i2i) endpoint also accepts `auto`. Other ratios are rejected by fal. Default: `auto` for image-to-image (`--source` provided), `1:1` for text-to-image. |
| `--resolution <1k\|2k\|4k>` | Output resolution (default: `2k`). Maps to Kling's `1K`/`2K` enum. fal Kling does not support `4k` — passing it triggers a warning and caps to `2k`. |
| `--name <slug>` | Output filename prefix (default: full prompt slugified, truncated to 40 chars). |
| `--out <dir>` | Output directory (default: `~/Pictures/imagen`). |
| `--transparent` | After generation, run the cutout step (controlled by `--cutout`). The original Kling PNG is kept; BiRefNet result is written to a sibling `<base>-alpha.png`. Both paths are emitted. |
| `--cutout <birefnet\|none>` | Controls the cutout step when `--transparent` is set. `birefnet` (default): run BiRefNet v2 and write `<base>-alpha.png`. `none`: skip BiRefNet; only the raw Kling PNG is saved. |
| `--dry-run` | Print the resolved request payload as JSON and exit without making an API call. No `FAL_KEY` required. |

## Workflow

```
// Gather
intent     = do("understand what the user wants to create or edit")
transparent = do("true if user wants a transparent/cut-out/no-background/alpha result")

// Expand prompt
prompt = do("""
  Rewrite the request as a full descriptive paragraph — not a keyword list.
  Cover: subject, composition, lighting, colour palette, style, camera angle, mood.
  Omit transparency/alpha/checkerboard wording — that is handled by --transparent.
""")

// Choose flags
source_flag      = do("--source a.png,b.png for comma-separated reference images")
drafts_flag      = do("--drafts 3 or 4 when the user wants options; omit (default 1) otherwise")
model_flag       = do("--model only when the user explicitly overrides the default")
aspect_flag      = do("--aspect <ratio> when the user specifies dimensions or orientation")
resolution_flag  = do("--resolution 1k or 2k; warn if user requests 4k (not supported on fal Kling); omit to use default 2k")
name_flag        = do("--name <slug> when the user wants a specific filename prefix")
transparent_flag = do("--transparent when transparent is true")
cutout_flag      = do("--cutout none when the user explicitly wants to skip BiRefNet; omit otherwise (default birefnet)")

// Invoke
Bash(doppler run -p claude-code -c std --no-fallback -- \
  bun <skill-dir>/scripts/imagen-fal.ts "<prompt>" \
  [source_flag] [drafts_flag] [model_flag] [aspect_flag] \
  [resolution_flag] [name_flag] [transparent_flag] [cutout_flag])

// Relay output
do("print each 'image: ...' path (raw Kling PNG) and 'alpha: ...' path (BiRefNet result, when cutout ran) so the user can see or copy them")
do("note the log path and cost_estimate if emitted")

// Iterate
if user wants to refine:
  do("call the script again with a chosen output as --source and adjusted flags")
```

## Notes

- `FAL_KEY` is injected by `doppler run -p claude-code -c std --no-fallback`. It is never passed on the command line.
- Output images land in `~/Pictures/imagen/` by default. That directory is sandbox-allowlisted. Pointing `--out` outside it requires a matching `home/claude/settings.json` entry.
- fal returns signed CDN URLs (~1h TTL). The script downloads each URL to disk; the CDN URL is not the final path.
- `--transparent` keeps the original Kling PNG and writes BiRefNet output to a sibling `<base>-alpha.png`. Both files persist. The script emits `image: <raw>` and `alpha: <alpha>` on stdout.
- The green-plate prompt strategy used by `imagen-nanobanana` is NOT used here. Kling does not render flat chroma-key backgrounds — BiRefNet on the raw Kling output is the cutout path.
- Kling O1 does not render text inside images reliably. Route text-in-image prompts to `imagen-nanobanana`.
