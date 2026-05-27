---
name: vidgen-fal
description: >
  The fal.ai worker for video generation; produces a Kling-rendered MP4 as the
  master output (always kept). Pass --webm to also encode a VP9 WebM loop
  alongside it (default 640px wide, ~1–3 MB for a 5s clip).
  Targets Kling v1.6 by default (standard tier); pass --pro for the pro tier. No
  router hub exists today; invoke this skill directly.
  Triggers: /vidgen-fal, "generate a video", "make a looping video", "animate this",
  explicit mentions of "fal video", "Kling video".
  Skip for image-only tasks and non-video generation requests.
---

# vidgen-fal

This skill is a direct-call fal.ai video worker. It calls a Kling v1.6 endpoint, downloads the MP4 (always kept as the master), then optionally runs a local ffmpeg pipeline — scale + VP9 encode — to produce a WebM alongside it. Pass `--webm` to opt into the WebM transcode. No router hub exists today; the user chose this as a direct-call worker.

## Models

| Tier | Endpoint | Cost |
|---|---|---|
| **Standard (default)** | `fal-ai/kling-video/v1.6/standard/text-to-video` | $0.28 / 5s, $0.56 / 10s |
| **Pro** (`--pro`) | `fal-ai/kling-video/v1.6/pro/text-to-video` | $0.49 / 5s, $0.98 / 10s |

Both tiers share the same request schema (`prompt`, `duration`, `aspect_ratio`, `negative_prompt`, `cfg_scale`). Pro produces higher quality output at roughly double the cost.

## Invocation

```bash
doppler run -p claude-code -c std --no-fallback -- bun ~/.claude/skills/vidgen-fal/scripts/vidgen-fal.ts --prompt "<text>"
```

Pass the file path directly — `bun run` is not used because it would interpret the path as a package.json script name.

## Flag reference

| Flag | Default | Description |
|---|---|---|
| `--prompt <text>` | required | Text description of the video to generate. |
| `--out <dir>` | `~/Pictures/vidgen` | Output directory for all generated files. |
| `--duration <5\|10>` | `5` | Clip length in seconds. Enum — only `5` or `10` accepted. |
| `--aspect-ratio <16:9\|9:16\|1:1>` | `16:9` | Output aspect ratio. |
| `--cfg-scale <0–1>` | `0.5` | Prompt adherence (float). Values outside 0–1 are rejected. |
| `--negative-prompt <text>` | `blur, distort, and low quality` | Negative prompt passed verbatim to Kling. |
| `--pro` | off | Switch to the pro tier endpoint. |
| `--webm` | off | Also encode a WebM loop (VP9) alongside the MP4. Both files are kept and emitted. |
| `--scale <number>` | `640` | Width in pixels for the WebM output. Must be a positive even integer. Height is computed automatically. Has no effect unless `--webm` is set. |
| `--webm-crf <number>` | `32` | VP9 quality, 0–63. Lower = larger file / better quality. Out-of-range values are rejected. Has no effect unless `--webm` is set. |

## Workflow

```
// Gather
intent      = do("understand what motion or scene the user wants")

// Expand prompt
prompt = do("""
  Rewrite the request as a descriptive paragraph.
  Cover: subject, motion type, environment, mood, lighting, style.
  Do NOT include loop or WebM wording — that is handled by the pipeline.
""")

// Choose flags
duration_flag     = do("--duration 10 if user wants a longer clip; default 5 is fine for most")
aspect_flag       = do("--aspect-ratio 9:16 for portrait/vertical output; omit for landscape default")
cfg_flag          = do("--cfg-scale <n> only if user wants tighter (closer to 1) or looser prompt adherence")
negative_flag     = do("--negative-prompt '<text>' to override default")
pro_flag          = do("--pro if user asks for higher quality or if standard output is unsatisfactory")
out_flag          = do("--out <dir> when the user specifies an output path")
webm_flag         = do("--webm if user wants a WebM loop encoded alongside the MP4 (default: MP4 only)")
scale_flag        = do("--scale <n> to override the default 640px width (must be even, e.g. --scale 480 for smaller output)")
crf_flag          = do("--webm-crf <n> to override the default quality (e.g. --webm-crf 28 for higher quality)")

// Invoke  (pipeline: fal call → MP4 kept; if --webm: ffmpeg scale + VP9 → WebM also kept)
Bash(doppler run -p claude-code -c std --no-fallback -- \
  bun ~/.claude/skills/vidgen-fal/scripts/vidgen-fal.ts \
  --prompt "<prompt>" \
  [duration_flag] [aspect_flag] [cfg_flag] [negative_flag] [pro_flag] \
  [out_flag] [webm_flag] [scale_flag] [crf_flag])

// Relay output
do("print the 'video: ...' path so the user can open it")
do("if --webm was set, also print the 'webm: ...' path")
do("note the log path and elapsed time if emitted")
```

## Notes

**Source fps.** Kling v1.6 standard renders at 24 fps at 1280×720 (confirmed via smoke test on a real output).

**MP4 as master.** The MP4 from Kling is always kept. It is the highest-quality output and serves as the source for any downstream transcode. Pass `--webm` to produce a WebM alongside it.

**FAL_KEY** is injected by `doppler run -p claude-code -c std --no-fallback`. It is never passed on the command line.

**Output files.** The script emits `vidgen-<timestamp>.mp4` into `~/Pictures/vidgen/` (created automatically) or the directory given by `--out`. When `--webm` is set, a matching `.webm` is also produced in the same directory. A `log.jsonl` entry is appended per run.

### If you opt into --webm

**WebM size.** A 5s source at 24 fps × 1280×720 scaled to 640×360 with VP9 crf 32 produces roughly 1–3 MB. Compare that to the 144 MB GIF the same source produced — WebM is the practical format for looping video in HTML5 contexts.

**Looping in HTML5.** WebM loops automatically with `<video loop autoplay muted playsinline>`. No special encoding or server configuration is required.

**Tuning levers.** Use `--scale 480` to cut size further at the cost of resolution. Use `--webm-crf 36` to reduce file size at the cost of visible compression artifacts. Use `--webm-crf 24` for higher quality at a larger file size. `--scale` and `--webm-crf` are independent.

### Convert MP4 to WebM later

If you have the MP4 and want to produce a WebM after the fact, use the same pipeline the script runs internally:

```bash
ffmpeg -i in.mp4 -vf scale=640:-2 -c:v libvpx-vp9 -crf 32 -b:v 0 -row-mt 1 -pix_fmt yuv420p -g 1 -keyint_min 1 -an out.webm
```
