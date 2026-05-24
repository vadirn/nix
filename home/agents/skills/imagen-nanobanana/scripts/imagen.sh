#!/usr/bin/env bash
# imagen.sh — generate images via Google Gemini image models
# Usage: imagen.sh "<prompt>" [--source <img>]... [--drafts N] [--model M]
#                             [--aspect A] [--resolution R] [--name S] [--out PATH]
#                             [--transparent] [--cutout <colorkey|none>]
#                             [--chroma-key-fallback]
set -uo pipefail

# Require bash >= 4.3 (for wait -n)
if [[ "${BASH_VERSINFO[0]}" -lt 4 ]] || [[ "${BASH_VERSINFO[0]}" -eq 4 && "${BASH_VERSINFO[1]}" -lt 3 ]]; then
  echo "ERROR: bash >= 4.3 is required (this script uses 'wait -n'); found ${BASH_VERSION}" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------
usage() {
  cat <<'EOF'
Usage: imagen.sh "<prompt>" [OPTIONS]

Generate images via Google Gemini image models (default: gemini-3.1-flash-image-preview).

Positional:
  <prompt>           Required image description (quoted string).

Options:
  --source <path>    Image file to edit/compose/reference. Repeatable, up to 10.
  --drafts N         Number of images to generate, 1-8 (default: 1).
  --model M          Model name (default: gemini-3.1-flash-image-preview).
  --aspect A         Aspect ratio: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4,
                     9:16, 16:9, 21:9 (default: 1:1).
  --resolution R     Output resolution: 512, 1K, 2K, 4K (default: 2K).
                     Not supported by gemini-2.5-flash-image.
  --name S           Output filename slug (default: slugified first ~5 prompt words).
  --out PATH         Explicit output path. Valid only with --drafts 1.
  --transparent      Signal that the caller will post-process the output with ffmpeg
                     chroma-key to achieve transparency. The script accepts and logs
                     the flag but performs no keying itself — the SKILL.md workflow
                     runs the ffmpeg step after the script exits.
                     Default --cutout when --transparent is set: colorkey.
  --cutout MODE      Cutout mode: colorkey (ffmpeg chroma-key) or none (skip cutout).
                     Only meaningful when --transparent is also set.
  --chroma-key-fallback
                     Deprecated alias for --transparent --cutout colorkey.
  -h, --help         Show this help and exit.

Environment:
  GEMINI_API_KEY     Google API key (injected by doppler run).
  IMAGEN_DIR         Output directory (default: ~/Pictures/imagen).

Example:
  doppler run -p claude-code -c std --no-fallback -- \
    bash imagen.sh "A sunlit forest path in watercolour style" --aspect 16:9 --drafts 3
EOF
}

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
PROMPT=""
SOURCES=()
DRAFTS=1
MODEL="gemini-3.1-flash-image-preview"
ASPECT="1:1"
RESOLUTION="2K"
NAME_SLUG=""
OUT_PATH=""
RESOLUTION_EXPLICIT=0
CHROMA_KEY_FALLBACK=0
TRANSPARENT=0
CUTOUT=""

if [[ $# -eq 0 ]]; then
  usage
  exit 0
fi

# First positional arg is the prompt (if not a flag)
if [[ "${1:-}" != -* ]]; then
  PROMPT="$1"
  shift
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --source)
      [[ $# -lt 2 ]] && { echo "ERROR: --source requires a path" >&2; exit 1; }
      SOURCES+=("$2")
      shift 2
      ;;
    --drafts)
      [[ $# -lt 2 ]] && { echo "ERROR: --drafts requires a number" >&2; exit 1; }
      DRAFTS="$2"
      shift 2
      ;;
    --model)
      [[ $# -lt 2 ]] && { echo "ERROR: --model requires a value" >&2; exit 1; }
      MODEL="$2"
      shift 2
      ;;
    --aspect)
      [[ $# -lt 2 ]] && { echo "ERROR: --aspect requires a value" >&2; exit 1; }
      ASPECT="$2"
      shift 2
      ;;
    --resolution)
      [[ $# -lt 2 ]] && { echo "ERROR: --resolution requires a value" >&2; exit 1; }
      RESOLUTION="$2"
      RESOLUTION_EXPLICIT=1
      shift 2
      ;;
    --name)
      [[ $# -lt 2 ]] && { echo "ERROR: --name requires a value" >&2; exit 1; }
      NAME_SLUG="$2"
      shift 2
      ;;
    --out)
      [[ $# -lt 2 ]] && { echo "ERROR: --out requires a path" >&2; exit 1; }
      OUT_PATH="$2"
      shift 2
      ;;
    --transparent)
      TRANSPARENT=1
      shift
      ;;
    --cutout)
      [[ $# -lt 2 ]] && { echo "ERROR: --cutout requires a value (colorkey|none)" >&2; exit 1; }
      CUTOUT="$2"
      shift 2
      ;;
    --chroma-key-fallback)
      echo "WARNING: --chroma-key-fallback is deprecated; use --transparent --cutout colorkey instead" >&2
      CHROMA_KEY_FALLBACK=1
      TRANSPARENT=1
      CUTOUT="colorkey"
      shift
      ;;
    *)
      echo "ERROR: unknown flag: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Validate
# ---------------------------------------------------------------------------
if [[ -z "$PROMPT" ]]; then
  echo "ERROR: a prompt is required" >&2
  usage >&2
  exit 1
fi

# Validate drafts
case "$DRAFTS" in
  ''|*[!0-9]*) echo "ERROR: --drafts must be a positive integer" >&2; exit 1 ;;
esac
if [[ "$DRAFTS" -eq 0 ]]; then
  echo "ERROR: --drafts must be a positive integer" >&2
  exit 1
fi
if [[ "$DRAFTS" -gt 8 ]]; then
  echo "ERROR: --drafts must be 8 or fewer" >&2
  exit 1
fi

if [[ -n "$OUT_PATH" && "$DRAFTS" -ne 1 ]]; then
  echo "ERROR: --out is only valid with --drafts 1" >&2
  exit 1
fi

# Validate resolution
case "$RESOLUTION" in
  512|1K|2K|4K) ;;
  *) echo "ERROR: --resolution must be one of: 512, 1K, 2K, 4K" >&2; exit 1 ;;
esac

# Apply --transparent default for --cutout and validate
if [[ "$TRANSPARENT" -eq 1 && -z "$CUTOUT" ]]; then
  CUTOUT="colorkey"
fi
if [[ -n "$CUTOUT" ]]; then
  case "$CUTOUT" in
    colorkey|none) ;;
    *) echo "ERROR: --cutout must be one of: colorkey, none" >&2; exit 1 ;;
  esac
fi

# Validate aspect ratio
case "$ASPECT" in
  1:1|2:3|3:2|3:4|4:3|4:5|5:4|9:16|16:9|21:9) ;;
  *) echo "ERROR: --aspect must be one of: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9" >&2; exit 1 ;;
esac

# Validate source files and detect MIME types
if [[ ${#SOURCES[@]} -gt 10 ]]; then
  echo "ERROR: at most 10 --source images are supported (got ${#SOURCES[@]})" >&2
  exit 1
fi
declare -a SOURCE_MIMES=()
for src in "${SOURCES[@]+"${SOURCES[@]}"}"; do
  if [[ ! -f "$src" ]]; then
    echo "ERROR: source file not found: $src" >&2
    exit 1
  fi
  mime="$(file --mime-type -b "$src")"
  case "$mime" in
    image/png|image/jpeg|image/webp) ;;
    *) echo "ERROR: unsupported MIME type '$mime' for source: $src" >&2; exit 1 ;;
  esac
  SOURCE_MIMES+=("$mime")
done

# Model capability branch: gemini-2.5-flash-image does not accept imageSize
SUPPORTS_IMAGE_SIZE=1
if [[ "$MODEL" == "gemini-2.5-flash-image" ]]; then
  SUPPORTS_IMAGE_SIZE=0
  if [[ "$RESOLUTION_EXPLICIT" -eq 1 ]]; then
    echo "WARNING: --resolution is ignored for model $MODEL (fixed size)" >&2
  fi
fi

# ---------------------------------------------------------------------------
# Output directory and filename slug
# ---------------------------------------------------------------------------
IMAGEN_DIR="${IMAGEN_DIR:-$HOME/Pictures/imagen}"
mkdir -p "$IMAGEN_DIR" || { echo "ERROR: cannot create output directory: $IMAGEN_DIR" >&2; exit 1; }

# Ensure the parent directory of an explicit --out path exists
if [[ -n "$OUT_PATH" ]]; then
  out_parent="$(dirname "$OUT_PATH")"
  mkdir -p "$out_parent" || { echo "ERROR: cannot create output directory: $out_parent" >&2; exit 1; }
fi

if [[ -z "$NAME_SLUG" ]]; then
  # Slugify first ~5 words of the prompt
  NAME_SLUG="$(printf '%s' "$PROMPT" \
    | tr '[:upper:]' '[:lower:]' \
    | tr -cs 'a-z0-9' '-' \
    | sed 's/^-//; s/-$//' \
    | cut -c1-40 \
    | sed 's/-$//')"
fi
[[ -z "$NAME_SLUG" ]] && NAME_SLUG="image"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)-$$"

LOG_FILE="${IMAGEN_DIR}/log.jsonl"

# ---------------------------------------------------------------------------
# API key — secure handling
# ---------------------------------------------------------------------------
if [[ -z "${GEMINI_API_KEY:-}" ]]; then
  echo "ERROR: GEMINI_API_KEY is not set. Inject it via: doppler run -p claude-code -c std --no-fallback --" >&2
  exit 1
fi

# Allocate all temp paths up front so a single trap covers them all
CURL_CONFIG="$(mktemp)"
BODY_FILE="$(mktemp)"
RESULTS_DIR="$(mktemp -d)"
trap 'rm -f "$CURL_CONFIG" "$BODY_FILE"; rm -rf "$RESULTS_DIR"' EXIT INT TERM

# Write key to the curl config file; never expose it in argv
chmod 600 "$CURL_CONFIG"
printf 'header = "x-goog-api-key: %s"\n' "$GEMINI_API_KEY" >"$CURL_CONFIG"

ENDPOINT="https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent"

# ---------------------------------------------------------------------------
# Build JSON body (reused across drafts — all drafts share the same request)
# ---------------------------------------------------------------------------

# Build the parts array in one pass: the text part, then one inline_data part
# per source image. Emitting each part as a JSON line and slurping once avoids
# re-parsing the (potentially large) accumulating array on every source.
PARTS_JSON="$(
  {
    jq -cn --arg text "$PROMPT" '{text: $text}'
    if [[ ${#SOURCES[@]} -gt 0 ]]; then
      for i in "${!SOURCES[@]}"; do
        b64="$(base64 < "${SOURCES[$i]}" | tr -d '\n')"
        jq -cn --arg mime "${SOURCE_MIMES[$i]}" --arg data "$b64" \
          '{inline_data: {mime_type: $mime, data: $data}}'
      done
    fi
  } | jq -cs '.'
)"

# imageSize is included only for models that accept it; gemini-2.5-flash-image
# rejects it.
IMAGE_CONFIG="$(jq -n --arg aspect "$ASPECT" --arg size "$RESOLUTION" \
  --argjson withSize "$SUPPORTS_IMAGE_SIZE" \
  'if $withSize == 1
   then {aspectRatio: $aspect, imageSize: $size}
   else {aspectRatio: $aspect} end')"

jq -n \
  --argjson parts "$PARTS_JSON" \
  --argjson imageConfig "$IMAGE_CONFIG" \
  '{
    "contents": [{"parts": $parts}],
    "generationConfig": {
      "responseModalities": ["TEXT","IMAGE"],
      "imageConfig": $imageConfig
    }
  }' >"$BODY_FILE"

# ---------------------------------------------------------------------------
# Draft generation (bounded concurrency: max 2 in flight)
# ---------------------------------------------------------------------------
declare -a SUCCESSFUL_OUTPUTS=()
declare -a FAILED_DRAFTS=()

# Each draft runs in a subshell; results are communicated via temp files

run_draft() {
  local draft_num="$1"
  local out_file="$2"
  local result_file="${RESULTS_DIR}/draft-${draft_num}"

  local resp_file
  resp_file="$(mktemp -p "$RESULTS_DIR")"

  local http_code
  http_code="$(curl -s --max-time 180 --connect-timeout 20 \
    -X POST \
    -K "$CURL_CONFIG" \
    -H 'Content-Type: application/json' \
    --data "@${BODY_FILE}" \
    -w '%{http_code}' \
    -o "$resp_file" \
    "$ENDPOINT" 2>/dev/null)" || true

  if [[ "$http_code" != "200" ]]; then
    local err_msg
    err_msg="$(jq -r '.error.message // "unknown error"' "$resp_file" 2>/dev/null || echo "unknown error")"
    # Collapse newlines/tabs — the result file is parsed as a single TSV line
    err_msg="$(printf '%s' "HTTP ${http_code}: ${err_msg}" | tr '\n\t' '  ')"
    printf 'FAIL\t%s\t%s\n' "$draft_num" "$err_msg" >"$result_file"
    rm -f "$resp_file"
    return 1
  fi

  # Check for inlineData
  local has_image
  has_image="$(jq -r '[.candidates[0].content.parts[]? | select(.inlineData)] | length' "$resp_file" 2>/dev/null || echo 0)"

  if [[ "$has_image" -eq 0 ]]; then
    # Safety refusal or text-only response
    local text_content
    text_content="$(jq -r '[.candidates[0].content.parts[]?.text // empty] | join(" ")' "$resp_file" 2>/dev/null || echo "")"
    local finish_reason
    finish_reason="$(jq -r '.candidates[0].finishReason // ""' "$resp_file" 2>/dev/null || echo "")"
    local feedback
    feedback="$(jq -r '.promptFeedback // "" | if . == "" then "" else "promptFeedback: \(tojson)" end' "$resp_file" 2>/dev/null || echo "")"
    local noimg_msg
    # Collapse newlines/tabs — the result file is parsed as a single TSV line
    noimg_msg="$(printf '%s' "${text_content} [finishReason: ${finish_reason}] ${feedback}" | tr '\n\t' '  ')"
    printf 'NOIMG\t%s\t%s\n' "$draft_num" "$noimg_msg" >"$result_file"
    rm -f "$resp_file"
    return 1
  fi

  # Extract mimeType from the first inlineData part; fall back to image/png
  local mime_type
  mime_type="$(jq -r '[.candidates[0].content.parts[]? | select(.inlineData)] | first | .inlineData.mimeType // "image/png"' "$resp_file" 2>/dev/null || echo "image/png")"

  # Decode image bytes into a temp file; the caller will rename to the correct extension
  local img_tmp
  img_tmp="$(mktemp -p "$RESULTS_DIR")"
  jq -r '[.candidates[0].content.parts[]? | select(.inlineData)] | first | .inlineData.data' "$resp_file" \
    | base64 -d >"$img_tmp" 2>/dev/null

  # Capture usage metadata
  local usage
  usage="$(jq -c '.usageMetadata // {}' "$resp_file" 2>/dev/null || echo '{}')"

  printf 'OK\t%s\t%s\t%s\t%s\t%s\n' "$draft_num" "$img_tmp" "$out_file" "$usage" "$mime_type" >"$result_file"
  rm -f "$resp_file"
}

# Determine intended output paths upfront (extension will be corrected after API response)
# For --out PATH, the user's path is used verbatim.
# For auto-generated paths, .png is a placeholder; the final extension is set after decoding.
declare -a DRAFT_OUT_FILES=()
for ((i=1; i<=DRAFTS; i++)); do
  if [[ -n "$OUT_PATH" ]]; then
    DRAFT_OUT_FILES+=("$OUT_PATH")
  elif [[ "$DRAFTS" -eq 1 ]]; then
    DRAFT_OUT_FILES+=("${IMAGEN_DIR}/${NAME_SLUG}-${TIMESTAMP}.png")
  else
    DRAFT_OUT_FILES+=("${IMAGEN_DIR}/${NAME_SLUG}-${TIMESTAMP}-${i}.png")
  fi
done

# Run drafts with bounded concurrency (max 2 in flight)
in_flight=0
for ((i=1; i<=DRAFTS; i++)); do
  run_draft "$i" "${DRAFT_OUT_FILES[$((i-1))]}" &
  ((in_flight++)) || true
  if [[ "$in_flight" -ge 2 ]]; then
    # wait -n blocks until one job exits; ignore its exit status — a failed
    # draft returns non-zero, and `|| wait` would otherwise drain all jobs
    # and break the concurrency bound.
    wait -n 2>/dev/null || true
    ((in_flight--)) || true
  fi
done
# Wait for any remaining background jobs
wait

# ---------------------------------------------------------------------------
# Map MIME type to file extension
# ---------------------------------------------------------------------------
mime_to_ext() {
  local mime="$1"
  case "$mime" in
    image/png)  echo "png" ;;
    image/jpeg) echo "jpg" ;;
    image/webp) echo "webp" ;;
    *)          echo "png" ;;
  esac
}

# ---------------------------------------------------------------------------
# Collect results
# ---------------------------------------------------------------------------
FIRST_USAGE='{}'
for ((i=1; i<=DRAFTS; i++)); do
  result_file="${RESULTS_DIR}/draft-${i}"
  if [[ ! -f "$result_file" ]]; then
    FAILED_DRAFTS+=("$i")
    echo "ERROR: draft $i produced no result file" >&2
    continue
  fi

  # Each result file is a single tab-separated line:
  #   OK   <draft> <img_tmp> <out_file> <usage> <mime_type>
  #   FAIL <draft> <message>   (also NOIMG)
  IFS=$'\t' read -r status _ field3 field4 usage mime_type < "$result_file"
  case "$status" in
    OK)
      img_tmp="$field3"
      intended_out="$field4"

      # For auto-generated paths, replace the placeholder .png extension with
      # the correct one derived from the API's reported mimeType.
      # For explicit --out PATH, honor the user's path verbatim.
      ext="$(mime_to_ext "$mime_type")"
      if [[ -n "$OUT_PATH" ]]; then
        final_out="$intended_out"
        # Warn if the --out extension disagrees with the returned format.
        out_ext="$(printf '%s' "${intended_out##*.}" | tr '[:upper:]' '[:lower:]')"
        [[ "$out_ext" == "jpeg" ]] && out_ext="jpg"
        if [[ "$out_ext" != "$ext" ]]; then
          echo "WARNING draft $i: --out extension does not match returned format ($mime_type); file kept at $final_out" >&2
        fi
      else
        final_out="${intended_out%.png}.${ext}"
      fi

      if [[ ! -s "$img_tmp" ]]; then
        echo "ERROR draft $i: image decode produced an empty file" >&2
        FAILED_DRAFTS+=("$i")
        continue
      fi
      if ! mv "$img_tmp" "$final_out"; then
        echo "ERROR draft $i: failed to move image to $final_out" >&2
        FAILED_DRAFTS+=("$i")
        continue
      fi
      SUCCESSFUL_OUTPUTS+=("$final_out")
      if [[ "$FIRST_USAGE" == '{}' ]]; then
        FIRST_USAGE="$usage"
      fi
      ;;
    FAIL|NOIMG)
      echo "ERROR draft $i: $field3" >&2
      FAILED_DRAFTS+=("$i")
      ;;
    *)
      FAILED_DRAFTS+=("$i")
      echo "ERROR: draft $i unknown status" >&2
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
success_count="${#SUCCESSFUL_OUTPUTS[@]}"
echo "${success_count}/${DRAFTS} drafts generated"
if [[ "${#FAILED_DRAFTS[@]}" -gt 0 ]]; then
  echo "failed drafts: ${FAILED_DRAFTS[*]}"
fi

if [[ "$success_count" -eq 0 ]]; then
  echo "ERROR: no images were generated" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Log (one JSON line)
# ---------------------------------------------------------------------------
if [[ ${#SOURCES[@]} -gt 0 ]]; then
  SOURCES_JSON="$(printf '%s\n' "${SOURCES[@]}" | jq -Rn '[inputs]')"
else
  SOURCES_JSON='[]'
fi
OUTPUTS_JSON="$(printf '%s\n' "${SUCCESSFUL_OUTPUTS[@]}" | jq -Rn '[inputs]')"
ISO_TS="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

jq -cn \
  --arg ts "$ISO_TS" \
  --arg prompt "$PROMPT" \
  --arg model "$MODEL" \
  --arg aspect "$ASPECT" \
  --arg resolution "$RESOLUTION" \
  --argjson chromaKeyFallback "$CHROMA_KEY_FALLBACK" \
  --argjson transparent "$TRANSPARENT" \
  --arg cutout "$CUTOUT" \
  --argjson sources "$SOURCES_JSON" \
  --argjson outputs "$OUTPUTS_JSON" \
  --argjson usage "$FIRST_USAGE" \
  '{ts: $ts, prompt: $prompt, model: $model, aspect: $aspect,
    resolution: $resolution, chroma_key_fallback: ($chromaKeyFallback == 1),
    transparent: ($transparent == 1), cutout: $cutout,
    sources: $sources, outputs: $outputs, usage: $usage}' \
  >>"$LOG_FILE"

# ---------------------------------------------------------------------------
# Print output paths
# ---------------------------------------------------------------------------
for out in "${SUCCESSFUL_OUTPUTS[@]}"; do
  echo "image: $out"
done
echo "log: $LOG_FILE"
