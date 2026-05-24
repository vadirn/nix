---
name: imagen-fal
description: >
  The fal.ai worker for the /imagen hub — use directly only to pin the provider.
  Triggers: /imagen-fal, explicit mentions of "Kling", "BiRefNet", "fal.ai image",
  or "use fal". Skip for non-image tasks, text-in-image prompts (route to
  imagen-nanobanana), and ambiguous image requests (those route through the /imagen
  hub). Do NOT trigger on bare "/imagen" or "generate an image".
---

# imagen-fal

This skill is the fal.ai worker for the `/imagen` hub — invoke it directly only when you need to pin the provider to fal.ai (Kling O1 or another fal-hosted model).

## Models

| Model ID | Notes |
|---|---|
| `fal-ai/kling-image/o1` | **Default.** Kling Image O1. Best for multi-reference remix, character consistency, cinematic/anime. 1K/2K supported. $0.028/image (0% fal markup). |
| `fal-ai/nano-banana-2` | Gemini 3.1 Flash Image via fal. Explicit override only — costs 3–10x more than the direct Google path used by `imagen-nanobanana`. |
| `fal-ai/nano-banana-pro` | Gemini 3 Pro Image via fal. Same cost caveat. |

**Not on fal:** `kling-v3-omni` (`fal-ai/kling-image/v3-omni`) is not hosted on fal. Calls requiring v3-omni or 4K resolution fall outside what the hub routes today — inform the user and defer.

**Transparency:** `--transparent` invokes BiRefNet v2 (`fal-ai/birefnet/v2`) as a post-processing step after generation, replacing the output with an alpha PNG. Cost add: ~$0.001–0.005/image; latency add: ~1–3s. Superior to chroma-key for subjects with hair, fur, and soft edges.

## Invocation

```
doppler run -p claude-code -c std --no-fallback -- \
  bun --cwd <skill-dir>/scripts run imagen-fal.ts "<prompt>" [flags]
```

Replace `<skill-dir>` with this skill's base directory at invocation time.

## Flag reference

| Flag | Description |
|---|---|
| `--source <path>` | One or more reference images. Comma-separated paths for Kling multi-ref (e.g. `a.png,b.png`). Up to 10. Each file is uploaded to fal storage and passed as `reference_images`. |
| `--drafts <N>` | Number of variant images to generate (default: 1). |
| `--model <id>` | Model identifier (default: `fal-ai/kling-image/o1`). |
| `--aspect <ratio>` | Aspect ratio, e.g. `16:9`, `1:1`, `4:3`. Passed as `aspect_ratio`. |
| `--resolution <1k\|2k\|4k>` | Output resolution. fal Kling supports `1k` and `2k`. `4k` is not available through fal — use `2k` or route elsewhere. |
| `--name <slug>` | Output filename prefix (default: slugified first 5 prompt words). |
| `--out <dir>` | Output directory (default: `~/Pictures/imagen`). |
| `--transparent` | After generation, run BiRefNet v2 to remove background and save an alpha PNG in place of the original file. |

## Workflow

```
// Gather
intent     = do("understand what the user wants to create or edit")
transparent = do("true if user wants a transparent/cut-out/no-background/alpha result")

// Expand prompt
prompt = do("""
  Rewrite the request as a full descriptive paragraph — not a keyword list.
  Cover: subject, composition, lighting, colour palette, style, camera angle, mood.
  Do NOT include transparency/alpha/checkerboard wording — that is handled by --transparent.
""")

// Choose flags
source_flag      = do("--source a.png,b.png for comma-separated reference images")
drafts_flag      = do("--drafts 3 or 4 when the user wants options; omit (default 1) otherwise")
model_flag       = do("--model only when the user explicitly overrides the default")
aspect_flag      = do("--aspect <ratio> when the user specifies dimensions or orientation")
resolution_flag  = do("--resolution 1k or 2k; warn if user requests 4k (not supported on fal Kling)")
name_flag        = do("--name <slug> when the user wants a specific filename prefix")
transparent_flag = do("--transparent when transparent is true")

// Invoke
Bash(doppler run -p claude-code -c std --no-fallback -- \
  bun --cwd <skill-dir>/scripts run imagen-fal.ts "<prompt>" \
  [source_flag] [drafts_flag] [model_flag] [aspect_flag] \
  [resolution_flag] [name_flag] [transparent_flag])

// Relay output
do("print each final 'image: ...' path so the user can see or copy them")
do("note the log path and cost_estimate if emitted")

// Iterate
if user wants to refine:
  do("call the script again with a chosen output as --source and adjusted flags")
```

## Notes

- `FAL_KEY` is injected by `doppler run -p claude-code -c std --no-fallback`. It is never passed on the command line.
- Output images land in `~/Pictures/imagen/` by default. That directory is sandbox-allowlisted. Pointing `--out` outside it requires a matching `home/claude/settings.json` entry.
- fal returns signed CDN URLs (~1h TTL). The script downloads each URL to disk; the CDN URL is not the final path.
- `--transparent` replaces the generated file in-place with the alpha PNG (same filename). The original fal-generated file is not kept.
- Kling O1 does not render text inside images reliably. Route text-in-image prompts to `imagen-nanobanana`.
