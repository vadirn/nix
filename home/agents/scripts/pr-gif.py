#!/usr/bin/env python3
"""Pick a GIF for a PR template's GIF section from the git skill's library,
references/gifs.json, a map of title to URL.

    pr-gif                     list the titles, one per line
    pr-gif <title>             print the markdown embed for that title
    pr-gif add <title> <url>   add a GIF, refusing one GitHub will not render

Exit codes: 0 on success, 1 on an unknown title or a refused add, 2 on misuse.
"""

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

LIBRARY = Path(__file__).resolve().parent.parent / "skills/git/references/gifs.json"
MAX_BYTES = 5 * 1024 * 1024  # GitHub's image proxy refuses a larger image


def fail(message):
    sys.exit(f"pr-gif: {message}")


def load():
    return json.loads(LIBRARY.read_text())


def refusal(url):
    """Say why GitHub would not render the image at url, or return None."""
    if "tenor.com/m/" in url:
        return "a Tenor /m/ link returns 404 on some requests; use media.tenor.com/<id>/<slug>.gif"
    request = urllib.request.Request(url, headers={"User-Agent": "pr-gif"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            size = response.headers.get("Content-Length")
    except urllib.error.HTTPError as error:
        return f"{url} returned HTTP {error.code}"
    except urllib.error.URLError as error:
        return f"{url} is unreachable: {error.reason}"
    if size is None:
        return f"{url} sent no content-length, so its size is unknown"
    if int(size) > MAX_BYTES:
        return f"{url} is {size} bytes; GitHub's image proxy refuses over {MAX_BYTES}"
    return None


def add(title, url):
    library = load()
    if title in library:
        fail(f"the library already has a GIF titled: {title}")
    reason = refusal(url)
    if reason:
        fail(reason)
    LIBRARY.write_text(
        json.dumps({title: url, **library}, indent=2, ensure_ascii=False) + "\n"
    )


def main(args):
    if not args:
        print("\n".join(load()))
    elif args[0] == "add":
        if len(args) != 3:
            print("usage: pr-gif add <title> <url>", file=sys.stderr)
            sys.exit(2)
        add(args[1], args[2])
    else:
        url = load().get(args[0]) or fail(f"no GIF titled: {args[0]}")
        print(f"![]({url})")


if __name__ == "__main__":
    main(sys.argv[1:])
