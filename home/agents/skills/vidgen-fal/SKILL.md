---
name: vidgen-fal
description: >
  The fal.ai worker for video generation — produces a seamless looped GIF (plus
  the MP4 source) via local ffmpeg pingpong reverse-concat and palette-optimized
  encoding. No router hub exists today; invoke this skill directly.
  Triggers: /vidgen-fal, "generate a video", "make a looping gif", "animate this",
  explicit mentions of "fal video", "Kling video", or "AnimateDiff".
  Skip for image-only tasks and non-video generation requests.
---

# vidgen-fal

This skill is a direct-call fal.ai video worker. It calls a fal video endpoint, downloads the MP4, then runs a local ffmpeg pipeline — pingpong reverse-concat followed by palettegen/paletteuse — to produce a seamless looped GIF. No router hub exists today; the user chose this as a direct-call worker.

## Models

| Model ID | Notes |
|---|---|
| `fal-ai/fast-animatediff/text-to-video` | **Default.** AnimateDiff t2v, text prompt only, ~$0/compute-second (fal free tier). 16 frames at 8fps = 2s forward + 2s reversed = 4-second pingpong loop. Designed for ambient, stylized motion — ideal for pingpong. |
| `fal-ai/kling-video/v1.6/standard/text-to-video` | **Fallback.** Kling v1.6 standard t2v, $0.28 for a 5-second clip. Cinematic naturalistic motion with smoother loops; use if AnimateDiff output quality is too low. |

Override the endpoint with `--endpoint` when needed.

## Invocation

```bash
doppler run -p claude-code -c std --no-fallback -- bun ~/.claude/skills/vidgen-fal/scripts/vidgen-fal.ts --prompt "<text>"
```

Pass the file path directly — `bun run` is not used because it would interpret the path as a package.json script name.

## Flag reference

| Flag | Default | Description |
|---|---|---|
| `--prompt <text>` | required | Text description of the video to generate. |
| `--out <dir>` | cwd | Output directory for all generated files. |
| `--frames <n>` | `16` | Number of frames (1–32). 16 frames = 2-second clip, ideal for pingpong. |
| `--fps <n>` | `8` | Frames per second (1–16). |
| `--endpoint <id>` | `fal-ai/fast-animatediff/text-to-video` | Override the fal endpoint ID. |
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
frames_flag   = do("--frames 16 is fine for most loops; increase to 24-32 for smoother motion")
fps_flag      = do("--fps 8 default; 12 if smoother playback is wanted")
out_flag      = do("--out <dir> when the user specifies an output path")
gif_flag      = do("--no-gif only if user explicitly wants MP4 only")
pingpong_flag = do("--no-pingpong only if the motion is inherently cyclic (e.g. a pendulum) or user requests single-pass")
endpoint_flag = do("--endpoint fal-ai/kling-video/v1.6/standard/text-to-video only if user asks for Kling or higher quality")

// Invoke
Bash(doppler run -p claude-code -c std --no-fallback -- \
  bun ~/.claude/skills/vidgen-fal/scripts/vidgen-fal.ts \
  --prompt "<prompt>" \
  [frames_flag] [fps_flag] [out_flag] [gif_flag] [pingpong_flag] [endpoint_flag])

// Relay output
do("print the 'video: ...' and 'gif: ...' paths so the user can open them")
do("note the log path and elapsed time if emitted")
```

## Notes

**Loop quality.** Pingpong quality depends heavily on motion direction. Prompts that describe slow, ambient, non-directional motion — smoke, mist, ripples, falling petals, flickering flames — produce near-invisible seams. Prompts that imply camera movement, a character walking, or a strongly directional pan will show a visible jump at the midpoint. Add to the negative prompt: `"camera movement, walking, panning, zooming"`.

**Palette optimization.** The `palettegen=stats_mode=full` + `paletteuse=dither=sierra2_4a` pipeline generates a dedicated 256-color palette from the full video, maximizing GIF color fidelity. This produces noticeably better output than ffmpeg's default palette. The intermediate palette PNG and pingpong MP4 are deleted after encoding.

**Prompt guidance.** AnimateDiff responds well to quality boosters appended to the prompt: `masterpiece, best quality, highly detailed`. Use `negative_prompt` (via direct `fal.subscribe` input if extended control is needed) to suppress `bad quality, worst quality:1.2`.

**FAL_KEY** is injected by `doppler run -p claude-code -c std --no-fallback`. It is never passed on the command line.

**Output files.** The script emits `vidgen-<timestamp>.mp4` and (when `--no-gif` is not set) `vidgen-<timestamp>.gif` into the output directory. A `log.jsonl` entry is appended per run.
