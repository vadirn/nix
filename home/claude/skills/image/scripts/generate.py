# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "google-genai>=1.0.0",
#     "Pillow>=10.0.0",
# ]
# ///
"""Generate or edit images via Gemini API."""

import argparse
import io
import os
import sys
import time

from google import genai
from google.genai import types
from PIL import Image

ASPECT_RATIOS = [
    "1:1",
    "2:3",
    "3:2",
    "3:4",
    "4:3",
    "9:16",
    "16:9",
    "2:1",
    "1:2",
    "4:5",
    "5:4",
    "3:1",
    "1:3",
    "9:21",
]

SIZE_MAP = {
    "512px": "512x512",
    "1K": "1024x1024",
    "2K": "2048x2048",
    "4K": "4096x4096",
}


def parse_args():
    p = argparse.ArgumentParser(description="Generate or edit images via Gemini")
    p.add_argument("prompt", help="Text prompt for generation or editing")
    p.add_argument("--image", default=None, help="Input image path (edit mode)")
    p.add_argument(
        "--output",
        default=None,
        help="Output path (default: /tmp/image-<timestamp>.png)",
    )
    p.add_argument(
        "--aspect-ratio",
        default="1:1",
        choices=ASPECT_RATIOS,
        help="Aspect ratio (default: 1:1)",
    )
    p.add_argument(
        "--size",
        default="1K",
        choices=list(SIZE_MAP.keys()),
        help="Output size (default: 1K)",
    )
    p.add_argument(
        "--model",
        default="gemini-3.1-flash-image-preview",
        help="Model ID",
    )
    return p.parse_args()


def main():
    args = parse_args()

    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        print("Error: GEMINI_API_KEY not set", file=sys.stderr)
        sys.exit(1)

    output_path = args.output or f"/tmp/image-{int(time.time())}.png"

    client = genai.Client(api_key=api_key)

    # Build contents
    contents = []
    if args.image:
        try:
            img = Image.open(args.image)
        except FileNotFoundError:
            print(f"Error: image not found: {args.image}", file=sys.stderr)
            sys.exit(1)
        contents.append(img)
    contents.append(args.prompt)

    # Config
    generate_config = {
        "response_modalities": ["TEXT", "IMAGE"],
    }

    # image_config only for generation (not editing)
    if not args.image:
        generate_config["image_config"] = types.ImageConfig(
            image_size=SIZE_MAP[args.size],
            aspect_ratio=args.aspect_ratio,
        )

    try:
        response = client.models.generate_content(
            model=args.model,
            contents=contents,
            config=types.GenerateContentConfig(**generate_config),
        )
    except Exception as e:
        print(f"Error: API call failed: {e}", file=sys.stderr)
        sys.exit(1)

    # Extract image from response
    image_saved = False
    for part in response.candidates[0].content.parts:
        if part.inline_data and part.inline_data.mime_type.startswith("image/"):
            img = Image.open(io.BytesIO(part.inline_data.data))
            img.save(output_path)
            image_saved = True
            break
        if part.text:
            print(part.text, file=sys.stderr)

    if not image_saved:
        print("Error: no image in response", file=sys.stderr)
        sys.exit(1)

    print(f"IMAGE_PATH={output_path}")


if __name__ == "__main__":
    main()
