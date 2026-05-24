---
name: vidgen-fal
description: >
  The fal.ai worker for video generation — produces a Kling-rendered MP4 plus a
  small palette-free WebM loop (default 640px wide, ~1–3 MB for a 5s clip) encoded
  with VP9. The WebM loops natively in HTML5 video with no special encoding required.
  Targets Kling v1.6 by default (standard tier); pass --pro for the pro tier. No
  router hub exists today; invoke this skill directly.
  Triggers: /vidgen-fal, "generate a video", "make a looping video", "animate this",
  explicit mentions of "fal video", "Kling video".
  Skip for image-only tasks and non-video generation requests.
---

# vidgen-fal

This skill is a direct-call fal.ai video worker. It calls a Kling v1.6 endpoint, downloads the MP4, then runs a local ffmpeg pipeline — scale + VP9 encode — to produce a WebM that loops natively in HTML5 video. No router hub exists today; the user chose this as a direct-call worker.

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
| `--no-webm` | off | Skip the ffmpeg WebM stage; keep the MP4 only. |
| `--scale <number>` | `640` | Width in pixels for the WebM output. Height is computed automatically to preserve aspect ratio. |
| `--webm-crf <number>` | `32` | VP9 quality, 0–63. Lower = larger file / better quality. Out-of-range values are rejected. |

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
webm_flag         = do("--no-webm only if user explicitly wants MP4 only")
scale_flag        = do("--scale <n> to override the default 640px width (e.g. --scale 480 for smaller output)")
crf_flag          = do("--webm-crf <n> to override the default quality (e.g. --webm-crf 28 for higher quality)")

// Invoke  (pipeline: fal call → MP4 → ffmpeg (scale + VP9) → WebM)
Bash(doppler run -p claude-code -c std --no-fallback -- \
  bun ~/.claude/skills/vidgen-fal/scripts/vidgen-fal.ts \
  --prompt "<prompt>" \
  [duration_flag] [aspect_flag] [cfg_flag] [negative_flag] [pro_flag] \
  [out_flag] [webm_flag] [scale_flag] [crf_flag])

// Relay output
do("print the 'video: ...' and 'webm: ...' paths so the user can open them")
do("note the log path and elapsed time if emitted")
```

## Notes

**Source fps.** Kling v1.6 standard renders at 24 fps at 1280×720 (confirmed via smoke test on a real output). The WebM transcode scales the video to the target width while preserving aspect ratio and native frame rate.

**WebM size.** A 5s source at 24 fps × 1280×720 scaled to 640×360 with VP9 crf 32 produces roughly 1–3 MB. Compare that to the 144 MB GIF the same source produced — WebM is the practical format for looping video in HTML5 contexts.

**Looping in HTML5.** WebM loops automatically with `<video loop autoplay muted playsinline>`. No special encoding or server configuration is required.

**Tuning levers.** Use `--scale 480` to cut size further at the cost of resolution. Use `--webm-crf 36` to reduce file size at the cost of visible compression artifacts. Use `--webm-crf 24` for higher quality at a larger file size. `--scale` and `--webm-crf` are independent.

**MP4 only.** Pass `--no-webm` if you just want the raw MP4 from Kling without any local transcoding.

**FAL_KEY** is injected by `doppler run -p claude-code -c std --no-fallback`. It is never passed on the command line.

**Output files.** The script emits `vidgen-<timestamp>.mp4` and (when `--no-webm` is not set) `vidgen-<timestamp>.webm` into `~/Pictures/vidgen/` (created automatically) or the directory given by `--out`. A `log.jsonl` entry is appended per run.
