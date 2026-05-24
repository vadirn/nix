# What's the right CLI / flag shape for max-quality-first imagen and vidgen workflows that keep transparency and format conversion as separable, opt-in steps?

Date: 2026-05-24
Status: answered
Time-box: 30m / 30m

## Method

Side-by-side comparison of four candidate API shapes for the three skills (`imagen-nanobanana`, `imagen-fal`, `vidgen-fal`), with concrete CLI examples for each. No code written — the underlying pipelines are known-working; what is open is the surface shape. Evidence is the tradeoff analysis per shape against five sub-questions: transparency strategy, format passthrough, draft/final API, destructive vs non-destructive output, and vidgen MP4/WebM defaults.

## Result

### The five sub-questions

**Q1. Transparency strategy.** Currently asymmetric: `imagen-nanobanana --chroma-key-fallback` forces a green-plate prompt then ffmpeg-keys it; `imagen-fal --transparent` runs BiRefNet on whatever Kling rendered, no prompt manipulation. The asymmetry hurts `imagen-fal` quality on busy scenes.

**Q2. Format passthrough.** `imagen-nanobanana` returns whatever MIME Gemini emits (currently JPEG). Question: re-encode to PNG, or keep as JPEG and document?

**Q3. Draft vs final.** Defaults today bias toward cheap draft sizes (`--resolution 512` on nano-banana, `1k` on fal). The user wants max quality after draft selection.

**Q4. Destructive output.** `--transparent` and `--chroma-key-fallback` both overwrite the generated file with the keyed version. If the cutout is wrong, the original is gone (paid call).

**Q5. vidgen MP4/WebM.** Source MP4 is deleted by default; ships only the lossy 640 px VP9 WebM. The master is destroyed.

### Candidate shapes

**Shape A — Flip defaults, unified transparency, non-destructive, no new flags.**

```sh
# Draft phase (explicit, opt-in to cheap mode)
imagen-nanobanana "a fox" --drafts 4 --resolution 512
imagen-fal       "a fox" --drafts 4 --resolution 1k
vidgen-fal --prompt "fox running"   # default is now MP4-only; no WebM

# Final phase (default is max quality)
imagen-nanobanana "a fox"               # → 2K
imagen-fal       "a fox"                # → 2k
vidgen-fal --prompt "fox running" --webm  # opt in to WebM transcode

# Transparency (unified: green-plate prompt + cutout step)
imagen-nanobanana "a fox" --transparent                  # default cutout: colorkey
imagen-fal       "a fox" --transparent                   # default cutout: birefnet
imagen-fal       "a fox" --transparent --cutout colorkey # override
imagen-fal       "a fox" --transparent --cutout none     # keep raw green-plate
```

Sibling-file convention: `name.png` (raw) + `name-alpha.png` (cutout). Both reported.

**Shape B — Keep current defaults, add `--final` / `--draft` shortcuts.**

```sh
imagen-nanobanana "a fox" --draft   # → 512, drafts=4
imagen-nanobanana "a fox" --final   # → 2K, drafts=1
imagen-nanobanana "a fox"           # → 512 (back-compat default)
vidgen-fal --prompt "fox" --final   # → MP4 only, max
vidgen-fal --prompt "fox"           # → 640 px WebM, MP4 deleted (current)
```

**Shape C — Split skills: generators do only generation; new `cutout` / `convert` skill handles transparency and format.**

```sh
imagen-nanobanana "a fox"                  # always JPEG/PNG, no transparent flag
Skill(cutout) --in fox.jpg --green-plate   # generates --alpha.png
vidgen-fal --prompt "fox"                  # MP4 only
Skill(convert) --in fox.mp4 --to webm640   # produces WebM
```

**Shape D — Hybrid: workers expose `--transparent` as a convenience that internally invokes a shared `cutout` skill.**

```sh
imagen-fal "a fox" --transparent           # internally: generate, then Skill(cutout)
```

### Tradeoff matrix

| Dimension | A | B | C | D |
|---|---|---|---|---|
| Breaking changes | yes (defaults flip) | none | yes (flags removed) | yes (flags moved) |
| New flag surface | +1 (`--cutout`, `--webm`) | +2 (`--draft`/`--final`) | -2 (transparent, no-webm gone) | +1 (`--cutout`) |
| Convenience of one-shot transparency | preserved | preserved | lost (two skills) | preserved |
| Conversion is separable | yes (sibling file) | yes (sibling file) | yes (separate skill) | yes (separate skill, indirect) |
| Master output preserved | yes | yes | yes | yes |
| Maintenance burden | low (3 SKILL.md edits + script tweaks) | medium (preset logic + dual paths) | high (new skill scaffold) | medium-high (new skill + indirection) |
| Cleanest mental model | "skills do one thing; flags are explicit phase markers" | "shortcuts for common cases" | "compose small tools" | "convenience over composition" |

### Confidence

Confidence: 9/10 (after smoke test, see below). Biggest remaining risk: ffmpeg colorkey tuning on Gemini's flat-green output has not been re-verified against the current `gemini-3.1-flash-image-preview` default — existing tuning is from an earlier model run.

### Smoke test: Kling green-plate directive (added 2026-05-24)

Two runs, four images, $0.112 total.

**Run 1.** Prompt: red apple + the verbatim `imagen-nanobanana` green-plate directive ("entire background must be a single flat fully saturated pure green #00ff00 … no pattern, gradient, shadow"). Both drafts came back with a **gradient** studio-backdrop green. Sampled background pixels in the (16–70, 100–160, 30–80) RGB range — nowhere near (0, 255, 0).

**Run 2.** More aggressive prompt forbidding studio lighting, gradient, vignette, ambient occlusion, color variation; explicitly invoking "paint bucket tool". Draft 1 **misparsed "green plate" as a physical dinner plate** on a red background — completely off. Draft 2 still rendered a gradient green backdrop sampling around (110, 192, 113) — still nowhere near (0, 255, 0).

Conclusion: **Kling on fal does NOT honor a chroma-key green directive.** The prompt strategy that works for Gemini Nano Banana does not transfer. ffmpeg colorkey is not a viable cutout option for Kling output regardless of how the prompt is phrased; BiRefNet is the only viable cutout method.

### Falsification

What would falsify this conclusion: a Kling prompt formulation that produces a flat #00ff00 backdrop. Two attempts above both failed; further iteration is plausible but the cost/reliability tradeoff vs. BiRefNet (already wired, already works) is no longer favorable. Branches the prototype did not exercise: BiRefNet quality on Kling-natural vs Kling-(failed)-green-plate inputs, colorkey tuning on current Gemini model output.

### Reasoning chain

- **Thesis**: Shape A is the right shape.
- **Premise 1**: The user's stated principle is "max quality from skill; conversion separate; chroma-key even with specialized model". Grounded in the user message of this session.
- **Premise 2**: Current defaults violate the principle on all three skills (512/1k draft sizes; vidgen deletes MP4; in-place transparency overwrite). Grounded in source code review (`imagen.sh` L61, `imagen-fal.ts` L144, `vidgen-fal.ts` L295).
- **Premise 3**: Two existing flags (`--drafts`, `--resolution`) already express the draft/final dichotomy; a third preset flag is redundant. Grounded in flag inventories of all three SKILL.md files.
- **Premise 4**: The current `imagen-fal --transparent` skips the green-plate prompt trick and runs BiRefNet on busy scenes. Grounded in `imagen-fal.ts` L307 (calls `applyBiRefNet` without prompt modification) vs `imagen-nanobanana/SKILL.md` L44–54 (forces green-plate prompt directive).
- **Conclusion**: Flipping defaults, adding `--cutout` and `--webm` as the only new flags, and making outputs non-destructive (sibling-file convention) achieves the user's principle with the smallest API change.

## Decision

Adopt Shape A: flip defaults to max-quality, unify transparency under green-plate-prompt + `--cutout=birefnet|colorkey|none`, write cutout as sibling file (not in-place), and flip `vidgen-fal` to MP4-by-default with `--webm` as opt-in.

### Resolutions per open question (from prior message)

- **Q1 transparency**: Strategy splits by provider, **not unified at the prompt level** (smoke test killed the unified version):
  - `imagen-nanobanana --transparent`: green-plate prompt + ffmpeg colorkey. Gemini honors flat #00ff00. (Current behavior, kept.)
  - `imagen-fal --transparent`: BiRefNet on raw Kling output, **no green-plate prompt**. Kling does not render a clean chroma-key backdrop regardless of directive strength. (Current behavior, kept.)
  - The `--cutout=birefnet|colorkey|none` flag is still added on both workers as a convenience, but the *default* matches what works for each provider. `--cutout none` skips cutout and emits the raw generation.
- **Q2 format passthrough**: Leave as-is. Skill does not transcode JPEG→PNG. SKILL.md adds a one-line note: "For lossless archival, re-encode externally: `magick in.jpg out.png` or `ffmpeg -i in.jpg out.png`."
- **Q3 API shape**: Flip defaults; no `--all-quality` / `--final` shortcut. Existing `--drafts N --resolution 512|1k` already expresses draft mode explicitly.
- **Q4 destructive output**: Sibling-file convention. `name.jpg` (raw or green-plate) is always preserved; `name-alpha.png` is added when `--cutout` runs. Both paths reported.
- **Q5 vidgen format**: MP4 is the master. `--webm` is the only new flag (replaces `--no-webm` / `--keep-mp4` pair). SKILL.md documents the ffmpeg one-liner (`ffmpeg -i in.mp4 -vf scale=640:-2 -c:v libvpx-vp9 -crf 32 -b:v 0 -row-mt 1 -pix_fmt yuv420p -g 1 -keyint_min 1 -an out.webm`) for users who want WebM later.

### Net flag changes

| Skill | Removed | Added | Default flipped |
|---|---|---|---|
| `imagen-nanobanana` | (none — `--chroma-key-fallback` kept as deprecated alias for `--transparent --cutout colorkey`) | `--transparent`, `--cutout` | `--resolution`: 512 → 2K |
| `imagen-fal` | (none) | `--cutout` | `--resolution`: 1k → 2k |
| `vidgen-fal` | `--no-webm`, `--keep-mp4` | `--webm` | output: WebM-default → MP4-default |

## Next step

Implement Shape A across the three skills — flip defaults, add `--cutout` flag (defaults differ per provider per smoke-test finding), add `--webm` to vidgen, switch transparency outputs to sibling-file naming. Do NOT add a green-plate prompt directive to `imagen-fal` — Kling doesn't honor it. The unified flag surface stays; the unified prompt strategy is dropped.
