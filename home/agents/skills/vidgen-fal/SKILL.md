---
name: vidgen-fal
description: >
  The fal.ai worker for video generation — produces a seamless looped GIF (plus
  the MP4 source) via local ffmpeg pingpong reverse-concat and palette-optimized
  encoding. Targets Kling v1.6 by default (standard tier); pass --pro for the
  pro tier. No router hub exists today; invoke this skill directly.
  Triggers: /vidgen-fal, "generate a video", "make a looping gif", "animate this",
  explicit mentions of "fal video", "Kling video".
  Skip for image-only tasks and non-video generation requests.
---

# vidgen-fal

This skill is a direct-call fal.ai video worker. It calls a Kling v1.6 endpoint, downloads the MP4, then runs a local ffmpeg pipeline — pingpong reverse-concat followed by palettegen/paletteuse — to produce a seamless looped GIF. No router hub exists today; the user chose this as a direct-call worker.

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
| `--no-gif` | off | Skip the ffmpeg GIF stage; keep the MP4 only. |
| `--no-pingpong` | off | Single-pass MP4 → GIF without reverse-concat. |

## Workflow

```
// Gather
intent      = do("understand what motion or scene the user wants looped")

// Expand prompt
prompt = do("""
  Rewrite the request as a descriptive paragraph.
  Cover: subject, motion type, environment, mood, lighting, style.
  Bias toward ambient, non-directional motion (smoke, petals, ripples, flames) —
  directional camera motion or walking figures produce poor pingpong seams.
  Do NOT include GIF, loop, or pingpong wording — that is handled by the pipeline.
""")

// Choose flags
duration_flag     = do("--duration 10 if user wants a longer clip; default 5 is fine for most loops")
aspect_flag       = do("--aspect-ratio 9:16 for portrait/vertical output; omit for landscape default")
cfg_flag          = do("--cfg-scale <n> only if user wants tighter (closer to 1) or looser prompt adherence")
negative_flag     = do("--negative-prompt '<text>' to override default; append camera movement etc. for better loops")
pro_flag          = do("--pro if user asks for higher quality or if standard output is unsatisfactory")
out_flag          = do("--out <dir> when the user specifies an output path")
gif_flag          = do("--no-gif only if user explicitly wants MP4 only")
pingpong_flag     = do("--no-pingpong only if the motion is inherently cyclic or user requests single-pass")

// Invoke
Bash(doppler run -p claude-code -c std --no-fallback -- \
  bun ~/.claude/skills/vidgen-fal/scripts/vidgen-fal.ts \
  --prompt "<prompt>" \
  [duration_flag] [aspect_flag] [cfg_flag] [negative_flag] [pro_flag] \
  [out_flag] [gif_flag] [pingpong_flag])

// Relay output
do("print the 'video: ...' and 'gif: ...' paths so the user can open them")
do("note the log path and elapsed time if emitted")
```

## Notes

**Loop quality.** Pingpong quality depends heavily on motion direction. Prompts that describe slow, ambient, non-directional motion — smoke, mist, ripples, falling petals, flickering flames — produce near-invisible seams. Prompts that imply camera movement, a character walking, or a strongly directional pan will show a visible jump at the midpoint. Extend the negative prompt: `"camera movement, walking, panning, zooming, blur, distort, and low quality"`.

**Palette optimization.** The `palettegen=stats_mode=full` + `paletteuse=dither=sierra2_4a` pipeline generates a dedicated 256-color palette from the full video, maximizing GIF color fidelity. This produces noticeably better output than ffmpeg's default palette. The intermediate palette PNG and pingpong MP4 are deleted after encoding.

**GIF size with Kling source.** A 5s clip pingponged into a 10s loop at Kling's native fps (not documented by fal, but consistently observed as ~30 fps externally) produces a large GIF — typically tens of MB. Use `--no-pingpong` to halve the frame count, or `--no-gif` to keep MP4 only. Downscaling and a separate gif-fps control are deferred to a follow-up. Verify rendered fps with `ffprobe <file>` on first run.

**FAL_KEY** is injected by `doppler run -p claude-code -c std --no-fallback`. It is never passed on the command line.

**Output files.** The script emits `vidgen-<timestamp>.mp4` and (when `--no-gif` is not set) `vidgen-<timestamp>.gif` into `~/Pictures/vidgen/` (created automatically) or the directory given by `--out`. A `log.jsonl` entry is appended per run.
