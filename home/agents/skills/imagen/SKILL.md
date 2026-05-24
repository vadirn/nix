---
name: imagen
description: >
  Router hub for image generation. Triggers: /imagen, "generate an image", "create a picture",
  "make an image", «нарисуй», «сгенерируй картинку». Dispatches to either imagen-nanobanana
  (Google Nano Banana / Gemini, direct API) or imagen-fal (Kling O1 + BiRefNet via fal.ai)
  based on prompt characteristics — invoke the worker skills directly only when you need to
  pin a provider.
---

# imagen

This skill is a router only — it has no script of its own. It reads the user's prompt, matches it against the decision table below, and invokes the appropriate worker skill via the `Skill` tool. Both workers (`imagen-nanobanana`, `imagen-fal`) remain explicitly callable when the user wants to pin a provider.

## Routing decision table

| Signal | Worker | Why |
|---|---|---|
| Text inside image (sign, label, UI mock, readable words) | `imagen-nanobanana` | Nano Banana is strong at typography; Kling O1 is explicitly weak at text rendering. |
| Numerical / logical reasoning (chart, infographic, diagram, math) | `imagen-nanobanana` | Nano Banana has stronger reasoning needed to place data correctly. |
| 4+ reference images, multi-reference remix | `imagen-fal` | Kling O1 accepts up to 10 reference images; Nano Banana does not support multi-ref. |
| Cinematic / anime / stylised artistic composition | `imagen-fal` | Declared Kling strength per provider documentation. |
| Transparent background requested | `imagen-fal --transparent` | BiRefNet v2 produces a clean alpha PNG sibling. Chroma-key (the nanobanana path via `--transparent --cutout colorkey`) is reserved for hard-edged subjects. |
| Default / ambiguous | `imagen-nanobanana` | Cheaper for the common case — see cost rationale below. |

## Dispatch

```
// Read intent
intent      = do("understand what the user wants to create")
prompt_args = do("collect any flags the user specified: --source, --drafts, --model, --aspect, --resolution, --name, --out, --transparent")

// Match signals (in priority order)
transparent_requested = do("true if user asked for transparent / alpha / cut-out / no background")
ref_count             = do("count of --source images the user provided; 0 if none")
text_in_image         = do("true if the final image must contain readable text: signs, labels, UI mockups")
reasoning_image       = do("true if the image requires numerical layout: charts, infographics, math diagrams")
cinematic_or_anime    = do("true if the prompt is primarily cinematic, anime, or highly stylised artistic composition")

// Route: prefer Kling for refs / transparent; otherwise nanobanana
if transparent_requested OR ref_count >= 4:
  worker = "imagen-fal"
else if text_in_image OR reasoning_image:
  worker = "imagen-nanobanana"
else if cinematic_or_anime:
  worker = "imagen-fal"
else:
  worker = "imagen-nanobanana"   // default: cheaper

// Inject worker-specific transparency flag from natural-language signal
if transparent_requested:
  if worker == "imagen-fal" AND "--transparent" not in prompt_args:
    prompt_args = prompt_args + " --transparent"   // default cutout is birefnet on fal
  else if worker == "imagen-nanobanana" AND "--transparent" not in prompt_args:
    prompt_args = prompt_args + " --transparent --cutout colorkey"

// Invoke — args passed through verbatim; both workers accept the same flag shape.
if worker == "imagen-nanobanana":
  Skill(skill: "imagen-nanobanana", args: "<prompt> [prompt_args]")
else:
  Skill(skill: "imagen-fal", args: "<prompt> [prompt_args]")
```

If multiple signals match: prefer `imagen-fal` when any of ≥4 refs or transparent is present; fall through to `imagen-nanobanana` otherwise.

## Capability gaps

- `kling-v3-omni` is not on fal — the hub cannot route to it today. Inform the user and defer.
- Character-consistent series (`kling-v3-omni` `series_amount`) is not supported today because v3-omni is not hosted on fal. Both workers treat `num_images > 1` as independent variants, not a coherent series.
- Kling on fal splits text-to-image (`fal-ai/kling-image/v3/text-to-image`) and image-to-image (`fal-ai/kling-image/o1`, requires `--source`) across separate endpoints. `imagen-fal` auto-picks based on whether `--source` is provided.
- 4K resolution: Kling O1 on fal tops out at 2K (per fal's hosted variant). 4K output requires direct Kling, which is not implemented.
- Nano Banana via fal: `fal-ai/nano-banana-2` and `fal-ai/nano-banana-pro` exist on fal but cost 3–10× direct Google API billing. The hub routes Nano Banana work to `imagen-nanobanana` (direct Google) by default. Explicit `--model fal-ai/nano-banana-2` passed to `imagen-fal` is the override when a user wants fal's predictable per-image pricing instead.

## Cost rationale

Asymmetric pricing drives the asymmetric architecture. fal charges 0% markup on Kling O1 ($0.028/image), so Kling work routes through fal; fal charges 3–10× markup on Nano Banana relative to the direct Google API, so Nano Banana work routes direct to Google via `imagen-nanobanana`. The hybrid keeps the cheapest path for each provider and makes `imagen-nanobanana` the sensible default for ambiguous prompts where either provider could work.
